/**
 * In-memory chat state for one running endpoint.
 *
 * The shape follows the QwenPaw channel deliberately: the browser reads its own
 * history back from `/conversations/<id>/messages`, so the channel that answers has
 * to keep the transcript it can show. OpenClaw also records a transcript in the
 * agent session, but reading it back would couple the wire contract to a host
 * storage layout, and `/capabilities` already advertises `recovery: false` — the
 * transcript dies with the process either way.
 *
 * Failures here are thrown as `HttpError` instances so the wording the browser
 * shows stays in one place with the rest of the contract sentences.
 */
import { randomUUID } from "node:crypto";
import { badRequest, conflict, forbidden, notFound, tooManyRequests } from "./http/respond.js";
import {
  MAX_CONVERSATIONS,
  MAX_OUTGOING_TOTAL_BYTES,
  MAX_PENDING_REQUESTS,
  PENDING_ATTACHMENTS_MAX,
  TERMINAL_REQUEST_STATES,
  buildUserMessageAttachments,
  buildUserMessageText,
  type AttachmentKind,
  type ConversationMessage,
  type MessageAttachment,
  type MessagePayload,
  type RequestDto,
  type RequestState,
} from "./protocol.js";
import type { StagedMedia } from "./media.js";

export type PageAssistConversation = {
  id: string;
  messages: ConversationMessage[];
  /** requestId of the run holding this conversation; absent when idle. */
  active?: string;
  /**
   * Host session this conversation maps to, recorded on the first request. Approval
   * correlation (P3) starts from the host's pending record, which only carries a
   * session key, so the reverse lookup has to exist by then.
   */
  sessionKey?: string;
};

export type PageAssistRequest = {
  requestId: string;
  conversation: PageAssistConversation;
  payload: MessagePayload;
  /**
   * Payload serialized in the protocol's fixed key order. An idempotent replay must
   * carry the same content, and comparing this string is what makes the check
   * independent of the key order the client happened to use.
   */
  canonical: string;
  state: RequestState;
  /** Reply rows this request delivered; the terminal mapping reads this. */
  delivered: number;
  /**
   * Uploads this request consumed. The turn hands their stored bytes to the agent as
   * media facts, so the run and the transcript row describe the same attachments.
   */
  attachments: PageAssistAttachment[];
  /** Set when the host reported a failure, kept for the logs only. */
  error?: string;
  /** Aborted when the endpoint stops so the underlying agent run can be cut short. */
  abort: AbortController;
  /** True once the host turn settled, so late replies are no longer admitted. */
  settled: boolean;
};

/**
 * Bytes this endpoint has staged, addressed by the id the browser uses.
 *
 * `storeId` and `path` belong to the host media store and stay in memory: the contract
 * says an id is an opaque UUID, while a store id embeds the uploader's filename, and no
 * server path may ever reach the browser.
 */
export type PageAssistMedia = StagedMedia & {
  id: string;
  kind: AttachmentKind;
  name: string;
  mediaType: string;
  bytes: number;
  /** Which media bucket holds this record, because reads must name it. */
  subdir: string;
};

/** One pending upload. `usedBy` is set once a request consumes it, and it never resets. */
export type PageAssistAttachment = PageAssistMedia & {
  usedBy?: string;
};

/** The fields an upload carries before it is staged, produced by the payload parser. */
export type PageAssistUploadDescriptor = {
  name: string;
  kind: AttachmentKind;
  mediaType: string;
  bytes: number;
};

/** Builds the fixed-order serialization used for replay comparison. */
function canonicalize(payload: MessagePayload): string {
  return JSON.stringify({
    requestId: payload.requestId,
    text: payload.text,
    pageContext: payload.pageContext ?? null,
    attachments: payload.attachments ?? null,
  });
}

/**
 * Wire projection of a request. The same three fields answer `POST /conversations/
 * <id>/messages`, `GET /requests/<id>`, and every `request.state` event, so they are
 * built in one place and in the browser's key order.
 */
export function buildRequestDto(record: PageAssistRequest): RequestDto {
  return {
    requestId: record.requestId,
    conversationId: record.conversation.id,
    state: record.state,
  };
}

export class PageAssistStore {
  private readonly conversations = new Map<string, PageAssistConversation>();
  private readonly requests = new Map<string, PageAssistRequest>();
  /** Pending uploads by wire id, including the ones a request already consumed. */
  private readonly attachments = new Map<string, PageAssistAttachment>();
  /**
   * Every staged file in both directions, and the capacity ledger at once. An upload
   * is served back through `GET /media/:id` just like reply media is, and it shares the
   * byte budget, so the oldest staged bytes — upload or reply — are the first to go.
   */
  private readonly media = new Map<string, PageAssistMedia>();
  private mediaBytes = 0;

  /** Conversation count, exposed for tests and the limit's error path. */
  get conversationCount(): number {
    return this.conversations.size;
  }

  get requestCount(): number {
    return this.requests.size;
  }

  get pendingAttachmentCount(): number {
    return this.attachments.size;
  }

  get stagedMediaCount(): number {
    return this.media.size;
  }

  get stagedMediaBytes(): number {
    return this.mediaBytes;
  }

  /**
   * `POST /conversations`: one endpoint drives one agent, so anything addressed to a
   * different agent is refused rather than silently rerouted.
   */
  createConversation(agentId: string, boundAgentId: string): PageAssistConversation {
    if (agentId !== boundAgentId) {
      throw forbidden("This channel is bound to another Agent");
    }
    if (this.conversations.size >= MAX_CONVERSATIONS) {
      throw tooManyRequests("Channel conversation limit reached; restart to clear browser state");
    }
    const conversation: PageAssistConversation = { id: randomUUID(), messages: [] };
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  requireConversation(id: string): PageAssistConversation {
    const conversation = this.conversations.get(id);
    if (!conversation) {
      throw notFound("Conversation unavailable; create a new chat after channel restart");
    }
    return conversation;
  }

  requireRequest(id: string): PageAssistRequest {
    const record = this.requests.get(id);
    if (!record) {
      throw notFound("Request unavailable in this channel instance");
    }
    return record;
  }

  /* -------------------------------------------------------------- *
   * Uploads and staged media                                        *
   * -------------------------------------------------------------- */

  /**
   * Rejects an upload this endpoint cannot hold.
   *
   * Called before the bytes are staged, so a refused upload leaves no orphan file in the
   * media store. Consumed uploads still count against the ceiling: they expire with the
   * channel, which is exactly what the "send or restart" sentence tells the user to do.
   */
  requireUploadCapacity(): void {
    if (this.attachments.size >= PENDING_ATTACHMENTS_MAX) {
      throw tooManyRequests("Too many unattached uploads; send or restart the channel");
    }
  }

  /**
   * Registers one staged upload.
   *
   * The bytes join the ledger without evicting anything, because uploads are already
   * bounded by count and per-file size and the reply path is what claims space up front.
   * A later reply can therefore retire a pending upload, and the browser finds out when
   * its submission is refused rather than when it uploaded.
   */
  registerUpload(
    upload: PageAssistUploadDescriptor,
    staged: StagedMedia,
    subdir: string,
  ): PageAssistAttachment {
    this.requireUploadCapacity();
    const record: PageAssistAttachment = { ...upload, ...staged, subdir, id: randomUUID() };
    this.attachments.set(record.id, record);
    this.media.set(record.id, record);
    this.mediaBytes += record.bytes;
    return record;
  }

  /**
   * Registers staged reply media and reports the bytes the ledger gave up.
   *
   * Space is claimed before the file is written, and eviction runs oldest registered
   * first. The reference channel sorts by id — a UUID there, so its order is
   * chronological by accident rather than by design — while its docstring states
   * oldest-first as the intent, and insertion order is the honest reading of that.
   */
  registerReplyMedia(
    media: PageAssistUploadDescriptor,
    staged: StagedMedia,
    subdir: string,
  ): { record: PageAssistMedia; evicted: PageAssistMedia[] } {
    const evicted = this.claimLedgerBytes(media.bytes);
    const record: PageAssistMedia = { ...media, ...staged, subdir, id: randomUUID() };
    this.media.set(record.id, record);
    this.mediaBytes += record.bytes;
    return { record, evicted };
  }

  /**
   * Drops the oldest staged media until `bytes` fit in the total budget.
   *
   * Eviction is silent on the wire: the browser simply gets a 404 for an id it read in
   * an older row, which is what the capacity ceiling is for — a bounded amount of
   * buffered bytes, not a promise that every reply attachment survives.
   */
  private claimLedgerBytes(bytes: number): PageAssistMedia[] {
    const evicted: PageAssistMedia[] = [];
    for (const record of [...this.media.values()]) {
      if (this.mediaBytes + bytes <= MAX_OUTGOING_TOTAL_BYTES) {
        break;
      }
      this.media.delete(record.id);
      this.mediaBytes -= record.bytes;
      evicted.push(record);
    }
    return evicted;
  }

  /**
   * Marks every referenced upload as used by this request, or none of them.
   *
   * All-or-nothing because a half-consumed message would leave the browser holding a
   * reference it cannot resend: the whole submission is refused with the QwenPaw
   * sentence and the retry re-uploads everything. `isPresent` is the caller's chance to
   * notice that the staged bytes are gone — evicted by the ledger or retired by host
   * media maintenance — while the record is still pending.
   */
  claimAttachments(
    payload: MessagePayload,
    isPresent: (record: PageAssistAttachment) => boolean,
  ): PageAssistAttachment[] {
    const claimed: PageAssistAttachment[] = [];
    for (const ref of payload.attachments ?? []) {
      const record = this.attachments.get(ref.attachmentId);
      if (record === undefined || record.usedBy !== undefined || !isPresent(record)) {
        for (const entry of claimed) {
          entry.usedBy = undefined;
        }
        throw badRequest("Attachment unavailable; upload it again");
      }
      claimed.push(record);
    }
    for (const record of claimed) {
      record.usedBy = payload.requestId;
    }
    return claimed;
  }

  /** The staged bytes behind one wire id, or the contract's plain 404. */
  requireMedia(id: string): PageAssistMedia {
    const record = this.media.get(id);
    if (!record) {
      throw notFound("Media unavailable");
    }
    return record;
  }

  /**
   * Registers a submission and takes the conversation lock.
   *
   * Returns `replay: true` for a request id that is already known with identical
   * content, which lets the route answer the original DTO without starting a second
   * run. A reused id with different content, or a submission against a conversation
   * that is already busy, is a conflict.
   *
   * `consumeAttachments` runs after those checks and before anything is written, so a
   * replay never spends the uploads a first submission already consumed, and a rejected
   * submission leaves every upload pending. It is synchronous on purpose: the claim has
   * to land in the same tick as the checks, or two concurrent submissions could both
   * believe they own one upload.
   */
  submit(
    conversation: PageAssistConversation,
    payload: MessagePayload,
    consumeAttachments: (payload: MessagePayload) => PageAssistAttachment[] = () => [],
  ): { record: PageAssistRequest; replay: boolean; attachments: PageAssistAttachment[] } {
    const canonical = canonicalize(payload);
    const existing = this.requests.get(payload.requestId);
    if (existing) {
      if (existing.conversation !== conversation || existing.canonical !== canonical) {
        throw conflict("requestId already used with another payload");
      }
      return { record: existing, replay: true, attachments: existing.attachments };
    }
    if (conversation.active) {
      throw conflict("Conversation is busy");
    }
    if (this.requests.size >= MAX_PENDING_REQUESTS) {
      throw tooManyRequests("Channel request limit reached; restart to clear browser state");
    }

    const attachments = consumeAttachments(payload);
    const record: PageAssistRequest = {
      requestId: payload.requestId,
      conversation,
      payload,
      canonical,
      state: "accepted",
      delivered: 0,
      attachments,
      abort: new AbortController(),
      settled: false,
    };
    this.requests.set(record.requestId, record);
    conversation.active = record.requestId;
    conversation.messages.push({
      id: `${record.requestId}:user`,
      requestId: record.requestId,
      role: "user",
      content: buildUserMessageText(payload.text, attachments),
      attachments: buildUserMessageAttachments(attachments),
      status: "complete",
    });
    return { record, replay: false, attachments };
  }

  /**
   * Appends one assistant row and reports whether it was admitted.
   *
   * A reply that arrives after its request was settled — the usual shape of a run
   * that was cancelled while the model was still writing — is dropped instead of
   * landing in the transcript of a request the browser already closed.
   */
  appendAssistant(
    record: PageAssistRequest,
    content: string,
    attachments: MessageAttachment[] = [],
  ): ConversationMessage | undefined {
    if (record.settled || TERMINAL_REQUEST_STATES.has(record.state)) {
      return undefined;
    }
    const message: ConversationMessage = {
      id: randomUUID(),
      requestId: record.requestId,
      role: "assistant",
      content,
      attachments,
      status: "complete",
    };
    record.conversation.messages.push(message);
    record.delivered += 1;
    return message;
  }

  setState(record: PageAssistRequest, state: RequestState): void {
    if (record.settled) {
      return;
    }
    record.state = state;
  }

  /**
   * Ends the request and frees the conversation.
   *
   * `unknown` keeps the lock, exactly as the QwenPaw channel does: the host did not
   * confirm the run is over, so accepting another message into the same session
   * could interleave two runs. Only a channel restart clears it, which the browser
   * presents as a fresh instance.
   */
  settle(record: PageAssistRequest, state: RequestState, error?: string): void {
    if (record.settled) {
      return;
    }
    record.state = state;
    if (error) {
      record.error = error;
    }
    if (state === "unknown") {
      return;
    }
    record.settled = true;
    if (record.conversation.active === record.requestId) {
      record.conversation.active = undefined;
    }
  }

  /**
   * Stops everything in flight. The Gateway is retiring this endpoint, so a running
   * agent turn has no subscriber left: abort the run, report the cancellation, and
   * let the event streams close with a terminal state instead of hanging.
   */
  beginStop(): void {
    for (const record of this.requests.values()) {
      if (record.settled || TERMINAL_REQUEST_STATES.has(record.state)) {
        continue;
      }
      record.abort.abort(new Error("Page Assist endpoint is stopping"));
      this.settle(record, "cancelled");
    }
  }
}

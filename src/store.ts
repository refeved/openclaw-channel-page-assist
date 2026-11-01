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
import { conflict, forbidden, notFound, tooManyRequests } from "./http/respond.js";
import {
  MAX_CONVERSATIONS,
  MAX_PENDING_REQUESTS,
  TERMINAL_REQUEST_STATES,
  type ConversationMessage,
  type MessagePayload,
  type RequestDto,
  type RequestState,
} from "./protocol.js";

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
  /** Set when the host reported a failure, kept for the logs only. */
  error?: string;
  /** Aborted when the endpoint stops so the underlying agent run can be cut short. */
  abort: AbortController;
  /** True once the host turn settled, so late replies are no longer admitted. */
  settled: boolean;
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

  /** Conversation count, exposed for tests and the limit's error path. */
  get conversationCount(): number {
    return this.conversations.size;
  }

  get requestCount(): number {
    return this.requests.size;
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

  /**
   * Registers a submission and takes the conversation lock.
   *
   * Returns `replay: true` for a request id that is already known with identical
   * content, which lets the route answer the original DTO without starting a second
   * run. A reused id with different content, or a submission against a conversation
   * that is already busy, is a conflict.
   */
  submit(
    conversation: PageAssistConversation,
    payload: MessagePayload,
  ): { record: PageAssistRequest; replay: boolean } {
    const canonical = canonicalize(payload);
    const existing = this.requests.get(payload.requestId);
    if (existing) {
      if (existing.conversation !== conversation || existing.canonical !== canonical) {
        throw conflict("requestId already used with another payload");
      }
      return { record: existing, replay: true };
    }
    if (conversation.active) {
      throw conflict("Conversation is busy");
    }
    if (this.requests.size >= MAX_PENDING_REQUESTS) {
      throw tooManyRequests("Channel request limit reached; restart to clear browser state");
    }

    const record: PageAssistRequest = {
      requestId: payload.requestId,
      conversation,
      payload,
      canonical,
      state: "accepted",
      delivered: 0,
      abort: new AbortController(),
      settled: false,
    };
    this.requests.set(record.requestId, record);
    conversation.active = record.requestId;
    conversation.messages.push({
      id: `${record.requestId}:user`,
      requestId: record.requestId,
      role: "user",
      content: payload.text,
      attachments: [],
      status: "complete",
    });
    return { record, replay: false };
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
    attachments: unknown[] = [],
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

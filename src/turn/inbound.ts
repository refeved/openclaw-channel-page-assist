/**
 * One browser request in, one OpenClaw agent turn out.
 *
 * The host owns the run: `runtime.channel.inbound.run` takes the normalized event
 * through ingest, admission, session recording, dispatch, and finalize, and returns
 * when the turn is over. Everything this channel needs is therefore expressed as
 * facts about the inbound event plus a delivery adapter that appends replies into
 * the conversation the browser is polling.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  readAgentRunTerminalOutcome,
  toInboundMediaFacts,
} from "openclaw/plugin-sdk/channel-inbound";
import { PAGE_ASSIST_CHANNEL_ID } from "../accounts.js";
import type { PageAssistScope } from "../http/scope.js";
import {
  buildAgentText,
  buildAssistantReplyBody,
  type RequestState,
} from "../protocol.js";
import { tryGetPageAssistRuntime } from "../runtime.js";
import type { PageAssistRequest } from "../store.js";
import { buildReplyMedia } from "./outbound.js";

/** Event payload handed to the host pipeline; `raw` stays plugin-owned. */
type PageAssistInboundEvent = {
  record: PageAssistRequest;
  userText: string;
  agentText: string;
  conversationId: string;
  /** Stable participant identity: the token digest, never the token. */
  principalId: string;
  /** Conversation label shown by host surfaces that list sessions. */
  label: string;
};

/** Rows the browser must be able to read, mirroring the QwenPaw channel's notices. */
const NOTICE = {
  dropped: (reason: string) =>
    `OpenClaw declined this request (${reason}). Check the Gateway configuration.`,
  blocked: "OpenClaw blocked this request before the agent ran. Check the Gateway logs.",
  failed: "OpenClaw agent run failed; check Gateway logs.",
  unconfirmed:
    "OpenClaw did not confirm completion. Do not resend; check the Gateway session logs.",
} as const;

/** First line of the question, shortened for host session listings. */
function buildConversationLabel(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "Shared page";
  }
  const characters = Array.from(trimmed);
  return characters.length <= 80 ? trimmed : `${characters.slice(0, 79).join("")}\u2026`;
}

/**
 * `allowFrom` is the only access lever this endpoint has, and the browser token is
 * the credential that gates it: an open allowlist admits the principal, while a
 * configured list is matched against the principal digest.
 */
function resolveIngressPolicy(allowFrom: Array<string | number>): "allowlist" | "open" {
  return allowFrom.some((entry) => String(entry).trim() === "*") ? "open" : "allowlist";
}

/** Maps a settled host turn onto the request states the browser understands. */
function resolveSettledState(params: {
  dispatched: boolean;
  admissionKind: string;
  admissionReason?: string;
  terminalOutcome?: string;
  aborted: boolean;
  beforeAgentRunBlocked?: boolean;
}): { state: RequestState; notice?: string } {
  if (params.aborted) {
    // The endpoint stopped; nobody is left to read a reply.
    return { state: "cancelled" };
  }
  if (!params.dispatched) {
    if (params.admissionKind === "drop") {
      return {
        state: "failed",
        notice: NOTICE.dropped(params.admissionReason ?? "dropped"),
      };
    }
    // `handled` and `observeOnly` both mean the host took the event and answered
    // it somewhere else; the browser's request is done as far as it is concerned.
    return { state: "completed" };
  }
  if (params.terminalOutcome === "failed") {
    return { state: "failed", notice: NOTICE.failed };
  }
  if (params.terminalOutcome === "completed") {
    return { state: "completed" };
  }
  if (params.beforeAgentRunBlocked === true) {
    return { state: "failed", notice: NOTICE.blocked };
  }
  return { state: "unknown", notice: NOTICE.unconfirmed };
}

/**
 * Runs one request to completion and settles its state.
 *
 * Never throws: the caller fires this off from a 202 handler, so an escaped
 * rejection would surface as an unhandled rejection in the Gateway process.
 */
export async function runPageAssistRequest(
  scope: PageAssistScope,
  record: PageAssistRequest,
): Promise<void> {
  const runtime = tryGetPageAssistRuntime();
  if (!runtime) {
    scope.store.appendAssistant(record, NOTICE.failed);
    scope.store.settle(record, "failed", "channel runtime unavailable");
    return;
  }
  if (record.settled) {
    return;
  }
  scope.store.setState(record, "running");

  try {
    const conversation = record.conversation;
    const account = scope.account;
    // The host hands out a read-only snapshot; the turn plan wants the plain config
    // type, and this is the single place where that relaxation happens.
    const cfg = runtime.config.current() as OpenClawConfig;
    const route = runtime.channel.routing.resolveAgentRoute({
      cfg,
      channel: PAGE_ASSIST_CHANNEL_ID,
      accountId: account.accountId,
      // The endpoint is bound to one agent, so an unmatched route must not fall back
      // to the Gateway's default agent.
      defaultAgentId: account.agentId,
      peer: { kind: "direct", id: conversation.id },
      // One browser conversation is one agent session. The host default `main`
      // collapses every DM of an agent into a single session, which would leak one
      // chat's history into the next browser chat; the QwenPaw channel keys its
      // session by conversation for the same reason. An operator binding can still
      // override the scope, because bindings win over this argument.
      dmScope: "per-channel-peer",
    });
    const sessionKey = route.sessionKey;
    conversation.sessionKey ??= sessionKey;

    const event: PageAssistInboundEvent = {
      record,
      userText: record.payload.text,
      agentText: buildAgentText(record.payload),
      conversationId: conversation.id,
      principalId: scope.principalScope,
      label: buildConversationLabel(record.payload.text),
    };

    /**
     * Uploads this request consumed, expressed the way the host reads them.
     *
     * The bytes already sit in the inbound media bucket, so the agent is given a store
     * reference rather than an absolute server path. `file` is the browser's label and not
     * a media family, so its kind is left for the host to classify from the type it
     * detected while staging; only a magic-byte-proven image claims `image`.
     */
    const media = toInboundMediaFacts(
      record.attachments.map((attachment) => ({
        url: `media://inbound/${attachment.storeId}`,
        contentType: attachment.mediaType,
        fileName: attachment.name,
        ...(attachment.kind === "image" ? { kind: "image" as const } : {}),
      })),
    );

    const ingress = await runtime.channel.inbound.ingress.resolveStable({
      channelId: PAGE_ASSIST_CHANNEL_ID,
      accountId: account.accountId,
      identity: { key: "sender-id", kind: "stable-id", entryIdPrefix: "page-assist-entry" },
      subject: { stableId: event.principalId },
      conversation: { kind: "direct", id: event.conversationId },
      contextBinding: {
        agentId: route.agentId,
        sessionKey,
        messageId: record.requestId,
        inboundEventKind: "user_request",
      },
      event: { mayPair: false },
      dmPolicy: resolveIngressPolicy(account.allowFrom),
      allowFrom: account.allowFrom,
    });

    const result = await runtime.channel.inbound.run({
      channel: PAGE_ASSIST_CHANNEL_ID,
      accountId: account.accountId,
      raw: event,
      adapter: {
        ingest: (inbound) => ({
          id: inbound.record.requestId,
          timestamp: Date.now(),
          rawText: inbound.userText,
          textForAgent: inbound.agentText,
          textForCommands: inbound.userText,
          raw: inbound,
        }),
        preflight: () =>
          ingress.senderAccess.allowed
            ? null
            : {
                admission: {
                  kind: "drop" as const,
                  reason: `sender_not_allowed:${ingress.senderAccess.reasonCode}`,
                },
              },
        resolveTurn: (input) => {
          // Identity facts come from the captured event, not from `input.raw`, whose
          // type is `unknown` on the host side: the adapter contract normalizes the
          // envelope, and the plugin keeps the authoritative copy.
          const ctxPayload = runtime.channel.inbound.buildContext({
            channelIngress: ingress,
            channel: PAGE_ASSIST_CHANNEL_ID,
            accountId: account.accountId,
            messageId: input.id,
            timestamp: input.timestamp,
            from: `${PAGE_ASSIST_CHANNEL_ID}:${event.principalId}`,
            sender: { id: event.principalId, name: "Page Assist" },
            conversation: {
              kind: "direct",
              id: event.conversationId,
              label: event.label,
            },
            route: {
              agentId: route.agentId,
              dmScope: route.dmScope,
              accountId: account.accountId,
              routeSessionKey: sessionKey,
              dispatchSessionKey: sessionKey,
            },
            reply: { to: `${PAGE_ASSIST_CHANNEL_ID}:${event.conversationId}` },
            // A text-only turn keeps the same context it did before uploads existed:
            // an empty media list is a different fact, not the same one.
            ...(media.length > 0 ? { media } : {}),
            message: {
              inboundEventKind: "user_request",
              rawBody: input.rawText,
              commandBody: input.textForCommands,
              bodyForAgent: input.textForAgent,
            },
          });
          return {
            cfg,
            channel: PAGE_ASSIST_CHANNEL_ID,
            accountId: account.accountId,
            route: { agentId: route.agentId, dmScope: route.dmScope, sessionKey },
            ctxPayload,
            delivery: {
              /**
               * Replies land in the transcript the browser polls, so there is no
               * transport to send through. `durable` is deliberately left unset: core
               * routes durable payloads through its own message-send owner, which
               * needs an outbound adapter this channel does not have.
               *
               * Attachments are resolved before the row is written, so the media list and
               * the text the browser reads describe the same reply. A payload that carries
               * neither — a reasoning marker, an empty status line — is reported as not
               * delivered rather than appended as a blank row.
               */
              deliver: async (payload) => {
                const text = payload.text?.trim() ?? "";
                const { attachments, notices } = await buildReplyMedia({
                  payload,
                  store: scope.store,
                  cfg,
                  agentId: route.agentId,
                  mediaMaxBytes: scope.account.mediaMaxBytes,
                });
                const body = buildAssistantReplyBody(text, notices);
                if (!body && attachments.length === 0) {
                  return { visibleReplySent: false };
                }
                const appended = scope.store.appendAssistant(record, body, attachments);
                return { visibleReplySent: appended !== undefined };
              },
            },
            // Cutting the agent run short is the only way this endpoint honours a
            // Gateway stop while a model is still writing.
            replyOptions: { abortSignal: record.abort.signal },
            record: {
              onRecordError: (error: unknown) => {
                scope.log?.warn(
                  `Page Assist session metadata update failed for ${sessionKey}: ${String(error)}`,
                );
              },
            },
          };
        },
      },
    });

    const dispatch = result.dispatched ? result.dispatchResult : undefined;
    const settled = resolveSettledState({
      dispatched: result.dispatched,
      admissionKind: result.admission.kind,
      admissionReason: "reason" in result.admission ? result.admission.reason : undefined,
      terminalOutcome: dispatch ? readAgentRunTerminalOutcome(dispatch) : undefined,
      aborted: record.abort.signal.aborted,
      beforeAgentRunBlocked: dispatch?.beforeAgentRunBlocked,
    });
    // The notice has to be in the transcript before the state flips, or a browser
    // that is polling on the state change reads a terminal request with no last row.
    if (settled.notice) {
      scope.store.appendAssistant(record, settled.notice);
    }
    scope.store.settle(record, settled.state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scope.log?.error(`Page Assist turn failed for ${record.requestId}: ${message}`);
    scope.store.appendAssistant(record, NOTICE.failed);
    scope.store.settle(record, record.abort.signal.aborted ? "cancelled" : "failed", message);
  }
}

import { runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";
import { HTTP_PREFIX, parseMessagePayload, parseNewConversation } from "../../protocol.js";
import { runPageAssistRequest } from "../../turn/inbound.js";
import { buildRequestDto } from "../../store.js";
import { readBrowserBody } from "../body.js";
import { badRequest, sendJson } from "../respond.js";
import type { PageAssistRoute } from "../scope.js";

/**
 * `POST /api/page-assist/conversations`
 *
 * A conversation is browser-owned state, not an agent session: it is the handle the
 * extension polls and replays against. One endpoint drives one agent, so a body
 * addressed to a different agent is refused instead of silently rerouted.
 */
export const pageAssistCreateConversationRoute: PageAssistRoute = {
  method: "POST",
  path: `${HTTP_PREFIX}/conversations`,
  handler: async ({ req, res, scope }) => {
    const body = await readBrowserBody(req, parseNewConversation);
    const conversation = scope.store.createConversation(body.agentId, scope.account.agentId);
    sendJson(res, 200, {
      conversationId: conversation.id,
      agentId: scope.account.agentId,
    });
  },
};

/**
 * `POST /api/page-assist/conversations/:id/messages`
 *
 * Accepted, then run: the browser needs its request id back immediately and watches
 * `GET /requests/:id/events` for the reply. A replay of a known id with identical
 * content answers with the original state instead of starting a second run.
 */
export const pageAssistSubmitMessageRoute: PageAssistRoute = {
  method: "POST",
  path: `${HTTP_PREFIX}/conversations/:id/messages`,
  handler: async ({ req, res, params, scope }) => {
    const conversation = scope.store.requireConversation(params.id ?? "");
    const payload = await readBrowserBody(req, parseMessagePayload);
    // Uploads belong to the attachment phase; `/capabilities` already reports
    // `attachments: false`, so a client that sends one is out of sync with the
    // endpoint it is talking to. This is the QwenPaw sentence for an unusable
    // attachment id, which keeps one meaning for one message across hosts.
    if (payload.attachments?.length) {
      throw badRequest("Attachment unavailable; upload it again");
    }

    const { record, replay } = scope.store.submit(conversation, payload);
    sendJson(res, replay ? 200 : 202, buildRequestDto(record));
    if (replay) {
      return;
    }
    // The turn runs detached: the agent may take minutes, and the browser is
    // already watching the event stream by the time the first reply lands.
    // It must run on its own gateway work root, though. A plain detached promise
    // inherits this request's admission, and once the 202 is written that admission
    // is released, so the session work inside the turn is refused with a
    // `GatewayDrainingError` as if the Gateway were restarting.
    // `runDetachedWebhookWork` reserves the root while the request is still admitted
    // and still lets the acknowledgement go out first.
    // `runPageAssistRequest` settles the request on every path, so the only thing
    // left to guarantee is that nothing escapes as an unhandled rejection.
    void runDetachedWebhookWork(() => runPageAssistRequest(scope, record)).catch((error: unknown) => {
      scope.log?.error(
        `Page Assist turn supervisor failed for ${record.requestId}: ${String(error)}`,
      );
      scope.store.settle(record, "failed", String(error));
    });
  },
};

/**
 * `GET /api/page-assist/conversations/:id/messages`
 *
 * Full transcript, every call. The extension restores a chat by re-reading history
 * rather than by replaying events, and `complete: true` states plainly that this
 * channel holds the whole conversation — a restarted endpoint has no conversations
 * at all, which the 404 on the unknown id already conveys.
 */
export const pageAssistHistoryRoute: PageAssistRoute = {
  method: "GET",
  path: `${HTTP_PREFIX}/conversations/:id/messages`,
  handler: ({ res, params, scope }) => {
    const conversation = scope.store.requireConversation(params.id ?? "");
    sendJson(res, 200, {
      conversationId: conversation.id,
      complete: true,
      messages: conversation.messages,
    });
  },
};

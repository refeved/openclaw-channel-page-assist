/**
 * The two approval endpoints, in the reference channel's shape.
 *
 * `GET /approvals` answers the panel and nothing else: the extension polls it while a run
 * is alive and treats an empty list as "the agent is working, not blocked". `POST
 * /approvals/:id/decision` answers once and is then replayable, because a browser that
 * loses the response cannot tell a denied approval from one that never arrived.
 *
 * The visible difference from the reference channel is how a row gets here. QwenPaw's
 * approval service pushes — its agent loop calls the channel when a command is gated, and
 * the channel reads its own pending map. OpenClaw's pending records belong to the Gateway
 * and carry a host session key instead of a browser conversation id, so the read goes the
 * other way: list the host's pending approvals, then match each record's session key
 * against the conversations this endpoint started. Everything downstream of that match —
 * the row fields, the decision mapping, the wording, the idempotent ledger — is the same.
 */
import {
  approvalSessionKey,
  buildApprovalDto,
  resolveApprovalDecision,
  type PageAssistApprovalChoice,
  type PageAssistApprovalEntry,
} from "../../approvals.js";
import {
  HTTP_PREFIX,
  isSameApprovalDecision,
  parseApprovalDecisionPayload,
  type ApprovalDecisionPayload,
  type ApprovalDto,
  type ApprovalDecisionDto,
} from "../../protocol.js";
import type { PageAssistConversation } from "../../store.js";
import { readBrowserBody } from "../body.js";
import { badRequest, conflict, notFound, sendJson } from "../respond.js";
import type { PageAssistRoute } from "../scope.js";

/** One pending record that belongs to a conversation of this endpoint. */
type MatchedApproval = {
  entry: PageAssistApprovalEntry;
  conversation: PageAssistConversation;
};

/**
 * Finds the conversation that owns each pending record.
 *
 * A record with no session key, or one whose key no conversation holds, is simply not
 * this browser's business: another channel's approval must not show up in this panel, and
 * an operator binding that two conversations share is answered as belonging to neither.
 */
function matchApprovals(
  entries: readonly PageAssistApprovalEntry[],
  store: { conversationForSessionKey: (sessionKey: string) => PageAssistConversation | undefined },
): MatchedApproval[] {
  const matched: MatchedApproval[] = [];
  for (const entry of entries) {
    const sessionKey = approvalSessionKey(entry);
    if (!sessionKey) {
      continue;
    }
    const conversation = store.conversationForSessionKey(sessionKey);
    if (!conversation) {
      continue;
    }
    matched.push({ entry, conversation });
  }
  // Creation time, then id: the panel shows the oldest gate first, and a tie gets a stable
  // order rather than whichever list call happened to return first this time.
  matched.sort((left, right) => {
    const byAge = left.entry.createdAtMs - right.entry.createdAtMs;
    if (byAge !== 0) {
      return byAge;
    }
    return left.entry.id < right.entry.id ? -1 : left.entry.id > right.entry.id ? 1 : 0;
  });
  return matched;
}

/**
 * Maps the payload onto a host decision, keeping the projection free of the HTTP layer.
 *
 * A scope the record does not allow is thrown as `RangeError` by `resolveApprovalDecision`;
 * here it becomes the contract's 400 with the same sentence the reference channel uses for
 * the one case it can detect.
 */
function approvalChoiceFor(
  entry: PageAssistApprovalEntry,
  payload: ApprovalDecisionPayload,
): PageAssistApprovalChoice {
  try {
    return resolveApprovalDecision(entry, payload);
  } catch (error) {
    if (error instanceof RangeError) {
      throw badRequest(error.message);
    }
    throw error;
  }
}

/**
 * `GET /api/page-assist/approvals`
 *
 * Also the only place the endpoint learns that a run is waiting, so it doubles as the
 * state sync: the conversations holding a pending approval move `running` →
 * `waiting_approval`, and the ones that no longer do move back. QwenPaw gets the same
 * effect from its approval hook calling the channel; here the poll is the event, which is
 * why the sync runs even for records that produced no row (a run that already finished has
 * nothing for the user to decide, but it is no longer waiting either).
 */
export const pageAssistApprovalsRoute: PageAssistRoute = {
  method: "GET",
  path: `${HTTP_PREFIX}/approvals`,
  handler: async ({ res, scope }) => {
    const nowMs = Date.now();
    const entries = await scope.approvals.listPending();
    const matched = matchApprovals(entries, scope.store);
    const rows: ApprovalDto[] = [];
    for (const { entry, conversation } of matched) {
      const dto = buildApprovalDto({
        entry,
        conversationId: conversation.id,
        // A record whose run is already gone cannot be answered: the extension requires a
        // non-empty `requestId` it can tie the row to, so the row is dropped rather than
        // invented — the same read the reference channel gets from `conversation.active`.
        requestId: conversation.active ?? "",
        fallbackAgentId: scope.account.agentId,
        nowMs,
      });
      if (dto) {
        rows.push(dto);
      }
    }
    scope.store.syncApprovalWaits(new Set(matched.map(({ conversation }) => conversation.id)));
    sendJson(res, 200, { approvals: rows });
  },
};

/**
 * `POST /api/page-assist/approvals/:id/decision`
 *
 * Checks run in the reference channel's order, because each one is what turns a wrong
 * answer into a harmless one: the ledger first, so a retry cannot be told from a new
 * decision; then the record's existence and ownership, so a stale or foreign id never
 * reaches the Gateway; then expiry, then the scope the host will actually honour.
 *
 * The scope check is the part with no QwenPaw equivalent to copy. Its rows advertise what
 * their own policy allows, and OpenClaw's Gateway applies a decision outside the persisted
 * allowed set as a silent denial — so a browser asking for `similar` on a record that only
 * allows a one-off would be told "confirmed" while its command was refused. Refusing the
 * request instead keeps the answer true, and the row never offered that scope anyway.
 */
export const pageAssistApprovalDecisionRoute: PageAssistRoute = {
  method: "POST",
  path: `${HTTP_PREFIX}/approvals/:id/decision`,
  handler: async ({ req, res, params, scope }) => {
    const approvalId = params.id ?? "";
    const payload = await readBrowserBody(req, parseApprovalDecisionPayload);

    const confirmed = scope.store.confirmedApprovalDecision(approvalId);
    if (confirmed) {
      if (!isSameApprovalDecision(confirmed.payload, payload)) {
        throw conflict("A different decision was already confirmed");
      }
      sendJson(res, 200, confirmed.response);
      return;
    }

    // The decision is applied to the record the host holds right now rather than to
    // anything this endpoint remembers, so an id that is stale, already answered in the
    // Control UI, or never existed is refused before it can reach the Gateway.
    const entries = await scope.approvals.listPending();
    const entry = entries.find((candidate) => candidate.id === approvalId);
    if (!entry) {
      throw notFound("Approval is no longer pending");
    }
    const sessionKey = approvalSessionKey(entry);
    const conversation = sessionKey ? scope.store.conversationForSessionKey(sessionKey) : undefined;
    if (!conversation) {
      throw notFound("Approval does not belong to this browser channel");
    }
    if (entry.expiresAtMs <= Date.now()) {
      throw conflict("Approval already resolved or expired");
    }

    const choice = approvalChoiceFor(entry, payload);

    const result = await scope.approvals.resolve({
      approvalId: entry.id,
      decision: choice.decision,
      approvalKind: choice.approvalKind,
    });
    // The host had the record and chose not to apply the answer — it was already decided
    // elsewhere — which is the same fact as a missing row for the user.
    if (!result.applied) {
      throw conflict("Approval already resolved or expired");
    }

    const response: ApprovalDecisionDto = {
      approvalId,
      decisionId: payload.decisionId,
      approved: payload.approved,
      status: "confirmed",
      ...(choice.scope ? { scope: choice.scope } : {}),
    };
    scope.store.recordApprovalDecision(approvalId, { payload, response });
    scope.store.resumeApprovalWait(conversation);
    scope.log?.info(
      `Page Assist approval ${approvalId.slice(0, 8)} resolved: approved=${payload.approved} scope=${choice.scope ?? "none"}`,
    );
    sendJson(res, 200, response);
  },
};

import assert from "node:assert/strict";
import { test } from "node:test";
// Behavioural tests run against the build output: the sources use the `.js`
// specifiers that emitted ESM requires, and Node's type stripping does not map
// them back to `.ts`. `npm test` builds first, so these are the shipped modules.
import {
  approvalAgentId,
  approvalSessionKey,
  buildApprovalDto,
  buildApprovalScopes,
  normalizeApprovalListResponse,
  resolveApprovalAllowedDecisions,
  resolveApprovalDecision,
} from "../dist/src/approvals.js";
import { PageAssistStore } from "../dist/src/store.js";
import {
  APPROVAL_SCOPE_PRESENTATION,
  APPROVAL_TARGET_MAX_CHARS,
  isSameApprovalDecision,
} from "../src/protocol.ts";
import type { PageAssistApprovalEntry } from "../src/approvals.ts";

/**
 * The approval projection is where this channel's contract is strictest, because the
 * extension compares a row byte for byte before it will let anyone click it, and the
 * Gateway applies a decision outside the record's own allowed set as a silent denial.
 * These tests pin the properties that keep both promises: the scopes come from the host's
 * own derivation, nothing that looks like a secret reaches the panel, and a row is built
 * only for the conversation that owns it.
 */
const NOW = 1_800_000_000_000;
const SESSION_KEY = "agent:main:page-assist:direct:11111111-1111-4111-8111-111111111111";
const SECRET_VALUE = "fixtureValue1234567890";

function execEntry(
  request: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): PageAssistApprovalEntry {
  return {
    kind: "exec",
    id: "approval-exec-1",
    createdAtMs: NOW - 60_000,
    expiresAtMs: NOW + 1_740_000,
    request: {
      sessionKey: SESSION_KEY,
      agentId: "main",
      command: "git push origin main",
      ask: "on-miss",
      ...request,
    },
    ...overrides,
  };
}

function pluginEntry(
  request: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): PageAssistApprovalEntry {
  return {
    kind: "plugin",
    id: "approval-plugin-1",
    createdAtMs: NOW - 30_000,
    expiresAtMs: NOW + 90_000,
    request: {
      sessionKey: SESSION_KEY,
      agentId: "main",
      title: "Send the page to the recorder",
      description: "Posts the article text to https://example.test/recorder",
      toolName: "page_recorder.send",
      ...request,
    },
    ...overrides,
  };
}

/** Runs the projection and hands back whatever it threw, so the sentences can be read. */
function capture<T>(run: () => T): T | unknown {
  try {
    return run();
  } catch (error) {
    return error;
  }
}

/** Builds a row for the default conversation, since every caller needs the same four keys. */
function rowOf(
  entry: PageAssistApprovalEntry,
  overrides: Record<string, unknown> = {},
): ReturnType<typeof buildApprovalDto> {
  return buildApprovalDto({
    entry,
    conversationId: "conversation-1",
    requestId: "request-1",
    fallbackAgentId: "main",
    nowMs: NOW,
    ...overrides,
  });
}

test("exec scopes come from the policy the Gateway recorded the request with", () => {
  // A record with no policy knobs is the host's default set, so both approve buttons show.
  assert.deepEqual(resolveApprovalAllowedDecisions(execEntry()), [
    "allow-once",
    "allow-always",
    "deny",
  ]);
  assert.deepEqual(buildApprovalScopes(resolveApprovalAllowedDecisions(execEntry())), [
    APPROVAL_SCOPE_PRESENTATION.exact,
    APPROVAL_SCOPE_PRESENTATION.similar,
  ]);

  // `ask: "always"` is the floor that has no generalized answer, and the Gateway would
  // apply an out-of-set decision as a denial instead of refusing it.
  const gated = execEntry({ ask: "always" });
  assert.deepEqual(resolveApprovalAllowedDecisions(gated), ["allow-once", "deny"]);
  assert.deepEqual(buildApprovalScopes(resolveApprovalAllowedDecisions(gated)), [
    APPROVAL_SCOPE_PRESENTATION.exact,
  ]);

  // The unavailable list is how the host says the same thing when the grant writer is off.
  const marked = execEntry({ unavailableDecisions: ["allow-always"] });
  assert.deepEqual(resolveApprovalAllowedDecisions(marked), ["allow-once", "deny"]);

  // The payload's own `allowedDecisions` is ignored for exec: the persisted record is the
  // policy, and a caller cannot widen it by restating the field.
  const widened = execEntry({
    ask: "always",
    allowedDecisions: ["allow-once", "allow-always", "deny"],
  });
  assert.deepEqual(resolveApprovalAllowedDecisions(widened), ["allow-once", "deny"]);

  // Denial is never missing, so every row stays decidable even on a malformed record.
  const malformed = execEntry({ ask: 42, unavailableDecisions: "nope" });
  assert.deepEqual(resolveApprovalAllowedDecisions(malformed), [
    "allow-once",
    "allow-always",
    "deny",
  ]);
});

test("plugin scopes come from the plugin's own list, with deny always appended", () => {
  assert.deepEqual(resolveApprovalAllowedDecisions(pluginEntry()), [
    "allow-once",
    "allow-always",
    "deny",
  ]);
  const oneShot = pluginEntry({ allowedDecisions: ["allow-once"] });
  assert.deepEqual(resolveApprovalAllowedDecisions(oneShot), ["allow-once", "deny"]);
  // Repeated and unknown entries are dropped the way the host's resolver drops them.
  const noisy = pluginEntry({
    allowedDecisions: ["allow-always", "allow-always", "always-yes", "deny"],
  });
  assert.deepEqual(resolveApprovalAllowedDecisions(noisy), ["allow-always", "deny"]);
  // A list that leaves nothing nameable is not a list, so the default set applies.
  const junk = pluginEntry({ allowedDecisions: ["nope"] });
  assert.deepEqual(resolveApprovalAllowedDecisions(junk), [
    "allow-once",
    "allow-always",
    "deny",
  ]);
  // A deny-only record advertises no approve button at all, and stays rejectable.
  const denyOnly = pluginEntry({ allowedDecisions: ["deny"] });
  assert.deepEqual(buildApprovalScopes(resolveApprovalAllowedDecisions(denyOnly)), []);
});

test("a browser decision maps onto the host's words", () => {
  assert.deepEqual(resolveApprovalDecision(execEntry(), { decisionId: "d", approved: false }), {
    decision: "deny",
    approvalKind: "exec",
  });
  assert.deepEqual(
    resolveApprovalDecision(execEntry(), { decisionId: "d", approved: true, scope: "exact" }),
    { decision: "allow-once", approvalKind: "exec", scope: "exact" },
  );
  assert.deepEqual(
    resolveApprovalDecision(execEntry(), { decisionId: "d", approved: true, scope: "similar" }),
    { decision: "allow-always", approvalKind: "exec", scope: "similar" },
  );
  // A missing scope is the reference channel's one-off default, echoed back as such.
  assert.deepEqual(resolveApprovalDecision(execEntry(), { decisionId: "d", approved: true }), {
    decision: "allow-once",
    approvalKind: "exec",
    scope: "exact",
  });

  // A denial that ignores the record's limits is still a denial: the host always takes it.
  const gated = execEntry({ ask: "always" });
  assert.deepEqual(resolveApprovalDecision(gated, { decisionId: "d", approved: false }), {
    decision: "deny",
    approvalKind: "exec",
  });

  const noGeneralize = capture(() =>
    resolveApprovalDecision(gated, { decisionId: "d", approved: true, scope: "similar" }),
  );
  assert.ok(noGeneralize instanceof RangeError);
  assert.equal(noGeneralize.message, "This approval has no generalized scope");

  const noOneOff = capture(() =>
    resolveApprovalDecision(pluginEntry({ allowedDecisions: ["allow-always", "deny"] }), {
      decisionId: "d",
      approved: true,
      scope: "exact",
    }),
  );
  assert.ok(noOneOff instanceof RangeError);
  assert.equal(noOneOff.message, "This approval has no one-off scope");

  // A plugin row keeps its own kind, which is what the resolve call sends back.
  assert.deepEqual(
    resolveApprovalDecision(pluginEntry(), { decisionId: "d", approved: true, scope: "similar" }),
    { decision: "allow-always", approvalKind: "plugin", scope: "similar" },
  );
});

test("a row carries the reference channel's fields", () => {
  const row = rowOf(execEntry({ warningText: "This reaches outside the workspace" }));
  assert.deepEqual(row, {
    id: "approval-exec-1",
    conversationId: "conversation-1",
    agentId: "main",
    requestId: "request-1",
    tool: "exec",
    target: "git push origin main",
    risk: "This reaches outside the workspace",
    expiresAt: new Date(NOW + 1_740_000).toISOString(),
    actionable: true,
    scopes: [APPROVAL_SCOPE_PRESENTATION.exact, APPROVAL_SCOPE_PRESENTATION.similar],
  });

  const pluginRow = rowOf(pluginEntry({ severity: "critical" }));
  assert.equal(pluginRow?.tool, "Send the page to the recorder");
  assert.equal(pluginRow?.target, "Posts the article text to https://example.test/recorder");
  assert.equal(pluginRow?.risk, "Severity critical");
  // An unrecognized severity reads as the host's default rather than as no risk at all.
  assert.equal(rowOf(pluginEntry({ severity: "apocalyptic" }))?.risk, "Severity warning");
  // With no analysis at all the row still says why it is here, never an empty risk.
  assert.equal(
    rowOf(execEntry({ command: "ls", ask: undefined, warningText: undefined }))?.risk,
    "Native policy requires approval before this command runs",
  );
});

test("classified risk kinds are shown when the analyzer wrote no prose", () => {
  const row = rowOf(execEntry({ commandAnalysis: { riskKinds: ["network", "delete"] } }));
  assert.equal(row?.risk, "Risk: network, delete");
  // Junk entries are dropped, and a list of only junk falls back to the neutral sentence.
  assert.equal(
    rowOf(execEntry({ command: "ls", commandAnalysis: { riskKinds: [7, null] } }))?.risk,
    "Native policy requires approval before this command runs",
  );
});

test("a row is dropped only when the browser could not act on it", () => {
  // No live run means no `requestId` the extension can validate, and nothing to answer.
  assert.equal(rowOf(execEntry(), { requestId: "" }), null);
  // Past its expiry the row is still shown, marked unactionable, exactly as the reference
  // channel does: a panel that quietly hides a row looks like an agent that stopped.
  const expired = rowOf(execEntry({}, { expiresAtMs: NOW - 1 }));
  assert.equal(expired?.actionable, false);
  assert.equal(expired?.expiresAt, new Date(NOW - 1).toISOString());
});

test("the row names the record's agent, and this endpoint's when it cannot", () => {
  assert.equal(approvalAgentId(execEntry({ agentId: "research" })), "research");
  assert.equal(approvalAgentId(execEntry({ agentId: "   " })), null);
  // Anything past the extension's identifier rule is not shown at all, because one
  // over-long id would fail validation for the whole response.
  assert.equal(approvalAgentId(execEntry({ agentId: "x".repeat(600) })), null);
  assert.equal(rowOf(execEntry({ agentId: undefined }))?.agentId, "main");
  assert.equal(rowOf(execEntry({ agentId: undefined }), { fallbackAgentId: "" }), null);
});

test("ownership is read off the host session key", () => {
  assert.equal(approvalSessionKey(execEntry()), SESSION_KEY);
  assert.equal(approvalSessionKey(execEntry({ sessionKey: "  " })), null);
  assert.equal(approvalSessionKey(execEntry({ sessionKey: 7 })), null);
});

test("nothing that looks like a secret reaches the panel", () => {
  const row = rowOf(execEntry({ command: `aws s3 cp --token ${SECRET_VALUE} ./file.txt` }));
  assert.ok(row);
  assert.ok(!row.target.includes(SECRET_VALUE), row.target);
  // The flag stays visible, so the user still recognizes the command being gated.
  assert.ok(row.target.includes("--token"), row.target);

  const pluginRow = rowOf(pluginEntry({ description: `curl --token ${SECRET_VALUE}` }));
  assert.ok(pluginRow);
  assert.ok(!pluginRow.target.includes(SECRET_VALUE), pluginRow.target);
});

test("text whose safety cannot be proven is suppressed instead of guessed", () => {
  // A zero-width space inside the flag: removing it exposes a secret the raw view hid, so
  // the whole field is withheld rather than rendered in whichever view happened to be safe.
  const bypass = pluginEntry({ description: `curl --to\u200Bken ${SECRET_VALUE}` });
  const suppressed = rowOf(bypass);
  assert.ok(suppressed);
  assert.match(suppressed.target, /suppressed by display safety policy/);
  assert.ok(!suppressed.target.includes(SECRET_VALUE));

  // A harmless invisible is escaped where it sits, so the layout stays readable.
  assert.equal(rowOf(pluginEntry({ description: "echo\u200B done" }))?.target, "echo\\u{200B} done");
  // A line break inside warning prose survives, because the panel renders real lines.
  assert.equal(
    rowOf(execEntry({ warningText: "first line\u200B\r\nsecond line" }))?.risk,
    "first line\\u{200B}\nsecond line",
  );

  // The target ceiling is a code-point cut, so a row never splits a surrogate pair.
  const capped = rowOf(pluginEntry({ description: "a\u{1F600}".repeat(1500) }));
  assert.ok(capped);
  assert.equal(Array.from(capped.target).length, APPROVAL_TARGET_MAX_CHARS);
  assert.equal(capped.target, "a\u{1F600}".repeat(1000));
});

test("a plugin record with no description still shows what it is asking about", () => {
  assert.equal(rowOf(pluginEntry({ description: undefined }))?.target, "page_recorder.send");
  assert.equal(rowOf(pluginEntry({ description: "  ", toolName: undefined }))?.target, "Plugin action");
  // An exec record with nothing to display is named plainly, not blamed on the policy.
  assert.equal(
    rowOf(execEntry({ command: undefined, host: undefined }))?.target,
    "[the approval record carries no command text]",
  );
});

test("list rows the host cannot name are skipped, not fatal", () => {
  const entries = normalizeApprovalListResponse(
    [
      execEntry(),
      { id: "no-request", createdAtMs: NOW, expiresAtMs: NOW },
      { id: "", request: {}, createdAtMs: NOW, expiresAtMs: NOW },
      { id: "no-times", request: {}, createdAtMs: "now", expiresAtMs: NOW },
      { id: "x".repeat(600), request: {}, createdAtMs: NOW, expiresAtMs: NOW },
      "not-an-object",
      null,
    ],
    "exec",
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.id, "approval-exec-1");
  assert.equal(entries[0]?.kind, "exec");
  assert.deepEqual(entries[0]?.createdAtMs, NOW - 60_000);

  // The method's kind is the fallback, and a row may restate it.
  const restated = normalizeApprovalListResponse(
    [{ id: "a", request: {}, createdAtMs: NOW, expiresAtMs: NOW, approvalKind: "plugin" }],
    "exec",
  );
  assert.equal(restated[0]?.kind, "plugin");
  // The payload is the array itself, so an envelope object is simply not a list.
  assert.deepEqual(normalizeApprovalListResponse({ approvals: [] }, "exec"), []);
  assert.deepEqual(normalizeApprovalListResponse(undefined, "plugin"), []);
});

test("the decision ledger replays an answer and forgets the oldest", () => {
  const store = new PageAssistStore();
  const payload = { decisionId: "d-1", approved: true, scope: "exact" } as const;
  const response = {
    approvalId: "approval-exec-1",
    decisionId: "d-1",
    approved: true,
    status: "confirmed",
    scope: "exact",
  } as const;
  assert.equal(store.confirmedApprovalDecision("approval-exec-1"), undefined);

  store.recordApprovalDecision("approval-exec-1", { payload, response });
  assert.deepEqual(store.confirmedApprovalDecision("approval-exec-1")?.response, response);

  // Only the identical answer is the same decision: a fresh decisionId, or a scope the
  // browser did not send the first time, is a second answer and the route refuses it.
  assert.equal(isSameApprovalDecision(payload, { decisionId: "d-1", approved: true, scope: "exact" }), true);
  assert.equal(isSameApprovalDecision(payload, { decisionId: "d-2", approved: true, scope: "exact" }), false);
  assert.equal(isSameApprovalDecision(payload, { decisionId: "d-1", approved: true }), false);
  assert.equal(isSameApprovalDecision(payload, { decisionId: "d-1", approved: false, scope: "exact" }), false);

  // The cap drops the oldest confirmed answer, which then gets its answer from the host.
  for (let index = 0; index < 300; index += 1) {
    store.recordApprovalDecision(`approval-${index}`, {
      payload: { decisionId: `d-${index}`, approved: false },
      response: {
        approvalId: `approval-${index}`,
        decisionId: `d-${index}`,
        approved: false,
        status: "confirmed",
      },
    });
  }
  assert.equal(store.confirmedDecisionCount, 200);
  assert.equal(store.confirmedApprovalDecision("approval-exec-1"), undefined);
  assert.ok(store.confirmedApprovalDecision("approval-299"));
});

test("a session key finds one conversation, and never an ambiguous one", () => {
  const store = new PageAssistStore();
  const conversation = store.createConversation("main", "main");
  conversation.sessionKey = SESSION_KEY;
  assert.equal(store.conversationForSessionKey(SESSION_KEY), conversation);
  assert.equal(store.conversationForSessionKey("agent:main:page-assist:direct:other"), undefined);

  // Two conversations on one bound session: the endpoint cannot tell which browser is
  // being asked to approve the command, so it shows the row to neither.
  const twin = store.createConversation("main", "main");
  twin.sessionKey = SESSION_KEY;
  assert.equal(store.conversationForSessionKey(SESSION_KEY), undefined);
});

test("approval waits move in both directions from one read", () => {
  const store = new PageAssistStore();
  const waiting = store.createConversation("main", "main");
  const idle = store.createConversation("main", "main");
  const { record } = store.submit(waiting, { requestId: "req-wait", text: "run a command" });
  store.setState(record, "running");
  const { record: finished } = store.submit(idle, { requestId: "req-idle", text: "hello" });
  store.setState(finished, "running");
  store.settle(finished, "completed");

  store.syncApprovalWaits(new Set([waiting.id]));
  assert.equal(record.state, "waiting_approval");
  // A settled request has nothing to wait on and is never rewound.
  assert.equal(finished.state, "completed");

  // The same read with nothing pending rewinds it: the host owns when a gate appears and
  // disappears, and this endpoint only learns about either when it asks.
  store.syncApprovalWaits(new Set());
  assert.equal(record.state, "running");
  store.settle(record, "completed");

  // An accepted request never entered the running phase, so it cannot be waiting either.
  const { record: accepted } = store.submit(waiting, { requestId: "req-next", text: "again" });
  store.syncApprovalWaits(new Set([waiting.id]));
  assert.equal(accepted.state, "accepted");

  store.setState(accepted, "waiting_approval");
  store.resumeApprovalWait(waiting);
  assert.equal(accepted.state, "running");
  // A decision for another conversation leaves this one alone.
  store.setState(accepted, "waiting_approval");
  store.resumeApprovalWait(idle);
  assert.equal(accepted.state, "waiting_approval");
});

test("a settled request is not rewound by a decision or a poll", () => {
  const store = new PageAssistStore();
  const conversation = store.createConversation("main", "main");
  const { record } = store.submit(conversation, { requestId: "req-stop", text: "hello" });
  store.setState(record, "waiting_approval");
  store.settle(record, "cancelled");
  // The active lock is released, so there is nothing left to resume.
  store.resumeApprovalWait(conversation);
  store.syncApprovalWaits(new Set([conversation.id]));
  assert.equal(record.state, "cancelled");

  // `unknown` keeps the conversation locked but is not a running phase either.
  const other = store.createConversation("main", "main");
  const { record: uncertain } = store.submit(other, { requestId: "req-unknown", text: "hello" });
  store.setState(uncertain, "running");
  store.settle(uncertain, "unknown");
  store.syncApprovalWaits(new Set([other.id]));
  assert.equal(uncertain.state, "unknown");
});

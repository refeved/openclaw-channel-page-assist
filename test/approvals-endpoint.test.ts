import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, beforeEach, test } from "node:test";
// Behavioural tests run against the build output: the sources use the `.js`
// specifiers that emitted ESM requires, and Node's type stripping does not map
// them back to `.ts`. `npm test` builds first, so these are the shipped modules.
import { HttpError } from "../dist/src/http/respond.js";
import { createPageAssistRequestHandler } from "../dist/src/http/router.js";
import { pageAssistRoutes } from "../dist/src/http/routes/index.js";
import { PageAssistStore } from "../dist/src/store.js";
import { APPROVAL_SCOPE_PRESENTATION } from "../src/protocol.ts";

/**
 * The approval routes over a real socket, with the Gateway side stubbed.
 *
 * What these tests own is the endpoint's own behaviour: which rows the browser is shown,
 * which sentences come back, when a decision is refused before it can reach the host, and
 * how the request state follows the pending list. Whether the operator client speaks
 * `exec.approval.list` correctly is a host question, and the real-Gateway run covers it.
 */
const TOKEN = "0123456789abcdefghijklmnopqrstuvwxyz";
const PRINCIPAL = "scope-under-test";
const SESSION_PREFIX = "agent:main:page-assist:direct:";
const DECISION_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_DECISION_ID = "33333333-3333-4333-8333-333333333333";
/** A deadline far enough out to stay in the future for the whole run of the suite. */
const HORIZON = Date.parse("2100-01-01T00:00:00.000Z");

/** Scripted stand-in for the operator-approvals bridge. */
const bridge = {
  entries: [] as Record<string, unknown>[],
  /** Thrown from `listPending` to exercise the failure policy. */
  listError: undefined as unknown,
  /** Thrown from `resolve` to exercise the failure policy. */
  resolveError: undefined as unknown,
  /** Returned from `resolve`, so `applied: false` is testable. */
  resolveResult: { applied: true, approval: {} } as Record<string, unknown>,
  resolveCalls: [] as Record<string, unknown>[],
  async listPending(): Promise<Record<string, unknown>[]> {
    if (this.listError) {
      throw this.listError;
    }
    return [...this.entries];
  },
  async resolve(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.resolveCalls.push(params);
    if (this.resolveError) {
      throw this.resolveError;
    }
    return this.resolveResult;
  },
  async close(): Promise<void> {},
};

const store = new PageAssistStore();
const scope = {
  account: {
    accountId: "default",
    enabled: true,
    configured: true,
    agentId: "main",
    principalScope: PRINCIPAL,
    browserToken: TOKEN,
    httpHost: "127.0.0.1",
    httpPort: 0,
    allowFrom: [],
    config: {},
  },
  instanceId: "instance-under-test",
  principalScope: PRINCIPAL,
  resolveAgentName: () => "Main Agent",
  store,
  approvals: bridge,
  isStopping: () => false,
};

const handle = createPageAssistRequestHandler(scope, pageAssistRoutes);
const server = createServer((req, res) => {
  void handle(req, res);
});
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve());
});
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

after(() => {
  // Keep-alive sockets from the client would otherwise hold the listener open and
  // leave the test process running after the assertions finish.
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  bridge.entries = [];
  bridge.listError = undefined;
  bridge.resolveError = undefined;
  bridge.resolveResult = { applied: true, approval: {} };
  bridge.resolveCalls = [];
});

async function call(
  path: string,
  init: { method?: string; token?: string | null; body?: unknown } = {},
): Promise<{ status: number; text: string; json?: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  // `token: null` sends no authorization header at all, which is the unauthenticated
  // case; a wrong token is a different one and stays covered by the endpoint tests.
  if (init.token !== null) {
    headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  }
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(base + path, {
    method: init.method ?? "GET",
    headers,
    body,
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: text.startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : undefined,
  };
}

/**
 * One browser conversation with a run in flight, which is the only shape an approval can
 * belong to: the row needs a live request id, and the reverse lookup needs the host session
 * key the turn records when it routes the message. No turn machinery runs here, so the key
 * is written the way `runPageAssistRequest` writes it.
 */
function startRun(label: string): { conversationId: string; requestId: string; sessionKey: string } {
  const requestId = `req-${label}`;
  const conversation = store.createConversation("main", "main");
  const sessionKey = `${SESSION_PREFIX}${conversation.id}`;
  conversation.sessionKey = sessionKey;
  const { record } = store.submit(conversation, { requestId, text: `run something for ${label}` });
  store.setState(record, "running");
  return { conversationId: conversation.id, requestId, sessionKey };
}

function pendingEntry(sessionKey: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    kind: "exec",
    id: `approval-${sessionKey.slice(-8)}`,
    createdAtMs: now - 5_000,
    expiresAtMs: HORIZON,
    request: {
      sessionKey,
      agentId: "main",
      command: "rm -rf ./build",
      ask: "on-miss",
    },
    ...overrides,
  };
}

async function stateOf(requestId: string): Promise<unknown> {
  const snapshot = await call(`/api/page-assist/requests/${requestId}`);
  assert.equal(snapshot.status, 200);
  return snapshot.json?.state;
}

test("the panel is shown only the rows this browser owns", async () => {
  const own = startRun("own");
  const foreign = startRun("foreign");
  bridge.entries = [
    pendingEntry(own.sessionKey, { id: "approval-own" }),
    // Another channel's session, and a record that names no session at all.
    pendingEntry(`${SESSION_PREFIX}${foreign.conversationId}-elsewhere`, { id: "approval-other-channel" }),
    pendingEntry("", { id: "approval-anonymous" }),
  ];

  const listed = await call("/api/page-assist/approvals");
  assert.equal(listed.status, 200);
  const rows = listed.json?.approvals as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: "approval-own",
    conversationId: own.conversationId,
    agentId: "main",
    requestId: own.requestId,
    tool: "exec",
    target: "rm -rf ./build",
    risk: "Native policy requires approval before this command runs",
    expiresAt: new Date(HORIZON).toISOString(),
    actionable: true,
    scopes: [APPROVAL_SCOPE_PRESENTATION.exact, APPROVAL_SCOPE_PRESENTATION.similar],
  });

  // The poll is also how the endpoint learns its run is gated.
  assert.equal(await stateOf(own.requestId), "waiting_approval");
  assert.equal(await stateOf(foreign.requestId), "running");

  // And the next poll is how it learns the gate is gone.
  bridge.entries = [];
  const emptied = await call("/api/page-assist/approvals");
  assert.deepEqual(emptied.json?.approvals, []);
  assert.equal(await stateOf(own.requestId), "running");
});

test("a confirmed decision is echoed, replayed, and never repeated to the host", async () => {
  const run = startRun("decide");
  bridge.entries = [pendingEntry(run.sessionKey, { id: "approval-decide" })];
  const body = { decisionId: DECISION_ID, approved: true, scope: "exact" };

  const decided = await call("/api/page-assist/approvals/approval-decide/decision", {
    method: "POST",
    body,
  });
  assert.equal(decided.status, 200);
  assert.deepEqual(decided.json, {
    approvalId: "approval-decide",
    decisionId: DECISION_ID,
    approved: true,
    status: "confirmed",
    scope: "exact",
  });
  assert.deepEqual(bridge.resolveCalls, [
    { approvalId: "approval-decide", decision: "allow-once", approvalKind: "exec" },
  ]);
  // The answer is in, so the panel stops claiming the run is waiting before the next poll.
  assert.equal(await stateOf(run.requestId), "running");

  const replay = await call("/api/page-assist/approvals/approval-decide/decision", {
    method: "POST",
    body,
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json, decided.json);
  assert.equal(bridge.resolveCalls.length, 1);

  // A second answer for the same approval is refused, whatever it claims.
  const changed = await call("/api/page-assist/approvals/approval-decide/decision", {
    method: "POST",
    body: { decisionId: OTHER_DECISION_ID, approved: false },
  });
  assert.equal(changed.status, 409);
  assert.equal(changed.text, "A different decision was already confirmed");
  assert.equal(bridge.resolveCalls.length, 1);
});

test("a denial carries no scope", async () => {
  const run = startRun("deny");
  // `ask: "always"` leaves no generalized answer, so only the reject control is offered.
  bridge.entries = [
    pendingEntry(run.sessionKey, {
      id: "approval-deny",
      request: { sessionKey: run.sessionKey, command: "rm -rf ./build", ask: "always" },
    }),
  ];

  const listed = await call("/api/page-assist/approvals");
  const rows = listed.json?.approvals as Record<string, unknown>[];
  assert.deepEqual(rows[0]?.scopes, [APPROVAL_SCOPE_PRESENTATION.exact]);

  const denied = await call("/api/page-assist/approvals/approval-deny/decision", {
    method: "POST",
    body: { decisionId: DECISION_ID, approved: false },
  });
  assert.equal(denied.status, 200);
  assert.deepEqual(denied.json, {
    approvalId: "approval-deny",
    decisionId: DECISION_ID,
    approved: false,
    status: "confirmed",
  });
  assert.deepEqual(bridge.resolveCalls, [
    { approvalId: "approval-deny", decision: "deny", approvalKind: "exec" },
  ]);
});

test("a scope the record does not offer is refused before it reaches the host", async () => {
  const run = startRun("scope");
  bridge.entries = [
    pendingEntry(run.sessionKey, {
      id: "approval-scope",
      request: { sessionKey: run.sessionKey, command: "rm -rf ./build", ask: "always" },
    }),
  ];

  // The poll is what marks the run as gated, and a refused decision must not clear it:
  // the approval is still pending, so the panel has to keep showing it as waiting.
  await call("/api/page-assist/approvals");
  assert.equal(await stateOf(run.requestId), "waiting_approval");

  const generalized = await call("/api/page-assist/approvals/approval-scope/decision", {
    method: "POST",
    body: { decisionId: DECISION_ID, approved: true, scope: "similar" },
  });
  assert.equal(generalized.status, 400);
  assert.equal(generalized.text, "This approval has no generalized scope");
  // The Gateway would have applied it as a silent denial, so nothing may be sent at all.
  assert.deepEqual(bridge.resolveCalls, []);
  assert.equal(await stateOf(run.requestId), "waiting_approval");
});

test("an approval the browser cannot act on is not decided", async () => {
  const run = startRun("miss");
  const foreign = pendingEntry(`${SESSION_PREFIX}someone-else`, { id: "approval-foreign" });
  bridge.entries = [foreign];

  const unknown = await call("/api/page-assist/approvals/approval-never-listed/decision", {
    method: "POST",
    body: { decisionId: DECISION_ID, approved: true, scope: "exact" },
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.text, "Approval is no longer pending");

  const notOurs = await call("/api/page-assist/approvals/approval-foreign/decision", {
    method: "POST",
    body: { decisionId: DECISION_ID, approved: true, scope: "exact" },
  });
  assert.equal(notOurs.status, 404);
  assert.equal(notOurs.text, "Approval does not belong to this browser channel");
  assert.deepEqual(bridge.resolveCalls, []);

  const expired = pendingEntry(run.sessionKey, {
    id: "approval-expired",
    expiresAtMs: Date.now() - 1,
  });
  bridge.entries = [expired];
  const late = await call("/api/page-assist/approvals/approval-expired/decision", {
    method: "POST",
    body: { decisionId: DECISION_ID, approved: true, scope: "exact" },
  });
  assert.equal(late.status, 409);
  assert.equal(late.text, "Approval already resolved or expired");
  assert.deepEqual(bridge.resolveCalls, []);

  const malformed = await call("/api/page-assist/approvals/approval-expired/decision", {
    method: "POST",
    body: { decisionId: "not-a-uuid", approved: true },
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.text, "Invalid browser request payload");
  // None of these answers reached the host, so none of them is in the ledger either: a
  // retry must be asked again rather than replay a decision that was never made.
  assert.equal(store.confirmedApprovalDecision("approval-never-listed"), undefined);
  assert.equal(store.confirmedApprovalDecision("approval-foreign"), undefined);
  assert.equal(store.confirmedApprovalDecision("approval-expired"), undefined);
});

test("the host's own answer outranks this endpoint's", async () => {
  const run = startRun("applied");
  bridge.entries = [pendingEntry(run.sessionKey, { id: "approval-applied" })];
  // Control UI answered it first: the record is still listed, and the resolve is a no-op.
  bridge.resolveResult = { applied: false, approval: {} };

  const decided = await call("/api/page-assist/approvals/approval-applied/decision", {
    method: "POST",
    body: { decisionId: DECISION_ID, approved: true, scope: "exact" },
  });
  assert.equal(decided.status, 409);
  assert.equal(decided.text, "Approval already resolved or expired");
  // Nothing was confirmed, so a later retry asks the host again instead of replaying.
  bridge.resolveResult = { applied: true, approval: {} };
  const retried = await call("/api/page-assist/approvals/approval-applied/decision", {
    method: "POST",
    body: { decisionId: DECISION_ID, approved: true, scope: "exact" },
  });
  assert.equal(retried.status, 200);
  assert.equal(bridge.resolveCalls.length, 2);
});

test("a broken bridge answers 503, never an empty list", async () => {
  const run = startRun("broken");
  bridge.entries = [pendingEntry(run.sessionKey, { id: "approval-broken" })];
  await call("/api/page-assist/approvals");
  assert.equal(await stateOf(run.requestId), "waiting_approval");

  bridge.listError = new HttpError(503, "Approval service unavailable; retry shortly");
  const failed = await call("/api/page-assist/approvals");
  assert.equal(failed.status, 503);
  assert.equal(failed.text, "Approval service unavailable; retry shortly");
  // A read that failed is not evidence that the approval went away, so the state holds.
  assert.equal(await stateOf(run.requestId), "waiting_approval");

  // A decision starts from the same read, so a bridge that cannot list cannot decide
  // either: answering a decision from memory would send an id the host has no record of.
  const unreadable = await call("/api/page-assist/approvals/approval-broken/decision", {
    method: "POST",
    body: { decisionId: DECISION_ID, approved: true, scope: "exact" },
  });
  assert.equal(unreadable.status, 503);
  assert.deepEqual(bridge.resolveCalls, []);

  bridge.listError = undefined;
  bridge.resolveError = new HttpError(403, "Approval caller does not own this request");
  const refused = await call("/api/page-assist/approvals/approval-broken/decision", {
    method: "POST",
    body: { decisionId: DECISION_ID, approved: true, scope: "exact" },
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.text, "Approval caller does not own this request");
  // An answer that never landed is not recorded, so the retry goes to the host again.
  assert.equal(store.confirmedApprovalDecision("approval-broken"), undefined);

  const anonymous = await call("/api/page-assist/approvals", { token: null });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.text, "Invalid Page Assist browser token");
});

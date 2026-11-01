import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
// Behavioural tests run against the build output: the sources use the `.js`
// specifiers that emitted ESM requires, and Node's type stripping does not map
// them back to `.ts`. `npm test` builds first, so these are the shipped modules.
import { createPageAssistRequestHandler } from "../dist/src/http/router.js";
import { pageAssistRoutes } from "../dist/src/http/routes/index.js";
import { PageAssistStore } from "../dist/src/store.js";

/**
 * The whole endpoint, driven over a real socket.
 *
 * No Gateway is involved: with no channel runtime registered, a submitted request
 * settles as `failed` with the host-failure notice in the transcript, which is
 * exactly the shape the browser has to handle on a broken deployment. What these
 * tests pin down is the wire — status codes, the sentences behind them, the
 * transcript rows, and the event frames.
 */
const TOKEN = "0123456789abcdefghijklmnopqrstuvwxyz";
const PRINCIPAL = "scope-under-test";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const STREAM_REQUEST_ID = "66666666-6666-4666-8666-666666666666";
const STOP_REQUEST_ID = "77777777-7777-4777-8777-777777777777";

let stopping = false;
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
  isStopping: () => stopping,
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

type Call = {
  status: number;
  contentType: string | null;
  cacheControl: string | null;
  text: string;
  json?: Record<string, unknown>;
};

async function call(
  path: string,
  init: { method?: string; token?: string | null; body?: unknown; rawBody?: string } = {},
): Promise<Call> {
  const headers: Record<string, string> = {};
  if (init.token !== null) {
    headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  }
  const body = init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
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
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    text,
    json: text.startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : undefined,
  };
}

/** Yields the JSON payload of every `data:` frame, ignoring `: waiting` comments. */
async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) {
          break;
        }
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (chunk.startsWith("data: ")) {
          yield JSON.parse(chunk.slice(6)) as Record<string, unknown>;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Waits for the detached turn to settle; the response is a 202, so the run is async. */
async function awaitTerminalState(requestId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const snapshot = await call(`/api/page-assist/requests/${requestId}`);
    assert.equal(snapshot.status, 200);
    const state = snapshot.json?.state;
    if (state !== "accepted" && state !== "running") {
      return snapshot.json ?? {};
    }
    if (Date.now() > deadline) {
      assert.fail(`request ${requestId} never left ${String(state)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("the token gates every route and answers in plain text", async () => {
  const anonymous = await call("/api/page-assist/capabilities", { token: null });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.text, "Invalid Page Assist browser token");
  assert.match(anonymous.contentType ?? "", /^text\/plain/);

  const wrong = await call("/api/page-assist/capabilities", { token: `${TOKEN}x` });
  assert.equal(wrong.status, 401);

  const ok = await call("/api/page-assist/capabilities");
  assert.equal(ok.status, 200);
  assert.equal(ok.cacheControl, "no-store");
  assert.equal(ok.json?.instanceId, "instance-under-test");
  assert.equal(ok.json?.principalScope, PRINCIPAL);
});

test("unknown paths and methods keep the contract's codes", async () => {
  const unknown = await call("/api/page-assist/nope");
  assert.equal(unknown.status, 404);
  assert.match(unknown.text, /^Unknown Page Assist path/);

  const wrongMethod = await call("/api/page-assist/agents", { method: "POST", body: {} });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.text, "Unsupported Page Assist method");

  const agents = await call("/api/page-assist/agents");
  assert.deepEqual(agents.json, { agents: [{ id: "main", name: "Main Agent" }] });
});

test("a conversation is created for the bound agent only", async () => {
  const wrongAgent = await call("/api/page-assist/conversations", {
    method: "POST",
    body: { agentId: "other" },
  });
  assert.equal(wrongAgent.status, 403);
  assert.equal(wrongAgent.text, "This channel is bound to another Agent");

  const malformed = await call("/api/page-assist/conversations", {
    method: "POST",
    rawBody: "{not json",
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.text, "Invalid browser request payload");

  const created = await call("/api/page-assist/conversations", {
    method: "POST",
    body: { agentId: "main" },
  });
  assert.equal(created.status, 200);
  assert.equal(typeof created.json?.conversationId, "string");
  assert.equal(created.json?.agentId, "main");
});

test("a message is accepted, run detached, and lands in history", async () => {
  const created = await call("/api/page-assist/conversations", {
    method: "POST",
    body: { agentId: "main" },
  });
  const conversationId = String(created.json?.conversationId);

  const submitted = await call(`/api/page-assist/conversations/${conversationId}/messages`, {
    method: "POST",
    body: { requestId: REQUEST_ID, text: "What does this page say?" },
  });
  assert.equal(submitted.status, 202);
  assert.equal(submitted.json?.requestId, REQUEST_ID);
  assert.equal(submitted.json?.conversationId, conversationId);
  assert.ok(["accepted", "running", "failed"].includes(String(submitted.json?.state)));

  // With no channel runtime the turn cannot run, and that must be visible as a
  // failed request plus a readable row instead of a request that hangs forever.
  const settled = await awaitTerminalState(REQUEST_ID);
  assert.equal(settled.state, "failed");

  const history = await call(`/api/page-assist/conversations/${conversationId}/messages`);
  assert.equal(history.status, 200);
  assert.equal(history.json?.conversationId, conversationId);
  assert.equal(history.json?.complete, true);
  const messages = history.json?.messages as Array<Record<string, unknown>>;
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "user");
  assert.equal(messages[0]?.content, "What does this page say?");
  assert.equal(messages[0]?.requestId, REQUEST_ID);
  assert.equal(messages[1]?.role, "assistant");
  assert.match(String(messages[1]?.content), /agent run failed/);

  // A replay of the same id and content answers with the original record, and does
  // not start a second run; anything else about that id is a conflict.
  const replay = await call(`/api/page-assist/conversations/${conversationId}/messages`, {
    method: "POST",
    body: { text: "What does this page say?", requestId: REQUEST_ID },
  });
  assert.equal(replay.status, 200);

  const hijacked = await call(`/api/page-assist/conversations/${conversationId}/messages`, {
    method: "POST",
    body: { requestId: REQUEST_ID, text: "different question" },
  });
  assert.equal(hijacked.status, 409);
  assert.equal(hijacked.text, "requestId already used with another payload");
});

test("payload and reference errors answer with the published sentences", async () => {
  const created = await call("/api/page-assist/conversations", {
    method: "POST",
    body: { agentId: "main" },
  });
  const conversationId = String(created.json?.conversationId);

  const badShape = await call(`/api/page-assist/conversations/${conversationId}/messages`, {
    method: "POST",
    body: { requestId: "req-1", text: "hi" },
  });
  assert.equal(badShape.status, 400);
  assert.equal(badShape.text, "Invalid browser request payload");

  const withAttachment = await call(`/api/page-assist/conversations/${conversationId}/messages`, {
    method: "POST",
    body: {
      requestId: OTHER_REQUEST_ID,
      text: "look at this",
      attachments: [{ attachmentId: "77777777-7777-4777-8777-777777777777" }],
    },
  });
  assert.equal(withAttachment.status, 400);
  assert.equal(withAttachment.text, "Attachment unavailable; upload it again");

  const missingConversation = await call("/api/page-assist/conversations/none/messages", {
    method: "POST",
    body: { requestId: REQUEST_ID, text: "hi" },
  });
  assert.equal(missingConversation.status, 404);
  assert.equal(
    missingConversation.text,
    "Conversation unavailable; create a new chat after channel restart",
  );

  const missingRequest = await call("/api/page-assist/requests/none");
  assert.equal(missingRequest.status, 404);
  assert.equal(missingRequest.text, "Request unavailable in this channel instance");
});

test("a busy conversation refuses a second run instead of queueing it", async () => {
  const created = await call("/api/page-assist/conversations", {
    method: "POST",
    body: { agentId: "main" },
  });
  const conversationId = String(created.json?.conversationId);
  const conversation = store.requireConversation(conversationId);
  store.submit(conversation, { requestId: "held", text: "already running" });

  const blocked = await call(`/api/page-assist/conversations/${conversationId}/messages`, {
    method: "POST",
    body: { requestId: OTHER_REQUEST_ID, text: "and then this" },
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.text, "Conversation is busy");
  store.settle(store.requireRequest("held"), "cancelled");
});

test(
  "the event stream reports state changes, replies, and the terminal frame",
  { timeout: 20000 },
  async () => {
    const conversation = store.createConversation("main", "main");
    const { record } = store.submit(conversation, {
      requestId: STREAM_REQUEST_ID,
      text: "stream me",
    });

    const response = await fetch(`${base}/api/page-assist/requests/${STREAM_REQUEST_ID}/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    const iterator = frames(response.body as ReadableStream<Uint8Array>);

    const first = await iterator.next();
    assert.deepEqual(first.value, {
      type: "request.state",
      state: "accepted",
      requestId: STREAM_REQUEST_ID,
    });

    store.setState(record, "running");
    const appended = store.appendAssistant(record, "the answer");
    store.settle(record, "completed");

    const rest: Array<Record<string, unknown>> = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      rest.push(next.value as Record<string, unknown>);
    }

    // One poll pass carries the whole tail: the new state, the reply, the close.
    assert.deepEqual(
      rest.map((event) => event.type),
      ["request.state", "message.snapshot", "request.terminal"],
    );
    assert.equal(rest[0]?.state, "completed");
    assert.equal(rest[1]?.content, "the answer");
    assert.equal(rest[1]?.messageId, appended?.id);
    assert.equal(rest[1]?.status, "complete");
    assert.deepEqual(rest[1]?.attachments, []);
    assert.equal(rest[2]?.state, "completed");
    for (const event of [first.value, ...rest]) {
      assert.equal(Object.keys(event as Record<string, unknown>).at(-1), "requestId");
    }
  },
);

// The host probe cannot reach this shape: a config hot reload defers until the
// running turn drains, so only an explicit account stop lands on top of a live
// request. The stop hook is what `beginStop` models here.
test("a stop cancels the run in flight and closes its open stream", async () => {
  const conversation = store.createConversation("main", "main");
  const { record } = store.submit(conversation, { requestId: STOP_REQUEST_ID, text: "hold on" });
  store.setState(record, "running");

  const response = await fetch(`${base}/api/page-assist/requests/${STOP_REQUEST_ID}/events`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.status, 200);
  const iterator = frames(response.body as ReadableStream<Uint8Array>);

  const first = await iterator.next();
  assert.deepEqual(first.value, {
    type: "request.state",
    state: "running",
    requestId: STOP_REQUEST_ID,
  });

  store.beginStop();

  const rest: Array<Record<string, unknown>> = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      break;
    }
    rest.push(next.value as Record<string, unknown>);
  }

  assert.deepEqual(
    rest.map((event) => `${String(event.type)}:${String(event.state)}`),
    ["request.state:cancelled", "request.terminal:cancelled"],
  );
  // The agent run has to be cut short, or the model keeps writing into a channel
  // that already reported the turn as cancelled.
  assert.equal(record.abort.signal.aborted, true);
  assert.equal(record.settled, true);
  assert.equal(conversation.active, undefined);
  for (const event of [first.value, ...rest]) {
    assert.equal(Object.keys(event as Record<string, unknown>).at(-1), "requestId");
  }

  // A reply that arrives after the cancellation stays out of the transcript.
  assert.equal(store.appendAssistant(record, "too late"), undefined);
  const history = await call(`/api/page-assist/conversations/${conversation.id}/messages`);
  const rows = history.json?.messages as Array<Record<string, unknown>>;
  assert.equal(rows.some((row) => row.content === "too late"), false);
});

test("the endpoint refuses new work while it is stopping", async () => {
  stopping = true;
  const drained = await call("/api/page-assist/capabilities");
  assert.equal(drained.status, 503);
  assert.equal(drained.text, "Channel is stopping");
  stopping = false;
});

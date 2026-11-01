import assert from "node:assert/strict";
import { test } from "node:test";
// Behavioural tests run against the build output: the sources use the `.js`
// specifiers that emitted ESM requires, and Node's type stripping does not map
// them back to `.ts`. `npm test` builds first, so these are the shipped modules.
import { HttpError } from "../dist/src/http/respond.js";
import { PageAssistStore, buildRequestDto } from "../dist/src/store.js";
import { MAX_CONVERSATIONS, MAX_PENDING_REQUESTS } from "../src/protocol.ts";

/**
 * The store holds the conversation the browser polls, so its guards are the ones
 * that keep two runs from interleaving into one transcript. The numbers and the
 * sentences are the QwenPaw channel's; a browser that reads a different error text
 * cannot tell a busy chat from a broken deployment.
 */
function makePayload(requestId: string, text = "question", extra = {}) {
  return { requestId, text, ...extra };
}

function statusOf(error: unknown): { status?: number; message: string } {
  assert.ok(error instanceof HttpError, `expected an HttpError, got ${String(error)}`);
  return { status: error.status, message: error.message };
}

test("a conversation is bound to the endpoint's agent", () => {
  const store = new PageAssistStore();
  assert.doesNotThrow(() => store.createConversation("main", "main"));
  const error = statusOf(capture(() => store.createConversation("other", "main")));
  assert.equal(error.status, 403);
  assert.equal(error.message, "This channel is bound to another Agent");
});

test("conversation and request ceilings answer 429", () => {
  const store = new PageAssistStore();
  for (let index = 0; index < MAX_CONVERSATIONS; index += 1) {
    store.createConversation("main", "main");
  }
  assert.equal(store.conversationCount, MAX_CONVERSATIONS);
  assert.equal(statusOf(capture(() => store.createConversation("main", "main"))).status, 429);

  const busyStore = new PageAssistStore();
  const conversation = busyStore.createConversation("main", "main");
  // One conversation may host many finished requests, so the counter is the request
  // map itself and not how many chats are open.
  for (let index = 0; index < MAX_PENDING_REQUESTS; index += 1) {
    const { record } = busyStore.submit(conversation, makePayload(`req-${index}`));
    busyStore.settle(record, "completed");
  }
  assert.equal(busyStore.requestCount, MAX_PENDING_REQUESTS);
  const overflow = capture(() => busyStore.submit(conversation, makePayload("req-overflow")));
  assert.equal(statusOf(overflow).status, 429);
  assert.match(statusOf(overflow).message, /restart to clear browser state/);
});

test("submit locks the conversation and records the user row", () => {
  const store = new PageAssistStore();
  const conversation = store.createConversation("main", "main");
  const { record, replay } = store.submit(conversation, makePayload("req-1", "What does this page say?"));

  assert.equal(replay, false);
  assert.equal(record.state, "accepted");
  assert.equal(conversation.active, "req-1");
  assert.deepEqual(conversation.messages, [
    {
      id: "req-1:user",
      requestId: "req-1",
      role: "user",
      content: "What does this page say?",
      attachments: [],
      status: "complete",
    },
  ]);
  assert.deepEqual(buildRequestDto(record), {
    requestId: "req-1",
    conversationId: conversation.id,
    state: "accepted",
  });

  // The lock is what makes a second submission a conflict instead of a second run.
  assert.equal(statusOf(capture(() => store.submit(conversation, makePayload("req-2")))).status, 409);
});

test("an id replay is idempotent and a reused id is not", () => {
  const store = new PageAssistStore();
  const conversation = store.createConversation("main", "main");
  const other = store.createConversation("main", "main");
  const first = store.submit(conversation, { requestId: "req-1", text: "same" });
  assert.equal(first.replay, false);

  // Key order on the wire must not be mistaken for a different payload.
  const replayed = store.submit(conversation, { requestId: "req-1", text: "same" });
  assert.equal(replayed.replay, true);
  assert.equal(replayed.record, first.record);

  assert.equal(
    statusOf(capture(() => store.submit(conversation, makePayload("req-1", "different")))).status,
    409,
  );
  assert.equal(statusOf(capture(() => store.submit(other, makePayload("req-1", "same")))).status, 409);
});

test("replies are dropped once the request settled", () => {
  const store = new PageAssistStore();
  const conversation = store.createConversation("main", "main");
  const { record } = store.submit(conversation, makePayload("req-1"));

  store.setState(record, "running");
  assert.ok(store.appendAssistant(record, "first answer"));
  assert.equal(record.delivered, 1);

  store.settle(record, "completed");
  assert.equal(record.settled, true);
  assert.equal(conversation.active, undefined);
  // A model still writing after its request was closed must not append to it.
  assert.equal(store.appendAssistant(record, "late answer"), undefined);
  assert.equal(record.delivered, 1);
  store.setState(record, "running");
  assert.equal(record.state, "completed");
  assert.equal(conversation.messages.length, 2);
});

test("unknown keeps the conversation locked, a restart does not", () => {
  const store = new PageAssistStore();
  const conversation = store.createConversation("main", "main");
  const { record } = store.submit(conversation, makePayload("req-1"));

  store.settle(record, "unknown");
  // The host never confirmed the run is over, so a second turn could interleave.
  assert.equal(record.settled, false);
  assert.equal(conversation.active, "req-1");
  assert.equal(statusOf(capture(() => store.submit(conversation, makePayload("req-2")))).status, 409);

  store.settle(record, "cancelled");
  assert.equal(record.settled, true);
  assert.equal(conversation.active, undefined);
});

test("stopping cancels everything in flight and leaves the finished alone", () => {
  const store = new PageAssistStore();
  const conversation = store.createConversation("main", "main");
  const idle = store.createConversation("main", "main");
  const { record: running } = store.submit(conversation, makePayload("req-run"));
  const { record: finished } = store.submit(idle, makePayload("req-done"));
  store.settle(finished, "completed");

  store.beginStop();
  assert.equal(running.state, "cancelled");
  assert.equal(running.settled, true);
  assert.equal(running.abort.signal.aborted, true);
  assert.equal(conversation.active, undefined);
  assert.equal(finished.state, "completed");
});

test("unknown ids answer with the restart sentences", () => {
  const store = new PageAssistStore();
  const missingConversation = statusOf(capture(() => store.requireConversation("nope")));
  assert.equal(missingConversation.status, 404);
  assert.equal(
    missingConversation.message,
    "Conversation unavailable; create a new chat after channel restart",
  );

  const missingRequest = statusOf(capture(() => store.requireRequest("nope")));
  assert.equal(missingRequest.status, 404);
  assert.equal(missingRequest.message, "Request unavailable in this channel instance");
});

/** Captures a thrown value so the status assertions stay readable. */
function capture(action: () => unknown): unknown {
  try {
    action();
    return new Error("expected the call to throw");
  } catch (error) {
    return error;
  }
}

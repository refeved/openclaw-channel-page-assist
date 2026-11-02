import assert from "node:assert/strict";
import { test } from "node:test";
// Behavioural tests run against the build output: the sources use the `.js`
// specifiers that emitted ESM requires, and Node's type stripping does not map
// them back to `.ts`. `npm test` builds first, so these are the shipped modules.
import { HttpError } from "../dist/src/http/respond.js";
import { PageAssistStore, buildRequestDto } from "../dist/src/store.js";
import {
  MAX_CONVERSATIONS,
  MAX_OUTGOING_TOTAL_BYTES,
  MAX_PENDING_REQUESTS,
  PENDING_ATTACHMENTS_MAX,
} from "../src/protocol.ts";

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

test("an upload joins the media ledger it is served from", () => {
  const store = new PageAssistStore();
  const record = store.registerUpload(uploadDescriptor(), { storeId: "store-1", path: "/tmp/1" }, "inbound");

  assert.match(record.id, UUID_PATTERN);
  assert.equal(store.pendingAttachmentCount, 1);
  // One registry for both directions, so `GET /media/:id` answers an upload exactly
  // like reply media and the capacity cap counts the same bytes either way.
  assert.equal(store.stagedMediaCount, 1);
  assert.equal(store.stagedMediaBytes, record.bytes);
  assert.equal(store.requireMedia(record.id), record);
});

test("the pending upload ceiling answers the restart sentence", () => {
  const store = new PageAssistStore();
  const uploads = Array.from({ length: PENDING_ATTACHMENTS_MAX }, (_unused, index) =>
    store.registerUpload(uploadDescriptor(), { storeId: `store-${index}`, path: `/tmp/${index}` }, "inbound"),
  );

  const error = statusOf(capture(() => store.requireUploadCapacity()));
  assert.equal(error.status, 429);
  assert.equal(error.message, "Too many unattached uploads; send or restart the channel");
  assert.equal(
    statusOf(capture(() => store.registerUpload(uploadDescriptor(), { storeId: "over", path: "/tmp/over" }, "inbound")))
      .status,
    429,
  );

  // A consumed upload still occupies its slot and its bytes: nothing here is reclaimed
  // until the channel restarts, which is what the sentence tells the user to do.
  const conversation = store.createConversation("main", "main");
  store.submit(conversation, makePayload("req-1"), () => [uploads[0]!]);
  assert.equal(store.pendingAttachmentCount, PENDING_ATTACHMENTS_MAX);
  assert.equal(statusOf(capture(() => store.requireUploadCapacity())).status, 429);
});

test("a claim takes every upload or none of them", () => {
  const store = new PageAssistStore();
  const first = store.registerUpload(uploadDescriptor(), { storeId: "a", path: "/tmp/a" }, "inbound");
  const second = store.registerUpload(uploadDescriptor(), { storeId: "b", path: "/tmp/b" }, "inbound");
  const missing = { attachmentId: "00000000-0000-4000-8000-000000000000" };

  const payload = {
    requestId: "req-1",
    text: "look at these",
    attachments: [{ attachmentId: first.id }, missing, { attachmentId: second.id }],
  };
  const error = statusOf(capture(() => store.claimAttachments(payload, () => true)));
  assert.equal(error.status, 400);
  assert.equal(error.message, "Attachment unavailable; upload it again");
  // Half a claim would leave the browser holding a reference it cannot resend.
  assert.equal(first.usedBy, undefined);
  assert.equal(second.usedBy, undefined);

  const claimed = store.claimAttachments(
    { requestId: "req-1", text: "look at these", attachments: [{ attachmentId: first.id }, { attachmentId: second.id }] },
    () => true,
  );
  assert.deepEqual(claimed.map((record) => record.id), [first.id, second.id]);
  assert.equal(first.usedBy, "req-1");

  // An upload that already travelled cannot travel again, even on the same request id.
  assert.equal(
    statusOf(
      capture(() => store.claimAttachments({ requestId: "req-1", text: "again", attachments: [{ attachmentId: first.id }] }, () => true)),
    ).status,
    400,
  );
});

test("an upload whose bytes are gone is not claimed", () => {
  const store = new PageAssistStore();
  const record = store.registerUpload(uploadDescriptor(), { storeId: "a", path: "/tmp/a" }, "inbound");
  // Capacity eviction and host media maintenance both retire files behind a live record.
  const error = statusOf(
    capture(() => store.claimAttachments({ requestId: "req-1", text: "x", attachments: [{ attachmentId: record.id }] }, () => false)),
  );
  assert.equal(error.status, 400);
  assert.equal(error.message, "Attachment unavailable; upload it again");
});

test("reply media claims space and retires the oldest bytes", () => {
  const store = new PageAssistStore();
  const firstBytes = Math.floor(MAX_OUTGOING_TOTAL_BYTES * 0.6);
  const secondBytes = Math.floor(MAX_OUTGOING_TOTAL_BYTES * 0.5);
  const first = store.registerReplyMedia(
    uploadDescriptor({ bytes: firstBytes }),
    { storeId: "old", path: "/tmp/old" },
    "page-assist",
  );
  assert.deepEqual(first.evicted, []);
  assert.equal(store.stagedMediaBytes, firstBytes);

  const second = store.registerReplyMedia(
    uploadDescriptor({ bytes: secondBytes }),
    { storeId: "new", path: "/tmp/new" },
    "page-assist",
  );
  // Oldest first, and only as much as the new file needs: the second entry fits once the
  // first is gone, so nothing else is touched.
  assert.deepEqual(
    second.evicted.map((record) => record.id),
    [first.record.id],
  );
  assert.equal(store.stagedMediaCount, 1);
  // Eviction is silent: the browser finds out from a 404 on an id it already read.
  assert.equal(statusOf(capture(() => store.requireMedia(first.record.id))).status, 404);
  assert.equal(store.requireMedia(second.record.id), second.record);
});

test("a submission that is refused never spends an upload", () => {
  const store = new PageAssistStore();
  const conversation = store.createConversation("main", "main");
  let claims = 0;
  const consume = () => {
    claims += 1;
    return [];
  };

  const { record } = store.submit(conversation, makePayload("req-1"), consume);
  assert.equal(claims, 1);

  // A replay must not re-consume, and a busy conversation must not be charged for a
  // submission that never happened: both checks come before the claim.
  const replay = store.submit(conversation, makePayload("req-1"), consume);
  assert.equal(replay.replay, true);
  assert.equal(replay.record, record);
  store.settle(record, "completed");

  const busy = store.createConversation("main", "main");
  store.submit(busy, makePayload("req-busy"), consume);
  assert.equal(claims, 2);
  assert.equal(
    statusOf(capture(() => store.submit(busy, makePayload("req-other"), consume))).status,
    409,
  );
  assert.equal(claims, 2);
});

test("the user row carries the attachments the run received", () => {
  const store = new PageAssistStore();
  const conversation = store.createConversation("main", "main");
  const image = store.registerUpload(
    uploadDescriptor({ name: "shot.png", kind: "image", mediaType: "image/png" }),
    { storeId: "a", path: "/tmp/a" },
    "inbound",
  );
  const notes = store.registerUpload(
    uploadDescriptor({ name: "notes.txt", kind: "file", mediaType: "text/plain", bytes: 12 }),
    { storeId: "b", path: "/tmp/b" },
    "inbound",
  );

  store.submit(conversation, makePayload("req-1", "compare these"), () => [image, notes]);
  const row = conversation.messages[0];
  // The reference channel puts one labelled note per attachment under the question, and
  // the structured list beside it: the text is what an agent transcript would show, the
  // list is what the panel turns into a preview.
  assert.equal(row?.content, "compare these\n[attachment image: shot.png]\n[attachment file: notes.txt]");
  assert.deepEqual(row?.attachments, [
    { mediaId: image.id, kind: "image", name: "shot.png", mediaType: "image/png", bytes: 2048 },
    { mediaId: notes.id, kind: "file", name: "notes.txt", mediaType: "text/plain", bytes: 12 },
  ]);
});

test("a question with only attachments keeps its notes", () => {
  const store = new PageAssistStore();
  const conversation = store.createConversation("main", "main");
  const upload = store.registerUpload(
    uploadDescriptor({ name: "shot.png" }),
    { storeId: "a", path: "/tmp/a" },
    "inbound",
  );

  // A screenshot with no text is a legitimate question, so the notes are the row.
  store.submit(conversation, { requestId: "req-1", text: "" }, () => [upload]);
  assert.equal(conversation.messages[0]?.content, "[attachment image: shot.png]");
});

/** A staged upload descriptor, with the fields the parsers produce. */
function uploadDescriptor(
  overrides: Partial<{ name: string; kind: "image" | "file"; mediaType: string; bytes: number }> = {},
) {
  return {
    name: overrides.name ?? "page.png",
    kind: overrides.kind ?? "image",
    mediaType: overrides.mediaType ?? "image/png",
    bytes: overrides.bytes ?? 2048,
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Captures a thrown value so the status assertions stay readable. */
function capture(action: () => unknown): unknown {
  try {
    action();
    return new Error("expected the call to throw");
  } catch (error) {
    return error;
  }
}

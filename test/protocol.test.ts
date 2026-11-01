import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HTTP_PREFIX,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_CONTEXT_CHARS,
  MAX_TEXT_CHARS,
  PROTOCOL_VERSION,
  buildCapabilities,
  checkBrowserToken,
  checkHttpPort,
  derivePrincipalScope,
} from "../src/protocol.ts";

/**
 * These assertions are the browser contract. They compare against the values the
 * QwenPaw channel publishes, because the extension has one client for both hosts:
 * a renamed field or a reinterpreted limit breaks the older build silently.
 */
const CONTRACT_CAPABILITY_KEYS = [
  "protocolVersion",
  "instanceId",
  "principalScope",
  "maxContextChars",
  "maxTextChars",
  "recovery",
  "approvals",
  "approvalEvents",
  "attachments",
  "maxAttachmentBytes",
  "maxAttachments",
  "media",
];

test("capabilities publish the contract limits", () => {
  const payload = buildCapabilities({
    instanceId: "instance-1",
    principalScope: "scope-1",
    approvals: false,
    attachments: false,
    media: false,
  });

  assert.equal(payload.protocolVersion, PROTOCOL_VERSION);
  assert.equal(payload.maxTextChars, MAX_TEXT_CHARS);
  assert.equal(payload.maxContextChars, MAX_CONTEXT_CHARS);
  assert.equal(payload.maxAttachmentBytes, MAX_ATTACHMENT_BYTES);
  assert.equal(payload.maxAttachments, MAX_ATTACHMENTS);
  assert.equal(payload.maxTextChars, 8000);
  assert.equal(payload.maxContextChars, 30000);
  assert.equal(payload.maxAttachmentBytes, 5 * 1024 * 1024);
  assert.equal(payload.maxAttachments, 4);
  assert.equal(payload.recovery, false);
  assert.equal(payload.approvalEvents, false);
});

test("capabilities carry the agreed field set and omit unknown versions", () => {
  const payload = buildCapabilities({
    instanceId: "instance-1",
    principalScope: "scope-1",
    approvals: true,
    attachments: true,
    media: true,
  });

  assert.deepEqual(Object.keys(payload).sort(), [...CONTRACT_CAPABILITY_KEYS].sort());

  const withVersions = buildCapabilities({
    instanceId: "instance-1",
    principalScope: "scope-1",
    approvals: false,
    attachments: false,
    media: false,
    channelVersion: "0.1.0",
    hostVersion: "2026.10.9",
  });
  assert.equal(withVersions.channelVersion, "0.1.0");
  assert.equal(withVersions.hostVersion, "2026.10.9");

  const emptyVersions = buildCapabilities({
    instanceId: "instance-1",
    principalScope: "scope-1",
    approvals: false,
    attachments: false,
    media: false,
    channelVersion: "",
    hostVersion: "",
  });
  assert.equal("channelVersion" in emptyVersions, false);
  assert.equal("hostVersion" in emptyVersions, false);
});

test("principal scope is the token digest the QwenPaw channel derives", () => {
  // hashlib.sha256("0123456789abcdefghijklmnopqrstuvwxyz".encode()).hexdigest()
  assert.equal(
    derivePrincipalScope("0123456789abcdefghijklmnopqrstuvwxyz"),
    "74e7e5bb9d22d6db26bf76946d40fff3ea9f0346b884fd0694920fccfad15e33",
  );
});

test("browser token rules match the host that generated them", () => {
  assert.equal(checkBrowserToken("0123456789abcdefghijklmnopqrstuvwxyz").ok, true);
  assert.equal(checkBrowserToken("short-token").ok, false);
  assert.equal(checkBrowserToken("0123456789abcdefghij klmnopqrstuvwxyz").ok, false);
  assert.equal(checkBrowserToken("0123456789abcdefghijklmnopqrstuvwxwü").ok, false);
});

test("http port stays inside the bindable range", () => {
  assert.equal(checkHttpPort(8767).ok, true);
  assert.equal(checkHttpPort(0).ok, false);
  assert.equal(checkHttpPort(65536).ok, false);
  assert.equal(checkHttpPort(8767.5).ok, false);
});

test("every route lives under the single advertised prefix", () => {
  assert.equal(HTTP_PREFIX, "/api/page-assist");
});

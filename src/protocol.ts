/**
 * Wire contract shared with the Page Assist browser extension.
 *
 * The extension talks to exactly one shape of endpoint, and the QwenPaw channel
 * defines that shape. This module keeps the same field names, limits, and error
 * codes so the browser needs no host-specific branches: it reads the published
 * capabilities and degrades instead of guessing. Nothing here may import the
 * OpenClaw SDK, because the contract is checked by plain unit tests without a
 * Gateway present.
 */
import { createHash } from "node:crypto";

/** Negotiated protocol revision. Bumping this is a breaking change for the browser. */
export const PROTOCOL_VERSION = 1;

/** Single path prefix the extension is configured with; every route lives under it. */
export const HTTP_PREFIX = "/api/page-assist";

/** Request-body ceiling, larger than one attachment so a batch fits in a single POST. */
export const MAX_UPLOAD_BODY_BYTES = 8 * 1024 * 1024;

/** Largest accepted message body, in characters. */
export const MAX_TEXT_CHARS = 8000;

/** Largest accepted page-context blob, in characters. */
export const MAX_CONTEXT_CHARS = 30000;

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS = 4;

/** In-flight guards; exceeding either is a 429 rather than a queue. */
export const MAX_CONVERSATIONS = 100;
export const MAX_PENDING_REQUESTS = 500;

/** Reply media the browser may render inline, mirrored from the QwenPaw channel. */
export const INLINE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type PageAssistCapabilities = {
  protocolVersion: number;
  instanceId: string;
  principalScope: string;
  maxContextChars: number;
  maxTextChars: number;
  recovery: boolean;
  approvals: boolean;
  approvalEvents: boolean;
  attachments: boolean;
  maxAttachmentBytes: number;
  maxAttachments: number;
  media: boolean;
  channelVersion?: string;
  hostVersion?: string;
};

export type CapabilitiesInput = {
  instanceId: string;
  principalScope: string;
  /**
   * Capability switches as observed at startup. A host that cannot serve a
   * feature must report it as absent; pretending otherwise is how a browser
   * ends up waiting for a reply that will never arrive.
   */
  approvals: boolean;
  attachments: boolean;
  media: boolean;
  channelVersion?: string;
  hostVersion?: string;
};

/**
 * Builds the `/capabilities` payload. Fields the host has not implemented are
 * false or omitted, never faked, so the browser disables those controls.
 */
export function buildCapabilities(input: CapabilitiesInput): PageAssistCapabilities {
  const capabilities: PageAssistCapabilities = {
    protocolVersion: PROTOCOL_VERSION,
    instanceId: input.instanceId,
    principalScope: input.principalScope,
    maxContextChars: MAX_CONTEXT_CHARS,
    maxTextChars: MAX_TEXT_CHARS,
    recovery: false,
    approvals: input.approvals,
    // ApprovalEvents would push host-side approval changes over SSE; the browser
    // polls `/approvals` instead, which is what the QwenPaw channel does too.
    approvalEvents: false,
    attachments: input.attachments,
    maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
    maxAttachments: MAX_ATTACHMENTS,
    media: input.media,
  };
  if (input.channelVersion) {
    capabilities.channelVersion = input.channelVersion;
  }
  if (input.hostVersion) {
    capabilities.hostVersion = input.hostVersion;
  }
  return capabilities;
}

/**
 * Principal identity: the token digest, never the token. Conversations, requests,
 * and pending approvals are owned by this value, so a different installation
 * cannot read or decide another installation's work.
 */
export function derivePrincipalScope(browserToken: string): string {
  return createHash("sha256").update(browserToken, "utf8").digest("hex");
}

const BROWSER_TOKEN_PATTERN = /^[\x00-\x7f]+$/;

export type BrowserTokenCheck = { ok: true } | { ok: false; reason: string };

/**
 * The token is an HTTP header value, so it must stay ASCII and whitespace-free;
 * 32 characters is the floor the extension itself enforces when it generates one.
 */
export function checkBrowserToken(token: string): BrowserTokenCheck {
  if (token.length < 32) {
    return { ok: false, reason: "browserToken must be at least 32 characters long" };
  }
  if (!BROWSER_TOKEN_PATTERN.test(token)) {
    return { ok: false, reason: "browserToken must be ASCII" };
  }
  if (/\s/.test(token)) {
    return { ok: false, reason: "browserToken must not contain whitespace" };
  }
  return { ok: true };
}

export function checkHttpPort(port: number): BrowserTokenCheck {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: "httpPort must be between 1 and 65535" };
  }
  return { ok: true };
}

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HTTP_PREFIX,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_CONTEXT_CHARS,
  MAX_OUTGOING_FILE_BYTES,
  MAX_TEXT_CHARS,
  PROTOCOL_VERSION,
  REPLY_MEDIA_NOTICE,
  attachmentKindForMediaType,
  base64DecodedUpperBound,
  buildAssistantReplyBody,
  buildCapabilities,
  buildUserMessageAttachments,
  checkBrowserToken,
  checkHttpPort,
  classifyReplyMediaSource,
  decodeBase64Media,
  derivePrincipalScope,
  isPaddedBase64,
  isUuid,
  mediaCeilingMegabytes,
  normalizeAttachmentKind,
  resolveMediaCeiling,
  resolveReplyMediaType,
  safeMediaSuffix,
  suggestMediaName,
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

test("ids on the wire are only ever the UUID the browser cannot guess", () => {
  assert.equal(isUuid("22222222-2222-4222-8222-222222222222"), true);
  assert.equal(isUuid("22222222-2222-4222-8222-222222222222".toUpperCase()), true);
  assert.equal(isUuid("2222222222224222822222222222 2"), false);
  assert.equal(isUuid("22222222-2222-4222-8222-22222222222"), false);
  assert.equal(isUuid("22222222-2222-4222-8222-22222222222z"), false);
  // The media route reads one path segment, so anything with a slash or a dot escapes it.
  assert.equal(isUuid("../../etc/passwd"), false);
  assert.equal(isUuid(""), false);
});

/**
 * Reply media is described by pure functions here and moved by the turn layer, so the
 * rules the QwenPaw channel implements with `Path`, `mimetypes` and `base64` have to be
 * reproduced exactly: the browser cannot tell a wrong type from a right one.
 */
test("a suffix is trusted only when a downloader could act on it", () => {
  assert.equal(safeMediaSuffix("report.final.XLSX"), ".xlsx");
  assert.equal(safeMediaSuffix(`C:\\Users\\someone\\notes.txt`), ".txt");
  assert.equal(safeMediaSuffix("https://example.com/a/b/chart.png"), ".png");
  assert.equal(safeMediaSuffix("archive"), "");
  assert.equal(safeMediaSuffix("notes."), "");
  assert.equal(safeMediaSuffix(".gitignore"), "");
  assert.equal(safeMediaSuffix("binary.v1beta"), ".v1beta");
  assert.equal(safeMediaSuffix("binary.v1betacdx"), "");
  assert.equal(safeMediaSuffix("照片.报告"), "");
  assert.equal(safeMediaSuffix("book.ef~"), "");
});

test("the content type the browser sees follows the agreed order", () => {
  // A declared type wins, without its parameters and whatever the name claims.
  assert.equal(resolveReplyMediaType("file", "x.png", "TEXT/Markdown; charset=utf-8"), "text/markdown");
  // The generic type says nothing, so the filename is asked instead.
  assert.equal(resolveReplyMediaType("file", "sheet.xlsx", "application/octet-stream"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(resolveReplyMediaType("file", "sheet.xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(resolveReplyMediaType("file", "mystery.zzz"), "application/octet-stream");
  // An unnamed picture still has to be previewable.
  assert.equal(resolveReplyMediaType("image", "attachment"), "image/png");
  assert.equal(resolveReplyMediaType("image", "attachment", "application/octet-stream"), "image/png");
  assert.equal(resolveReplyMediaType("image", "clip.mp4"), "video/mp4");
});

test("kinds fold down to what the panel can draw", () => {
  assert.equal(normalizeAttachmentKind("image"), "image");
  for (const kind of ["video", "audio", "document", "file", "text", "IMAGE"]) {
    assert.equal(normalizeAttachmentKind(kind), "file");
  }
  // Absent means "decide from the bytes", which is the caller's job, not a silent file.
  assert.equal(normalizeAttachmentKind(), undefined);
  // A bare reply reference has no part to ask, so its type decides what the panel draws.
  assert.equal(attachmentKindForMediaType("image/svg+xml"), "image");
  assert.equal(attachmentKindForMediaType("IMAGE/PNG"), "image");
  for (const mediaType of ["video/mp4", "audio/mpeg", "text/plain", "application/json"]) {
    assert.equal(attachmentKindForMediaType(mediaType), "file");
  }
  assert.equal(attachmentKindForMediaType(), "file");
});

test("a reply reference says where its bytes live", () => {
  assert.deepEqual(classifyReplyMediaSource("data:image/png;base64,AAAA"), {
    source: "data",
    mediaType: "image/png",
    data: "AAAA",
  });
  assert.deepEqual(classifyReplyMediaSource("data:;base64,AAAA"), {
    source: "data",
    mediaType: undefined,
    data: "AAAA",
  });
  // Anything else under `data:` has no byte payload to offer the browser.
  assert.deepEqual(classifyReplyMediaSource("data:text/plain;charset=utf-8,hello"), {
    source: "unsupported",
  });
  assert.deepEqual(classifyReplyMediaSource("data:image/png,iVBORw0KGgo="), {
    source: "unsupported",
  });

  // A public URL is forwarded, never fetched: this endpoint listens on loopback.
  assert.deepEqual(classifyReplyMediaSource(" https://example.com/a.png "), {
    source: "http",
    url: "https://example.com/a.png",
  });
  assert.deepEqual(classifyReplyMediaSource("HTTP://example.com/a.png"), {
    source: "http",
    url: "HTTP://example.com/a.png",
  });
  assert.deepEqual(classifyReplyMediaSource("https://"), { source: "unsupported" });
  assert.deepEqual(classifyReplyMediaSource("https:///a.png"), { source: "unsupported" });

  // Every disk form the host loader understands, and only the host loader decides.
  assert.deepEqual(classifyReplyMediaSource("file:///tmp/a.png"), {
    source: "local",
    reference: "file:///tmp/a.png",
  });
  assert.deepEqual(classifyReplyMediaSource("media://page-assist/abc"), {
    source: "local",
    reference: "media://page-assist/abc",
  });
  assert.deepEqual(classifyReplyMediaSource("/tmp/a.png"), {
    source: "local",
    reference: "/tmp/a.png",
  });
  assert.deepEqual(classifyReplyMediaSource(`C:\\Users\\someone\\a.png`), {
    source: "local",
    reference: `C:\\Users\\someone\\a.png`,
  });

  // Schemes with no byte source behind them, and schemes that would be a redirect.
  assert.deepEqual(classifyReplyMediaSource("ftp://example.com/a.png"), { source: "unsupported" });
  assert.deepEqual(classifyReplyMediaSource("mailto:someone@example.com"), { source: "unsupported" });
  assert.deepEqual(classifyReplyMediaSource("javascript:alert(1)"), { source: "unsupported" });
});

test("base64 payloads are decoded only when nothing had to be skipped", () => {
  assert.equal(decodeBase64Media("AAAA")?.length, 3);
  // Node's decoder drops stray characters instead of failing, so the strict check is
  // the only thing standing between a truncated payload and a shorter file.
  assert.equal(decodeBase64Media("AAAAA"), undefined);
  assert.equal(decodeBase64Media("AA AA"), undefined);
  assert.equal(decodeBase64Media("===A"), undefined);
  assert.equal(decodeBase64Media("")?.length, 0);
});

test("only canonical padding counts as base64", () => {
  assert.equal(isPaddedBase64(""), true);
  assert.equal(isPaddedBase64("AAAA"), true);
  assert.equal(isPaddedBase64("AA=="), true);
  assert.equal(isPaddedBase64("AAA="), true);
  assert.equal(isPaddedBase64("A==="), false);
  assert.equal(isPaddedBase64("===="), false);
  // A group of four is the unit, so an odd length is never a `btoa()` payload.
  assert.equal(isPaddedBase64("AAAAA"), false);
  assert.equal(isPaddedBase64("A".repeat(7)), false);
  assert.equal(isPaddedBase64("AA=A"), false);
  assert.equal(isPaddedBase64("AA= "), false);
});

test("a megabyte payload is checked without the checker running out of stack", () => {
  // A nested quantifier backtracks once per group, and an upload is millions of
  // characters: this is the body a screenshot at the advertised ceiling really is, so the
  // validator has to survive it rather than throw a RangeError the route cannot name.
  const atCeiling = Buffer.alloc(MAX_ATTACHMENT_BYTES, 0x41).toString("base64");
  assert.equal(isPaddedBase64(atCeiling), true);
  assert.equal(decodeBase64Media(atCeiling)?.length, MAX_ATTACHMENT_BYTES);

  // The bound is what refuses an oversized data URL before its bytes are allocated, so it
  // has to round up: three bytes per group, whatever the padding turns out to be.
  assert.ok(base64DecodedUpperBound(atCeiling) >= MAX_ATTACHMENT_BYTES);
  assert.ok(base64DecodedUpperBound("AA==") >= 1);
  assert.equal(base64DecodedUpperBound(""), 0);
  assert.equal(base64DecodedUpperBound("AAAA"), 3);
});

test("the name shown in the transcript is read out of the reference", () => {
  assert.equal(
    suggestMediaName(classifyReplyMediaSource("https://example.com/downloads/equation%20set.zip")),
    "equation set.zip",
  );
  assert.equal(suggestMediaName(classifyReplyMediaSource("https://example.com/")), "");
  assert.equal(suggestMediaName(classifyReplyMediaSource(`C:\\Users\\someone\\chart.png`)), "chart.png");
  assert.equal(suggestMediaName(classifyReplyMediaSource("media://page-assist/uuid.png")), "uuid.png");
  // A data URL has no name, only a type, so the extension is all there is to offer.
  assert.equal(suggestMediaName(classifyReplyMediaSource("data:image/svg+xml;base64,AAAA")), "image.svg");
  assert.equal(suggestMediaName(classifyReplyMediaSource("data:;base64,AAAA")), "");
  assert.equal(suggestMediaName(classifyReplyMediaSource("ftp://example.com/a.png")), "");
});

test("each dropped attachment gets the reference channel's sentence", () => {
  // Verbatim QwenPaw wording: the browser shows these as the reply, and a user who asked
  // for a file has to be able to tell the difference between formats and a vanished file.
  assert.equal(
    REPLY_MEDIA_NOTICE.unsupportedFormat("image"),
    "[image: this attachment format is not supported by the browser channel]",
  );
  assert.equal(
    REPLY_MEDIA_NOTICE.tooManyAttachments("file", "plan.pdf"),
    "[file: plan.pdf skipped, more than 4 attachments]",
  );
  assert.equal(REPLY_MEDIA_NOTICE.undecoded("image", "a.png"), "[image: a.png could not be decoded]");
  assert.equal(
    REPLY_MEDIA_NOTICE.unavailable("file", "plan.pdf"),
    "[file: plan.pdf is no longer available]",
  );
  assert.equal(REPLY_MEDIA_NOTICE.empty, "[Media is empty and was skipped.]");
  // The contract number, stated by the contract's own ceiling.
  assert.equal(
    REPLY_MEDIA_NOTICE.tooLarge("video.mp4", mediaCeilingMegabytes(MAX_OUTGOING_FILE_BYTES)),
    "[Media 'video.mp4' is larger than 5 MB and was skipped.]",
  );
});

test("mediaMaxMb can only tighten the ceiling the endpoint publishes", () => {
  assert.equal(resolveMediaCeiling(MAX_ATTACHMENT_BYTES), MAX_ATTACHMENT_BYTES);
  assert.equal(resolveMediaCeiling(MAX_ATTACHMENT_BYTES, 1024 * 1024), 1024 * 1024);
  // A looser operator limit cannot move the wire contract the browser was promised.
  assert.equal(resolveMediaCeiling(MAX_ATTACHMENT_BYTES, 20 * 1024 * 1024), MAX_ATTACHMENT_BYTES);
  assert.equal(resolveMediaCeiling(MAX_ATTACHMENT_BYTES, 0), MAX_ATTACHMENT_BYTES);
  assert.equal(resolveMediaCeiling(MAX_ATTACHMENT_BYTES, Number.NaN), MAX_ATTACHMENT_BYTES);
  // The MB number the notice is built from never says "0".
  assert.equal(mediaCeilingMegabytes(MAX_OUTGOING_FILE_BYTES), 5);
  assert.equal(mediaCeilingMegabytes(512 * 1024), 1);
  // An untouched install advertises exactly the contract's numbers.
  assert.equal(
    buildCapabilities({
      instanceId: "i",
      principalScope: "p",
      approvals: false,
      attachments: true,
      media: true,
    }).maxAttachmentBytes,
    MAX_ATTACHMENT_BYTES,
  );
  assert.equal(
    buildCapabilities({
      instanceId: "i",
      principalScope: "p",
      approvals: false,
      attachments: true,
      media: true,
      mediaMaxBytes: 2 * 1024 * 1024,
    }).maxAttachmentBytes,
    2 * 1024 * 1024,
  );
});

test("a reply that is nothing but notices still reaches the browser", () => {
  assert.equal(buildAssistantReplyBody("  Done.  ", []), "Done.");
  assert.equal(buildAssistantReplyBody("Done.", ["[Media is empty and was skipped.]"]), "Done.\n[Media is empty and was skipped.]");
  assert.equal(buildAssistantReplyBody("   ", ["a", "b"]), "a\nb");
  assert.equal(buildAssistantReplyBody("", []), "");
});

test("the wire calls the store id mediaId", () => {
  assert.deepEqual(
    buildUserMessageAttachments([
      {
        id: "22222222-2222-4222-8222-222222222222",
        kind: "image",
        name: "a.png",
        mediaType: "image/png",
        bytes: 3,
      },
    ]),
    [
      {
        mediaId: "22222222-2222-4222-8222-222222222222",
        kind: "image",
        name: "a.png",
        mediaType: "image/png",
        bytes: 3,
      },
    ],
  );
  assert.deepEqual(buildUserMessageAttachments([]), []);
});


/**
 * One agent reply out, as the browser reads it.
 *
 * The host tells a channel where reply bytes live; it does not promise the browser can
 * reach them. So every reference is classified first, then either forwarded untouched or
 * copied into this endpoint's own media bucket and handed back as an opaque id — a server
 * path never appears on the wire, which is the whole reason the reference channel refuses
 * to flatten a reply into `[Image: file:///…]`.
 *
 * What cannot travel is announced in the reply text with the reference channel's own
 * sentences, because an attachment the user asked for must not vanish silently.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-local-roots";
import { normalizeMediaReferenceForComparison } from "openclaw/plugin-sdk/media-store";
import { resolveOutboundMediaUrls, type ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import {
  REPLY_MEDIA_SUBDIR,
  discardStagedMedia,
  loadReplyMedia,
  stageMedia,
  type LoadedReplyMedia,
  type StagedMedia,
} from "../media.js";
import {
  MAX_OUTGOING_ATTACHMENTS,
  MAX_OUTGOING_FILE_BYTES,
  REPLY_MEDIA_NOTICE,
  type AttachmentKind,
  type MessageAttachment,
  type ReplyMediaSource,
  attachmentKindForMediaType,
  base64DecodedUpperBound,
  classifyReplyMediaSource,
  decodeBase64Media,
  mediaCeilingMegabytes,
  normalizeAttachmentKind,
  resolveMediaCeiling,
  resolveReplyMediaType,
  sanitizeAttachmentName,
  suggestMediaName,
} from "../protocol.js";
import type { PageAssistStore } from "../store.js";

/** Metadata the host prepared for one media reference; absent for most hand-written replies. */
type PreparedMedia = NonNullable<ReplyPayload["attachments"]>[number];

/** A reference that may travel, before its bytes have been read. */
type DescribedReplyMedia = {
  kind: AttachmentKind;
  /** The name the payload gave, raw: the loader may still offer a better one. */
  declaredName?: string;
  /** What the browser will be shown for this attachment, sanitized. */
  name: string;
  declaredType?: string;
  source: ReplyMediaSource;
};

/** A reference whose bytes are in hand, or a remote URL that needs none. */
type ResolvedReplyMedia = DescribedReplyMedia & {
  loaded?: LoadedReplyMedia;
};

/** The reply row's attachments and the notices that explain the ones that were dropped. */
export type ReplyMediaResult = {
  attachments: MessageAttachment[];
  notices: string[];
};

/** The name the browser will see: the sender's if it gave one, otherwise the reference's own tail. */
function resolveMediaName(preferred: string | undefined, fallback: string): string {
  return sanitizeAttachmentName(preferred?.trim() ? preferred : fallback);
}

/**
 * Matches `payload.attachments` to `payload.mediaUrls`.
 *
 * The host keeps the two aligned, but a prepared record may name a different reference
 * than the one it was stored next to, and compacted records name no reference at all.
 * Matching a canonicalized reference first and falling back to array position is the
 * host's own projection rule, so this endpoint reads the same pairing rather than
 * inventing one.
 */
function buildAttachmentLookup(
  payload: ReplyPayload,
): (url: string, index: number) => PreparedMedia | undefined {
  const prepared = payload.attachments ?? [];
  const byReference = new Map<string, PreparedMedia>();
  const positional: Array<PreparedMedia | undefined> = [];
  for (const attachment of prepared) {
    const reference = normalizeMediaReferenceForComparison(
      attachment.path ?? attachment.url ?? attachment.mediaUrl ?? attachment.filePath ?? "",
    );
    if (reference && !byReference.has(reference)) {
      byReference.set(reference, attachment);
    }
    // A record that identifies its media by reference cannot also stand in for whatever
    // sits at this position, so only unnamed records keep a slot here.
    positional.push(reference ? undefined : attachment);
  }
  return (url, index) =>
    byReference.get(normalizeMediaReferenceForComparison(url)) ?? positional[index];
}

/**
 * Reads a reference far enough to know what it is, without touching its bytes.
 *
 * An unparsable reference is announced and dropped here, which is also where the kind and
 * name for every later sentence about this attachment are settled — a file that never
 * opened still has to be named in the notice.
 */
function describeReplyMedia(
  url: string,
  prepared: PreparedMedia | undefined,
  notices: string[],
): DescribedReplyMedia | undefined {
  const source = classifyReplyMediaSource(url);
  const declaredName = prepared?.name;
  const name = resolveMediaName(declaredName, suggestMediaName(source));
  const declaredType = prepared?.mimeType;
  if (source.source === "unsupported") {
    // This sentence carries no name: the reference channel has nothing trustworthy to show
    // for a payload it could not parse in the first place.
    notices.push(
      REPLY_MEDIA_NOTICE.unsupportedFormat(normalizeAttachmentKind(prepared?.type) ?? "file"),
    );
    return undefined;
  }
  // The host's own metadata wins when it prepared any. Otherwise the kind comes out of what
  // the reference declares about itself, so the same attachment cannot be previewed as a
  // picture here and announced as a download there — the bytes refine it below, and a
  // reference that never opened keeps this answer.
  const kind =
    normalizeAttachmentKind(prepared?.type) ??
    attachmentKindForMediaType(
      resolveReplyMediaType(
        "file",
        name,
        declaredType ?? (source.source === "data" ? source.mediaType : undefined),
      ),
    );
  return { kind, declaredName, name, declaredType, source };
}

/**
 * Gets the bytes behind one reference, or the sentence that replaces the attachment.
 *
 * A public URL is returned without a fetch, and `undefined` means this attachment did not
 * travel — the reason is already in `notices`, and the reply itself is still worth showing.
 */
async function resolveReplyMediaBytes(
  media: DescribedReplyMedia,
  localRoots: readonly string[],
  notices: string[],
  ceiling: { maxBytes: number; megabytes: number },
): Promise<ResolvedReplyMedia | undefined> {
  const { kind, name, source } = media;
  if (source.source === "http") {
    return media;
  }
  if (source.source === "data") {
    // The length says it first: a payload that cannot fit the delivery ceiling is refused
    // for its size without decoding, so the notice keeps the reference channel's wording
    // and no megabytes are buffered for a file the browser would never be handed.
    if (base64DecodedUpperBound(source.data) > ceiling.maxBytes) {
      notices.push(REPLY_MEDIA_NOTICE.tooLarge(name, ceiling.megabytes));
      return undefined;
    }
    const buffer = decodeBase64Media(source.data);
    if (buffer === undefined) {
      notices.push(REPLY_MEDIA_NOTICE.undecoded(kind, name));
      return undefined;
    }
    // A data URL declares its own type, and that declaration is the only evidence here.
    return {
      ...media,
      declaredType: media.declaredType ?? source.mediaType,
      loaded: { buffer, mediaType: source.mediaType },
    };
  }
  // `describeReplyMedia` already announced the only remaining case, a reference it could
  // not parse, so nothing reaches here without a place to read bytes from.
  if (source.source !== "local") {
    return undefined;
  }
  const loaded = await loadReplyMedia({
    url: source.reference,
    maxBytes: ceiling.maxBytes,
    localRoots,
  });
  if (!loaded.ok) {
    notices.push(
      loaded.reason === "too-large"
        ? REPLY_MEDIA_NOTICE.tooLarge(name, ceiling.megabytes)
        : REPLY_MEDIA_NOTICE.unavailable(kind, name),
    );
    return undefined;
  }
  return {
    // The loader classified these bytes rather than trusting a name, and its filename may
    // be the name the uploader gave — better evidence than a generated id at the end of a
    // path. The type it detected is what the browser will be served.
    ...media,
    kind: normalizeAttachmentKind(loaded.media.kind) ?? kind,
    name: resolveMediaName(media.declaredName ?? loaded.media.fileName, suggestMediaName(source)),
    declaredType: media.declaredType ?? loaded.media.mediaType,
    loaded: loaded.media,
  };
}

/**
 * Stages one attachment's bytes and registers them, or reports why they did not arrive.
 *
 * The two size sentences come before the write, so a file the browser could never get is
 * never left on disk: empty bytes and an oversized file are both the reply's problem to
 * announce, not this endpoint's to buffer.
 */
async function storeReplyMedia(
  media: ResolvedReplyMedia,
  loaded: LoadedReplyMedia,
  store: PageAssistStore,
  notices: string[],
  ceiling: { maxBytes: number; megabytes: number },
): Promise<MessageAttachment | undefined> {
  const bytes = loaded.buffer;
  const mediaType = resolveReplyMediaType(
    media.kind,
    media.name,
    media.declaredType ?? loaded.mediaType,
  );
  if (bytes.length === 0) {
    notices.push(REPLY_MEDIA_NOTICE.empty);
    return undefined;
  }
  if (bytes.length > ceiling.maxBytes) {
    notices.push(REPLY_MEDIA_NOTICE.tooLarge(media.name, ceiling.megabytes));
    return undefined;
  }
  let staged: StagedMedia | undefined;
  try {
    staged = await stageMedia({
      buffer: bytes,
      mediaType,
      name: media.name,
      subdir: REPLY_MEDIA_SUBDIR,
      maxBytes: ceiling.maxBytes,
    });
  } catch {
    notices.push(REPLY_MEDIA_NOTICE.unavailable(media.kind, media.name));
    return undefined;
  }
  const { record, evicted } = store.registerReplyMedia(
    { name: media.name, kind: media.kind, mediaType, bytes: bytes.length },
    staged,
    REPLY_MEDIA_SUBDIR,
  );
  // Capacity eviction is silent on the wire — a promised id simply starts answering 404 —
  // so the bytes it retired are removed here rather than left to be found later.
  await discardStagedMedia(evicted);
  return {
    mediaId: record.id,
    kind: record.kind,
    name: record.name,
    mediaType: record.mediaType,
    bytes: record.bytes,
  };
}

/**
 * Turns one reply payload's media references into transcript attachments.
 *
 * Public HTTP(S) stays a URL the browser fetches itself; everything else becomes bytes in
 * this endpoint's own bucket under a fresh UUID. The count cap covers both kinds, because
 * what the browser has to render is the same either way.
 */
export async function buildReplyMedia(params: {
  payload: ReplyPayload;
  store: PageAssistStore;
  cfg: OpenClawConfig;
  agentId: string;
  /** The account's `mediaMaxMb`, applied through `resolveMediaCeiling`: tighter, never looser. */
  mediaMaxBytes?: number;
}): Promise<ReplyMediaResult> {
  const attachments: MessageAttachment[] = [];
  const notices: string[] = [];
  // The reference channel's own ceiling, unless `mediaMaxMb` lowers it: both the byte check
  // and the MB number in the sentence come from this one value, so they cannot disagree.
  const maxBytes = resolveMediaCeiling(MAX_OUTGOING_FILE_BYTES, params.mediaMaxBytes);
  const ceiling = { maxBytes, megabytes: mediaCeilingMegabytes(maxBytes) };
  const mediaUrls = resolveOutboundMediaUrls(params.payload);
  if (mediaUrls.length === 0) {
    return { attachments, notices };
  }
  const attachmentFor = buildAttachmentLookup(params.payload);
  // The host owns which directories this Agent's media may be read from, and a sandboxed
  // session's files are deliberately unreachable without its own workspace.
  const localRoots = getAgentScopedMediaLocalRoots(params.cfg, params.agentId);

  for (const [index, url] of mediaUrls.entries()) {
    if (!url.trim()) {
      continue;
    }
    const described = describeReplyMedia(url, attachmentFor(url, index), notices);
    if (described === undefined) {
      continue;
    }
    if (attachments.length >= MAX_OUTGOING_ATTACHMENTS) {
      notices.push(REPLY_MEDIA_NOTICE.tooManyAttachments(described.kind, described.name));
      continue;
    }
    const resolved = await resolveReplyMediaBytes(described, localRoots, notices, ceiling);
    if (resolved === undefined) {
      continue;
    }
    // A remote URL is forwarded as it stands: fetching it here would let the browser ask
    // this loopback endpoint to read any address the Agent named.
    if (resolved.loaded === undefined) {
      attachments.push({
        url,
        kind: resolved.kind,
        name: resolved.name,
        mediaType: resolveReplyMediaType(resolved.kind, resolved.name, resolved.declaredType),
        bytes: 0,
      });
      continue;
    }
    const attachment = await storeReplyMedia(
      resolved,
      resolved.loaded,
      params.store,
      notices,
      ceiling,
    );
    if (attachment !== undefined) {
      attachments.push(attachment);
    }
  }
  return { attachments, notices };
}

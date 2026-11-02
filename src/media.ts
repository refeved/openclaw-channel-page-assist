/**
 * Media-store access for one running endpoint.
 *
 * The Gateway owns where bytes live: `openclaw`'s media store resolves its root from
 * the active configuration on every call, names each file, and enforces the same
 * read/write guards for native channels. This module is the only place the plugin
 * touches it, so the rest of the code deals in records it can hold in memory and in
 * ids it can put on the wire.
 *
 * The wire never carries a store id or a path. Both directions address bytes with the
 * endpoint's own UUID, because the contract says an id is an opaque UUID and a store id
 * embeds the uploader's filename.
 */
import { statSync } from "node:fs";
import { readMediaBuffer, saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { unlinkIfExists } from "openclaw/plugin-sdk/media-runtime";
import { LocalMediaAccessError, loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";

/** Upload bucket the host's own channels use, so a browser upload is not a special case. */
export const INBOUND_MEDIA_SUBDIR = "inbound";

/**
 * Reply media lives in a bucket of its own.
 *
 * The host prunes `outbound` on a fixed schedule while the endpoint is running, which
 * would drop bytes the browser was already promised, and configuring
 * `attachments.ttlHours` turns on a recursive sweep of the whole media tree. A private
 * subdir is only ever touched by this endpoint, which keeps one promise per id: the
 * bytes stay readable until the channel restarts or the capacity cap evicts them.
 */
export const REPLY_MEDIA_SUBDIR = "page-assist";

export type StagedMedia = {
  /** Id inside the media store; internal to this process. */
  storeId: string;
  /** Absolute path; internal to this process and never serialized. */
  path: string;
};

/**
 * Writes bytes into the media store under the given bucket.
 *
 * `name` is already sanitized: the store embeds it in the filename it generates, so an
 * unsanitized value would end up on disk. The size ceiling is the caller's, and it is
 * enforced by the store as well as by the payload parser.
 */
export async function stageMedia(params: {
  buffer: Buffer;
  mediaType: string;
  name: string;
  subdir: string;
  maxBytes: number;
}): Promise<StagedMedia> {
  const saved = await saveMediaBuffer(
    params.buffer,
    params.mediaType,
    params.subdir,
    params.maxBytes,
    params.name,
  );
  return { storeId: saved.id, path: saved.path };
}

/**
 * Reads stored bytes back, or undefined when they are gone.
 *
 * A missing file is an ordinary outcome here: capacity eviction removes bytes, and an
 * operator who sets `attachments.ttlHours` turns on a sweep that can retire them. The
 * caller answers with the contract's own "unavailable" sentence rather than a stack.
 */
export async function readStagedMedia(
  media: StagedMedia,
  subdir: string,
  maxBytes: number,
): Promise<Buffer | undefined> {
  try {
    const result = await readMediaBuffer(media.storeId, subdir, maxBytes);
    return result.buffer;
  } catch {
    return undefined;
  }
}

/** Whether the stored file is still there, checked without awaiting. */
export function isStagedMediaPresent(media: StagedMedia): boolean {
  try {
    return statSync(media.path).isFile();
  } catch {
    return false;
  }
}

/**
 * Removes dropped media bytes.
 *
 * Best effort by design: the registry has already forgotten the record, so a failed
 * unlink leaves an orphan file and no incorrect answer on the wire.
 */
export async function discardStagedMedia(files: readonly StagedMedia[]): Promise<void> {
  await Promise.all(files.map((file) => unlinkIfExists(file.path)));
}

/** Bytes plus metadata the reply assembly needs in order to name and classify a file. */
export type LoadedReplyMedia = {
  buffer: Buffer;
  /** Type the source or the bytes gave; the caller still falls back to the name. */
  mediaType?: string;
  /** The host's family for these bytes, folded down to the browser's two kinds upstream. */
  kind?: string;
  fileName?: string;
};

/**
 * Why one reference could not be turned into a file the browser can be given.
 *
 * `too-large` and `unavailable` select different sentences on the wire, and nothing else
 * about the outcome changes: the attachment is dropped and the reply carries on.
 */
export type ReplyMediaLoadResult =
  | { ok: true; media: LoadedReplyMedia }
  | { ok: false; reason: "too-large" | "unavailable" };

/**
 * Reads reply media the host can reach: a store reference, a `file:` URL, or a path under
 * one of the Agent's allowed roots.
 *
 * Image optimization stays off, so the bytes the Agent named are the bytes the browser
 * downloads. The ceiling is applied while reading rather than after buffering, which is
 * the one place this endpoint is deliberately harsher than the reference channel, and
 * `localRoots` comes from the host so this module never decides which directories the
 * Agent may read.
 */
export async function loadReplyMedia(params: {
  url: string;
  maxBytes: number;
  localRoots: readonly string[];
}): Promise<ReplyMediaLoadResult> {
  try {
    const media = await loadWebMediaRaw(params.url, {
      maxBytes: params.maxBytes,
      optimizeImages: false,
      localRoots: params.localRoots,
    });
    return {
      ok: true,
      media: {
        buffer: media.buffer,
        mediaType: media.contentType,
        kind: media.kind,
        fileName: media.fileName,
      },
    };
  } catch (error) {
    return { ok: false, reason: isCapacityRefusal(error) ? "too-large" : "unavailable" };
  }
}

/**
 * Tells a byte-cap refusal from a source that is missing or unreadable.
 *
 * The host reports a cap as a plain `Media exceeds … limit` error, while existence and
 * access failures arrive as `LocalMediaAccessError`. Only the notice sentence depends on
 * the difference, so an unrecognized error takes the more conservative answer.
 */
function isCapacityRefusal(error: unknown): boolean {
  if (error instanceof LocalMediaAccessError) {
    return false;
  }
  return error instanceof Error && /\bexceeds\b.+\blimit\b/i.test(error.message);
}

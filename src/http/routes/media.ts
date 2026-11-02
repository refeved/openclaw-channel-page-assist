import { readStagedMedia } from "../../media.js";
import {
  HTTP_PREFIX,
  INLINE_MEDIA_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_OUTGOING_FILE_BYTES,
  isUuid,
  resolveMediaCeiling,
} from "../../protocol.js";
import type { PageAssistMedia } from "../../store.js";
import { notFound, sendBinary } from "../respond.js";
import type { PageAssistRoute } from "../scope.js";

/**
 * One limit serves a read either way: an upload is bounded by the attachment ceiling and
 * reply media by the outgoing one, and the contract sets both to the same number. Taking
 * the larger keeps this correct if the two ever diverge.
 */
const READ_MAX_BYTES = Math.max(MAX_ATTACHMENT_BYTES, MAX_OUTGOING_FILE_BYTES);

/**
 * Stored images render inline, everything else is a download.
 *
 * The name is already sanitized, so it carries no quote, no path separator and no
 * control byte, and it can be placed in the header verbatim. The browser reads the
 * display name from the message row regardless; this is what makes a hand-off to a
 * downloader keep the file's real name.
 */
function buildContentDisposition(record: PageAssistMedia): string {
  const inline = record.kind === "image" && INLINE_MEDIA_TYPES.has(record.mediaType);
  return `${inline ? "inline" : "attachment"}; filename="${record.name}"`;
}

/**
 * `GET /api/page-assist/media/:id`
 *
 * The one protected route that serves bytes in both directions: reply media the agent
 * produced, and uploads the browser sent, which is how an image the user shared reappears
 * in restored history instead of a bare filename. Nothing here exposes a server path —
 * the id is an opaque UUID, and an unknown, malformed, or already evicted id is one plain
 * 404, so the client has a single branch for "these bytes are gone".
 */
export const pageAssistMediaRoute: PageAssistRoute = {
  method: "GET",
  path: `${HTTP_PREFIX}/media/:id`,
  handler: async ({ res, params, scope }) => {
    const requestedId = params.id ?? "";
    if (!isUuid(requestedId)) {
      throw notFound("Media unavailable");
    }
    const record = scope.store.requireMedia(requestedId);
    // A file larger than the ceiling this endpoint enforces could never have been stored,
    // so reading more than that would only be a buffer the browser cannot get.
    const bytes = await readStagedMedia(
      record,
      record.subdir,
      resolveMediaCeiling(READ_MAX_BYTES, scope.account.mediaMaxBytes),
    );
    if (bytes === undefined) {
      throw notFound("Media unavailable");
    }
    sendBinary(res, 200, bytes, {
      "Content-Type": record.mediaType,
      "Content-Disposition": buildContentDisposition(record),
    });
  },
};

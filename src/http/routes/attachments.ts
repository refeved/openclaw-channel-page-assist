import { INBOUND_MEDIA_SUBDIR, stageMedia } from "../../media.js";
import {
  HTTP_PREFIX,
  MAX_ATTACHMENT_BYTES,
  parseAttachmentUpload,
  resolveMediaCeiling,
} from "../../protocol.js";
import { readBrowserBody } from "../body.js";
import { sendJson } from "../respond.js";
import type { PageAssistRoute } from "../scope.js";

/**
 * `POST /api/page-assist/attachments`
 *
 * Stages one upload and hands back the id a later message consumes. Bytes go into the
 * host's own inbound media bucket, so the agent reads a browser upload exactly as it
 * reads an attachment from a native channel; the id on the wire is the endpoint's own
 * UUID, because a store id embeds the uploader's filename and the contract promises an
 * opaque one.
 */
export const pageAssistUploadAttachmentRoute: PageAssistRoute = {
  method: "POST",
  path: `${HTTP_PREFIX}/attachments`,
  handler: async ({ req, res, scope }) => {
    const ceiling = resolveMediaCeiling(MAX_ATTACHMENT_BYTES, scope.account.mediaMaxBytes);
    const upload = await readBrowserBody(req, (value) => parseAttachmentUpload(value, ceiling));
    // Checked before the write, so an upload refused for capacity leaves no orphan file.
    scope.store.requireUploadCapacity();
    const staged = await stageMedia({
      buffer: upload.buffer,
      mediaType: upload.mediaType,
      name: upload.name,
      subdir: INBOUND_MEDIA_SUBDIR,
      maxBytes: ceiling,
    });
    const record = scope.store.registerUpload(
      { name: upload.name, kind: upload.kind, mediaType: upload.mediaType, bytes: upload.bytes },
      staged,
      INBOUND_MEDIA_SUBDIR,
    );
    sendJson(res, 201, {
      attachmentId: record.id,
      name: record.name,
      kind: record.kind,
      mediaType: record.mediaType,
      bytes: record.bytes,
    });
  },
};

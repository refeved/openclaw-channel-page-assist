import type { IncomingMessage } from "node:http";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
} from "openclaw/plugin-sdk/webhook-ingress";
import { BrowserPayloadError, MAX_UPLOAD_BODY_BYTES } from "../protocol.js";
import { badRequest, HttpError, payloadTooLarge } from "./respond.js";

/**
 * Body read window. A client that stops mid-upload must not hold a route open
 * forever; 30s is what the host's own webhook reader uses.
 */
const BODY_TIMEOUT_MS = 30_000;

/**
 * Reads and parses one browser JSON body.
 *
 * Every rejection is the plain 400 sentence the QwenPaw channel returns for a bad
 * payload, because the extension surfaces the text verbatim and the difference
 * between "not JSON" and "wrong shape" is a log question, not a UI question. The
 * size ceiling keeps its own 413 so an oversized batch is distinguishable.
 */
export async function readBrowserBody<T>(
  req: IncomingMessage,
  parse: (value: unknown) => T,
): Promise<T> {
  let text: string;
  try {
    text = await readRequestBodyWithLimit(req, {
      maxBytes: MAX_UPLOAD_BODY_BYTES,
      timeoutMs: BODY_TIMEOUT_MS,
      // Pause rather than destroy so the response below still reaches the client.
      destroyOnLimit: false,
    });
  } catch (error) {
    if (isRequestBodyLimitError(error, "PAYLOAD_TOO_LARGE")) {
      throw payloadTooLarge(`Maximum request body size ${MAX_UPLOAD_BODY_BYTES} exceeded.`);
    }
    if (error instanceof HttpError) {
      throw error;
    }
    throw badRequest();
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw badRequest();
  }
  try {
    return parse(value);
  } catch (error) {
    if (error instanceof BrowserPayloadError) {
      throw badRequest();
    }
    throw error;
  }
}

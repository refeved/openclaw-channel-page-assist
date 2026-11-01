import type { ServerResponse } from "node:http";

/**
 * Status + text pairs the browser already understands. Messages are plain text
 * because the extension surfaces them verbatim in its error row, and keeping the
 * wording identical to the QwenPaw channel means one sentence still means one
 * cause across hosts.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const unauthorized = () => new HttpError(401, "Invalid Page Assist browser token");
export const forbidden = (message: string) => new HttpError(403, message);
export const notFound = (message = "Unknown Page Assist request") => new HttpError(404, message);
export const methodNotAllowed = () => new HttpError(405, "Unsupported Page Assist method");
export const conflict = (message: string) => new HttpError(409, message);
export const payloadTooLarge = (message: string) => new HttpError(413, message);
export const tooManyRequests = (message: string) => new HttpError(429, message);
export const serviceUnavailable = (message = "Channel is stopping") =>
  new HttpError(503, message);

function writeHead(res: ServerResponse, status: number, headers: Record<string, string>): void {
  // no-store is mandatory: a cached /requests/<id> snapshot would hide the fact
  // that the run already moved on, and the browser would poll a stale answer.
  res.writeHead(status, { "Cache-Control": "no-store", ...headers });
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  writeHead(res, status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  writeHead(res, status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(text)),
  });
  res.end(text);
}

export function sendStatus(res: ServerResponse, error: HttpError): void {
  sendText(res, error.status, error.message);
}

import { HTTP_PREFIX, endsEventStream, type RequestState } from "../../protocol.js";
import { buildRequestDto } from "../../store.js";
import { sendJson } from "../respond.js";
import type { PageAssistRoute } from "../scope.js";

/**
 * Poll interval for the event stream.
 *
 * The stream is a diff of the conversation, not a token pipe: the host writes replies
 * into the transcript when a message is finished, and this loop reports what changed
 * since it last looked. One second is what the QwenPaw channel uses, so the browser's
 * typing indicator behaves the same on both hosts.
 */
const EVENT_POLL_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * `GET /api/page-assist/requests/:id`
 *
 * Single snapshot for reconnects and for the browser's own recovery path, where it
 * has to learn the state without holding a connection open.
 */
export const pageAssistRequestRoute: PageAssistRoute = {
  method: "GET",
  path: `${HTTP_PREFIX}/requests/:id`,
  handler: ({ res, params, scope }) => {
    const record = scope.store.requireRequest(params.id ?? "");
    sendJson(res, 200, buildRequestDto(record));
  },
};

/**
 * `GET /api/page-assist/requests/:id/events`
 *
 * Three events carry the whole run:
 * - `request.state` whenever the state changes,
 * - `message.snapshot` once per finished assistant row,
 * - `request.terminal` when the request reaches a state the browser must stop
 *   waiting on, which includes `unknown`.
 *
 * `requestId` is appended last on every frame, so the browser's own field reads line
 * up with what the QwenPaw channel put on the wire.
 */
export const pageAssistEventsRoute: PageAssistRoute = {
  method: "GET",
  path: `${HTTP_PREFIX}/requests/:id/events`,
  handler: async ({ req, res, params, scope }) => {
    const record = scope.store.requireRequest(params.id ?? "");

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      // no-store again: a cached frame would be a state the run has already left.
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });

    let closed = false;
    const handleClose = () => {
      closed = true;
    };
    // `error` has to have a listener: writing to a socket the browser abandoned
    // emits one, and an unhandled 'error' on a stream tears down the Gateway.
    res.on("close", handleClose);
    res.on("error", handleClose);
    req.on("aborted", handleClose);

    const write = (frame: string): boolean => {
      if (closed || res.writableEnded) {
        return false;
      }
      try {
        res.write(frame);
        return true;
      } catch {
        closed = true;
        return false;
      }
    };
    const emit = (event: Record<string, unknown>): boolean =>
      write(`data: ${JSON.stringify({ ...event, requestId: record.requestId })}\n\n`);

    const seen = new Set<string>();
    let lastState: RequestState | undefined;

    while (!closed) {
      if (lastState !== record.state) {
        lastState = record.state;
        emit({ type: "request.state", state: lastState });
      }
      for (const message of record.conversation.messages) {
        if (
          message.role !== "assistant" ||
          message.requestId !== record.requestId ||
          seen.has(message.id)
        ) {
          continue;
        }
        emit({
          type: "message.snapshot",
          messageId: message.id,
          content: message.content,
          attachments: message.attachments,
          status: message.status,
        });
        seen.add(message.id);
        if (closed) {
          break;
        }
      }
      if (closed) {
        break;
      }
      if (endsEventStream(record.state)) {
        emit({ type: "request.terminal", state: record.state });
        break;
      }
      // Checked after the terminal test so a stop still flushes the last state: the
      // endpoint marks running requests cancelled, and the browser deserves the
      // frame rather than a silently closed stream.
      if (scope.isStopping()) {
        break;
      }
      // A comment frame keeps proxies from treating an agent that is still working
      // as an idle connection.
      write(": waiting\n\n");
      await sleep(EVENT_POLL_MS);
    }

    if (!res.writableEnded) {
      res.end();
    }
  },
};

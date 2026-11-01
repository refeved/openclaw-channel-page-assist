import type { IncomingMessage, ServerResponse } from "node:http";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import {
  HttpError,
  methodNotAllowed,
  notFound,
  sendStatus,
  serviceUnavailable,
  unauthorized,
} from "./respond.js";
import type { PageAssistRoute, PageAssistScope } from "./scope.js";

type CompiledRoute = PageAssistRoute & { segments: string[] };

function compile(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/**
 * Matches one path segment list against a route pattern.
 * A `:name` segment captures a parameter and rejects an empty value, so
 * `/requests//events` is a 404 rather than a request with a blank id.
 */
function matchSegments(
  pattern: string[],
  actual: string[],
): Record<string, string> | undefined {
  if (pattern.length !== actual.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index] ?? "";
    const value = actual[index] ?? "";
    if (expected.startsWith(":")) {
      if (value.length === 0) {
        return undefined;
      }
      params[expected.slice(1)] = value;
      continue;
    }
    if (expected !== value) {
      return undefined;
    }
  }
  return params;
}

function decodePath(rawUrl: string): string {
  const path = rawUrl.split("?")[0] ?? "/";
  try {
    return decodeURIComponent(path);
  } catch {
    // A malformed escape must not take the listener down; it is simply an unknown path.
    return "\u0000malformed";
  }
}

/**
 * Builds the request handler for the Page Assist endpoint.
 *
 * The Gateway forwards every request under `HTTP_PREFIX` here, so this owns
 * authentication, the stopping gate, routing, and error projection. Handlers only
 * deal with their own payload.
 */
export function createPageAssistRequestHandler(
  scope: PageAssistScope,
  routes: readonly PageAssistRoute[],
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const compiled: CompiledRoute[] = routes.map((route) => ({ ...route, segments: compile(route.path) }));
  const expectedHeader = `Bearer ${scope.account.browserToken}`;

  return async (req, res) => {
    const method = req.method ?? "GET";
    const path = decodePath(req.url ?? "/");

    try {
      // Same comparison the QwenPaw channel makes: constant-time over the whole
      // header, so a wrong scheme is a failure rather than a second code path.
      if (!safeEqualSecret(req.headers.authorization ?? undefined, expectedHeader)) {
        throw unauthorized();
      }
      if (scope.isStopping()) {
        throw serviceUnavailable();
      }

      const segments = compile(path);
      let pathMatch: CompiledRoute | undefined;
      let params: Record<string, string> | undefined;
      let methodMatch: CompiledRoute | undefined;
      for (const route of compiled) {
        const captured = matchSegments(route.segments, segments);
        if (!captured) {
          continue;
        }
        pathMatch = route;
        if (route.method === method) {
          methodMatch = route;
          params = captured;
          break;
        }
      }
      if (!methodMatch) {
        throw pathMatch ? methodNotAllowed() : notFound(`Unknown Page Assist path ${path}`);
      }

      await methodMatch.handler({ req, res, params: params ?? {}, scope });
    } catch (error) {
      if (error instanceof HttpError) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        sendStatus(res, error);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      scope.log?.error(`Page Assist route failed for ${method} ${path}: ${message}`);
      if (!res.headersSent) {
        sendStatus(res, new HttpError(500, "Page Assist request failed"));
      } else {
        // Headers are already on the wire, so the only honest signal left is a
        // broken stream; the browser treats it as a dropped request and recovers.
        res.destroy();
      }
    }
  };
}

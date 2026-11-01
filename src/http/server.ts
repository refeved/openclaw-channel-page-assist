import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { HTTP_PREFIX } from "../protocol.js";
import { PAGE_ASSIST_CHANNEL_ID } from "../accounts.js";
import { createPageAssistRequestHandler } from "./router.js";
import { pageAssistRoutes } from "./routes/index.js";
import type { PageAssistScope } from "./scope.js";

/** Liveness path on the dedicated port; answered by the host before routing. */
const HEALTH_PATH = "/healthz";

/**
 * Opens the Page Assist endpoint and returns its disposer.
 *
 * The Gateway owns the HTTP server: `legacyListener` makes it bind our loopback
 * port and forward every request under `/api/page-assist` into the gateway
 * pipeline, where our `auth: "plugin"` route picks it up. That keeps one listener
 * per process, so there is no sidecar to supervise and no second port competing
 * with the Gateway's own.
 *
 * Two details are load-bearing:
 * - `legacyListener` is only accepted with `auth: "plugin"`, which also means the
 *   route gets no operator scopes. Everything the endpoints need must come from
 *   the channel runtime, never from a gateway method call.
 * - Node's default 300s request timeout would sever an idle SSE stream, so the
 *   listener declares no request or socket deadline and the routes own their
 *   endings.
 */
export function startPageAssistEndpoint(scope: PageAssistScope): () => void {
  const handle = createPageAssistRequestHandler(scope, pageAssistRoutes);
  return registerPluginHttpRoute({
    path: HTTP_PREFIX,
    match: "prefix",
    auth: "plugin",
    pluginId: PAGE_ASSIST_CHANNEL_ID,
    source: "channel-endpoint",
    accountId: scope.account.accountId,
    reuseExistingSameOwner: true,
    // A port that cannot be bound must fail the account loudly: a silently missing
    // listener leaves the browser pointing at a connection that refuses.
    throwOnFailure: true,
    legacyListener: {
      port: scope.account.httpPort,
      host: scope.account.httpHost,
      health: { path: HEALTH_PATH, contentType: "text/plain" },
      timeouts: { headers: 60_000, request: 0, socket: 0 },
    },
    handler: (req, res) => handle(req, res),
    log: (message) => scope.log?.info(message),
  });
}

import { randomUUID } from "node:crypto";
import { resolveAgentIdentity } from "openclaw/plugin-sdk/agent-runtime";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { channelReadyPatch, channelStoppedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { startPageAssistEndpoint } from "./http/server.js";
import type { PageAssistScope } from "./http/scope.js";
import { tryGetPageAssistRuntime } from "./runtime.js";
import type { ResolvedPageAssistAccount } from "./types.js";

type PageAssistGatewayContext = ChannelGatewayContext<ResolvedPageAssistAccount>;

type RunningEndpoint = {
  unregister: () => void;
  /**
   * Flipped before teardown. New requests then answer 503 rather than queueing
   * onto an endpoint that is already closing.
   */
  beginStopping: () => void;
};

/**
 * One endpoint per account, keyed so a reload that restarts the account disposes
 * the previous listener before the same port is bound again.
 */
const runningEndpoints = new Map<string, RunningEndpoint>();

/**
 * Display name advertised on `/agents`: the agent's configured identity name, or
 * the id when no name was set. A browser that only ever shows `main` learns
 * nothing about which deployment it is talking to.
 */
export function resolvePageAssistAgentName(cfg: OpenClawConfig, agentId: string): string {
  return normalizeOptionalString(resolveAgentIdentity(cfg, agentId)?.name) ?? agentId;
}

/**
 * The config the Gateway is running right now, or `undefined` when no runtime surface
 * is reachable. The host hands out a read-only snapshot; the identity resolvers only
 * read from it, so the type is relaxed at this single boundary.
 */
function currentPageAssistConfig(): OpenClawConfig | undefined {
  try {
    return tryGetPageAssistRuntime()?.config.current() as OpenClawConfig | undefined;
  } catch {
    return undefined;
  }
}

/** Tears the endpoint down for one account. Safe to call more than once. */
export function stopPageAssistGatewayAccount(accountId: string): void {
  const running = runningEndpoints.get(accountId);
  if (!running) {
    return;
  }
  runningEndpoints.delete(accountId);
  running.beginStopping();
  running.unregister();
}

function abortPromise(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Starts the account: validates the configuration, opens the endpoint, and stays
 * until the Gateway aborts or stops it.
 *
 * There is no transport to poll — the browser drives every request. "Running"
 * therefore means the listener is registered and the shared token is in place, and
 * the returned promise simply holds the account open until it is retired.
 */
export async function startPageAssistGatewayAccount(ctx: PageAssistGatewayContext): Promise<void> {
  const account = ctx.account;
  const accountId = account.accountId;
  if (!account.configured) {
    throw new Error(
      `Page Assist cannot start for account "${accountId}": ` +
        (account.configError ?? "browserToken is required"),
    );
  }

  let notifyStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    notifyStopped = resolve;
  });

  if (!runningEndpoints.has(accountId)) {
    let stopping = false;
    const startupAgentName = resolvePageAssistAgentName(ctx.cfg, account.agentId);
    const scope: PageAssistScope = {
      account,
      instanceId: randomUUID(),
      principalScope: account.principalScope,
      // Renaming the agent is a config edit that does not restart this endpoint, so
      // `/agents` reads the live config and keeps the start-time name only as a fallback.
      resolveAgentName: () => {
        const cfg = currentPageAssistConfig();
        return cfg ? resolvePageAssistAgentName(cfg, account.agentId) : startupAgentName;
      },
      log: ctx.log,
      isStopping: () => stopping,
    };

    ctx.setStatus({
      accountId,
      running: true,
      lifecycle: "starting",
      configured: true,
      enabled: account.enabled,
    });

    let unregister: () => void;
    try {
      unregister = startPageAssistEndpoint(scope);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.log?.error(
        `Page Assist listener unavailable on ${account.httpHost}:${account.httpPort}: ${message}`,
      );
      ctx.setStatus({
        accountId,
        running: false,
        lifecycle: "blocked",
        configured: true,
        enabled: account.enabled,
        stateReason: message,
      });
      throw error;
    }

    runningEndpoints.set(accountId, {
      unregister,
      beginStopping: () => {
        stopping = true;
        notifyStopped?.();
      },
    });

    ctx.setStatus(channelReadyPatch({ accountId }));
    ctx.log?.info(
      `Page Assist endpoint ready on http://${account.httpHost}:${account.httpPort}/api/page-assist`,
    );
  } else {
    // A restart that reused the live listener must not rebind the port; it only
    // needs to keep the account open until the next stop arrives.
    ctx.setStatus(channelReadyPatch({ accountId }));
  }

  try {
    if (ctx.abortSignal.aborted) {
      return;
    }
    await Promise.race([stopped, abortPromise(ctx.abortSignal)]);
  } finally {
    stopPageAssistGatewayAccount(accountId);
    ctx.setStatus(channelStoppedPatch({ accountId }));
  }
}

/**
 * Explicit stop hook. The Gateway calls it when retiring an account without
 * aborting, so the disposer and the 503 gate run on both paths.
 */
export async function stopPageAssistGatewayAccountContext(
  ctx: PageAssistGatewayContext,
): Promise<void> {
  stopPageAssistGatewayAccount(ctx.account.accountId);
  ctx.setStatus(channelStoppedPatch({ accountId: ctx.account.accountId }));
}

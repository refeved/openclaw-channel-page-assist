import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { ResolvedPageAssistAccount } from "../types.js";

/** Log sink handed to us by the Gateway; kept optional so routes never depend on it. */
export type PageAssistLog = NonNullable<ChannelGatewayContext["log"]>;

/**
 * Everything an endpoint needs that is not per-request state. Built once per account
 * start, so routes never re-read account config mid-request; values the host can change
 * underneath a running endpoint are read through a resolver instead of copied.
 */
export type PageAssistScope = {
  account: ResolvedPageAssistAccount;
  /** Random id for this endpoint run, so the browser can tell a restart from a reconnect. */
  instanceId: string;
  /** sha256 of the browser token; the owner of every conversation and request. */
  principalScope: string;
  /** Display name advertised on `/agents`, read from the live config on each call. */
  resolveAgentName: () => string;
  log?: PageAssistLog;
  /** Flipped on stop so in-flight drains report 503 instead of accepting new work. */
  isStopping: () => boolean;
};

export type PageAssistRequest = {
  req: IncomingMessage;
  res: ServerResponse;
  /** Path parameters captured by the route pattern, e.g. `{ id: "req_1" }`. */
  params: Record<string, string>;
  scope: PageAssistScope;
};

export type PageAssistRouteHandler = (request: PageAssistRequest) => Promise<void> | void;

export type PageAssistRoute = {
  method: "GET" | "POST" | "DELETE";
  /** Absolute path under HTTP_PREFIX; `:name` segments become params. */
  path: string;
  handler: PageAssistRouteHandler;
};

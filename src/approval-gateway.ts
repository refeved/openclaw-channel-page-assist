/**
 * The operator-approvals bridge: one in-process Gateway client that can see the host's
 * pending approvals and apply a decision to them.
 *
 * A plugin HTTP route is not an operator client, so it holds none of the scopes that
 * approval reads require — the two routes therefore need a client of their own. The
 * Plugin SDK exports the factory (`createOperatorApprovalsGatewayClient`) but not the
 * one-call wrapper the host's own runtime uses, which is deliberate: a wrapper would
 * open a WebSocket per `/approvals` poll. This keeps a single connection for the life of
 * the endpoint, opens it on the first read, and reconnects when a call proves it dead.
 *
 * Failure policy is the other half of the design. Every error that is not a Gateway
 * answer — no config, no connection, a closed socket, a timeout — becomes one 503
 * sentence rather than an empty approval list: a browser that is shown no approvals
 * while one is pending will conclude its agent stopped working, and the honest reading of
 * a failed read is that the endpoint cannot know, not that there is nothing to know.
 */
import {
  ErrorCodes,
  createOperatorApprovalsGatewayClient,
  isGatewayClientRequestError,
  startGatewayClientWhenEventLoopReady,
  type GatewayClient,
} from "openclaw/plugin-sdk/gateway-runtime";
import {
  resolveApprovalOverGateway,
  type ApprovalResolveResult,
} from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PageAssistApprovalEntry, PageAssistApprovalKind } from "./approvals.js";
import { normalizeApprovalListResponse } from "./approvals.js";
import { conflict, forbidden, HttpError, serviceUnavailable } from "./http/respond.js";

/**
 * Ceiling on one approval call. The client's own request timeout is the host's default,
 * and a browser poll that outlives it would report a state the Gateway never confirmed.
 */
const APPROVAL_CALL_TIMEOUT_MS = 10_000;

/** Both list methods answer for one panel, so the poll is only as good as its worst half. */
const APPROVAL_LIST_METHODS = [
  { method: "exec.approval.list", kind: "exec" },
  { method: "plugin.approval.list", kind: "plugin" },
] as const satisfies ReadonlyArray<{ method: string; kind: PageAssistApprovalKind }>;

/** 503 sentence: the endpoint cannot tell the browser anything about approvals right now. */
const APPROVAL_SERVICE_UNAVAILABLE = "Approval service unavailable; retry shortly";

/**
 * Config source, read per call.
 *
 * A Gateway reload swaps the config object underneath a running endpoint, and the
 * bootstrap URL and auth token both come from it, so the bridge must not freeze the
 * snapshot it connected with.
 */
export type PageAssistApprovalGatewayOptions = {
  /** Labels the client in the host's approval surfaces; must not read as a person. */
  clientDisplayName: string;
  resolveConfig: () => OpenClawConfig | undefined;
  /** Debug sink: connection churn is noise at info level and a mystery without it. */
  debug?: (message: string) => void;
};

/** The adapter shape `resolveApprovalOverGateway` expects for its injected runtime. */
type ApprovalResolveRuntime = {
  request: (
    method: "approval.resolve",
    params: unknown,
    options?: { clientDisplayName?: string },
  ) => Promise<ApprovalResolveResult>;
};

function unavailable(context: string, error: unknown): HttpError {
  const detail = error instanceof Error ? error.message : String(error);
  return serviceUnavailable(`${APPROVAL_SERVICE_UNAVAILABLE} (${context}: ${detail})`);
}

/**
 * Turns a Gateway error answer into the contract's status.
 *
 * The host reports a missing or already-decided record several ways: the canonical code,
 * and an `INVALID_REQUEST` carrying `APPROVAL_ALREADY_RESOLVED` for a repeat decision on
 * a settled one. Both mean the same thing to a user — the row they clicked is gone — so
 * both take the reference channel's 409 sentence. A permission denial keeps the 403 the
 * reference channel uses, and everything else stays a 503, because guessing at a cause
 * the host did not state is how a wrong decision gets presented as a confirmed one.
 */
export function translateApprovalGatewayError(error: unknown): HttpError {
  if (!isGatewayClientRequestError(error)) {
    return serviceUnavailable(APPROVAL_SERVICE_UNAVAILABLE);
  }
  const reason =
    error.details && typeof error.details === "object" && !Array.isArray(error.details)
      ? (error.details as Record<string, unknown>).reason
      : undefined;
  if (error.gatewayCode === ErrorCodes.APPROVAL_NOT_FOUND) {
    return conflict("Approval already resolved or expired");
  }
  if (
    error.gatewayCode === ErrorCodes.INVALID_REQUEST &&
    reason === "APPROVAL_ALREADY_RESOLVED"
  ) {
    return conflict("Approval already resolved or expired");
  }
  if (error.gatewayCode === ErrorCodes.FORBIDDEN) {
    return forbidden("Approval caller does not own this request");
  }
  return serviceUnavailable(APPROVAL_SERVICE_UNAVAILABLE);
}

export class PageAssistApprovalGateway {
  private readonly options: PageAssistApprovalGatewayOptions;
  private client: GatewayClient | null = null;
  private connecting: Promise<GatewayClient> | null = null;
  private closed = false;

  constructor(options: PageAssistApprovalGatewayOptions) {
    this.options = options;
  }

  /**
   * Every pending approval this client can see, exec and plugin rows together.
   *
   * The two reads run concurrently because they are one panel's worth of state, and they
   * are not reconciled against each other: an id is unique across kinds, and the kind a
   * row carries is what the resolve call sends back.
   */
  async listPending(): Promise<PageAssistApprovalEntry[]> {
    const client = await this.acquire();
    try {
      const rows = await Promise.all(
        APPROVAL_LIST_METHODS.map(async (spec) => ({
          spec,
          value: await client.request<unknown>(spec.method, {}, { timeoutMs: APPROVAL_CALL_TIMEOUT_MS }),
        })),
      );
      return rows.flatMap((row) => normalizeApprovalListResponse(row.value, row.spec.kind));
    } catch (error) {
      // A transport that failed once is not trusted with the next poll either.
      this.discard(client);
      if (isGatewayClientRequestError(error)) {
        // An authorization or method answer is a stable fact, not a dead socket.
        throw translateApprovalGatewayError(error);
      }
      throw unavailable("list", error);
    }
  }

  /**
   * Applies one decision through the canonical `approval.resolve` call.
   *
   * `resolveApprovalOverGateway` is given this bridge as its runtime rather than left to
   * open its own client: the canonical path is what the Control UI uses, it carries the
   * record kind the host needs to route the decision, and injecting the runtime is the
   * only supported way to keep one connection.
   */
  async resolve(params: {
    approvalId: string;
    decision: "allow-once" | "allow-always" | "deny";
    approvalKind: PageAssistApprovalKind;
  }): Promise<ApprovalResolveResult> {
    const cfg = this.options.resolveConfig();
    if (!cfg) {
      throw serviceUnavailable(APPROVAL_SERVICE_UNAVAILABLE);
    }
    const client = await this.acquire();
    const runtime: ApprovalResolveRuntime = {
      request: async (method, resolveParams) =>
        client.request<ApprovalResolveResult>(method, resolveParams, {
          timeoutMs: APPROVAL_CALL_TIMEOUT_MS,
        }),
    };
    try {
      return await resolveApprovalOverGateway({
        cfg,
        approvalId: params.approvalId,
        decision: params.decision,
        approvalKind: params.approvalKind,
        clientDisplayName: this.options.clientDisplayName,
        gatewayRuntime: runtime,
      });
    } catch (error) {
      this.discard(client);
      if (isGatewayClientRequestError(error)) {
        throw translateApprovalGatewayError(error);
      }
      throw unavailable("resolve", error);
    }
  }

  /**
   * Opens the connection without waiting for it, so a run that could raise an approval
   * does not depend on the browser having polled yet.
   *
   * The host expires an exec approval the moment it is raised if no approval surface is
   * connected for it to route to, and this endpoint connects lazily on the first read. A
   * fast model can therefore finish its tool call before the browser's first poll has
   * opened the socket, and the approval is lost rather than merely delayed — which no
   * retry would recover, because the record is already gone. Starting the run is the last
   * moment before that window opens, and a shared connection makes the call a no-op
   * whenever the browser is already polling.
   *
   * Failure is deliberately not the run's problem: an agent turn must not be abandoned
   * because its approval panel could not connect, and the poll still reports 503.
   */
  prefetch(): void {
    this.acquire().catch((error: unknown) => {
      this.options.debug?.(`approval preflight failed: ${String(error)}`);
    });
  }

  /**
   * Closes the bridge for good. Called while the endpoint is being retired, so a late
   * reconnect must not resurrect the connection after the port is gone.
   */
  async close(): Promise<void> {
    this.closed = true;
    const connecting = this.connecting;
    const client = this.client;
    this.client = null;
    this.connecting = null;
    // A start that is still in flight would otherwise hand back a client nobody owns.
    await connecting?.catch(() => undefined);
    if (!client) {
      return;
    }
    await client.stopAndWait({ timeoutMs: APPROVAL_CALL_TIMEOUT_MS }).catch(() => {
      client.stop();
    });
  }

  /**
   * The live client, connecting once on demand.
   *
   * Concurrent polls share one start: two WebSocket handshakes for one panel would show
   * the same approval twice, and the second connection would outlive the first.
   */
  private async acquire(): Promise<GatewayClient> {
    if (this.closed) {
      throw serviceUnavailable("Channel is stopping");
    }
    const existing = this.client;
    if (existing && existing.connected) {
      return existing;
    }
    if (existing) {
      // The host reconnects a dropped socket on its own, so a closed connection is only
      // worth waiting for while it is not actually shut down.
      this.discard(existing);
    }
    this.connecting ??= this.connect();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async connect(): Promise<GatewayClient> {
    const cfg = this.options.resolveConfig();
    if (!cfg) {
      throw serviceUnavailable(APPROVAL_SERVICE_UNAVAILABLE);
    }
    let settleReady: (error: Error | null) => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      settleReady = (error) => (error ? reject(error) : resolve());
    });
    // The handshake can fail before anyone awaits `ready`, and an unobserved rejection
    // would end the process under Node's default mode.
    ready.catch(() => undefined);

    const client = await createOperatorApprovalsGatewayClient({
      config: cfg,
      clientDisplayName: this.options.clientDisplayName,
      onHelloOk: () => settleReady(null),
      onConnectError: (error) => settleReady(error instanceof Error ? error : new Error(String(error))),
      onClose: (code, reason) => {
        this.options.debug?.(`approval client closed (${code}) ${reason}`);
        settleReady(new Error(`gateway closed (${code}): ${reason}`));
      },
    });

    if (this.closed) {
      client.stop();
      throw serviceUnavailable("Channel is stopping");
    }
    try {
      const readiness = await startGatewayClientWhenEventLoopReady(client, { clientOptions: {} });
      if (!readiness.ready) {
        throw new Error(
          readiness.aborted
            ? "gateway approval client start aborted before readiness"
            : "gateway readiness unavailable before approval client start",
        );
      }
      await ready;
    } catch (error) {
      client.stop();
      if (error instanceof HttpError) {
        throw error;
      }
      throw unavailable("connect", error);
    }
    if (this.closed) {
      client.stop();
      throw serviceUnavailable("Channel is stopping");
    }
    this.client = client;
    this.options.debug?.("approval client connected");
    return client;
  }

  /** Detaches a client the bridge no longer trusts, and stops it outside the lock. */
  private discard(client: GatewayClient): void {
    if (this.client === client) {
      this.client = null;
    }
    client.stop();
  }
}

/** Builds the bridge for one endpoint run; the caller owns `close()`. */
export function createPageAssistApprovalGateway(
  options: PageAssistApprovalGatewayOptions,
): PageAssistApprovalGateway {
  return new PageAssistApprovalGateway(options);
}

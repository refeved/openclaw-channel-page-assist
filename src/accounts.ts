import { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-scope-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  checkBrowserToken,
  checkHttpPort,
  derivePrincipalScope,
} from "./protocol.js";
import type { CoreConfig, ResolvedPageAssistAccount } from "./types.js";

export const PAGE_ASSIST_CHANNEL_ID = "page-assist" as const;

const DEFAULT_HTTP_HOST = "127.0.0.1";
/** QwenPaw's channel keeps 8766, so a Gateway on the same box can run both. */
const DEFAULT_HTTP_PORT = 8767;

/**
 * Resolves the single endpoint from config. This never throws: an unusable token
 * reports `configured: false` plus the reason, so `channels status` can show it
 * and Doctor can flag it without a stack trace from account listing.
 */
export function resolvePageAssistAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedPageAssistAccount {
  const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
  const section = params.cfg.channels?.[PAGE_ASSIST_CHANNEL_ID] ?? {};
  const baseEnabled = params.cfg.channels?.[PAGE_ASSIST_CHANNEL_ID]?.enabled !== false;
  const enabled = baseEnabled && section.enabled !== false;
  const browserToken = normalizeOptionalString(section.browserToken) ?? "";
  const httpHost = normalizeOptionalString(section.httpHost) ?? DEFAULT_HTTP_HOST;
  const httpPort = section.httpPort ?? DEFAULT_HTTP_PORT;
  const agentId = normalizeOptionalString(section.agentId) ?? resolveDefaultAgentId(params.cfg);

  const tokenCheck = browserToken ? checkBrowserToken(browserToken) : { ok: false as const, reason: "browserToken is required" };
  const portCheck = checkHttpPort(httpPort);
  const configError = !tokenCheck.ok
    ? tokenCheck.reason
    : !portCheck.ok
      ? portCheck.reason
      : undefined;

  return {
    accountId,
    enabled,
    configured: configError === undefined && browserToken.length > 0,
    name: normalizeOptionalString(section.name),
    agentId,
    principalScope: browserToken ? derivePrincipalScope(browserToken) : "",
    browserToken,
    httpHost,
    httpPort,
    mediaMaxBytes: resolveChannelMediaMaxBytes({
      cfg: params.cfg,
      accountId,
      resolveChannelLimitMb: () => section.mediaMaxMb,
    }),
    allowFrom: section.allowFrom ?? ["*"],
    ...(configError ? { configError } : {}),
    config: section,
  };
}

export function listPageAssistAccountIds(_cfg: CoreConfig): string[] {
  // One endpoint per Gateway: a second browser installation is a second Gateway,
  // not a second account, so the list is always the implicit default.
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultPageAssistAccountId(_cfg: CoreConfig): string {
  return DEFAULT_ACCOUNT_ID;
}

export { DEFAULT_ACCOUNT_ID };
export type { ResolvedPageAssistAccount } from "./types.js";

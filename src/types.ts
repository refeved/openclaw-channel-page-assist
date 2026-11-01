import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PageAssistAccountConfig } from "./config-schema.js";

export type { PageAssistAccountConfig };

/** Channel section shape as it appears in `openclaw.json`. */
export type CoreConfig = OpenClawConfig & {
  channels?: {
    "page-assist"?: PageAssistAccountConfig;
  };
};

export type ResolvedPageAssistAccount = {
  accountId: string;
  enabled: boolean;
  /**
   * False when the shared browser token is missing or unusable. The endpoint must
   * not come up without it, because an open loopback port would then accept any
   * local process as the browser.
   */
  configured: boolean;
  /** Human label from config, shown by `openclaw channels status`. */
  name?: string;
  /** The one agent this endpoint drives. Requests naming another agent are refused. */
  agentId: string;
  /** sha256 of the browser token; owns conversations, requests, and approvals. */
  principalScope: string;
  /** Raw token, kept in memory only, for constant-time bearer comparison. */
  browserToken: string;
  httpHost: string;
  httpPort: number;
  /** Resolved from `mediaMaxMb` or the host default; undefined lets the host decide. */
  mediaMaxBytes?: number;
  allowFrom: Array<string | number>;
  /** Populated when the config is unusable, so status and logs can explain it. */
  configError?: string;
  config: PageAssistAccountConfig;
};

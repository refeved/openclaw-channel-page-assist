import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
import {
  PAGE_ASSIST_CHANNEL_ID,
  listPageAssistAccountIds,
  resolveDefaultPageAssistAccountId,
  resolvePageAssistAccount,
} from "./accounts.js";
import { pageAssistPluginConfigSchema } from "./config-schema.js";
import {
  startPageAssistGatewayAccount,
  stopPageAssistGatewayAccountContext,
} from "./gateway.js";
import type { CoreConfig, ResolvedPageAssistAccount } from "./types.js";

/**
 * Channel identity. Page Assist is not in the host's bundled chat-meta catalog, so
 * it owns its metadata instead of spreading a lookup that could only be undefined.
 */
export const pageAssistRuntimeMeta = {
  id: PAGE_ASSIST_CHANNEL_ID,
  label: "Page Assist",
  selectionLabel: "Page Assist",
  detailLabel: "Page Assist",
  blurb: "Browser sidebar channel: one loopback endpoint driving one agent.",
};

/**
 * Surfaces the channel owns. `messaging`, `outbound`, and the approval bridge are
 * added with their own phases, because a half-wired adapter is worse to debug than
 * an absent one: the host then routes replies into a stub that pretends success.
 */
type PageAssistPluginBase = Pick<
  ChannelPlugin<ResolvedPageAssistAccount>,
  "id" | "meta" | "capabilities" | "reload" | "configSchema" | "setupContract" | "config" | "gateway"
>;

function applyPageAssistSetup(params: {
  cfg: CoreConfig;
  input: Record<string, unknown>;
}): CoreConfig {
  const { cfg, input } = params;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [PAGE_ASSIST_CHANNEL_ID]: {
        ...cfg.channels?.[PAGE_ASSIST_CHANNEL_ID],
        ...input,
      },
    },
  } as CoreConfig;
}

function createPageAssistPluginBase(): PageAssistPluginBase {
  return {
    id: PAGE_ASSIST_CHANNEL_ID,
    meta: pageAssistRuntimeMeta,
    capabilities: {
      chatTypes: ["direct"],
      // Replies carry no media and inbound files are not accepted until those
      // phases land, so the host must not offer either to the agent.
      media: false,
    },
    reload: { configPrefixes: [`channels.${PAGE_ASSIST_CHANNEL_ID}`] },
    configSchema: pageAssistPluginConfigSchema,
    setupContract: defineChannelSetupContract({
      fields: {
        // Marked sensitive so onboarding never echoes it back into logs or help output.
        browserToken: {
          kind: "string",
          sensitive: true,
          cli: {
            flags: "--browser-token <token>",
            description: "Shared bearer token the browser extension presents",
          },
        },
        agentId: {
          kind: "string",
          cli: { flags: "--agent-id <id>", description: "Agent this endpoint drives" },
        },
        httpPort: {
          kind: "integer",
          cli: { flags: "--http-port <port>", description: "Loopback port to bind" },
        },
      },
      adapter: {
        applyAccountConfig: ({ cfg, input }) =>
          applyPageAssistSetup({ cfg: cfg as CoreConfig, input: input as Record<string, unknown> }),
      },
    }),
    config: {
      listAccountIds: (cfg) => listPageAssistAccountIds(cfg as CoreConfig),
      resolveAccount: (cfg, accountId) =>
        resolvePageAssistAccount({ cfg: cfg as CoreConfig, accountId }),
      defaultAccountId: (cfg) => resolveDefaultPageAssistAccountId(cfg as CoreConfig),
      isConfigured: (account) => account.configured,
      inspectAccount: (cfg, accountId) => {
        const account = resolvePageAssistAccount({ cfg: cfg as CoreConfig, accountId });
        return {
          enabled: account.enabled,
          configured: account.configured,
          // The token itself never leaves config; status only reports whether it exists.
          tokenStatus: account.browserToken ? "available" : "missing",
        };
      },
    },
    gateway: {
      startAccount: (ctx) => startPageAssistGatewayAccount(ctx),
      stopAccount: (ctx) => stopPageAssistGatewayAccountContext(ctx),
    },
  };
}

export const pageAssistPlugin: ChannelPlugin<ResolvedPageAssistAccount> = createChatChannelPlugin({
  base: createPageAssistPluginBase(),
});

import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

/**
 * `channels.page-assist` holds one endpoint bound to one agent, so there is no
 * account map: a second installation is a second Gateway, not a second account.
 * `.strict()` keeps typos from silently reading as "unconfigured".
 */
const PageAssistConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    name: z.string().optional(),
    /** Shared secret the extension sends as `Authorization: Bearer <token>`. */
    browserToken: z.string().optional(),
    /** Agent this endpoint drives; defaults to the Gateway's default agent. */
    agentId: z.string().optional(),
    httpHost: z.string().min(1).optional(),
    httpPort: z.number().int().min(1).max(65535).optional(),
    mediaMaxMb: z.number().positive().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .strict();

export type PageAssistAccountConfig = z.input<typeof PageAssistConfigSchema>;

export const pageAssistPluginConfigSchema = buildChannelConfigSchema(PageAssistConfigSchema);

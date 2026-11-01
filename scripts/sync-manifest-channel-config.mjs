/**
 * Regenerates `openclaw.plugin.json#channelConfigs` from the Zod schema in
 * `src/config-schema.ts`.
 *
 * The manifest copy is the host's cold path: config validation, `openclaw channels
 * status`, and the setup wizard read it before the plugin runtime is loaded. A
 * hand-maintained duplicate drifts the first time a field is added, and the drift is
 * invisible until someone edits config through the wizard. So the JSON Schema is
 * generated from the same source the runtime parser uses, and
 * `test/manifest.test.ts` fails if the manifest and the schema disagree again.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pageAssistPluginConfigSchema } from "../src/config-schema.ts";

const manifestPath = new URL("../openclaw.plugin.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
// The manifest owns the channel id, so the generated key cannot drift from the id
// the host already registered this plugin under.
const channelId = manifest.id;

/** Field-by-field labels for the Control UI form; `sensitive` keeps values out of logs. */
const uiHints = {
  enabled: { label: "Enabled" },
  name: { label: "Display name" },
  browserToken: {
    label: "Browser token",
    sensitive: true,
    help: "Shared secret the sidebar sends as Authorization: Bearer <token>. At least 32 ASCII characters.",
    placeholder: "paste the token from the extension settings",
  },
  agentId: {
    label: "Agent id",
    help: "Agent this endpoint drives. Defaults to the Gateway's default agent.",
  },
  httpHost: { label: "Bind address", advanced: true },
  httpPort: { label: "Port", advanced: true },
  mediaMaxMb: { label: "Max media size (MB)", advanced: true },
  allowFrom: { label: "Allow from", advanced: true },
};

manifest.channelConfigs = {
  ...(manifest.channelConfigs ?? {}),
  [channelId]: {
    label: "Page Assist",
    description: "Page Assist browser sidebar endpoint.",
    schema: pageAssistPluginConfigSchema.schema,
    uiHints,
  },
};

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`channelConfigs.${channelId}.schema rewritten from src/config-schema.ts`);

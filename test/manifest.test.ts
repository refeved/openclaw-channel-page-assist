import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pageAssistPluginConfigSchema } from "../src/config-schema.ts";

/**
 * openclaw.plugin.json is the host's cold path: config validation, `channels status`,
 * and the setup wizard read it before any plugin code runs, so a stale copy rejects or
 * mislabels fields the runtime parser actually accepts. The sync script generates this
 * block from the Zod schema; these assertions catch a manifest that was never regenerated.
 */
const manifest = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as {
  id: string;
  channels: string[];
  channelConfigs: Record<string, { schema: Record<string, unknown>; uiHints: Record<string, object> }>;
};

const channelConfig = manifest.channelConfigs[manifest.id];

test("manifest carries the generated copy of the runtime schema", () => {
  assert.ok(manifest.channels.includes(manifest.id));
  assert.ok(channelConfig, `channelConfigs.${manifest.id} missing; run npm run sync:manifest`);
  assert.deepEqual(channelConfig.schema, pageAssistPluginConfigSchema.schema);
});

test("every cold-path hint names a field the schema declares", () => {
  const properties = Object.keys(
    (channelConfig.schema as { properties?: Record<string, unknown> }).properties ?? {},
  );
  for (const field of Object.keys(channelConfig.uiHints)) {
    assert.ok(properties.includes(field), `uiHints.${field} has no matching schema property`);
  }
});

test("the cold-path schema parses the config the runtime parser accepts", () => {
  const config = { browserToken: "0123456789abcdefghijklmnopqrstuvwxyz", httpPort: 8767 };
  assert.equal(pageAssistPluginConfigSchema.runtime?.safeParse(config).success, true);
  // A typo must not read as "unconfigured", so the strict object rejects unknown keys.
  assert.equal(
    pageAssistPluginConfigSchema.runtime?.safeParse({ ...config, browserTokens: "x" }).success,
    false,
  );
});

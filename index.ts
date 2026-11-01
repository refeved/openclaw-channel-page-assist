import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { pageAssistPlugin } from "./src/channel.js";
import { setPageAssistPluginVersion, setPageAssistRuntime } from "./src/runtime.js";

/**
 * Page Assist channel plugin entry.
 *
 * The plugin registers one channel: an authenticated loopback HTTP endpoint that
 * the Page Assist browser extension drives. Everything it can do goes through the
 * Gateway's own channel runtime, so no companion process is required.
 */
export default defineChannelPluginEntry({
  id: "page-assist",
  name: "Page Assist",
  description: "Drive one OpenClaw agent from the Page Assist browser sidebar.",
  plugin: pageAssistPlugin,
  setRuntime: setPageAssistRuntime,
  registerFull(api) {
    // The version the Gateway actually loaded, which is what the browser should show.
    setPageAssistPluginVersion(api.version);
  },
});

import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { pageAssistPlugin } from "./src/channel.js";

/**
 * Setup-side entry. `openclaw channels add page-assist` loads this instead of the
 * runtime entry, so onboarding does not need the Gateway's channel machinery.
 */
export default defineSetupPluginEntry(pageAssistPlugin);

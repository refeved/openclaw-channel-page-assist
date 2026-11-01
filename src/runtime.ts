import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

/**
 * The Gateway hands a runtime surface to the entry at registration. Routes need it
 * for inbound dispatch, session binding, and media, and it is only reachable before
 * `startAccount`, so it is captured once here.
 */
const { setRuntime: setPageAssistRuntime, getRuntime: getPageAssistRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "page-assist",
    errorMessage: "Page Assist runtime not initialized",
  });

let pluginVersion: string | undefined;

/**
 * Records `api.version`, the package version the Gateway actually loaded. The
 * browser shows it so a user can tell which deployment answered; nothing may
 * depend on it, so an unavailable version is omitted rather than guessed.
 */
export function setPageAssistPluginVersion(version: string | undefined): void {
  const trimmed = version?.trim();
  if (trimmed) {
    pluginVersion = trimmed;
  }
}

export function getPageAssistPluginVersion(): string | undefined {
  return pluginVersion;
}

export { getPageAssistRuntime, setPageAssistRuntime };

import type { PageAssistRoute } from "../scope.js";
import { pageAssistAgentsRoute } from "./agents.js";
import { pageAssistCapabilitiesRoute } from "./capabilities.js";

/**
 * The endpoint's route table. Additions land here in contract order, and every
 * entry must be reachable by the browser's own client code; a route the extension
 * never calls is a maintenance burden, not a feature.
 */
export const pageAssistRoutes: readonly PageAssistRoute[] = [
  pageAssistCapabilitiesRoute,
  pageAssistAgentsRoute,
];

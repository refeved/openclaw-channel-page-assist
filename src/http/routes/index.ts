import type { PageAssistRoute } from "../scope.js";
import { pageAssistAgentsRoute } from "./agents.js";
import { pageAssistUploadAttachmentRoute } from "./attachments.js";
import { pageAssistCapabilitiesRoute } from "./capabilities.js";
import {
  pageAssistCreateConversationRoute,
  pageAssistHistoryRoute,
  pageAssistSubmitMessageRoute,
} from "./conversations.js";
import { pageAssistMediaRoute } from "./media.js";
import { pageAssistEventsRoute, pageAssistRequestRoute } from "./requests.js";

/**
 * The endpoint's route table. Additions land here in contract order, and every
 * entry must be reachable by the browser's own client code; a route the extension
 * never calls is a maintenance burden, not a feature.
 */
export const pageAssistRoutes: readonly PageAssistRoute[] = [
  pageAssistCapabilitiesRoute,
  pageAssistAgentsRoute,
  pageAssistCreateConversationRoute,
  pageAssistSubmitMessageRoute,
  pageAssistHistoryRoute,
  pageAssistUploadAttachmentRoute,
  pageAssistMediaRoute,
  pageAssistRequestRoute,
  pageAssistEventsRoute,
];

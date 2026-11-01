import { HTTP_PREFIX } from "../../protocol.js";
import { sendJson } from "../respond.js";
import type { PageAssistRoute } from "../scope.js";

/**
 * `GET /api/page-assist/agents`
 *
 * One endpoint drives exactly one agent, so the list has one entry. The name is
 * the label the user configured, never the raw id: the browser shows it as the
 * assistant's identity, and an id reads as a broken deployment.
 */
export const pageAssistAgentsRoute: PageAssistRoute = {
  method: "GET",
  path: `${HTTP_PREFIX}/agents`,
  handler: ({ res, scope }) => {
    sendJson(res, 200, {
      agents: [{ id: scope.account.agentId, name: scope.resolveAgentName() }],
    });
  },
};

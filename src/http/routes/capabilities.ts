// The published package ships OPENCLAW_VERSION on two re-export paths; only this one
// carries a .d.ts, so the host version stays type-checked instead of locally declared.
import { OPENCLAW_VERSION } from "openclaw/plugin-sdk/agent-harness-runtime";
import { getPageAssistPluginVersion } from "../../runtime.js";
import { HTTP_PREFIX, buildCapabilities } from "../../protocol.js";
import { sendJson } from "../respond.js";
import type { PageAssistRoute } from "../scope.js";

/**
 * `GET /api/page-assist/capabilities`
 *
 * The browser's first call, and the only place it learns what this host can do.
 * A switch that is on without a working implementation behind it is a bug the
 * user finds as a hung request, so each flag turns on together with its code.
 */
export const pageAssistCapabilitiesRoute: PageAssistRoute = {
  method: "GET",
  path: `${HTTP_PREFIX}/capabilities`,
  handler: ({ res, scope }) => {
    sendJson(
      res,
      200,
      buildCapabilities({
        instanceId: scope.instanceId,
        principalScope: scope.principalScope,
        approvals: false,
        attachments: false,
        media: false,
        channelVersion: getPageAssistPluginVersion(),
        hostVersion: OPENCLAW_VERSION,
      }),
    );
  },
};

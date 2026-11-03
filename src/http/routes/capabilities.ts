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
        // Poll-only: the browser reads `/approvals` on its own cadence, and `approvalEvents`
        // stays false because no SSE push for host approval changes is implemented here.
        approvals: true,
        // Both flags belong to the same feature: the browser reads `attachments` for the
        // upload control and `media` for every byte fetch, including the upload it just
        // sent coming back from a restored history. One without the other is a composer
        // that accepts a file it can never show, so they light together — as they do in
        // the reference channel.
        attachments: true,
        media: true,
        // Publishes the ceiling this endpoint actually enforces, so an operator who set a
        // tighter `mediaMaxMb` never has a browser that planned for 5 MB.
        mediaMaxBytes: scope.account.mediaMaxBytes,
        channelVersion: getPageAssistPluginVersion(),
        hostVersion: OPENCLAW_VERSION,
      }),
    );
  },
};

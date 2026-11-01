# Page Assist channel for OpenClaw

An OpenClaw Gateway channel plugin that lets the [Page Assist](https://github.com/refeved/page-assist-agent-usage)
browser sidebar talk to one OpenClaw agent over a local, authenticated HTTP
endpoint — the same wire contract the QwenPaw channel serves, so the extension
needs no host-specific branch.

**Status: bring-up (P1).** The plugin loads, the channel appears in
`openclaw channels status`, and the chat loop is closed: creating a
conversation, submitting a message, reading history, polling a request, and
streaming its events all reach a real agent run. Attachments, reply media, and
in-browser approvals land in the following phases; until they do, the
corresponding capability switches stay `false` so the browser disables those
controls instead of hanging on a reply that cannot arrive.

Everything above `Status` has been exercised against a real Gateway
(OpenClaw 2026.10.9) with a stub OpenAI-compatible provider: plugin load,
`channels status`, every live endpoint below, the 401/404/405 responses, a
config hot reload that stops and restarts the endpoint on the same port, a turn
that carries the page context into the model and settles `completed`, one agent
session per browser conversation, and an explicit channel stop that settles an
in-flight request `cancelled` while its open stream still receives the terminal
frame.

## What the endpoint is

| | |
| --- | --- |
| Bound address | `127.0.0.1:8767` by default (`httpHost` / `httpPort`) |
| Path prefix | `/api/page-assist` |
| Auth | `Authorization: Bearer <browserToken>`; constant-time over the whole header |
| Principal | `sha256(browserToken)`, which owns conversations, requests, and approvals |
| Port choice | 8767 so a machine can run the QwenPaw channel on 8766 alongside |

The listener is opened through the Gateway's own HTTP pipeline
(`registerPluginHttpRoute` with a dedicated `legacyListener` port), so there is no
sidecar process, no second HTTP server to supervise, and no port fighting with the
Gateway's main listener.

## Requirements

- OpenClaw `>= 2026.10.9`
- Node.js `>= 24.22.1` (the host's own floor)

## Build and install

```bash
npm install
npm run build
npm pack --pack-destination /tmp
openclaw plugins install npm-pack:/tmp/refeved-openclaw-channel-page-assist-0.1.0.tgz
openclaw plugins inspect page-assist --runtime --json
```

For development, point the host at the checkout instead of packing every round:

```jsonc
{
  "plugins": { "load": { "paths": ["/path/to/openclaw-channel-page-assist"] } }
}
```

## Configure the channel

```jsonc
{
  "channels": {
    "page-assist": {
      "browserToken": "<32+ ASCII characters, no whitespace>",
      "agentId": "main",
      "httpPort": 8767
    }
  }
}
```

`browserToken` is mandatory and is compared, never logged. `agentId` defaults to
the Gateway's default agent; `name` labels the account in status output;
`mediaMaxMb` overrides the host media ceiling once reply media is wired up.

Then in the browser extension choose **Remote agent** and enter
`http://127.0.0.1:8767/api/page-assist` with the same token.

`GET /agents` reports the display name from `agents.*.identity.name`, falling
back to the agent id. It is resolved from the live config on every request,
because renaming an agent is a config edit that does not have to restart the
endpoint.

## How a turn runs

`POST /conversations/{id}/messages` answers `202` as soon as the request is
recorded, then runs the agent turn behind the response. The turn has to be
started through `runDetachedWebhookWork`: a plain detached promise inherits the
HTTP request's Gateway work admission, and that admission is released once the
`202` is written, so the session work inside the turn would be refused as if
the Gateway were restarting.

One browser conversation is one agent session. The turn routes through
`dmScope: "per-channel-peer"`, which gives
`agent:<agentId>:page-assist:direct:<conversationId>`, so a chat's history
stays inside that chat; an operator binding can still override the scope,
because bindings win over the plugin's argument. Replies are appended to the
transcript the browser polls, so the channel has no outbound transport and
advertises no durable delivery.

The browser can follow the turn with `GET /requests/{id}/events`. Frames are
`request.state`, then `message.snapshot` per reply, then `request.terminal`, and
the server ends the stream itself. Subscribe after submitting: an unknown
request id answers `404` in this instance, which is how a restarted endpoint
tells the browser that its history is gone.

A stop settles everything in flight as `cancelled`, aborts the agent run, and
closes open streams. A config hot reload does not: the host defers a channel
reload until active Gateway work drains, so a running turn finishes before the
restart lands. `channels.stop` is the path that retires the account under a
running turn.

## Endpoint coverage

| Endpoint | State |
| --- | --- |
| `GET /capabilities` | live |
| `GET /agents` | live |
| `POST /conversations`, `POST /conversations/{id}/messages` | live |
| `GET /conversations/{id}/messages` | live |
| `GET /requests/{id}`, `GET /requests/{id}/events` (SSE) | live |
| `GET /approvals`, `POST /approvals/{id}/decision` | pending (host approval registry + native resolve) |
| `POST /attachments`, `GET /media/{id}` | pending (inbound files, reply media) |

## Development

```bash
npm test           # contract tests, no Gateway needed
npm run typecheck
npm run sync:manifest   # regenerate manifest channelConfigs from the zod schema
```

`src/protocol.ts` holds the shared wire contract and stays free of SDK imports so
the browser-visible field set and limits can be asserted without a host present.

`openclaw.plugin.json` carries a `channelConfigs.page-assist` block that the host
reads *before* the plugin runtime loads, to validate `channels.page-assist` and to
build the setup wizard. Writing that JSON Schema by hand would let it drift from
the zod schema the runtime actually enforces, so `npm run sync:manifest` generates
it and `test/manifest.test.ts` fails if the two disagree. The script rewrites the
whole manifest, so its JSON formatting is whatever `JSON.stringify` produces.

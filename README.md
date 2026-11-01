# Page Assist channel for OpenClaw

An OpenClaw Gateway channel plugin that lets the [Page Assist](https://github.com/refeved/page-assist-agent-usage)
browser sidebar talk to one OpenClaw agent over a local, authenticated HTTP
endpoint — the same wire contract the QwenPaw channel serves, so the extension
needs no host-specific branch.

**Status: bring-up (P0).** The plugin loads, the channel appears in
`openclaw channels status`, and the endpoint answers `GET /capabilities` and
`GET /agents`. Message submission, streaming, attachments, reply media, and
in-browser approvals land in the following phases; until they do, the
corresponding capability switches stay `false` so the browser disables those
controls instead of hanging on a reply that cannot arrive.

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

## Endpoint coverage

| Endpoint | State |
| --- | --- |
| `GET /capabilities` | live |
| `GET /agents` | live |
| `POST /conversations`, `POST /conversations/{id}/messages` | pending (inbound dispatch) |
| `GET /requests/{id}`, `GET /requests/{id}/events` (SSE) | pending (turn state + stream) |
| `GET /approvals`, `POST /approvals/{id}/decision` | pending (host approval registry + native resolve) |
| `POST /attachments`, `GET /media/{id}` | pending (inbound files, reply media) |

## Development

```bash
npm test        # contract tests, no Gateway needed
npm run typecheck
```

`src/protocol.ts` holds the shared wire contract and stays free of SDK imports so
the browser-visible field set and limits can be asserted without a host present.

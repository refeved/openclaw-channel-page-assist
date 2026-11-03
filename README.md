# Page Assist channel for OpenClaw

An OpenClaw Gateway channel plugin that lets the [Page Assist](https://github.com/refeved/page-assist-agent-usage)
browser sidebar talk to one OpenClaw agent over a local, authenticated HTTP
endpoint — the same wire contract the QwenPaw channel serves, so the extension
needs no host-specific branch.

**Status: bring-up (P3).** The plugin loads, the channel appears in
`openclaw channels status`, and both halves of the loop are closed: creating a
conversation, submitting a message, reading history, polling a request, streaming
its events, uploading a file for the agent to read, and turning the agent's own
reply files into browser-served downloads all reach a real agent run — and a
command the host wants to gate now surfaces as an in-browser approval the user can
allow or refuse. The endpoint advertises `approvals: true` with
`approvalEvents: false`, so the browser drives those controls from its own poll
rather than waiting on a push channel this plugin does not have.

Everything above `Status` has been exercised against a real Gateway
(OpenClaw 2026.10.9) with a stub OpenAI-compatible provider: plugin load,
`channels status`, every live endpoint below, the 401/404/405 responses, a
config hot reload that stops and restarts the endpoint on the same port, a turn
that carries the page context into the model and settles `completed`, one agent
session per browser conversation, an explicit channel stop that settles an
in-flight request `cancelled` while its open stream still receives the terminal
frame, an upload that the next message consumes exactly once, a reply that
carries local files, a public URL and refused references in the same turn, and the
ceiling sentences that a full composer or a crowded reply provokes, plus an
operator `mediaMaxMb` moving the advertised ceiling and the upload refusal
together, an approval row that a browser saw without having polled yet, the
`waiting_approval` state a pending row writes and the state its decision restores,
the 400/404/409 replies that keep a wrong decision from looking like a confirmed
one, an allowed decision whose command output came back in the reply, and a denied
one whose refusal the reply repeats.

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
`mediaMaxMb` (or `agents.defaults.mediaMaxMb`) can only *lower* the 5 MB per-file
ceiling the contract publishes — it is applied to uploads, reply media and the
`GET /media` read alike, and `/capabilities` advertises the lowered number so the
browser never plans around a limit this endpoint does not enforce.

Then in the browser extension choose **Remote agent** and enter the service
origin `http://127.0.0.1:8767` with the same token. The extension appends the
protocol prefix itself and refuses a saved URL that already carries a path, so
the origin is the whole address.

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

The transcript is what the host hands the channel, nothing more. In the measured
build a reply whose second line read like an internal tool marker (`toolResult=…`)
arrived at the channel with that line already removed, while an ordinary trailing
line in the same build reached the browser intact. The endpoint appends the text it
is given and does not reassemble what the host filtered, so a missing marker line
is a host decision, not a lost row here.

## Attachments and reply media

Both directions ride one protected route, `GET /media/{id}`, so the browser keeps
a single fetch path and a single place to attach its token.

**Inbound.** `POST /attachments` takes `{ name, mediaType, data }` with `data` as
`btoa()` output, refuses anything it cannot decode or name with the contract's
plain 400, and stages the bytes into the host's own inbound media bucket — the
agent reads a browser upload exactly as it reads an attachment from a native
channel. The answer is an opaque UUID, because a store id embeds the uploader's
filename and the wire promises it never will. A message then consumes uploads by
id, once: `attachments` moves each id out of the pending ledger, and naming the
same id again is `Attachment unavailable; upload it again` rather than a second
copy of a file the user already sent. Four per message, thirty-two pending
uploads, and the overflow answers `429` so an abandoned composer draft cannot
hold bytes open indefinitely.

**Outbound.** A reply names its media as `MEDIA:<path-or-url>` lines, which the
host resolves before the channel sees them. Public HTTPS is forwarded untouched —
fetching it here would turn a loopback endpoint into a proxy for any address the
agent named — and everything else is copied into the plugin's own bucket under a
fresh UUID, which also detaches the reply from the host's outbound-directory
churn. A reference that cannot travel is announced in the reply text with the
reference channel's own sentence (`[file: plan.pdf is no longer available]`,
`[Media 'clip.mp4' is larger than 5 MB and was skipped.]`,
`[image: chart.png skipped, more than 4 attachments]`) instead of disappearing.

**Kind and type.** QwenPaw reads an attachment's `kind` off the media part its
framework builds; an OpenClaw reply carries a bare reference with no part. So the
kind is settled from evidence in a fixed order — metadata the host prepared, then
the sniffed bytes, then the content type the reference resolves to — and a
reference that never opened is announced with the same kind it would have arrived
with, so a picture is never previewed in one reply and mourned as a download in
another. Local references are accepted as `media://…`, `file://…`, a bare path or
a drive-letter path: a superset of QwenPaw's `file://`-only syntax, because that
is what this host actually hands over.

**Who refuses what.** The host owns which directories a reference may read, and
in the current build it also rejects a missing file, a file above its own read
ceiling, and a `data:` URL before the channel is consulted — those arrive as the
host's notice, not the plugin's. The plugin's sentences therefore cover what the
host does hand over: bytes it promised and then lost, an id the store no longer
holds, an undecodable payload, and the four-attachment cap. Whatever the route,
the browser is never given a server path.

The same key bounds both ends: the host stages an outbound reply under
`channels.page-assist.mediaMaxMb` too, so lowering it was measured (OpenClaw
2026.10.9) as a 1 MB `/capabilities` number, a 2 MB upload refused and a 700 KB
one accepted, and a 1.5 MB reply file stopped by the host's own notice rather
than ours. Our size sentence is the second line, not the first — what the check
proves is that no path quotes a ceiling the operator did not set.

## Approvals

QwenPaw is asked; this endpoint has to go and look. The reference channel's agent
loop calls into the channel when a command is gated, so its pending map is pushed
to. OpenClaw keeps pending records inside the Gateway and tags them with a host
session key instead of a browser conversation id, so `GET /approvals` lists the
host's records and matches each record's session key against the conversations
this endpoint started. Everything after that match is the reference contract: the
same row fields, the same decision payload, the same sentences.

**Ownership, no reviewer identity.** A record whose session key no conversation
holds — another channel's approval, or an operator binding that lets two
conversations share one session — is not shown at all, and a row is dropped rather
than invented when its run has already finished, because the extension's validator
rejects an empty `requestId`. `POST /approvals/:id/decision` re-reads the host
record before applying anything, so a stale id, a foreign id, and a row the Control
UI already answered all fail there instead of reaching the Gateway.

**Pull only, on the browser's own cadence.** `approvals: true` with
`approvalEvents: false` is the pair that makes the extension run its plain poll and
skip the push loop; the extension re-reads the panel every 5 s while a run is
alive, so a gate appears within one poll and no server-side event is needed. The
poll is also the state sync: conversations holding a pending record move
`running` → `waiting_approval` and the ones that stop holding one move back, which
is why the sync runs even for records that produced no row.

**A cold endpoint still catches the first gate.** The host expires an exec approval
the instant it is raised if no approval surface is connected to route it to, and
the bridge here connects lazily on the first read — so a browser that submits and
never polls would lose the row. The turn therefore opens the connection before it
dispatches, fire-and-forget: a failed preflight is not the run's problem, and the
poll still answers 503 when the bridge cannot be built at all.

**Scopes are re-derived, never trusted from the wire.** A decision outside a
record's persisted allowed set is not rejected by the host — it is applied as a
silent denial, which would report a user's approval as confirmed while their
command never runs. So each row advertises the scopes computed the same way the
Gateway computed them when it created the record (the exec policy knobs for a
command, the plugin's own list for a plugin call, `deny` always available), and the
decision endpoint refuses an unoffered scope with `This approval has no generalized
scope` rather than forwarding a decision the host would invert. Measured on
2026.10.9 with `tools.exec: { host: "gateway", mode: "ask" }`, a gated command
offers exactly `exact`; a `similar` request against it is the 400.

**What a row says.** `tool` is the fixed `exec` label for a command — an approval
is about a command, not about a tool — and the plugin's own title otherwise.
`target` is the host's sanitized command display text, the same string the Control
UI shows, so the two surfaces cannot disagree about what was allowed. `risk` prefers
the analyzer's warning prose, then its classified kinds, then a neutral sentence,
because an empty risk line reads as "no risk". Text whose safety cannot be proven is
suppressed instead of guessed: the host's sanitizer is not on the Plugin SDK, and
its redact-then-escape order can only be reproduced here by comparing two views of
the same string and withholding it when they disagree.

**A decision is answered once and is replayable.** The first `POST` reaches the
host and is remembered; replaying the identical payload returns the identical
`200`, and a different decision for the same approval is 409 `A different decision
was already confirmed`. A browser that lost the response cannot tell a denial from
an approval that never arrived, so this is the difference it needs; the ledger is
bounded and forgets the oldest.

**A broken bridge is 503, never an empty list.** No config, no connection, a closed
socket, a timeout — each becomes `Approval service unavailable; retry shortly`. An
empty list asserts that nothing is blocked, and a read that failed is not entitled
to that assertion.

One host decision is worth stating because it shapes what a gate can even be: a
command whose first token cannot be resolved to a real executable raises no approval
at all and is refused outright (`SYSTEM_RUN_DENIED: approval requires a resolved
executable`). On Windows a bare shell built-in is in that set, while
`cmd /c echo …`, `findstr X notes.txt`, `whoami` and `node --version` were each
measured as producing a row. The endpoint shows what the host chose to record.

## Endpoint coverage

| Endpoint | State |
| --- | --- |
| `GET /capabilities` | live |
| `GET /agents` | live |
| `POST /conversations`, `POST /conversations/{id}/messages` | live |
| `GET /conversations/{id}/messages` | live |
| `GET /requests/{id}`, `GET /requests/{id}/events` (SSE) | live |
| `POST /attachments`, `GET /media/{id}` | live |
| `GET /approvals`, `POST /approvals/{id}/decision` | live |

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

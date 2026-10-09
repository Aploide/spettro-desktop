# Spettro Desktop — architecture

An Electron port of Spettro.app (macOS, `../spettro-apple`) for Linux and
Windows. The macOS app's documentation (`../spettro-apple/docs/`) is the
specification; this file maps its concepts onto this codebase.

## Process split

| macOS concept | Here |
| --- | --- |
| SwiftUI layer | `src/renderer/` — React, pure view, mirrors state over IPC |
| Model layer (`AppModel`, `ChatSession`, stores) | `src/main/model/` — lives in the Electron **main** process |
| ACP layer (`ACPConnection`, `ACPAgent`) | `src/main/acp/` |
| Remote host (`RemoteHost*`) | `src/main/remote/` — `ws` server + mDNS + HMAC pairing |
| Terminal (SwiftTerm) | `node-pty` in main + `@xterm/xterm` in renderer |
| Shared wire/presentation types | `src/shared/` — imported by both sides |

Keeping the model in the main process means the local window and remote
clients (the iPhone and Android apps) are both "screens" attached to one source of truth —
exactly the topology doc 34 (remote protocol) prescribes.

## IPC contract

`src/shared/ipc.ts` is the single contract:

- Main → renderer: `MainEvent` union pushed on `spettro:event`
  (`app-state`, `chat-reset`, `chat-item` upserts, `chat-meta`,
  `permissions`, `questions`, `terminal-data`, …).
- Renderer → main: `RendererApi` methods routed over `spettro:invoke`,
  exposed by the preload as `window.spettro.call(method, ...args)`.

`chat-item` upsert semantics: replace the item whose `transcriptItemId`
matches, else append. Main-side model code performs the same transcript
mutations `ChatSession.swift` does (streaming append, dedup/replay guards,
tool-event merge) and then emits the changed item.

## File map (planned)

```
src/shared/     acp.ts model.ts ipc.ts remote.ts
src/main/
  index.ts      app entry: window, model wiring, ipc registration
  ipc.ts        RendererApi implementation → AppModel
  acp/          connection.ts agent.ts parse.ts
  model/        appModel.ts chatSession.ts sessionStore.ts memoryStore.ts
                subscriptionStore.ts cliLocator.ts cliInstaller.ts
  remote/       host.ts hostSession.ts pairedDevices.ts discovery.ts pairing.ts
                connectionGuard.ts
    tunnel/     remoteTunnel.ts tunnelProcess.ts tunnelLog.ts tunnelStore.ts
                tunnelToken.ts cloudflaredLocator.ts cloudflaredInstaller.ts
  terminal/     panels.ts
src/renderer/src/
  App.tsx       Phase routing (ContentView port)
  state/        store.ts (mirror of main state)
  design/       theme.css tokens (Theme.swift port)
  views/        Sidebar, ProjectPicker, Onboarding, Settings, ChatView,
                ChatHeader, TranscriptItem, ToolCall, Composer, ConfigBar,
                MarkdownText, PermissionSheet, QuestionSheet, MemoryView,
                TerminalDrawer, RemoteAccessView, …
```

## Persistence map

| macOS | Here |
| --- | --- |
| `Application Support/Spettro/sessions.json` | `app.getPath('userData')/sessions.json` |
| `UserDefaults` keys (`spettro.*`) | `userData/preferences.json` |
| `~/.spettro/config.json` (CLI-owned, watched) | same path, watched with fs.watch |
| `~/.spettro/memory.md`, `<project>/.spettro/memory.md` | same paths |
| Keychain (remote device keys) | `userData/remote-devices.json` (0600) |
| — (tunnel token, hostname, port, switch) | `userData/remote-tunnel.json` (0600) |
| — (Spettro's own cloudflared) | `userData/bin/cloudflared[.exe]` |

Remote access itself is a preference (`remoteSharing`): left on, it is
turned back on at the next launch, and the tunnel with it if its switch
was on.

## Remote protocol

`src/shared/remote.ts` is the wire, Spettro Remote v1 as the Swift host
defines it (doc 34), and `src/main/remote/` serves it. The protocol
version stays 1, because a host refuses any other. What this host adds
on top is listed in `features` (in `hello` and the auth result), so a
phone knows what it may rely on:

| Feature | What it adds |
| --- | --- |
| `configResult` | `chats/config` answers `{configOptions}` once the set is done (a refusal is an error), and every option change, by any path, reaches every phone as a `config_option_update` |
| `notices` | notices the app writes into a chat arrive as `chat/state` with a `notice` and no `stopReason` |
| `pendingReplay` | prompts still waiting are asked again right after auth |
| `mentions` | `chats/prompt` takes `mentions` (project-relative paths) |
| `rename` | `chats/rename {chatID, title}` |
| `projectFiles` | `projects/files {projectPath}` → `{files}` (≤ 5000) |
| `remoteHost` | the auth result and every `host/state` carry the tunnel's public hostname (`""` while there is none) |
| `snapshotV2` | `chats/open` keeps the transcript fields the Swift store lacks (see `transcriptItemToWire`); a thought's `startedAt`/`endedAt` keep their milliseconds |

A phone's first `host/state` follows the auth reply, never the other way
round. A goodbye `host/state` (`shuttingDown`) leaves `remoteHost` out,
which means unchanged; only `""` clears it. Workflow Studio's scratch
chats never reach a phone, nor does a removed chat's late `chat/state`
(`remoteBridge.ts`).

## Remote over the internet

`remote/tunnel/` runs a Cloudflare named tunnel (remotely managed, on the
user's own domain; no quick tunnels) so phones can reach the relay away
from the LAN at `wss://<hostname>/`:

- **cloudflared**: PATH and the usual install locations first, else the
  latest `cloudflare/cloudflared` release asset, verified against GitHub's
  sha256 `digest`, into `userData/bin`. Run as `cloudflared tunnel
  --no-autoupdate --config <empty> --metrics 127.0.0.1:0 --output json
  --grace-period 2s run`, the token in `TUNNEL_TOKEN` (never argv), other
  `TUNNEL_*` variables dropped.
- **State** comes from its JSON log (registered connections, connector id,
  edge refusals, the dashboard's ingress) and `/ready`. Restarts back off
  1, 2, 5, 10, 30, 60 s; a refused token or deleted tunnel is not
  restarted. Quitting signals it synchronously.
- **Port**: the relay listens on the pinned port (7879, configurable) the
  dashboard's service URL (`HTTP`, `localhost:<port>`) names. `EADDRINUSE`
  (or `EACCES`/`EPERM`, a port Windows reserves) moves the LAN elsewhere,
  and then the tunnel reports `port-in-use` and doesn't start. Starts and
  moves of the listener run one at a time; one overtaken by a stop closes
  what it opened.
- **Who gets in** (`connectionGuard.ts`): a tunneled connection is any
  carrying `Cf-Warp-Tag-Id`, wherever from (cloudflared may dial the LAN
  address); `Cf-Connecting-Ip` is believed only from loopback or this
  machine's own addresses. Tunneled connections need this computer's
  running connector (the kill switch; another connector's are turned away
  with a warning, and dropped once ours is known), can't pair unless
  "Allow pairing over the internet" is on (`-33003 Pair on the same
  network as this computer first.`), and see `pairingOpen: false` and the
  name "Spettro" in `hello`. Every socket gets 15 s to sign in, ten frames
  of ≤ 64 KiB and 128 KiB off the wire before it has, and a 30 s ping;
  failed sign-ins are limited per peer (5 in 5 min blocks for 15; an IPv6
  peer through the tunnel is its /64; idling past the deadline or sending
  too much counts too); at most 32 sockets, 8 unauthenticated through the
  tunnel and 2 per peer; frames ≤ 32 MiB. Over 50 failed sign-ins through
  the tunnel in 10 min stop internet pairing until a new code is shown,
  with a notification.
- **Phones learn the hostname** from the QR (`r=`), the auth result and
  `host/state`, broadcast again whenever it changes.

## CLI discovery

`spettro` binary search order (Linux/Windows): explicit override →
`~/.local/bin`, `/usr/local/bin`, `/usr/bin`, `PATH` (plus `spettro.exe`
on Windows), → dev checkout fallback (`../spettro/bin`).

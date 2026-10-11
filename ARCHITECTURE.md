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
                connectionGuard.ts legacyTunnelCleanup.ts
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

Remote access itself is a preference (`remoteSharing`): left on, it is
turned back on at the next launch.

Builds that offered access over the internet left `userData/remote-tunnel.json`
and Spettro's own `userData/bin/cloudflared[.exe]` behind; the first launch
without it deletes those (`legacyTunnelCleanup.ts`), and nothing else.

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
| `snapshotV2` | `chats/open` keeps the transcript fields the Swift store lacks (see `transcriptItemToWire`); a thought's `startedAt`/`endedAt` keep their milliseconds |
| `unpair` | `devices/unpair {}` → `null`: the calling device is taken off the paired devices (see Who gets in) |
| `goodbyeReason` | the goodbye `host/state` carries `reason`, and there is exactly one per shutdown |

A phone's first `host/state` follows the auth reply, never the other way
round. Workflow Studio's scratch chats never reach a phone, nor does a
removed chat's late `chat/state` (`remoteBridge.ts`).

Goodbye: one `host/state {agentReady: false, shuttingDown: true, reason}`
per shutdown, and no `host/state` after it. `reason` is `quit`, `restart`
(quitting to install an update; `index.ts` knows from the updater's quit
callback) or `sharing-off`. Only sharing-off has a `message` ("Remote
access was turned off."), which is all an older phone goes by to tell it
from a quit. The app says goodbye before the model shuts down, so the
model's own shutdown emission finds it said.

## Who gets in

Remote access is for the local network: phones find the host by Bonjour
or by the LAN address in the pairing code, and nothing is relayed through
a server. `connectionGuard.ts` keeps it that way:

- An upgrade carrying `Cf-Warp-Tag-Id` or `Cf-Connecting-Ip` (a Cloudflare
  tunnel relayed it) is closed with 1008 before `hello`, so a stray
  `cloudflared` or a tunnel the user points at the port can't put the
  relay on the internet. No header is believed about the peer's address.
- Every socket gets 15 s to sign in, ten frames of ≤ 64 KiB and 128 KiB
  off the wire before it has, and a 30 s ping.
- Five failed sign-ins in 5 min block an address for 15 (a phone on the
  LAN may still pair while a code is up, which is how it gets a working
  key again). A stale code or an old protocol doesn't count.
- At most 32 sockets at once; frames ≤ 32 MiB.
- `devices/unpair` removes the calling device's record (never another's:
  it takes no id) and closes its socket with 1000, after the reply. The
  record is deleted rather than revoked, so pairing again starts a fresh
  row. Settings' Remove… revokes instead, and leaves a connected phone's
  socket open until it reconnects.

The listener tries port 7879 first and lets the OS pick another when it is
taken or reserved (`EADDRINUSE`, `EACCES`, `EPERM`). Starts run one at a
time, and one overtaken by a stop closes what it opened.

## CLI discovery

`spettro` binary search order (Linux/Windows): explicit override →
`~/.local/bin`, `/usr/local/bin`, `/usr/bin`, `PATH` (plus `spettro.exe`
on Windows), → dev checkout fallback (`../spettro/bin`).

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
clients (iPhone app) are both "screens" attached to one source of truth —
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

## CLI discovery

`spettro` binary search order (Linux/Windows): explicit override →
`~/.local/bin`, `/usr/local/bin`, `/usr/bin`, `PATH` (plus `spettro.exe`
on Windows), → dev checkout fallback (`../spettro/bin`).

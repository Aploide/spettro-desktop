# Tests

```sh
npm test          # once
npm run test:watch
npm run typecheck # includes the tests themselves (tsconfig.test.json)
```

Vitest, because the app is already a Vite build: the suite reuses the same
`@shared` / `@renderer` aliases the app resolves with, so a test imports a
module exactly the way the app does. `@main` is a test-only alias — the main
process uses relative imports, but tests cross the process boundary often
enough that spelling `../../src/main/...` obscured what was under test.

Most tests run in Node. Pure code has no business paying for a DOM, and the
majority of what is worth testing here is pure. The few that assert on
behaviour a user can perform opt in with `// @vitest-environment jsdom` at the
top of the file.

## What is tested, and why that and not other things

This codebase has an unusually good visual regression story — `tools/visual`
renders the orchestration views offscreen and screenshots them, in both colour
schemes — so the tests deliberately do **not** re-check appearance. They cover
the things a screenshot renders perfectly while being wrong:

| File | What it protects |
| --- | --- |
| `orchestration.test.ts` | `groupTranscript`, the most intricate pure function in the app. A member attached to the wrong run still draws beautifully. The workflow card is read from its `_meta` when the CLI sends it and from its text otherwise — one case per line `render()` writes (pause, stop, size and budget, `↳` detail, runtime-added phase, `·` and `replayed` members, the trimmed log, the summary, the continued prefix), and the two sources must draw the same run. A paused run is waiting, not running; a stopped one is neither done nor failed; a card a later turn took over says "continued" and hands its members to the next card; an escaped checkpoint trace never opens a phantom run. |
| `workflowBudget.test.ts` | The `+500k` budget directive against a golden file Go's regexp produced from the CLI's own pattern (`go-budget-directives.json`), and that it lights only beside workflows. |
| `workflowHint.test.tsx` | The composer under Ask first: a workflow phrase is muted, the line under it says workflows are paused and its button switches to Restricted; with workflows allowed, a budget directive lights and the line names the budget. |
| `toolPresentation.test.ts` | String surgery against title/args formats defined in another language in another repo, which rots quietly. |
| `extensions.test.ts` | The `_spettro/*` decoders — specifically where their deliberate leniency stops. Also that workflow calls name a live session or, for a cold chat, its absolute folder, and that a method the handshake didn't list fails fast instead of round-tripping. |
| `acpGaps.test.ts` | The main process against the ACP surface the CLI really speaks, through a real `AcpConnection` with only the subprocess faked. A JSON-RPC error surfaces `data.error` (not "Internal error"); a permission attached to an open card takes that card's title, kind and chat and shows its diff; a `perm-N` request plus its settle update make exactly one titled card; the compaction prompt is marked and gets no card; `$/cancel_request`, Stop, a failed turn and a torn-down agent each clear the prompts (Stop answering them "cancelled"); an image-only send carries the text spettro requires; a message sent while busy steers (queued and delivered flip its state, never render, and its end_turn ends nothing), while a mid-turn send the CLI answers on its own (a slash command, a failed steer) leaves the running turn's stream, record and prompts alone; usage and stop reasons are filed; closing a chat cancels then sends `session/close`; only the opened chat resumes, and a send during that resume waits for it instead of starting `session/new`; terminal sessions list unless linked, and import replays user messages only during the load. A workflow card's `_meta["spettro.app/workflow"]` reaches the transcript whole. |
| `chatSession.test.ts` | Transcript upsert semantics, including the `argsJSON` overwrite that the whole text-recovery path exists to survive. Also the session bookkeeping behind the sidebar, through `AppModel` (what the IPC handlers call): a rename survives a relaunch and reaches paired phones, a blank one is refused, a turn that ends on a chat you aren't looking at is marked unread until opened, and the new-session folder menu remembers and forgets recents (flagging ones that vanished) without creating a chat. A chat's last-activity time ignores notices the app adds on its own, so opening an old chat doesn't float it to the top. Sessions saved by an older build load (bare-path locations upgrade, a stale steering state is dropped, a malformed item is skipped rather than failing the load), the token count persists, and the slash-command cache is per folder with the old single list migrated as the fallback. |
| `shellLayout.test.ts` | The sidebar's order (recency, pinned first, archived apart) — Ctrl/Cmd+1…9 and the switcher count rows in it — plus the row timestamp and the "this is your whole home folder" check. |
| `appShell.test.tsx` | The persistent shell in jsdom: nothing selected shows the new-session view (never the old full-window picker), Ctrl+1/2 open sidebar rows, no global shortcut fires while focus is in the terminal (Ctrl+N included) or behind an open sheet, Ctrl+B collapses (persisted) and the header reopens, Ctrl+K filters and opens (Tab stays in it, Escape closes), rename from the "…" menu, Tab closes a row menu, Delete needs a second click, the same starter chip refills the composer twice, the first message waits for a home-folder confirmation and refuses a vanished folder, and otherwise creates the chat in the chosen folder. |
| `setConfigValue.test.ts` | Telling an agent's refusal from a dead pipe. Getting it wrong is invisible until you look closely. |
| `configBar.test.tsx` | That the Ultra chip *does nothing* when locked — a screenshot only shows that it looks locked — and says what Ultra is now (ultracode). The workflow size chip labels tiers in agents, read from the CLI's own descriptions. |
| `workflowStudio.test.tsx` | That Run saves first, refuses to run a broken script, and that an old CLI says so instead of showing an empty project. |
| `theme.test.ts` | That the light palette declares every token the dark one does (a missing one silently inherits the dark value), that view CSS uses tokens rather than hex, that `.icon-btn`/`.sheet-card` are defined once, and that a bad `appearance` — on disk or over IPC — can't reach `nativeTheme`, while a good one is applied, persisted and announced in app-state. |
| `appearancePane.test.tsx` | Settings › General's theme control: the stored choice shows as checked, it is one tab stop, and clicks and arrow keys (wrapping) send `setAppearance`. |

## `wire.ts`

The fixture builders are not conveniences — they are the specification the
tests are written against, so each one records which Go file its shape comes
from. A wrong builder makes every test using it agree with the wrong thing.
That is not hypothetical: the hand-written visual fixtures encoded a misreading
of the CLI twice before a recording caught it, which is why
`tools/visual/capture-live.cjs` records real sessions and
`tools/probe-workflow-ext.cjs` drives a real binary. Those are the check on
these; these are not a substitute for them.

## Adding one

Assert on the promise, not the implementation. The Ultra chip is the worked
example: it uses `aria-disabled` rather than `disabled` because a disabled
button in Chromium swallows the pointer events its own tooltip needs — so the
test asserts the click does not fire and the reason is readable, not that a
particular attribute is set. A test that pins the mechanism blocks the fix.

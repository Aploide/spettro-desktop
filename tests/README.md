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
| `orchestration.test.ts` | `groupTranscript`, the most intricate pure function in the app. A member attached to the wrong run still draws beautifully. The workflow card is read from its `_meta` when the CLI sends it and from its text otherwise — one case per line `render()` writes (pause, stop, size and budget, `↳` detail, runtime-added phase, `·` and `replayed` members, the trimmed log, the summary, the continued prefix), and the two sources must draw the same run. A paused run is waiting, not running; a stopped one is neither done nor failed; a card a later turn took over says "continued" and hands its members to the next card; an escaped checkpoint trace never opens a phantom run; runs without an id never share members. |
| `workflowBudget.test.ts` | The `+500k` budget directive against a golden file Go's regexp produced from the CLI's own pattern (`go-budget-directives.json`), and that it lights only beside workflows. |
| `workflowHint.test.tsx` | The composer under Ask first: a workflow phrase is muted, the line under it says workflows are paused and its button switches to Restricted; with workflows allowed, a budget directive lights and the line names the budget. A budget typed for a suspended Ultra also gets the paused line. |
| `orchestrationPanel.test.tsx` | The live panel settling a run that left its input: a paused run says "Waiting — <question>" and a stopped one its reason, from the run's current state, never a guessed "done". |
| `toolPresentation.test.ts` | String surgery against title/args formats defined in another language in another repo, which rots quietly: the row's verb (a write is not an edit, `ls` lists), the argument cut in the middle so both ends survive, the right-edge note (`exit 1` from the CLI's `[exit status N]`, lines read, results found), and a diff stat that counts a real diff. |
| `unifiedDiff.test.ts` | The edit rows' diff: insertions, deletions and replacements with the file's own line numbers, hunks merged and split as `diff -u` does, a missing final newline, a created file, and a huge rewrite that falls back instead of stalling. |
| `transcript.test.tsx` | The transcript as a reader meets it (jsdom): finished reads and searches fold into one line that opens to them (never across a message or a running call), reasoning says "Thought for Ns" from its chunk times and invents none it lacks, Try again only on the error that ended the last turn, Edit & resend only on the newest message, a steer's Queued / Delivered caption, an edit opening to numbered diff rows, a command to `$ command` held to 30 lines, a row awaiting approval marked as such, and what the run ticker says the turn is doing. |
| `extensions.test.ts` | The `_spettro/*` decoders — specifically where their deliberate leniency stops. Also that workflow calls name a live session or, for a cold chat, its absolute folder, and that a method the handshake didn't list fails fast instead of round-tripping. |
| `acpGaps.test.ts` | The main process against the ACP surface the CLI really speaks, through a real `AcpConnection` with only the subprocess faked. A JSON-RPC error surfaces `data.error` (not "Internal error"); a permission attached to an open card takes that card's title, kind and chat and shows its diff; a `perm-N` request plus its settle update make exactly one titled card; the compaction prompt is marked and gets no card; `$/cancel_request`, Stop, a failed turn and a torn-down agent each clear the prompts (Stop answering them "cancelled"); an image-only send carries the text spettro requires; a message sent while busy steers (queued and delivered flip its state, never render, and its end_turn ends nothing), while a mid-turn send the CLI answers on its own (a slash command, a failed steer) leaves the running turn's stream, record and prompts alone; usage and stop reasons are filed; closing a chat cancels then sends `session/close`; only the opened chat resumes, and a send during that resume waits for it instead of starting `session/new`; terminal sessions list unless linked, and import replays user messages only during the load. A workflow card's `_meta["spettro.app/workflow"]` reaches the transcript whole. |
| `chatSession.test.ts` | Transcript upsert semantics, including the `argsJSON` overwrite that the whole text-recovery path exists to survive. Also the session bookkeeping behind the sidebar, through `AppModel` (what the IPC handlers call): a rename survives a relaunch and reaches paired phones, a blank one is refused, a turn that ends on a chat you aren't looking at is marked unread until opened, and the new-session folder menu remembers and forgets recents (flagging ones that vanished) without creating a chat. A chat's last-activity time ignores notices the app adds on its own, so opening an old chat doesn't float it to the top. Reasoning bubbles are stamped with their first and latest chunk (for "Thought for Ns"), and Try again resends the newest prompt but never into a running turn. Sessions saved by an older build load (bare-path locations upgrade, a stale steering state is dropped, a malformed item is skipped rather than failing the load), the token count persists, and the slash-command cache is per folder with the old single list migrated as the fallback. |
| `shellLayout.test.ts` | The sidebar's order (recency, pinned first, archived apart) — Ctrl/Cmd+1…9 and the switcher count rows in it — plus the row timestamp and the "this is your whole home folder" check. |
| `appShell.test.tsx` | The persistent shell in jsdom: nothing selected shows the new-session view (never the old full-window picker), Ctrl+1/2 open sidebar rows, no global shortcut fires while focus is in the terminal (Ctrl+N included) or behind an open sheet, Ctrl+B collapses (persisted) and the header reopens, Ctrl+K filters and opens (Tab stays in it, Escape closes), rename from the "…" menu, Tab closes a row menu, Delete needs a second click, the same starter chip refills the composer twice, the first message waits for a home-folder confirmation and refuses a vanished folder, and otherwise creates the chat in the chosen folder. |
| `setConfigValue.test.ts` | Telling an agent's refusal from a dead pipe. Getting it wrong is invisible until you look closely. |
| `configBar.test.tsx` | That thinking and Ultra are one chip named for the level, and that no Ultra toggle exists anywhere — nothing pressed, no switch, no checkbox; only a test can show something is absent. Escape hands the focus back to the chip. The workflow size chip labels tiers in agents, read from the CLI's own descriptions. |
| `thinking.test.ts` | The thinking slider's arithmetic: which stop the options put the thumb on (Ultra whenever ultracode is on, "Extra high" for `x-high`, Off resting left for `off`, Low → Max order whatever the CLI's), when Ultra is paused, and which calls a move sends — Ultra is thinking *high* plus ultracode, never max, and leaving it turns ultracode off first. Whether the model thinks follows the CLI's own rule (local and Subscription models do, unflagged). The meteor's run is reproducible from its seed. |
| `thinkingSlider.test.tsx` | The slider as a user drives it (jsdom): a real `role="slider"`, arrow keys and Home/End, Ultra's two calls strictly one after the other, a burst of key presses collapsing to the last, the Paused prompt's Switch and Keep Ask first, a non-reasoning model disabling it — and the meteor playing on the way into Ultra (a key, `/ultra`, the pause lifting) but never for a slider drawn with Ultra already on. |
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

Assert on the promise, not the implementation. The thinking slider is the
worked example: its tests say that reaching Ultra sends thinking high and then
ultracode on, in that order, and that the meteor plays on the way in and not
on a re-render — not which state variable holds the flight or how the queue is
built. A test that pins the mechanism blocks the fix.

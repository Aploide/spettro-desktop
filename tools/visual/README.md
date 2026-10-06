# Visual harness

Renders the orchestration views (workflow card, live panel)
against fixtures shaped exactly like the Go CLI's ACP output, then screenshots
them offscreen. A second page mounts the whole app the same way (see "The app
harness" below). Reviewing these views by reading the code does not work — what
matters is what they look like when twenty rows land at once — and reaching
the interesting states in the real app needs a provider and a ten-minute run.

```sh
npm run visual          # build the harness and shoot dark + light
```

Screenshots land in `.visual-shots/`. Both are gitignored; neither is bundled
by electron-builder, which packages `out/` only.

This is a local tool on purpose. There was briefly a CI job that shot every
scene and uploaded the PNGs as an artifact, and it was removed: with no
baseline to compare against, twenty-two pictures in a zip say nothing about
whether anything changed, and a non-blocking job protects nothing. Every defect
this harness has caught was caught by a person running it and looking. If it
ever needs to run in CI, the version worth building renders the pull request
and its base branch, diffs them, and comments with only the views that moved.

Add a state you care about to `fixtures.ts` — especially an awkward one. The
fixtures already cover the case that actually bit us: a finished workflow whose
`argsJSON` an older CLI overwrote with its finish payload, leaving the phase
tree recoverable only from the rendered text. The cards the current CLI sends
are built with `tests/wire.ts` `workflowCard` (a port of `render()` and the
`_meta` it carries), so the scenes and the tests agree on the wire: running,
`workflow-paused` (waiting at a checkpoint), `workflow-stopped`,
`workflow-failed` (a script that would not parse, said in words, then the
re-run that worked, with its check),
`workflow-continued` (a card a later turn took over, then its successor) and
`workflow-detail` (every line the text can carry, read without `_meta`).

The `chrome` page shows the composer toolbar (mode, the thinking chip at
High, Ultra lit and Ultra paused, the settings chip naming the permission —
amber for Don't ask — and the model button), an @-mentioned file drawn as a
chip, and the composer's glow: a lit phrase, a `+500k` budget directive with its hint, and the muted Ask-first
variant with its "switch permission" line. `chrome:thinking` lays out the
thinking slider in every state (High, Ultra lit, Ultra paused with its
"Switch to Restricted?" prompt, Extra high, Off, a model that doesn't reason)
and its chip; `chrome:meteor` freezes the meteor at twelve points of its run,
from Max and from Low: the flight, the impact (from Max at about 0.45, from Low
at about 0.6) and the cooling into the lit thumb. The meteor is a pure function
of its progress and a fixed seed, so `chrome:meteor&meteorProgress=0.3`
(optionally `&meteorFrom=<stop>`, 0 for Low) is the same frame every time. It
flies inside the slider's 16px bar, which clips it: `SHOT_SCALE=3` renders any
scene at three times the density for looking closely. `chrome:smoulder`
freezes lit Ultra's idle fire (heat running along the bar, embers drifting
toward the stop) at eight moments half a second apart; it too is a pure
function of its time, so `chrome:smoulder&idleTime=1.5` is one fixed frame.
`chrome:thinking` shows its lit panel frozen at 1.2s.

## The app harness

`app.html` mounts the real `<App/>` — sidebar, chat, composer, prompt cards,
settings, onboarding — with `window.spettro` stubbed by `AppHarness.tsx`:
`call` answers from a canned table (`getState`, `getChat`, `gitStat`, …;
anything else resolves `null`) and the events main would push (`app-state`,
`chat-reset`, `permissions`, `questions`) go through the real store reducer.
Pick the screen with `?mode=`:

| mode | what it shows |
| --- | --- |
| `welcome` | ready, no chat selected: the new-session view |
| `welcome-empty` | first run: no sessions yet, working in the home folder (the warning shows) |
| `welcome-folders` | the new-session view with its folder menu open, including a recent that no longer exists |
| `chat` | a finished turn: "Thought for 8s", two reads and a search folded into one line, a sub-agent, an edit, a command, a markdown answer with a code block |
| `chat-tools` | the same turn with its rows opened: the folded reads, the edit's numbered unified diff, the command's `$ npm test` and output |
| `chat-error` | a failed command (`exit 1`, opened), an "Interrupted" notice, and a turn the provider ended: the error card with Try again |
| `commands` | slash commands the CLI answered: /help as a two-column list (command chip, what it does), one-line replies as quiet lines, /models' roster verbatim |
| `chat-steering` | a running turn with a message sent mid-turn, queued for the agent's next step, and the run ticker |
| `thinking`, `thinking-paused` | the same chat with the thinking slider open over the composer: at High, and Ultra saved under Ask first (paused, offering Restricted) |
| `chat-one` | the same chat as the only session in the sidebar |
| `sidebar-many` | twenty sessions across three projects: pinned, archived, one working, two finished while away, two waiting on an approval ("Needs you") |
| `sidebar-menu` | the same, with a row's menu open (Rename… / Pin / Archive / Delete…) |
| `collapsed` | the sidebar collapsed (Ctrl/Cmd+B), its reopen button leading the header, dotted amber: another session needs you |
| `switcher` | the Ctrl/Cmd+K quick switcher over many sessions |
| `busy` | the same turn still running: a live row, the ticker ("Working… 3s · Esc to interrupt"), the todo list open above the composer (one task under way, one blocked) and the Stop button |
| `guide` | running, with words typed: Stop steps back and "Guide" sends them to the running agent |
| `ultra` | Ultra lit: the thinking chip wears it |
| `slash` | "/" typed: the command menu floating above the card |
| `mention` | one file picked with "@" (now a chip in the text) and the menu open for a second |
| `model-menu` | the model menu: favourites first, then each provider, capabilities in words, Manage models… |
| `session-settings` | the settings popover: permission, the thinking slider, workflow size |
| `permission-bash` | the inline approval card for a command, a second one queued ("1 of 2"), the card's row marked "Needs approval" and the todo list folded |
| `permission-diff` | the same for an edit: the diff preview, no "Always allow" (writes aren't remembered) |
| `permission-compact` | the compaction prompt: "This conversation is almost full", Compact now / Continue without compacting |
| `permission-denied` | after Deny: the "Tell Spettro what to do instead" field, and the call's row saying "denied" (not a red "failed") |
| `permission-orphan` | an approval no chat claims, in its modal fallback (focused, so its key hints show) |
| `question` | the inline question card: context, a Recommended option with a preview, Other… |
| `question-multi` | three questions, on the second (multi-select) with picks made and Other… open |
| `settings` | Settings, opened the way a user does (Ctrl+,) |
| `settings-<pane>` | one per pane — `general`, `account`, `models`, `permissions`, `memory`, `remote`, `updates` (the engine has an update waiting), `advanced`, `shortcuts`, `about` — chosen in Settings' sidebar |
| `onboarding`, `installing`, `install-failed` | setup, step 1 of 2: Install Spettro (Advanced folded), the determinate bar with Cancel, and "Couldn't download Spettro" with Try again |
| `gate`, `gate-keys` | setup, step 2 of 2: Sign in to Spettro first, the quieter alternatives under it; and "Use my own API key" with one provider opened (its "Get a key" link) |
| `failure` | the engine died: the sentence, Try again, and the log behind "Show details" |
| `reconnecting` | the engine restarting under a chat: the header's "Reconnecting…", the half-written message still in the field, Send waiting |
| `confirm-delete`, `deleted-undo` | Delete… from a row's menu: the alert, and after it the row gone with Undo on offer |
| `no-model` | nothing connected (setup skipped): the "Connect a model to start" bar over the composer, no model offered |
| `no-model-sent` | a message sent with nothing connected: it stays in the field, the bar says it will wait, and Settings › Models opens on the connect chooser |
| `no-model-connect` | "Connect…" on that bar: the same chooser as setup, inside Settings › Models (no second sheet) |
| `no-model-error` | a chat an older send left behind: the "No model is connected" card offering Connect a model… instead of Try again |
| `no-model-menu` | the model menu with nothing in it: one sentence and Connect a model… |
| `no-model-signin` | Settings › Account › Sign in…: the sign-in sheet sized by its content, plans and prices under the button |
| `mode-menu` | the mode chip's menu: the CLI's agent descriptions replaced by what each mode does |
| `welcome-sent` | first run in the home folder, a message sent before answering: "Choose where Spettro should work first", the focus on Choose folder… |
| `welcome-new-project` | the same warning's New project…: the folder menu as a name field (makes ~/Spettro Projects/<name>) |
| `welcome-more` | the sidebar footer's "…" with no session open: Workflows… disabled, saying why |
| `gate-signin`, `gate-local` | setup's step 2 after Sign in / Use a model on this computer: each in place of the chooser with Back (no stacked sheet), the local one saying where to get LM Studio or Ollama |
| `installing-slow` | the install stalled in one phase for 15 s: "taking longer than usual" and a moving sheen. Not in `shoot.sh` (it needs `SHOT_WAIT=16500`) |
| `error-toast` | a failed action said in words, with its one next step |

The window layout (sidebar width and collapse, terminal drawer) lives in
localStorage, which persists across scenes in the capture's profile, so
`appPrelude.ts` resets it before the app loads and applies only what the
mode asks for.

The modes that type into the composer do it the way a user does — through
the textarea's value setter React listens behind, then keys — and wait for
the focus first: the composer's menus open only while it is focused, and an
offscreen window never is, so the capture turns DevTools focus emulation on
for `app` scenes once the page has loaded.

Unsent drafts live in localStorage too (per chat), so the prelude clears
them as well.

`shoot.sh` shoots the main ones as `app:<mode>` scenes. They are taken at the
real window's size (1280×840, `SHOT_APP_HEIGHT` to change) rather than as a
tall page. One scene, one theme:

```sh
VISUAL_OUT=/tmp/sd-visual-dist npx vite build -c tools/visual/vite.config.ts
SHOT_THEMES=dark node_modules/electron/dist/electron --no-sandbox \
    tools/visual/capture.cjs /tmp/sd-visual-dist /tmp/out app:chat
```

### Accents

Every harness page takes `?accent=lilac|mono` (`accentPrelude.ts` puts it on
`<html>` before anything renders, as preload does in the app; the app
harness also reports it in its app-state). Without it a page is in the
default, Lilac. `SHOT_ACCENT=mono` makes `capture.cjs` and `shoot.sh` add it
to every URL and to every file name (`app-chat-mono-dark.png`), so both
accents can share one output folder:

```sh
for accent in lilac mono; do
  SHOT_ACCENT=$accent node_modules/electron/dist/electron --no-sandbox \
      tools/visual/capture.cjs /tmp/sd-visual-dist /tmp/out app:settings-general
done
```

## The live app

`cdp-shot.cjs` screenshots the real window, against a real spettro, over the
DevTools port — X11 tools can't see a Wayland client, the debug port always
answers. Run the dev app with a throwaway profile and a debug port, then:

```sh
npx electron-vite dev --outDir out/live --entry out/live/main/index.js \
    --remoteDebuggingPort 9333 -- --user-data-dir=/tmp/live-profile
node tools/visual/cdp-shot.cjs 9333 /tmp/shot.png ["<JS to run first, e.g. a click>"]
```

To see first-run setup from a dev run, hide every installed CLI: run with a
throwaway `HOME`, drop `~/.local/bin` from `PATH`, and set
`SPETTRO_IGNORE_DEV_CLI=1` (otherwise the locator finds the `spettro`
checkout beside this repo).

Pass `--entry` whenever you pass `--outDir`: without it Electron starts
`package.json`'s `main` (`out/main/index.js`) — whatever was built there last —
while the renderer comes fresh from the dev server, so main-process changes
silently aren't running. Keep the directory under `out/` (gitignored) so the
bundle still resolves `node_modules`.

The theme follows `nativeTheme.themeSource` in both places: the harness flips
it per shot, and the app sets it from the System / Light / Dark setting
(Settings › General), so `window.spettro.call('setAppearance', 'light')` in the
live app's console flips everything, the terminal included.

## End to end against a real spettro

Two tools in `tools/e2e` check the app against the CLI it ships with, not
against our fixtures of it. Build the CLI first (`make build` in the
spettro checkout); `~/.local/bin/spettro` may be an older release.

`acp-smoke.cjs` speaks ACP to the binary directly and prints PASS or FAIL per
check — the handshake (extensions v4, list/resume/close, image prompts), the
six config options in order, the commands (`ultra`, never `ultracode`),
Ultra saved but suspended under Ask first, a refusal's reason in
`data.error`, `/ultracode` and `/workflow-size`, the image-only refusal the
app works around, `session/list`, resume in a fresh process announcing
commands, close, and the `_spettro/*` providers, models, account and
workflow methods. It runs under a throwaway HOME and spends nothing:

```sh
SPETTRO_BIN=../spettro/bin/spettro node tools/e2e/acp-smoke.cjs
```

`tests/live` runs much the same through the app's own main process (see
`tests/README.md`).

`live-ui.sh` launches the dev app with a scratch profile and drives the real
window through scenarios (`live-ui.cjs`), screenshotting each step into
`$OUT/NN-<name>.png` (default `/tmp/sd-live/shots`). It clicks and waits on
`data-testid`s — `new-session`, `project-chip`, `composer-input`, `send`,
`stop`, `model-button`, `session-settings`, `thinking-chip`,
`settings-button`, `settings-pane-<id>`, `sidebar-toggle`, `sidebar-reopen`,
`terminal-toggle`, `permission-allow-once` / `-deny`, `deny-feedback`,
`question-option-<id>`, `question-submit`, `sidebar-row-<chatId>`,
`confirm-ok` — and types with real key events.

```sh
tools/e2e/live-ui.sh free                         # no tokens: throwaway HOME
SETUP=1 PROFILE=/tmp/setup tools/e2e/live-ui.sh setup   # first run, no CLI found
REAL_HOME=1 tools/e2e/live-ui.sh hello permission steering question workflow
REAL_HOME=1 tools/e2e/live-ui.sh reopen manage    # after a relaunch; no tokens
node tools/e2e/live-ui.cjs --list
```

The paid scenarios send small prompts to the user's own model and change
settings the CLI shares with every session and the TUI (`permission` goes to
Ask first, then Restricted; `workflow_size` to small). Note the values
before (`~/.spettro/config.json`, or a session's `configOptions`) and put
them back after. `capture-live.cjs` restores its own changes on exit.

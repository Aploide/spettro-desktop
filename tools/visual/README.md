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
`workflow-continued` (a card a later turn took over, then its successor) and
`workflow-detail` (every line the text can carry, read without `_meta`).

The `chrome` page shows the config bar (the thinking chip at High, Ultra lit
and Ultra paused, the workflow size chip) and the composer's glow: a lit
phrase, a `+500k` budget directive with its hint, and the muted Ask-first
variant with its "switch permission" line. `chrome:thinking` lays out the
thinking slider in every state (High, Ultra lit, Ultra paused with its
"Switch to Restricted?" prompt, Extra high, Off, a model that doesn't reason)
and its chip; `chrome:meteor` freezes the meteor at points of its flight, from
Max and from Low. The meteor is a pure function of its progress, so
`chrome:meteor&meteorProgress=0.3` (optionally `&meteorFrom=<stop>`) is the
same frame every time. It is a few pixels tall: `SHOT_SCALE=3` renders any
scene at three times the density for looking closely.

## The app harness

`app.html` mounts the real `<App/>` — sidebar, chat, composer, sheets,
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
| `chat-steering` | a running turn with a message sent mid-turn, queued for the agent's next step, and the run ticker |
| `thinking`, `thinking-paused` | the same chat with the thinking slider open over the composer: at High, and Ultra saved under Ask first (paused, offering Restricted) |
| `chat-one` | the same chat as the only session in the sidebar |
| `sidebar-many` | twenty sessions across three projects: pinned, archived, one working, two finished while away |
| `sidebar-menu` | the same, with a row's menu open (Rename… / Pin / Archive / Delete…) |
| `collapsed` | the sidebar collapsed (Ctrl/Cmd+B), its reopen button leading the header |
| `switcher` | the Ctrl/Cmd+K quick switcher over many sessions |
| `busy` | the same turn still running: a live row, and the ticker ("Working… 3s · Esc to interrupt") |
| `permission-bash`, `permission-diff` | the approval sheet for a command and for an edit |
| `question` | the ask-user sheet |
| `settings` | Settings, opened the way a user does (Ctrl+,) |
| `onboarding`, `installing`, `install-failed` | first run without a CLI |
| `gate` | the CLI is up but no model is connected |
| `failure`, `reconnecting` | the agent died / is starting |

The window layout (sidebar width and collapse, terminal drawer) lives in
localStorage, which persists across scenes in the capture's profile, so
`appPrelude.ts` resets it before the app loads and applies only what the
mode asks for.

`shoot.sh` shoots the main ones as `app:<mode>` scenes. They are taken at the
real window's size (1280×840, `SHOT_APP_HEIGHT` to change) rather than as a
tall page. One scene, one theme:

```sh
VISUAL_OUT=/tmp/sd-visual-dist npx vite build -c tools/visual/vite.config.ts
SHOT_THEMES=dark node_modules/electron/dist/electron --no-sandbox \
    tools/visual/capture.cjs /tmp/sd-visual-dist /tmp/out app:chat
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

Pass `--entry` whenever you pass `--outDir`: without it Electron starts
`package.json`'s `main` (`out/main/index.js`) — whatever was built there last —
while the renderer comes fresh from the dev server, so main-process changes
silently aren't running. Keep the directory under `out/` (gitignored) so the
bundle still resolves `node_modules`.

The theme follows `nativeTheme.themeSource` in both places: the harness flips
it per shot, and the app sets it from the System / Light / Dark setting
(Settings › General), so `window.spettro.call('setAppearance', 'light')` in the
live app's console flips everything, the terminal included.

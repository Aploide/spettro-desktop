# Performance benchmark

A reproducible measurement of how the desktop app feels: frame times, input
latency, long tasks, CPU per process, IPC traffic and memory, for the
interactions people actually do — sitting on a long chat, dragging the
thinking slider, typing, scrolling, switching chats, opening menus, and
watching a heavy turn stream in.

It drives the **real app** (the production build by default) through the
DevTools protocol with real input events, on a scratch profile seeded with a
large `sessions.json`, against a **fake spettro agent** — no model, no tokens,
nothing of yours touched.

```sh
node tools/perf/bench.cjs                          # npm run build, then 2 runs → /tmp/perf/bench-prod.{json,md}
node tools/perf/bench.cjs --runs 2 --out /tmp/perf/baseline
node tools/perf/bench.cjs --mode dev --only idle,typing,slider   # as `npm run dev` runs
node tools/perf/bench.cjs --only slider --skip-build --runs 3    # just the slider, fast loop
node tools/perf/bench.cjs --attribution            # + CPU profiles: which functions the time goes to
node tools/perf/report.cjs --compare a.json b.json # two reports side by side (before/after, prod/dev)
```

Run it in a desktop session (`DISPLAY` / `WAYLAND_DISPLAY`) on a quiet
machine: a video render in the background tripled every number in one of the
first runs. The report records the load average at the start of each run so a
noisy run can be spotted. The window must really be on screen — a hidden,
minimised or occluded window stops producing frames, which reads as a very
fast app. Each run shows, raises and focuses it (through the main process's
inspector) and the preflight checks that `requestAnimationFrame` ticks at the
display's rate (it warns otherwise).

## Files

| file | what |
|---|---|
| `bench.cjs` | the benchmark: launches, drives, measures, writes JSON + markdown |
| `lib.cjs` | scratch profile, launch/kill (by PID, own process group), DevTools client, `/proc` CPU, trace summary, stats |
| `probe.js` | injected into the page before the app loads: counts the app's rAF calls, React commits (and the components each rendered) through the DevTools hook, IPC events, long tasks, long animation frames, Event Timing; frame recorder; per-input latency; `settle()` |
| `fake-spettro.cjs` | the stand-in agent (stdio JSON-RPC, the CLI's shapes) |
| `cli-fixture.json` | `initialize`, the config options, commands, providers and account replies **captured from a real `spettro --acp`** under a throwaway HOME; the fake replays them |
| `content.cjs` | deterministic markdown, code, diffs and command output (seeded) |
| `gen-sessions.cjs` | writes the large `sessions.json` |
| `report.cjs` | JSON → the summary table; `--compare` for two reports |

## What a run does

1. `npm run build` (prod mode), then per run a fresh scratch directory
   `/tmp/perf/run-<mode>-<n>/`: `home/` (the clean `HOME` the app and agent
   run under), `userdata/` (the Electron profile: `--user-data-dir`), the
   generated `sessions.json` (40 chats in four projects; one of 800 items —
   turns of thinking, reads, ~200-line edit diffs, 300-line command output,
   markdown with code blocks and tables; 25 MB, as `SessionStore` writes it),
   `preferences.json` pointing `explicitCLIPath` at a shell wrapper that execs
   the fake agent, and the fake's log.
2. Launches `electron .` with `--remote-debugging-port` and `--inspect` (the
   main process's Node inspector) in its own process group, injects
   `probe.js` and reloads so it is in place before React starts.
3. Runs the scenarios below, each as a measured window, and kills the process
   group (by PID) at the end.

`--real-sessions <file>` adds a copy of a real `sessions.json` in front of
the generated chats (copy yours first; never point it at the live file):
`cp ~/.config/spettro-desktop/sessions.json /tmp/perf/real-sessions.json`.

## Scenarios

| name | what it does | headline numbers |
|---|---|---|
| `idle` | the 800-item chat open, nothing happening, 10 s (then 4 s traced) | CPU % of main / renderer / GPU; app rAF/s; React commits/s; style recalcs, layouts, paints and compositor frames per second; running CSS animations |
| `scroll` | 90 wheel ticks up the long transcript and 90 back, 16 ms apart | frame interval p50/p95/max, dropped frames |
| `typing` | 200 characters into the composer, 40 ms apart, as key events | keydown → end of next frame p50/p95/max; Event Timing (keydown → paint) |
| `open-close` | thinking popover, model menu, settings sheet ×3 each; 8 keys into the sidebar search | click → first frame showing it; click → settled |
| `slider` | the thinking popover open: 20 pointer drags Low ↔ Max (moves at 120 Hz, 400 ms each), rapid arrow keys (24 presses 30 ms apart), a drag onto Ultra and back off, and one drag with the fake CLI answering in 400 ms | frame interval and dropped frames while dragging; pointermove → next frame; release → painted (Event Timing); React commits and components per move; `set_config_option` calls per drag (from the fake's log: while dragging, and per release); IPC per move; main CPU and main event-loop delay |
| `ultra-idle` | a drop onto Ultra (the meteor, frames recorded through it), then 10 s idle with the popover open on lit Ultra (the smoulder), then 5 s with it closed | meteor frame times; idle CPU/paints with the smoulder |
| `glow-idle` | "ultracode …" in the composer (the activation glow), 10 s idle | idle CPU/paints with the glow |
| `switch` | 10 chat switches by clicking sidebar rows, mixing the long chat and short ones | click → first changed frame; click → the first frame holding the new chat (the reader sees it; rows above the fold may still be arriving); click → settled frame; IPC bytes (each switch sends the whole chat) |
| `streaming` | a prompt to the fake agent in the long chat: ~3000 message chunks of markdown, 40 thought chunks, 60 tool calls with updates (reads, ~200-line edit diffs, long command output), plan and usage updates, at 500 updates/s; then the same into a 16-item chat | first update → page settled, and how far the page lags behind the agent at the end; frame times; React commits and components per commit; CPU per process; IPC messages and bytes per second; main event-loop delay; renderer JS heap before/after (both after a forced GC) |

Every measured window also records: CPU per process kind (`/proc`, % of one
core: `main`, `renderer`, `gpu`, `utility`, `agent`, `devserver` in dev mode),
the renderer's style recalcs / layouts / script / task time
(`Performance.getMetrics`), long tasks and the longest animation frames (with
their script attribution), renderer → main calls (counted in main by wrapping
the invoke handler) and main → renderer events by type and size, and the main
process's event-loop delay (`monitorEventLoopDelay`). The idle scenarios add a
short trace (`devtools.timeline`, all processes) for paints and compositor
frames; tracing is kept out of the other windows because it costs frames
itself.

How to read a few of them:

- **Frame interval** is measured by a `requestAnimationFrame` loop the probe
  runs only during interactions. 8.3 ms is a frame at 120 Hz; *dropped* is
  frames the display had room for and didn't get.
- **→ next frame** is from the input event's timestamp to the end of the first
  frame after it (a message posted from that frame's rAF). **→ painted** is
  the browser's own Event Timing duration (to the next paint), recorded only
  for events that took 16 ms or more — so `n` says how many of them did.
- A **long animation frame** with no script and no blocking time is a frame
  the renderer was ready to draw and *couldn't present*: on Linux the
  window's presentation goes through the browser process, so a blocked main
  process (Electron's main JS runs on that thread) freezes the window.
  `main.loopDelayMs.max` says when that happened.
- **Components per commit** counts the React components that actually ran
  their render in a commit (the `PerformedWork` flag), so a number in the
  thousands means the whole transcript re-rendered.
- **Thumb behind the stop under the pointer** samples, every frame of the
  slider drags, the thumb's drawn position against the stop nearest the
  pointer: the gap in pixels, and how long the thumb takes to arrive (within
  1 px) after the pointer crosses into a new stop. It is what a hand feels as
  lag even when every frame is on time.

The probe costs a little itself, and the numbers include it: the frame
recorder's rAF loop and per-input bookkeeping during interactions, and during
the slider drags one `getBoundingClientRect` of the thumb per frame. IPC
events are kept (not copied) during a window and sized after it, so sizing
never lands in the frames measured.

## Comparing

Keep the JSON of a run as the baseline and compare later runs against it:

```sh
node tools/perf/bench.cjs --out /tmp/perf/after
node tools/perf/report.cjs --compare /tmp/perf/baseline.json /tmp/perf/after.json /tmp/perf/compare.md
```

The same machine, the same display and a quiet load average matter more than
the number of runs: two runs on a quiet machine agree within a few percent on
almost every number (the report shows the spread).

## The fake agent

`fake-spettro.cjs --acp --cwd <dir>` speaks newline-delimited JSON-RPC 2.0
like `spettro --acp`: `initialize` (the captured reply, extensions v4),
`session/new|resume|load|list|close`, `session/set_config_option` (applies
the change, waits `FAKE_SPETTRO_DELAY_MS` — default 20 —, sends every *other*
open session a `config_option_update`, then replies with the session's
options — the order `bridge.go SetSessionConfigOption` uses),
`session/prompt` (the heavy turn, paced at `FAKE_SPETTRO_RATE` updates/s,
cancellable with `session/cancel`), and the `_spettro/*` methods the app asks
at startup (providers with Anthropic and OpenAI connected, a models list,
signed-out account, no workflows). `--version` prints `spettro perf-fake`.

Sizes and pacing come from the environment (`FAKE_SPETTRO_TOKENS`,
`_THOUGHTS`, `_TOOLS`, `_DIFF_LINES`, `_BASH_LINES`, `_RATE`, `_DELAY_MS`), a
control file re-read on every request (`FAKE_SPETTRO_CONTROL`, how the
benchmark slows the CLI mid-run), or the prompt itself (`perf:tokens=500
perf:tools=4`). Every request and turn is logged to `FAKE_SPETTRO_LOG`.

To use it by hand, point a scratch profile's `preferences.json` at a wrapper:

```sh
printf '#!/bin/sh\nexec node %s "$@"\n' "$PWD/tools/perf/fake-spettro.cjs" > /tmp/fake-spettro && chmod +x /tmp/fake-spettro
echo '{"explicitCLIPath":"/tmp/fake-spettro","providerSetupSkipped":true}' > /tmp/profile/preferences.json
```

### Refreshing the fixture

`cli-fixture.json` holds what a real CLI answered on 2026-10-06. When the
CLI's config options or commands change, capture them again from a build of
`../spettro` under a throwaway HOME (no provider, so nothing is spent): send
`initialize`, `session/new`, `_spettro/providers/list` and
`_spettro/account/status`, and copy the replies (and the
`available_commands_update` that follows the new session) into the file —
`tools/e2e/acp-smoke.cjs` shows the handshake.

## Dev mode

`--mode dev` launches `electron-vite dev --outDir out/perf-dev` (the renderer
from the Vite dev server, React's development build, unminified) — what a
contributor running `npm run dev` sees. Its numbers are not the product's: the
dev build of React is several times slower at rendering, and the dev server
adds its own process (counted as `devserver`). Use it to see component names
in `topComponents` and readable renderer profiles under `--attribution`.

#!/usr/bin/env node
// The desktop app's performance benchmark. Launches the real app — the
// production build by default — on a scratch profile seeded with a large
// sessions.json, against a fake spettro agent (no model, no tokens), drives
// it over the DevTools protocol with real input events, and measures what
// the user feels: frame times, input latency, long tasks, CPU per process,
// IPC traffic and memory. See README.md for what each scenario does.
//
//   node tools/perf/bench.cjs [options]
//
//   --mode prod|dev       prod: `npm run build` then the out/ bundle (default);
//                         dev: electron-vite dev, the way `npm run dev` runs
//   --runs N              fresh launches to repeat the suite (default 2)
//   --only a,b            scenarios to run (default: all); see SCENARIOS
//   --out PREFIX          writes PREFIX.json and PREFIX.md (default
//                         /tmp/perf/bench-<mode>)
//   --skip-build          use the out/ bundle as it is
//   --real-sessions FILE  also load a COPY of a real sessions.json
//   --chats N, --long-items N   size of the generated sessions (40, 800)
//   --attribution         after the runs, one more launch with CPU profilers
//                         on (main and renderer) for the slider drag, typing
//                         and streaming; top functions go into the report and
//                         the .cpuprofile files next to it
//   --port N              first DevTools port (default 9450)
//
// Needs a display (DISPLAY or WAYLAND_DISPLAY): the window must really be on
// screen — a hidden or occluded window stops producing frames, which would
// read as a very fast app. The preflight checks the frame rate and says so.

'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const L = require('./lib.cjs')
const { writeReport } = require('./report.cjs')

const SCENARIOS = [
  'idle',
  'scroll',
  'typing',
  'open-close',
  'slider',
  'ultra-idle',
  'glow-idle',
  'switch',
  'streaming'
]

// ----------------------------------------------------------------- args

function parseArgs(argv) {
  const a = {
    mode: 'prod',
    runs: 2,
    only: null,
    out: null,
    skipBuild: false,
    realSessions: null,
    chats: 40,
    longItems: 800,
    attribution: false,
    port: 9450
  }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = () => argv[++i]
    if (k === '--mode') a.mode = v()
    else if (k === '--runs') a.runs = Number(v())
    else if (k === '--only') a.only = v().split(',')
    else if (k === '--out') a.out = v()
    else if (k === '--skip-build') a.skipBuild = true
    else if (k === '--real-sessions') a.realSessions = path.resolve(v())
    else if (k === '--chats') a.chats = Number(v())
    else if (k === '--long-items') a.longItems = Number(v())
    else if (k === '--attribution') a.attribution = true
    else if (k === '--port') a.port = Number(v())
    else if (k === '-h' || k === '--help') {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 33).join('\n'))
      process.exit(0)
    } else throw new Error(`unknown option ${k}`)
  }
  if (!a.out) a.out = `/tmp/perf/bench-${a.mode}`
  return a
}

const log = (...m) => console.log(`[bench ${new Date().toISOString().slice(11, 19)}]`, ...m)

// ------------------------------------------------------------ the app

/** One launched app and the handles to drive and measure it. */
async function startApp(args, runIndex, opts = {}) {
  const runDir = path.join('/tmp/perf', `run-${args.mode}-${runIndex}`)
  const profile = L.makeProfile(runDir, {
    chats: args.chats,
    longItems: args.longItems,
    realSessions: args.realSessions
  })
  const cdpPort = args.port + runIndex * 2
  const inspectPort = cdpPort + 1
  const child = L.launch(profile, { mode: args.mode, cdpPort, inspectPort, logFile: path.join(runDir, 'app.log') })
  log(`run ${runIndex}: launched ${args.mode} app pid ${child.pid} (profile ${runDir}, ${(profile.sessionsBytes / 1e6).toFixed(1)} MB sessions.json, ${profile.sessions.length} chats, ${profile.totalItems} items)`)
  const app = { args, profile, child, cdpPort, inspectPort, runDir }
  try {
    const page = await L.waitForJSON(
      `http://127.0.0.1:${cdpPort}/json/list`,
      (l) => l.find((t) => t.type === 'page' && !t.url.startsWith('devtools')),
      args.mode === 'dev' ? 120000 : 60000
    )
    const nodeTarget = await L.waitForJSON(`http://127.0.0.1:${inspectPort}/json/list`, (l) => l[0], 30000)
    app.cdp = await L.cdpConnect(page.webSocketDebuggerUrl)
    app.main = await L.cdpConnect(nodeTarget.webSocketDebuggerUrl)
    await app.main.send('Runtime.enable')
    await setup(app, opts)
    return app
  } catch (err) {
    await L.kill(child)
    throw err
  }
}

/** Main-process instrumentation, through its Node inspector: the window
 *  shown, focused and raised; the renderer → main calls counted (wrapping
 *  the invoke handler); and an event-loop delay histogram. */
const MAIN_SETUP = `(() => {
  const req = process.mainModule.require
  const { BrowserWindow, ipcMain } = req('electron')
  const { monitorEventLoopDelay } = req('perf_hooks')
  const g = globalThis
  if (!g.__perfMain) {
    g.__perfMain = { invokes: [], hist: monitorEventLoopDelay({ resolution: 5 }), wrapped: false }
    g.__perfMain.hist.enable()
    const handlers = ipcMain._invokeHandlers
    const channel = 'spettro:invoke'
    const h = handlers && handlers.get && handlers.get(channel)
    if (h) {
      handlers.set(channel, function (e, method, ...rest) {
        g.__perfMain.invokes.push([Date.now(), method, /Option$/.test(method) && typeof rest[1] === 'string' ? rest[1] : undefined])
        return h.call(this, e, method, ...rest)
      })
      g.__perfMain.wrapped = true
    }
  }
  const w = BrowserWindow.getAllWindows()[0]
  if (!w) return { window: false }
  if (w.isMinimized()) w.restore()
  w.show(); w.moveTop(); w.focus()
  return { window: true, visible: w.isVisible(), focused: w.isFocused(), bounds: w.getBounds(), invokeWrapped: g.__perfMain.wrapped, electron: process.versions.electron, chrome: process.versions.chrome }
})()`

async function setup(app, opts) {
  const { cdp } = app
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Performance.enable', { timeDomain: 'timeTicks' })
  // A window without OS focus still behaves as focused (the composer's
  // menus open only while it has focus).
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(path.join(__dirname, 'probe.js'), 'utf8') })
  await waitApp(app, 'the first load')
  // Reload so the probe is in place before React starts.
  await cdp.send('Page.reload')
  await L.sleep(500)
  await waitApp(app, 'the reload')
  app.window = await app.main.evaluate(MAIN_SETUP)
  app.windowInfo = app.window
  const probeOk = await cdp.evaluate('!!window.__perf && !!window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.size')
  if (!probeOk) throw new Error('the probe did not attach to React (was it injected before the app loaded?)')
}

async function waitApp(app, what) {
  const start = Date.now()
  for (;;) {
    const n = await app.cdp
      .evaluate(`document.querySelectorAll('[data-testid^="sidebar-row-"]').length`)
      .catch(() => 0)
    if (n > 0) return
    if (Date.now() - start > 60000) throw new Error(`the app never showed its sessions after ${what}`)
    await L.sleep(250)
  }
}

// ------------------------------------------------------------ driving

function driver(app) {
  const { cdp } = app
  const ev = (expr, ms) => cdp.evaluate(expr, ms)
  const mouse = (type, x, y, extra = {}) =>
    cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse', ...extra })
  const d = {
    ev,
    async rect(selector) {
      return ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 } })()`)
    },
    async click(selector) {
      const r = await d.rect(selector)
      if (!r) throw new Error(`nothing to click: ${selector}`)
      await mouse('mouseMoved', r.cx, r.cy, { buttons: 0 })
      await mouse('mousePressed', r.cx, r.cy)
      await mouse('mouseReleased', r.cx, r.cy)
      return r
    },
    mouse,
    async key(key, modifiers = 0) {
      const codes = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, End: 35, Home: 36, a: 65 }
      const vk = codes[key] ?? key.toUpperCase().charCodeAt(0)
      const code = key.length === 1 ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : '') : key
      const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: key === 'Enter' ? '\r' : undefined })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    },
    /** One character as a keystroke (keydown with text → keypress, input). */
    async typeChar(ch) {
      const upper = ch.toUpperCase()
      const vk = /[a-z]/i.test(ch) ? upper.charCodeAt(0) : ch === ' ' ? 32 : ch.charCodeAt(0)
      const code = /[a-z]/i.test(ch) ? `Key${upper}` : ch === ' ' ? 'Space' : ''
      const base = { key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: ch, unmodifiedText: ch })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    },
    async insertText(text) {
      await cdp.send('Input.insertText', { text })
    },
    async waitFor(selector, ms = 8000) {
      return ev(`__perf.waitFor(${JSON.stringify(selector)}, ${ms})`, ms + 5000)
    },
    async waitGone(selector, ms = 5000) {
      const start = Date.now()
      while (Date.now() - start < ms) {
        if (!(await ev(`!!document.querySelector(${JSON.stringify(selector)})`))) return true
        await L.sleep(30)
      }
      return false
    },
    async settle(quiet = 250, timeout = 8000) {
      return ev(`__perf.settle(${quiet}, ${timeout})`, timeout + 5000)
    },
    async clearComposer() {
      await d.click('[data-testid="composer-input"]')
      await d.key('a', 2) // Ctrl+A
      await d.key('Backspace')
      await L.sleep(100)
    }
  }
  return d
}

// --------------------------------------------------------- measuring

const METRIC_KEYS = ['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration', 'JSHeapUsedSize', 'Nodes', 'JSEventListeners']

async function perfMetrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics')
  const out = {}
  for (const m of metrics) if (METRIC_KEYS.includes(m.name)) out[m.name] = m.value
  return out
}

/**
 * Runs `body` as one measured window and returns what happened in it: CPU per
 * process kind, the renderer's own counters (style recalcs, layouts, script
 * and task time), the probe's (app rAF calls, React commits and the
 * components they rendered, IPC events and bytes, long tasks and long
 * animation frames, Event Timing entries, per-input latency), main-process
 * calls and event-loop delay, and — when `frames` — the frame recorder's
 * intervals.
 */
async function measure(app, name, body, { frames = false, inputs = false, components = false } = {}) {
  const { cdp, main } = app
  await cdp.evaluate(`(() => { __perf.reset(); __perf.trackInputs = ${inputs}; __perf.trackComponents = ${components} })()`)
  await main.evaluate('(() => { __perfMain.invokes = []; __perfMain.hist.reset() })()')
  if (frames) await cdp.evaluate('__perf.startFrames()')
  const m0 = await perfMetrics(cdp)
  const c0 = L.cpuSample(app.child.pid)
  const t0 = Date.now()
  const pageT0 = await cdp.evaluate('performance.now()')
  const extra = (await body()) || {}
  const t1 = Date.now()
  const c1 = L.cpuSample(app.child.pid)
  const m1 = await perfMetrics(cdp)
  const secs = (t1 - t0) / 1000
  const frameTimes = frames ? await cdp.evaluate('__perf.stopFrames()', 180000) : null
  const probe = await cdp.evaluate(`(() => {
    const P = __perf
    return {
      rafCalls: P.rafCalls, commits: P.commits, fibers: P.fibers, commitTimes: P.commitTimes,
      components: [...P.components.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
      ipc: P.ipcSummary(), ipcTimes: P.ipc.map((x) => x.t),
      longtasks: P.longtasks, loafs: P.loafs.slice().sort((a, b) => b.duration - a.duration).slice(0, 8),
      events: P.events, inputs: P.inputs.filter((r) => r.done > 0)
    }
  })()`, 180000)
  const mainInfo = await main.evaluate(`(() => {
    const h = __perfMain.hist
    const by = {}
    for (const [, m, id] of __perfMain.invokes) { const k = id ? m + ':' + id : m; by[k] = (by[k] || 0) + 1 }
    return { invokes: __perfMain.invokes.length, invokesBy: by, invokeTimes: __perfMain.invokes.map((x) => x[0]),
      loopDelayMs: { mean: h.mean / 1e6, p99: h.percentile(99) / 1e6, max: h.max / 1e6 },
      heapUsedMB: process.memoryUsage().heapUsed / 1e6, rssMB: process.memoryUsage().rss / 1e6 }
  })()`)
  // Let go of the events kept for sizing, so they don't sit in the heap (and
  // in the next scenario's GCs).
  await cdp.evaluate('(() => { __perf.trackInputs = false; __perf.trackComponents = false; __perf.ipc = [] })()')

  const dm = (k) => (m1[k] ?? 0) - (m0[k] ?? 0)
  const result = {
    name,
    seconds: L.round(secs, 2),
    cpu: L.cpuDelta(c0, c1),
    rss: Object.fromEntries(Object.entries(c1.procs.reduce((acc, p) => ((acc[p.kind] = (acc[p.kind] || 0) + p.rssMB), acc), {})).map(([k, v]) => [k, L.round(v, 0)])),
    renderer: {
      styleRecalcsPerSec: L.round(dm('RecalcStyleCount') / secs, 1),
      layoutsPerSec: L.round(dm('LayoutCount') / secs, 1),
      styleMsPerSec: L.round((dm('RecalcStyleDuration') * 1000) / secs, 1),
      layoutMsPerSec: L.round((dm('LayoutDuration') * 1000) / secs, 1),
      scriptMsPerSec: L.round((dm('ScriptDuration') * 1000) / secs, 1),
      taskMsPerSec: L.round((dm('TaskDuration') * 1000) / secs, 1),
      heapMB: L.round(m1.JSHeapUsedSize / 1e6, 1),
      domNodes: m1.Nodes,
      listeners: m1.JSEventListeners
    },
    app: {
      rafCallsPerSec: L.round(probe.rafCalls / secs, 1),
      reactCommits: probe.commits,
      reactCommitsPerSec: L.round(probe.commits / secs, 1),
      fibersRendered: probe.fibers,
      fibersPerCommit: probe.commits ? L.round(probe.fibers / probe.commits, 0) : 0,
      topComponents: probe.components
    },
    ipc: {
      toRenderer: probe.ipc.count,
      toRendererPerSec: L.round(probe.ipc.count / secs, 1),
      toRendererKBPerSec: L.round(probe.ipc.bytes / 1000 / secs, 1),
      toRendererBytes: probe.ipc.bytes,
      byType: probe.ipc.byType,
      toMain: mainInfo.invokes,
      toMainBy: mainInfo.invokesBy
    },
    main: { loopDelayMs: roundAll(mainInfo.loopDelayMs), heapUsedMB: L.round(mainInfo.heapUsedMB, 1), rssMB: L.round(mainInfo.rssMB, 0) },
    longTasks: {
      count: probe.longtasks.length,
      totalMs: L.round(probe.longtasks.reduce((a, t) => a + t.duration, 0), 0),
      maxMs: L.round(Math.max(0, ...probe.longtasks.map((t) => t.duration)), 0)
    },
    longAnimationFrames: probe.loafs.map((l) => ({ ...l, start: L.round(l.start - pageT0, 0), duration: L.round(l.duration, 0), blocking: L.round(l.blocking, 0), render: L.round(l.render, 0), style: L.round(l.style, 0) })),
    slowEvents: summarizeEvents(probe.events),
    ...extra
  }
  if (frameTimes) result.frames = L.frameStats(frameTimes, app.periodMs)
  if (inputs) result.inputLatency = summarizeInputs(probe.inputs)
  // Kept for the scenarios that slice the window (per drag, per switch).
  result._raw = { probe, mainInfo, frameTimes, pageT0, t0 }
  return result
}

function roundAll(o) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, L.round(v, 1)]))
}

function summarizeEvents(events) {
  const by = {}
  for (const e of events) {
    const b = by[e.name] || (by[e.name] = [])
    b.push(e.duration)
  }
  return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, L.dist(v)]))
}

/** Input → end of the next frame, per input type, in ms. */
function summarizeInputs(inputs) {
  const by = {}
  for (const r of inputs) {
    const b = by[r.type] || (by[r.type] = { latency: [], toFrame: [], queued: [] })
    b.latency.push(r.done - r.ts)
    b.toFrame.push(r.frame - r.ts)
    b.queued.push(r.handled - r.ts)
  }
  return Object.fromEntries(
    Object.entries(by).map(([k, v]) => [k, { latency: L.dist(v.latency), toFrame: L.dist(v.toFrame), queued: L.dist(v.queued) }])
  )
}

async function traced(app, name, secs) {
  await L.traceStart(app.cdp, ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'toplevel', 'v8'])
  await L.sleep(secs * 1000)
  const events = await L.traceStop(app.cdp)
  return L.summarizeTrace(events, secs)
}

const strip = (r) => {
  const { _raw, ...rest } = r
  return rest
}

// ---------------------------------------------------------- scenarios

async function openChat(app, d, chatId) {
  await d.ev(`document.querySelector('[data-testid="sidebar-row-${chatId}"]')?.scrollIntoView({ block: 'center' })`)
  await L.sleep(50)
  await d.click(`[data-testid="sidebar-row-${chatId}"] .chat-row-open`)
  await d.settle(400, 15000)
}

async function ensureLongChat(app, d) {
  const selected = await d.ev(`!!document.querySelector('.chat-transcript') && !!document.querySelector('[data-testid="sidebar-row-${app.profile.longChatId}"].chat-row--selected')`)
  if (!selected) await openChat(app, d, app.profile.longChatId)
  // Scrolled to the end, where a reader of a running chat is.
  await d.ev(`(() => { const el = document.querySelector('.chat-transcript'); if (el) el.scrollTop = el.scrollHeight })()`)
  await L.sleep(300)
}

async function closePopovers(d) {
  for (let i = 0; i < 3; i++) {
    const open = await d.ev(`!!document.querySelector('.thinking-popover, .model-menu, .settings-nav, .session-settings-popover')`)
    if (!open) return
    await d.key('Escape')
    await L.sleep(250)
  }
}

const S = {}

S.idle = async (app, d) => {
  await ensureLongChat(app, d)
  await L.sleep(3000)
  const animations = await d.ev('__perf.animations()')
  const r = await measure(app, 'idle', () => L.sleep(10000))
  r.runningAnimations = animations
  r.trace = await traced(app, 'idle', 4)
  return [r]
}

S.scroll = async (app, d) => {
  await ensureLongChat(app, d)
  const box = await d.rect('.chat-transcript')
  const r = await measure(
    app,
    'scroll',
    async () => {
      const step = async (dy) => {
        await d.mouse('mouseWheel', box.cx, box.cy, { deltaX: 0, deltaY: dy, buttons: 0 })
        await L.sleep(16)
      }
      for (let i = 0; i < 90; i++) await step(-120)
      for (let i = 0; i < 90; i++) await step(120)
      await L.sleep(400)
      return { wheelEvents: 180 }
    },
    { frames: true, inputs: true }
  )
  return [r]
}

const TYPED =
  'please look at why the session store writes the whole file on every change and whether we can batch the writes so typing stays fast and the sidebar keeps its order when a long chat updates its timestamp ok'

S.typing = async (app, d) => {
  await ensureLongChat(app, d)
  await d.click('[data-testid="composer-input"]')
  await L.sleep(300)
  const text = TYPED.slice(0, 200)
  const r = await measure(
    app,
    'typing',
    async () => {
      for (const ch of text) {
        const due = Date.now() + 40
        await d.typeChar(ch)
        const wait = due - Date.now()
        if (wait > 0) await L.sleep(wait)
      }
      await L.sleep(400)
      const value = await d.ev(`document.querySelector('[data-testid="composer-input"]')?.value?.length ?? document.querySelector('[data-testid="composer-input"]')?.textContent?.length`)
      return { chars: text.length, intervalMs: 40, composerLength: value }
    },
    { frames: true, inputs: true }
  )
  await d.clearComposer()
  return [r]
}

S['open-close'] = async (app, d) => {
  await ensureLongChat(app, d)
  await closePopovers(d)
  const targets = [
    { name: 'thinking popover', open: '[data-testid="thinking-chip"]', shown: '.thinking-popover .thinking-slider', gone: '.thinking-popover' },
    { name: 'model menu', open: '[data-testid="model-button"]', shown: '.model-menu-panel', gone: '.model-menu-panel' },
    { name: 'settings sheet', open: '[data-testid="settings-button"]', shown: '.settings-nav', gone: '.settings-nav' }
  ]
  const results = {}
  const r = await measure(
    app,
    'open-close',
    async () => {
      for (const t of targets) {
        const opens = []
        const closes = []
        for (let i = 0; i < 3; i++) {
          // Both watchers start before the click, so neither waits on the
          // click's own round trips.
          const settlePromise = d.settle(150, 4000)
          const shownPromise = d.waitFor(t.shown)
          const before = await d.ev('performance.now()')
          await d.click(t.open)
          const shown = await shownPromise
          const settled = await settlePromise
          opens.push({ toFrame: shown ? shown.frame - before : null, toSettled: settled.settled - before })
          await L.sleep(200)
          const s2p = d.settle(150, 4000)
          const b2 = await d.ev('performance.now()')
          await d.key('Escape')
          await d.waitGone(t.gone)
          const s2 = await s2p
          closes.push(s2.settled - b2)
          await L.sleep(200)
        }
        results[t.name] = {
          openToFrameMs: L.dist(opens.map((o) => o.toFrame)),
          openToSettledMs: L.dist(opens.map((o) => o.toSettled)),
          closeToSettledMs: L.dist(closes)
        }
      }
      // The sidebar's search: a query typed, the list filtered, cleared.
      await d.click('.sidebar-search input')
      await L.sleep(200)
      const perKey = []
      for (const ch of 'refactor') {
        const sp = d.settle(100, 4000)
        const b = await d.ev('performance.now()')
        await d.typeChar(ch)
        const s = await sp
        perKey.push(s.settled - b)
      }
      const filtered = await d.ev(`document.querySelectorAll('[data-testid^="sidebar-row-"]').length`)
      const s3p = d.settle(100, 4000)
      const b3 = await d.ev('performance.now()')
      await d.key('Escape')
      const s3 = await s3p
      results['sidebar search'] = { keyToSettledMs: L.dist(perKey), rowsShown: filtered, clearToSettledMs: L.round(s3.settled - b3, 1) }
      return {}
    },
    { frames: true, inputs: true }
  )
  r.targets = results
  return [r]
}

/** The slider's geometry: where each stop is on screen. */
async function sliderGeometry(d) {
  return d.ev(`(() => {
    const rail = document.querySelector('.thinking-popover .thinking-rail')
    if (!rail) return null
    const r = rail.getBoundingClientRect()
    const labels = [...document.querySelectorAll('.thinking-popover .thinking-label')].map((l) => l.textContent)
    const n = labels.length
    return { left: r.left, width: r.width, y: r.top, labels, xs: labels.map((_, i) => r.left + (r.width * i) / (n - 1)) }
  })()`)
}

async function openSlider(d) {
  await closePopovers(d)
  await d.click('[data-testid="thinking-chip"]')
  await d.waitFor('.thinking-popover .thinking-rail')
  await L.sleep(250)
  return sliderGeometry(d)
}

/** A pointer drag along the slider at `hz`, `ms` long per leg: pressed at
 *  the first point, moved through the others, released at the last. */
async function drag(app, d, points, { ms = 400, hz = 120, holdMs = 0 } = {}) {
  const period = 1000 / hz
  const y = points.y
  const acks = []
  let moves = 0
  const xs = points.xs
  await d.mouse('mouseMoved', xs[0], y, { buttons: 0 })
  const tPress = Date.now()
  await d.mouse('mousePressed', xs[0], y)
  for (let leg = 1; leg < xs.length; leg++) {
    const from = xs[leg - 1]
    const to = xs[leg]
    const steps = Math.max(1, Math.round(ms / period))
    const start = Date.now()
    for (let s = 1; s <= steps; s++) {
      const x = from + ((to - from) * s) / steps
      const sent = Date.now()
      acks.push(d.mouse('mouseMoved', x, y).then(() => Date.now() - sent))
      moves++
      const wait = start + s * period - Date.now()
      if (wait > 0) await L.sleep(wait)
    }
    if (holdMs) await L.sleep(holdMs)
  }
  const ackMs = await Promise.all(acks)
  const tRelease = Date.now()
  await d.mouse('mouseReleased', xs[xs.length - 1], y)
  return { moves, tPress, tRelease, ackMs }
}

/** Watches the slider's words for `ms` after a release: when they first
 *  say `label`, and every value they show on the way (a thumb that steps
 *  back through a stale value shows here as a flicker). */
function watchLabel(d, label, ms = 1500) {
  return d.ev(
    `new Promise((resolve) => {
      const t0 = performance.now(); const seen = []; let hit = null; let el = null
      const tick = () => {
        const t = performance.now()
        if (!el || !el.isConnected) el = document.querySelector('.thinking-popover .thinking-value')
        const v = el ? el.textContent : null
        if (seen.length === 0 || seen[seen.length - 1].v !== v) seen.push({ v, at: Math.round(t - t0) })
        if (hit === null && v === ${JSON.stringify(label)}) hit = t - t0
        if (t - t0 < ${ms}) requestAnimationFrame(tick); else resolve({ hit, seen })
      }
      requestAnimationFrame(tick)
    })`,
    ms + 5000
  )
}

/**
 * How far the drawn thumb trails the pointer. Per frame: the distance from
 * the thumb to the stop nearest the pointer (where a snapping slider should
 * already be), and per change of that stop, how long the thumb took to get
 * within a pixel of it.
 */
function thumbLag(samples, xs) {
  const nearest = (x) => xs.reduce((best, sx) => (Math.abs(sx - x) < Math.abs(best - x) ? sx : best), xs[0])
  const gaps = []
  const catchUps = []
  let target = null
  let since = 0
  let arrived = true
  for (const [t, px, thumb] of samples) {
    const want = nearest(px)
    if (want !== target) {
      if (target !== null && !arrived) catchUps.push(t - since) // overtaken before arriving
      target = want
      since = t
      arrived = Math.abs(thumb - want) < 1
    }
    const gap = Math.abs(thumb - want)
    gaps.push(gap)
    if (!arrived && gap < 1) {
      arrived = true
      catchUps.push(t - since)
    }
  }
  return { frames: samples.length, gapPx: L.dist(gaps), catchUpMs: L.dist(catchUps), stopSpacingPx: L.round(xs[1] - xs[0], 1) }
}

function configCallsBetween(app, t0, t1) {
  return L.readFakeLog(app.profile).filter((e) => e.method === 'session/set_config_option' && e.t >= t0 && e.t <= t1)
}

S.slider = async (app, d) => {
  await ensureLongChat(app, d)
  let g = await openSlider(d)
  if (!g) throw new Error('the thinking slider did not open')
  const last = g.labels.length - 1
  const max = last - 1
  // Start from Low with Ultra off.
  await d.key('Home')
  await L.sleep(800)
  g = await sliderGeometry(d)
  const results = {}
  const drags = []

  // 10 × Low → Max and back, each a press-drag-release.
  let thumbSamples = []
  const main = await measure(
    app,
    'slider-drag',
    async () => {
      await d.ev('__perf.startThumb()')
      for (let i = 0; i < 10; i++) {
        for (const [a, b] of [[0, max], [max, 0]]) {
          const info = await drag(app, d, { xs: [g.xs[a], g.xs[b]], y: g.y }, { ms: 400 })
          const watch = await watchLabel(d, g.labels[b], 600)
          drags.push({ ...info, to: g.labels[b], label: watch })
        }
      }
      await L.sleep(400)
      thumbSamples = await d.ev('__perf.stopThumb()')
      return {}
    },
    { frames: true, inputs: true, components: true }
  )
  // Per drag: the calls the CLI got while the pointer was down and after.
  const fakeLog = L.readFakeLog(app.profile)
  const calls = (t0, t1) => fakeLog.filter((e) => e.method === 'session/set_config_option' && e.t >= t0 && e.t < t1)
  const perDrag = drags.map((dr, i) => {
    const next = drags[i + 1]?.tPress ?? dr.tRelease + 1500
    return { during: calls(dr.tPress, dr.tRelease).length, after: calls(dr.tRelease, next).length, releaseToLabelMs: dr.label.hit, labelsSeen: dr.label.seen.map((s) => s.v), maxAckMs: Math.max(...dr.ackMs) }
  })
  const totalMoves = drags.reduce((a, x) => a + x.moves, 0)
  // Event Timing: from the release to the frame that showed its result, as
  // the browser itself measured it (entries of 16 ms or more only).
  const ups = main._raw.probe.events.filter((e) => e.name === 'pointerup').map((e) => e.duration)
  main.drag = {
    releaseToPaintMs: { slowCount: ups.length, ...L.dist(ups) },
    drags: drags.length,
    moves: totalMoves,
    reactCommitsPerMove: L.round(main.app.reactCommits / totalMoves, 2),
    fibersPerMove: L.round(main.app.fibersRendered / totalMoves, 1),
    ipcToRendererPerMove: L.round(main.ipc.toRenderer / totalMoves, 2),
    ipcToMainPerMove: L.round(main.ipc.toMain / totalMoves, 2),
    configCallsDuringDrag: perDrag.reduce((a, x) => a + x.during, 0),
    configCallsPerRelease: L.dist(perDrag.map((x) => x.after)),
    releaseToLabelMs: L.dist(perDrag.map((x) => x.releaseToLabelMs ?? 9999)),
    labelFlickers: perDrag.filter((x) => new Set(x.labelsSeen).size > 2).length,
    dispatchAckMs: L.dist(drags.flatMap((x) => x.ackMs)),
    sampleLabelsSeen: perDrag.slice(0, 2).map((x) => x.labelsSeen),
    thumb: thumbLag(thumbSamples, g.xs.slice(0, max + 1))
  }
  results.drag = main

  // Rapid arrow keys inside Low…Max: R R R R L L L L, three times, 30 ms apart.
  await d.key('Home')
  await L.sleep(800)
  const arrows = await measure(
    app,
    'slider-arrows',
    async () => {
      const t0 = Date.now()
      let presses = 0
      for (let i = 0; i < 3; i++) {
        for (const k of ['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft']) {
          const due = Date.now() + 30
          await d.key(k)
          presses++
          const w = due - Date.now()
          if (w > 0) await L.sleep(w)
        }
      }
      const tEnd = Date.now()
      await L.sleep(1500)
      return { presses, configCalls: configCallsBetween(app, t0, Date.now()).length, configCallsWhilePressing: configCallsBetween(app, t0, tEnd).length }
    },
    { frames: true, inputs: true }
  )
  results.arrows = arrows

  // Onto Ultra and off again without letting go: no meteor, ends on Max.
  const onOff = await measure(
    app,
    'slider-ultra-on-off',
    async () => {
      const info = await drag(app, d, { xs: [g.xs[max], g.xs[last], g.xs[max]], y: g.y }, { ms: 250, holdMs: 200 })
      const watch = await watchLabel(d, g.labels[max], 1200)
      return { moves: info.moves, labelsSeen: watch.seen.map((s) => s.v), configCalls: configCallsBetween(app, info.tPress, Date.now()).map((c) => `${c.configId}=${c.value}`) }
    },
    { frames: true, inputs: true }
  )
  results.ultraOnOff = onOff

  // The UI under a slow CLI: a 400 ms reply delay, one drag Low → Max.
  await d.key('Home')
  await L.sleep(1000)
  L.setControl(app.profile, { delayMs: 400 })
  const slow = await measure(
    app,
    'slider-slow-cli',
    async () => {
      const info = await drag(app, d, { xs: [g.xs[0], g.xs[max]], y: g.y }, { ms: 400 })
      const watch = await watchLabel(d, g.labels[max], 1500)
      const replies = configCallsBetween(app, info.tPress, Date.now())
      return {
        releaseToLabelMs: watch.hit === null ? null : L.round(watch.hit, 1),
        labelsSeen: watch.seen,
        cliDelayMs: 400,
        configCalls: replies.length,
        firstCallAfterReleaseMs: replies.length ? replies[0].t - info.tRelease : null
      }
    },
    { frames: true, inputs: true }
  )
  L.setControl(app.profile, {})
  results.slowCli = slow
  await L.sleep(600)
  return [main, arrows, onOff, slow].map((r) => r)
}

S['ultra-idle'] = async (app, d) => {
  await ensureLongChat(app, d)
  let g = await openSlider(d)
  const last = g.labels.length - 1
  // From Max, onto Ultra, released: the meteor.
  await d.key('End')
  await L.sleep(300)
  await d.key('ArrowLeft')
  await L.sleep(1200)
  g = await sliderGeometry(d)
  const meteor = await measure(
    app,
    'slider-meteor',
    async () => {
      const info = await drag(app, d, { xs: [g.xs[last - 1], g.xs[last]], y: g.y }, { ms: 150 })
      const flight = await d.ev(`new Promise((resolve) => {
        const t0 = performance.now(); let flying = 0, meteor = 0, lit = null, s = null
        const tick = (t) => {
          if (!s || !s.isConnected) s = document.querySelector('.thinking-popover .thinking-slider')
          const c = s ? s.className : ''
          if (c.includes('--flying')) flying = t - t0
          if (c.includes('--meteor')) meteor = t - t0
          if (lit === null && c.includes('--ultra') && !c.includes('--meteor')) lit = t - t0
          if (t - t0 < 2500) requestAnimationFrame(tick); else resolve({ flyingUntil: Math.round(flying), meteorUntil: Math.round(meteor), litAt: lit && Math.round(lit) })
        }
        requestAnimationFrame(tick)
      })`)
      return { flight, configCalls: configCallsBetween(app, info.tPress, Date.now()).map((c) => `${c.configId}=${c.value}`) }
    },
    { frames: true, inputs: true, components: true }
  )
  await L.sleep(1000)
  const lit = await d.ev(`!!document.querySelector('.thinking-popover .thinking-slider--ultra') && !!document.querySelector('.thinking-embers')`)
  const animations = await d.ev('__perf.animations()')
  const idle = await measure(app, 'idle-ultra-popover', () => L.sleep(10000))
  idle.smoulderRunning = lit
  idle.runningAnimations = animations
  idle.trace = await traced(app, 'idle-ultra-popover', 4)
  await closePopovers(d)
  // Ultra stays on; the chip wears it. Idle with the popover closed, lit chip.
  await L.sleep(1000)
  const chipIdle = await measure(app, 'idle-ultra-chip', () => L.sleep(5000))
  chipIdle.runningAnimations = await d.ev('__perf.animations()')
  // Back to High, Ultra off, for what follows.
  await openSlider(d)
  await d.key('ArrowLeft')
  await L.sleep(300)
  await d.key('ArrowLeft')
  await L.sleep(300)
  await d.key('ArrowLeft')
  await L.sleep(1000)
  await closePopovers(d)
  return [meteor, idle, chipIdle]
}

S['glow-idle'] = async (app, d) => {
  await ensureLongChat(app, d)
  await closePopovers(d)
  await d.click('[data-testid="composer-input"]')
  await d.insertText('ultracode refactor the session store so that persist is debounced')
  await L.sleep(1500)
  const glow = await d.ev(`!!document.querySelector('[data-testid="activation-mirror"]')`)
  const animations = await d.ev('__perf.animations()')
  const r = await measure(app, 'idle-activation-glow', () => L.sleep(10000))
  r.glowShown = glow
  r.runningAnimations = animations
  r.trace = await traced(app, 'idle-activation-glow', 4)
  await d.clearComposer()
  return [r]
}

S.switch = async (app, d) => {
  await closePopovers(d)
  const visible = app.profile.sessions.filter((s) => !s.archived)
  const long = app.profile.longChatId
  const others = visible.filter((s) => s.id !== long).map((s) => s.id)
  const o = (i) => others[i % others.length]
  const order = [o(0), long, o(1), long, o(2), o(3), long, o(4), o(5), long]
  const switches = []
  const r = await measure(
    app,
    'switch-chats',
    async () => {
      for (const id of order) {
        await d.ev(`document.querySelector('[data-testid="sidebar-row-${id}"]')?.scrollIntoView({ block: 'center' })`)
        await L.sleep(120)
        const settle = d.settle(300, 15000)
        const before = await d.ev('performance.now()')
        await d.click(`[data-testid="sidebar-row-${id}"] .chat-row-open`)
        const s = await settle
        const items = app.profile.sessions.find((x) => x.id === id).items
        switches.push({ id, items, toFirstFrameMs: L.round((s.firstFrame ?? s.frame) - before, 1), toSettledFrameMs: L.round(s.settled - before, 1), mutations: s.mutations, timedOut: s.timedOut })
        await L.sleep(300)
      }
      return {}
    },
    { frames: true, inputs: true }
  )
  r.switches = switches
  r.toSettledFrameMs = L.dist(switches.map((s) => s.toSettledFrameMs))
  r.toFirstFrameMs = L.dist(switches.map((s) => s.toFirstFrameMs))
  r.toLongChatMs = L.dist(switches.filter((s) => s.id === long).map((s) => s.toSettledFrameMs))
  r.toShortChatMs = L.dist(switches.filter((s) => s.id !== long).map((s) => s.toSettledFrameMs))
  return [r]
}

S.streaming = async (app, d) => {
  const long = await streamInto(app, d, app.profile.longChatId, 'streaming')
  // The same turn into a short chat: what is per update, and what grows
  // with the transcript.
  const shortId = app.profile.sessions.find((s) => !s.archived && s.items < 30 && s.id !== app.profile.longChatId).id
  const short = await streamInto(app, d, shortId, 'streaming-short-chat')
  return [...long, ...short]
}

async function streamInto(app, d, chatId, name) {
  await closePopovers(d)
  if (chatId === app.profile.longChatId) await ensureLongChat(app, d)
  else await openChat(app, d, chatId)
  await L.sleep(1500)
  await d.ev('__perf.reset()')
  await app.cdp.send('HeapProfiler.collectGarbage')
  await L.sleep(500)
  const heapBefore = (await perfMetrics(app.cdp)).JSHeapUsedSize
  const mainHeapBefore = await app.main.evaluate('(global.gc && global.gc(), process.memoryUsage().heapUsed)')
  await d.click('[data-testid="composer-input"]')
  await d.insertText('Profile the persistence layer and make the hot paths cheaper')
  await L.sleep(300)
  let fake = {}
  const r = await measure(
    app,
    name,
    async () => {
      const sentAt = Date.now()
      await d.key('Enter')
      // Until the agent has said everything and the page has caught up.
      const deadline = Date.now() + 180000
      let end = null
      while (Date.now() < deadline) {
        end = L.readFakeLog(app.profile).find((e) => e.event === 'turn-end' && e.t >= sentAt)
        if (end) break
        await L.sleep(200)
      }
      log(`    turn ended at the agent: ${JSON.stringify(end)}; waiting for the page`)
      const s = await d.settle(500, 120000)
      log(`    page settled: ${JSON.stringify(s)}`)
      const settledEpoch = await d.ev(`performance.timeOrigin + ${s.settled}`)
      const start = L.readFakeLog(app.profile).find((e) => e.event === 'turn-start' && e.t >= sentAt)
      fake = { start, end }
      return {
        stream: {
          updates: end?.updates,
          wireBytes: end?.bytes,
          agentStreamMs: end && start ? end.t - start.t : null,
          sendToFirstUpdateMs: start ? start.t - sentAt : null,
          firstUpdateToSettledMs: start ? L.round(settledEpoch - start.t, 0) : null,
          renderLagAtEndMs: end ? L.round(settledEpoch - end.t, 0) : null,
          settleTimedOut: s.timedOut
        }
      }
    },
    { frames: true }
  )
  await d.ev('__perf.reset()')
  await app.cdp.send('HeapProfiler.collectGarbage')
  await L.sleep(500)
  const heapAfter = (await perfMetrics(app.cdp)).JSHeapUsedSize
  const mainHeapAfter = await app.main.evaluate('(global.gc && global.gc(), process.memoryUsage().heapUsed)')
  r.memory = {
    rendererHeapBeforeMB: L.round(heapBefore / 1e6, 1),
    rendererHeapAfterMB: L.round(heapAfter / 1e6, 1),
    mainHeapBeforeMB: L.round(mainHeapBefore / 1e6, 1),
    mainHeapAfterMB: L.round(mainHeapAfter / 1e6, 1)
  }
  // The renderer's frames over the stream alone, from the first update.
  return [r]
}

// --------------------------------------------------------------- runs

async function preflight(app) {
  const hz = await app.cdp.evaluate(`new Promise((r) => { __perf.startFrames(); setTimeout(() => { const t = __perf.stopFrames(); const iv = []; for (let i = 1; i < t.length; i++) iv.push(t[i] - t[i - 1]); iv.sort((a, b) => a - b); r({ frames: t.length, medianMs: iv[Math.floor(iv.length / 2)] }) }, 1000) })`)
  const page = await app.cdp.evaluate('({ visibility: document.visibilityState, focus: document.hasFocus(), dpr: devicePixelRatio, w: innerWidth, h: innerHeight })')
  app.periodMs = hz.medianMs || 16.7
  const info = { refreshHz: L.round(1000 / app.periodMs, 0), rafFramesIn1s: hz.frames, ...page, window: app.windowInfo }
  if (hz.frames < 30) {
    log(`WARNING: only ${hz.frames} frames in a second — the window is hidden, minimised or throttled; numbers will be meaningless`)
    info.warning = 'window not producing frames'
  }
  return info
}

async function runOnce(args, runIndex, scenarios) {
  const app = await startApp(args, runIndex)
  const d = driver(app)
  const out = { run: runIndex, loadavgStart: L.loadAverage(), scenarios: {} }
  try {
    await L.sleep(1500)
    out.preflight = await preflight(app)
    log(`preflight: ${JSON.stringify(out.preflight)}`)
    await ensureLongChat(app, d)
    await L.sleep(1000)
    for (const name of scenarios) {
      log(`  ${name}…`)
      try {
        const results = await S[name](app, d)
        for (const r of results) out.scenarios[r.name] = strip(r)
      } catch (err) {
        log(`  ${name} FAILED: ${err.stack || err}`)
        out.scenarios[name] = { name, error: String(err.stack || err) }
        await closePopovers(d).catch(() => {})
      }
    }
    out.loadavgEnd = L.loadAverage()
    out.fakeLogLines = L.readFakeLog(app.profile).length
  } finally {
    app.cdp.close()
    app.main.close()
    await L.kill(app.child)
  }
  return out
}

// ------------------------------------------------------- attribution

/** CPU profiles of main and renderer while the slider is dragged, keys are
 *  typed and a turn streams: which functions the time goes to. */
async function attribution(args, scenarios) {
  const app = await startApp(args, 9)
  const d = driver(app)
  const out = {}
  try {
    await L.sleep(1500)
    await preflight(app)
    await ensureLongChat(app, d)
    await app.cdp.send('Profiler.enable')
    await app.main.send('Profiler.enable')
    await app.cdp.send('Profiler.setSamplingInterval', { interval: 200 })
    await app.main.send('Profiler.setSamplingInterval', { interval: 200 })
    for (const name of scenarios.filter((s) => ['slider', 'typing', 'streaming', 'switch', 'idle'].includes(s))) {
      log(`  attribution: ${name}…`)
      await app.cdp.send('Profiler.start')
      await app.main.send('Profiler.start')
      await S[name](app, d)
      const { profile: rp } = await app.cdp.send('Profiler.stop')
      const { profile: mp } = await app.main.send('Profiler.stop')
      fs.writeFileSync(`${args.out}-${name}-renderer.cpuprofile`, JSON.stringify(rp))
      fs.writeFileSync(`${args.out}-${name}-main.cpuprofile`, JSON.stringify(mp))
      out[name] = { renderer: topFunctions(rp), main: topFunctions(mp), rendererBusyMs: busyMs(rp), mainBusyMs: busyMs(mp) }
    }
  } finally {
    app.cdp.close()
    app.main.close()
    await L.kill(app.child)
  }
  return out
}

/** Milliseconds a CPU profile spent outside (idle) and (program). */
function busyMs(profile) {
  const byId = new Map(profile.nodes.map((x) => [x.id, x]))
  let us = 0
  for (let i = 0; i < profile.samples.length; i++) {
    const name = byId.get(profile.samples[i]).callFrame.functionName
    if (name !== '(idle)' && name !== '(program)') us += profile.timeDeltas[i] || 0
  }
  return L.round(us / 1000, 0)
}

/** The functions with the most self time in a V8 CPU profile. */
function topFunctions(profile, n = 15) {
  const byId = new Map(profile.nodes.map((x) => [x.id, x]))
  const self = new Map()
  const dt = profile.timeDeltas
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i])
    const f = node.callFrame
    const key = `${f.functionName || '(anonymous)'} ${path.basename(f.url || '')}:${f.lineNumber + 1}:${f.columnNumber + 1}`
    self.set(key, (self.get(key) || 0) + (dt[i] || 0))
  }
  // Shares of the time the process was doing something.
  const busy = [...self.entries()].filter(([k]) => !/^\((idle|program)\)/.test(k))
  const total = busy.reduce((a, [, us]) => a + us, 0)
  return busy
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, us]) => ({ fn: k, ms: L.round(us / 1000, 1), pct: L.round((us / total) * 100, 1) }))
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2))
  fs.mkdirSync('/tmp/perf', { recursive: true })
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error('no display: run this in a desktop session (DISPLAY or WAYLAND_DISPLAY)')
  }
  const scenarios = args.only ? SCENARIOS.filter((s) => args.only.includes(s)) : SCENARIOS
  if (args.mode === 'prod' && !args.skipBuild) {
    log('npm run build…')
    execFileSync('npm', ['run', 'build'], { cwd: L.ROOT, stdio: 'ignore' })
  }
  const rev = (() => {
    try {
      return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: L.ROOT, encoding: 'utf8' }).trim() + (execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: L.ROOT, encoding: 'utf8' }).trim() ? '+dirty' : '')
    } catch {
      return 'unknown'
    }
  })()
  const report = {
    tool: 'tools/perf/bench.cjs',
    date: new Date().toISOString(),
    rev,
    mode: args.mode,
    machine: {
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model,
      memGB: L.round(os.totalmem() / 1e9, 0),
      kernel: os.release(),
      session: process.env.XDG_SESSION_TYPE || (process.env.WAYLAND_DISPLAY ? 'wayland' : 'x11'),
      loadavg: L.loadAverage()
    },
    config: { chats: args.chats, longItems: args.longItems, realSessions: !!args.realSessions, scenarios, fake: { delayMs: 20, rate: 500, tokens: 3000, thoughts: 40, tools: 60 } },
    runs: []
  }
  for (let i = 0; i < args.runs; i++) {
    report.runs.push(await runOnce(args, i, scenarios))
    fs.writeFileSync(`${args.out}.json`, JSON.stringify(report, null, 1))
  }
  if (args.attribution) {
    report.attribution = await attribution(args, scenarios)
  }
  fs.writeFileSync(`${args.out}.json`, JSON.stringify(report, null, 1))
  writeReport(report, `${args.out}.md`)
  log(`wrote ${args.out}.json and ${args.out}.md`)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

module.exports = { SCENARIOS }

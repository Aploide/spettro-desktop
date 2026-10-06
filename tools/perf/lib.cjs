// Plumbing for bench.cjs: a scratch profile, launching the app (production
// build or dev server) against the fake agent, a minimal DevTools-protocol
// client, per-process CPU from /proc, and trace/statistics helpers.
//
// Linux only (it reads /proc). No dependencies: Node's own fetch and
// WebSocket.

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------- profile

/**
 * A scratch run directory: a clean HOME for the CLI, an Electron user-data
 * dir seeded with sessions.json and preferences.json pointing at the fake
 * agent, and the fake's log and control files. Never touches the user's own
 * profile: a copy of their sessions can be passed in (`realSessions`).
 */
function makeProfile(dir, { chats = 40, longItems = 800, realSessions = null, fakeEnv = {} } = {}) {
  fs.rmSync(dir, { recursive: true, force: true })
  const home = path.join(dir, 'home')
  const userData = path.join(dir, 'userdata')
  const projects = path.join(dir, 'projects')
  for (const d of [home, userData, projects]) fs.mkdirSync(d, { recursive: true })

  const gen = require('./gen-sessions.cjs')
  for (const p of gen.PROJECTS) fs.mkdirSync(path.join(projects, p), { recursive: true })
  let sessions = gen.generate(chats, longItems, projects)
  if (realSessions) {
    // The user's own chats (a copy), first in the list, pointed at folders
    // that exist here; the synthetic ones follow.
    const real = JSON.parse(fs.readFileSync(realSessions, 'utf8'))
    for (const s of real) {
      const folder = path.join(projects, 'real-' + path.basename(s.projectPath || 'project'))
      fs.mkdirSync(folder, { recursive: true })
      s.projectPath = folder
    }
    sessions = [...real, ...sessions]
  }
  fs.writeFileSync(path.join(userData, 'sessions.json'), JSON.stringify(sessions, null, 2))

  const log = path.join(dir, 'fake-spettro.log')
  const control = path.join(dir, 'fake-control.json')
  fs.writeFileSync(control, '{}')
  const wrapper = path.join(dir, 'spettro')
  const envLines = Object.entries({ FAKE_SPETTRO_LOG: log, FAKE_SPETTRO_CONTROL: control, ...fakeEnv })
    .map(([k, v]) => `export ${k}=${JSON.stringify(String(v))}`)
    .join('\n')
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh\n# The benchmark's stand-in for spettro (tools/perf/fake-spettro.cjs).\n${envLines}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(__dirname, 'fake-spettro.cjs'))} "$@"\n`
  )
  fs.chmodSync(wrapper, 0o755)

  const longest = sessions.reduce((a, s) => (s.items.length > a.items.length ? s : a), sessions[0])
  fs.writeFileSync(
    path.join(userData, 'preferences.json'),
    JSON.stringify({
      explicitCLIPath: wrapper,
      lastProjectPath: longest.projectPath,
      recentProjects: gen.PROJECTS.map((p) => path.join(projects, p)),
      providerSetupSkipped: true,
      notifyWhenDone: false,
      appearance: 'dark',
      accent: 'lilac'
    })
  )
  const totalItems = sessions.reduce((n, s) => n + s.items.length, 0)
  return {
    dir,
    home,
    userData,
    projects,
    log,
    control,
    wrapper,
    sessions: sessions.map((s) => ({ id: s.id, items: s.items.length, archived: !!s.isArchived, title: s.title })),
    longChatId: longest.id,
    sessionsBytes: fs.statSync(path.join(userData, 'sessions.json')).size,
    totalItems
  }
}

function setControl(profile, value) {
  fs.writeFileSync(profile.control, JSON.stringify(value))
}

function readFakeLog(profile) {
  try {
    return fs
      .readFileSync(profile.log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

// -------------------------------------------------------------- launch

/** Starts the app in its own process group. `mode` is 'prod' (the built
 *  out/ bundle under the Electron binary) or 'dev' (electron-vite dev, as
 *  `npm run dev` runs it, into out/perf-dev). */
function launch(profile, { mode = 'prod', cdpPort, inspectPort, logFile }) {
  const env = { ...process.env, HOME: profile.home }
  delete env.ELECTRON_RUN_AS_NODE
  const out = fs.openSync(logFile, 'a')
  let child
  if (mode === 'prod') {
    const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron')
    child = spawn(
      electron,
      [`--inspect=${inspectPort}`, `--remote-debugging-port=${cdpPort}`, '.', `--user-data-dir=${profile.userData}`],
      { cwd: ROOT, env, detached: true, stdio: ['ignore', out, out] }
    )
  } else {
    const bin = path.join(ROOT, 'node_modules', '.bin', 'electron-vite')
    child = spawn(
      bin,
      [
        'dev',
        '--outDir', 'out/perf-dev',
        '--entry', 'out/perf-dev/main/index.js',
        '--remoteDebuggingPort', String(cdpPort),
        '--inspect', String(inspectPort),
        '--',
        `--user-data-dir=${profile.userData}`
      ],
      { cwd: ROOT, env, detached: true, stdio: ['ignore', out, out] }
    )
  }
  return child
}

/** Ends everything the launch started — its process group, and any
 *  descendant that left it — by PID, never by name. */
async function kill(child) {
  if (!child || child.pid === undefined) return
  const pids = [child.pid, ...descendants(child.pid)]
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {}
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
  for (let i = 0; i < 30; i++) {
    if (pids.every((p) => !alive(p))) return
    await sleep(100)
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ------------------------------------------------------------ /proc CPU

const CLK_TCK = (() => {
  try {
    return Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100
  } catch {
    return 100
  }
})()

function readStat(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const rest = s.slice(s.lastIndexOf(')') + 2).split(' ')
    return { ppid: Number(rest[1]), ticks: Number(rest[11]) + Number(rest[12]), rssPages: Number(rest[21]) }
  } catch {
    return null
  }
}

function allPids() {
  return fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number)
}

function descendants(root) {
  const children = new Map()
  for (const pid of allPids()) {
    const st = readStat(pid)
    if (!st) continue
    if (!children.has(st.ppid)) children.set(st.ppid, [])
    children.get(st.ppid).push(pid)
  }
  const out = []
  const stack = [root]
  while (stack.length) {
    const p = stack.pop()
    for (const c of children.get(p) || []) {
      out.push(c)
      stack.push(c)
    }
  }
  return out
}

function cmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
  } catch {
    return []
  }
}

/** What a process in the app's tree is. */
function classify(argv) {
  const joined = argv.join(' ')
  const type = /--type=([\w-]+)/.exec(joined)?.[1]
  if (joined.includes('fake-spettro.cjs')) return 'agent'
  if (type === 'renderer') return 'renderer'
  if (type === 'gpu-process') return 'gpu'
  if (type === 'utility') return 'utility'
  if (type === 'zygote') return 'zygote'
  if (type) return type
  if (/electron\/dist\/electron/.test(argv[0] || '')) return 'main'
  if (/electron-vite|vite|esbuild|npm|node/.test(joined)) return 'devserver'
  return 'other'
}

/** CPU ticks per process kind in the app's tree right now. */
function cpuSample(rootPid) {
  const by = {}
  const procs = []
  for (const pid of [rootPid, ...descendants(rootPid)]) {
    const st = readStat(pid)
    if (!st) continue
    const kind = classify(cmdline(pid))
    by[kind] = (by[kind] || 0) + st.ticks
    procs.push({ pid, kind, ticks: st.ticks, rssMB: (st.rssPages * 4096) / 1e6 })
  }
  return { t: Date.now(), by, procs }
}

/** CPU % (of one core) per process kind between two samples. */
function cpuDelta(a, b) {
  const secs = (b.t - a.t) / 1000
  const out = {}
  for (const kind of new Set([...Object.keys(a.by), ...Object.keys(b.by)])) {
    out[kind] = round(((((b.by[kind] || 0) - (a.by[kind] || 0)) / CLK_TCK) / secs) * 100, 1)
  }
  return out
}

function loadAverage() {
  try {
    return fs.readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).map(Number)
  } catch {
    return null
  }
}

// ----------------------------------------------------------------- CDP

/** A DevTools-protocol connection to one target (a page, or the main
 *  process's Node inspector). */
async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const listeners = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id !== undefined && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      if (m.error) reject(new Error(`${m.error.message} (${m.error.code})`))
      else resolve(m.result)
    } else if (m.method) {
      for (const fn of listeners.get(m.method) || []) fn(m.params)
    }
  }
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  const send = (method, params = {}, ms = 120000) =>
    new Promise((resolve, reject) => {
      const i = ++id
      pending.set(i, { resolve, reject })
      ws.send(JSON.stringify({ id: i, method, params }))
      setTimeout(() => {
        if (pending.delete(i)) reject(new Error(`timeout: ${method}`))
      }, ms)
    })
  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, [])
    listeners.get(method).push(fn)
  }
  const evaluate = async (expression, ms) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true }, ms)
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text)
    }
    return res.result?.value
  }
  return { ws, send, on, evaluate, close: () => ws.close() }
}

async function waitForJSON(url, pick, ms = 60000) {
  const start = Date.now()
  for (;;) {
    try {
      const list = await (await fetch(url)).json()
      const hit = pick(list)
      if (hit) return hit
    } catch {}
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${url}`)
    await sleep(250)
  }
}

// --------------------------------------------------------------- trace

/** Starts a trace of the whole browser (every process) from a page target. */
async function traceStart(cdp, categories) {
  await cdp.send('Tracing.start', {
    transferMode: 'ReturnAsStream',
    traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: categories }
  })
}

async function traceStop(cdp) {
  const done = new Promise((resolve) => cdp.on('Tracing.tracingComplete', resolve))
  await cdp.send('Tracing.end')
  const { stream } = await done
  let data = ''
  for (;;) {
    const chunk = await cdp.send('IO.read', { handle: stream, size: 1 << 22 })
    data += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data
    if (chunk.eof) break
  }
  await cdp.send('IO.close', { handle: stream })
  const parsed = JSON.parse(data)
  return Array.isArray(parsed) ? parsed : parsed.traceEvents
}

/**
 * What a trace says happened, per second of `secs`: on the renderer's main
 * thread, style recalcs, layouts, paints, rAF callbacks fired, tasks and
 * long tasks (>50 ms) and its busy time; frames the renderer's compositor
 * drew; and the GPU process's busy time.
 */
function summarizeTrace(events, secs, rendererPid) {
  const threads = new Map() // pid:tid → name
  const procs = new Map()
  for (const e of events) {
    if (e.ph !== 'M') continue
    if (e.name === 'thread_name') threads.set(`${e.pid}:${e.tid}`, e.args.name)
    if (e.name === 'process_name') procs.set(e.pid, e.args.name)
  }
  const thread = (e) => threads.get(`${e.pid}:${e.tid}`) || ''
  // The page's renderer: the one with a CrRendererMain doing the most work
  // (DevTools' own targets are not pages here).
  const mainBusy = new Map()
  for (const e of events) {
    if (e.ph === 'X' && e.name === 'RunTask' && thread(e) === 'CrRendererMain') {
      mainBusy.set(e.pid, (mainBusy.get(e.pid) || 0) + (e.dur || 0))
    }
  }
  let rpid = rendererPid
  if (!rpid || !mainBusy.has(rpid)) {
    rpid = [...mainBusy.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  }
  const count = {}
  const dur = {}
  const longTasks = []
  let mainTaskUs = 0
  let gpuTaskUs = 0
  let browserTaskUs = 0
  const add = (k, d = 0) => {
    count[k] = (count[k] || 0) + 1
    dur[k] = (dur[k] || 0) + d
  }
  for (const e of events) {
    if (e.ph !== 'X' && e.ph !== 'I' && e.ph !== 'i' && e.ph !== 'B') continue
    const tn = thread(e)
    if (e.pid === rpid && tn === 'CrRendererMain') {
      switch (e.name) {
        case 'UpdateLayoutTree':
        case 'Layout':
        case 'Paint':
        case 'PrePaint':
        case 'Layerize':
        case 'FireAnimationFrame':
        case 'EventDispatch':
        case 'FunctionCall':
        case 'TimerFire':
        case 'HitTest':
        case 'ParseHTML':
        case 'MinorGC':
        case 'MajorGC':
        case 'V8.GC_SCAVENGER':
          add(e.name, e.dur || 0)
          break
        case 'RunTask':
          mainTaskUs += e.dur || 0
          add('RunTask', e.dur || 0)
          if ((e.dur || 0) > 50000) longTasks.push(round((e.dur || 0) / 1000, 1))
          break
      }
    } else if (e.pid === rpid && tn === 'Compositor') {
      if (e.name === 'DrawFrame' || e.name === 'BeginFrame' || e.name === 'Commit' || e.name === 'ActivateLayerTree') add('cc.' + e.name)
    } else if (e.name === 'RunTask' && e.ph === 'X') {
      const pname = procs.get(e.pid) || ''
      if (/GPU/i.test(pname)) gpuTaskUs += e.dur || 0
      else if (/Browser/i.test(pname) && tn === 'CrBrowserMain') browserTaskUs += e.dur || 0
    }
  }
  const per = (k) => round((count[k] || 0) / secs, 1)
  return {
    rendererPid: rpid,
    perSecond: {
      styleRecalcs: per('UpdateLayoutTree'),
      layouts: per('Layout'),
      paints: per('Paint'),
      prePaints: per('PrePaint'),
      rafFired: per('FireAnimationFrame'),
      timers: per('TimerFire'),
      events: per('EventDispatch'),
      tasks: per('RunTask'),
      ccFramesDrawn: per('cc.DrawFrame'),
      ccBeginFrames: per('cc.BeginFrame'),
      ccCommits: per('cc.Commit'),
      gcs: round(((count.MinorGC || 0) + (count.MajorGC || 0) + (count['V8.GC_SCAVENGER'] || 0)) / secs, 1)
    },
    msPerSecond: {
      rendererMainBusy: round(mainTaskUs / 1000 / secs, 1),
      style: round((dur.UpdateLayoutTree || 0) / 1000 / secs, 1),
      layout: round((dur.Layout || 0) / 1000 / secs, 1),
      paint: round(((dur.Paint || 0) + (dur.PrePaint || 0) + (dur.Layerize || 0)) / 1000 / secs, 1),
      script: round(((dur.FunctionCall || 0) + (dur.EventDispatch || 0) + (dur.FireAnimationFrame || 0) + (dur.TimerFire || 0)) / 1000 / secs, 1),
      gc: round(((dur.MinorGC || 0) + (dur.MajorGC || 0) + (dur['V8.GC_SCAVENGER'] || 0)) / 1000 / secs, 1),
      gpuBusy: round(gpuTaskUs / 1000 / secs, 1),
      browserMainBusy: round(browserTaskUs / 1000 / secs, 1)
    },
    longTasksMs: longTasks.sort((a, b) => b - a).slice(0, 10)
  }
}

// --------------------------------------------------------------- stats

function round(x, d = 1) {
  if (!Number.isFinite(x)) return x
  const f = 10 ** d
  return Math.round(x * f) / f
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[i]
}

function dist(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (v.length === 0) return { n: 0, p50: null, p95: null, max: null, mean: null }
  return {
    n: v.length,
    p50: round(quantile(v, 0.5), 1),
    p95: round(quantile(v, 0.95), 1),
    max: round(v[v.length - 1], 1),
    mean: round(v.reduce((a, b) => a + b, 0) / v.length, 1)
  }
}

/** Frame intervals from rAF timestamps, and frames dropped against the
 *  display's own period. */
function frameStats(times, periodMs) {
  const intervals = []
  for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1])
  let dropped = 0
  let over50 = 0
  for (const d of intervals) {
    const missed = Math.round(d / periodMs) - 1
    if (missed > 0) dropped += missed
    if (d > 50) over50++
  }
  const d = dist(intervals)
  const span = times.length > 1 ? times[times.length - 1] - times[0] : 0
  return {
    frames: times.length,
    fps: span > 0 ? round(((times.length - 1) * 1000) / span, 1) : 0,
    intervalMs: d,
    dropped,
    droppedPct: round((dropped / Math.max(1, intervals.length + dropped)) * 100, 1),
    over50ms: over50
  }
}

module.exports = {
  ROOT,
  sleep,
  makeProfile,
  setControl,
  readFakeLog,
  launch,
  kill,
  cpuSample,
  cpuDelta,
  loadAverage,
  cdpConnect,
  waitForJSON,
  traceStart,
  traceStop,
  summarizeTrace,
  round,
  dist,
  frameStats,
  descendants,
  cmdline,
  classify
}

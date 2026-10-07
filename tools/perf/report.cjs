// Turns bench.cjs's JSON into a short human summary: one table of headline
// numbers per scenario, each run side by side with the spread between them.
//
//   node tools/perf/report.cjs <bench.json> [out.md]           one report
//   node tools/perf/report.cjs --compare <a.json> <b.json> [out.md]
//                                                               two, side by side
//                                                               (e.g. prod vs dev)

'use strict'

const fs = require('node:fs')

const get = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o)

/** [section, scenario, label, path into the scenario result, unit]. */
const HEADLINES = [
  ['Idle (long chat open, 10 s)', 'idle', 'CPU main / renderer / GPU', ['cpu.main', 'cpu.renderer', 'cpu.gpu'], '%'],
  ['', 'idle', 'app rAF callbacks', 'app.rafCallsPerSec', '/s'],
  ['', 'idle', 'React commits', 'app.reactCommitsPerSec', '/s'],
  ['', 'idle', 'style recalcs / layouts / paints', ['trace.perSecond.styleRecalcs', 'trace.perSecond.layouts', 'trace.perSecond.paints'], '/s'],
  ['', 'idle', 'compositor frames drawn', 'trace.perSecond.ccFramesDrawn', '/s'],
  ['', 'idle', 'IPC main→renderer', 'ipc.toRendererPerSec', '/s'],
  ['', 'idle', 'long tasks', 'longTasks.count', ''],

  ['Idle, thinking popover open on lit Ultra (smoulder)', 'idle-ultra-popover', 'CPU main / renderer / GPU', ['cpu.main', 'cpu.renderer', 'cpu.gpu'], '%'],
  ['', 'idle-ultra-popover', 'app rAF callbacks', 'app.rafCallsPerSec', '/s'],
  ['', 'idle-ultra-popover', 'React commits', 'app.reactCommitsPerSec', '/s'],
  ['', 'idle-ultra-popover', 'style recalcs / layouts / paints', ['trace.perSecond.styleRecalcs', 'trace.perSecond.layouts', 'trace.perSecond.paints'], '/s'],
  ['', 'idle-ultra-popover', 'compositor frames drawn', 'trace.perSecond.ccFramesDrawn', '/s'],
  ['', 'idle-ultra-chip', 'popover closed, lit chip: CPU renderer / GPU', ['cpu.renderer', 'cpu.gpu'], '%'],

  ['Idle, composer holding an activation phrase (glow)', 'idle-activation-glow', 'CPU main / renderer / GPU', ['cpu.main', 'cpu.renderer', 'cpu.gpu'], '%'],
  ['', 'idle-activation-glow', 'app rAF callbacks', 'app.rafCallsPerSec', '/s'],
  ['', 'idle-activation-glow', 'style recalcs / layouts / paints', ['trace.perSecond.styleRecalcs', 'trace.perSecond.layouts', 'trace.perSecond.paints'], '/s'],
  ['', 'idle-activation-glow', 'compositor frames drawn', 'trace.perSecond.ccFramesDrawn', '/s'],

  ['Thinking slider drag (20 drags Low↔Max, 120 Hz moves)', 'slider-drag', 'frame interval p50 / p95 / max', ['frames.intervalMs.p50', 'frames.intervalMs.p95', 'frames.intervalMs.max'], 'ms'],
  ['', 'slider-drag', 'dropped frames', 'frames.droppedPct', '%'],
  ['', 'slider-drag', 'thumb behind the stop under the pointer: p50 / p95 px; catch-up p50 / p95 ms', ['drag.thumb.gapPx.p50', 'drag.thumb.gapPx.p95', 'drag.thumb.catchUpMs.p50', 'drag.thumb.catchUpMs.p95'], ''],
  ['', 'slider-drag', 'pointermove → next frame p50 / p95 / max', ['inputLatency.pointermove.latency.p50', 'inputLatency.pointermove.latency.p95', 'inputLatency.pointermove.latency.max'], 'ms'],
  ['', 'slider-drag', 'long tasks (count / max)', ['longTasks.count', 'longTasks.maxMs'], ''],
  ['', 'slider-drag', 'React commits per move / components per move', ['drag.reactCommitsPerMove', 'drag.fibersPerMove'], ''],
  ['', 'slider-drag', 'set_config_option while dragging / per release (mean)', ['drag.configCallsDuringDrag', 'drag.configCallsPerRelease.mean'], ''],
  ['', 'slider-drag', 'release → label in the DOM p50 / p95', ['drag.releaseToLabelMs.p50', 'drag.releaseToLabelMs.p95'], 'ms'],
  ['', 'slider-drag', 'release → painted (Event Timing; releases ≥16 ms of 20: n / p50 / max)', ['drag.releaseToPaintMs.slowCount', 'drag.releaseToPaintMs.p50', 'drag.releaseToPaintMs.max'], 'ms'],
  ['', 'slider-drag', 'longest animation frame', '_worstLoaf', 'ms'],
  ['', 'slider-drag', 'IPC per move: →renderer / →main', ['drag.ipcToRendererPerMove', 'drag.ipcToMainPerMove'], ''],
  ['', 'slider-drag', 'IPC main→renderer volume', 'ipc.toRendererKBPerSec', 'KB/s'],
  ['', 'slider-drag', 'CPU main / renderer / GPU', ['cpu.main', 'cpu.renderer', 'cpu.gpu'], '%'],
  ['', 'slider-drag', 'main event-loop delay p99 / max', ['main.loopDelayMs.p99', 'main.loopDelayMs.max'], 'ms'],
  ['', 'slider-arrows', 'arrow keys: keydown → frame p95 / max', ['inputLatency.keydown.latency.p95', 'inputLatency.keydown.latency.max'], 'ms'],
  ['', 'slider-arrows', 'arrow keys: keydown → painted (Event Timing ≥16 ms: n / p50 / max)', ['slowEvents.keydown.n', 'slowEvents.keydown.p50', 'slowEvents.keydown.max'], 'ms'],
  ['', 'slider-arrows', 'arrow keys: set_config_option for 24 presses', 'configCalls', ''],
  ['', 'slider-arrows', 'arrow keys: CPU main / main event-loop delay max', ['cpu.main', 'main.loopDelayMs.max'], '% / ms'],
  ['', 'slider-ultra-on-off', 'onto Ultra and off: frame p95 / max', ['frames.intervalMs.p95', 'frames.intervalMs.max'], 'ms'],
  ['', 'slider-meteor', 'meteor: frame p50 / p95 / max', ['frames.intervalMs.p50', 'frames.intervalMs.p95', 'frames.intervalMs.max'], 'ms'],
  ['', 'slider-meteor', 'meteor: dropped frames / long tasks', ['frames.droppedPct', 'longTasks.count'], ''],
  ['', 'slider-slow-cli', 'CLI answering in 400 ms: release → label in the DOM / painted', ['releaseToLabelMs', 'slowEvents.pointerup.max'], 'ms'],

  ['Typing 200 chars (40 ms apart)', 'typing', 'keydown → next frame p50 / p95 / max', ['inputLatency.keydown.latency.p50', 'inputLatency.keydown.latency.p95', 'inputLatency.keydown.latency.max'], 'ms'],
  ['', 'typing', 'keydown → painted (Event Timing ≥16 ms: n / p50 / max)', ['slowEvents.keydown.n', 'slowEvents.keydown.p50', 'slowEvents.keydown.max'], 'ms'],
  ['', 'typing', 'frame interval p95 / max', ['frames.intervalMs.p95', 'frames.intervalMs.max'], 'ms'],
  ['', 'typing', 'IPC renderer→main per key / main→renderer per key', ['_perKeyToMain', '_perKeyToRenderer'], ''],
  ['', 'typing', 'long tasks (count / max)', ['longTasks.count', 'longTasks.maxMs'], ''],
  ['', 'typing', 'React commits per key / components per commit', ['_perKeyCommits', 'app.fibersPerCommit'], ''],
  ['', 'typing', 'CPU main / renderer', ['cpu.main', 'cpu.renderer'], '%'],

  ['Scrolling the long transcript (wheel)', 'scroll', 'frame interval p50 / p95 / max', ['frames.intervalMs.p50', 'frames.intervalMs.p95', 'frames.intervalMs.max'], 'ms'],
  ['', 'scroll', 'dropped frames / long tasks', ['frames.droppedPct', 'longTasks.count'], ''],

  ['Switching chats (10 switches)', 'switch-chats', 'click → settled frame p50 / p95 / max', ['toSettledFrameMs.p50', 'toSettledFrameMs.p95', 'toSettledFrameMs.max'], 'ms'],
  ['', 'switch-chats', 'click → first changed frame p50 / max', ['toFirstFrameMs.p50', 'toFirstFrameMs.max'], 'ms'],
  ['', 'switch-chats', 'to the 800-item chat / to a short chat (p50)', ['toLongChatMs.p50', 'toShortChatMs.p50'], 'ms'],
  ['', 'switch-chats', 'click → the 800-item chat on screen p50 / max', ['toLongChatShownMs.p50', 'toLongChatShownMs.max'], 'ms'],
  ['', 'switch-chats', 'IPC main→renderer volume (10 switches)', '_switchMB', 'MB'],
  ['', 'switch-chats', 'main event-loop delay max', 'main.loopDelayMs.max', 'ms'],
  ['', 'switch-chats', 'long tasks (count / max)', ['longTasks.count', 'longTasks.maxMs'], ''],

  ['Opening and closing', 'open-close', 'thinking popover: click → frame / settled (p50)', ['targets.thinking popover.openToFrameMs.p50', 'targets.thinking popover.openToSettledMs.p50'], 'ms'],
  ['', 'open-close', 'model menu: click → frame / settled (p50)', ['targets.model menu.openToFrameMs.p50', 'targets.model menu.openToSettledMs.p50'], 'ms'],
  ['', 'open-close', 'settings sheet: click → frame / settled (p50)', ['targets.settings sheet.openToFrameMs.p50', 'targets.settings sheet.openToSettledMs.p50'], 'ms'],
  ['', 'open-close', 'sidebar search: key → list settled p50 / max', ['targets.sidebar search.keyToSettledMs.p50', 'targets.sidebar search.keyToSettledMs.max'], 'ms'],

  ['Streaming a heavy turn (3171 updates at 500/s)', 'streaming', 'first update → page settled / agent stream time', ['stream.firstUpdateToSettledMs', 'stream.agentStreamMs'], 'ms'],
  ['', 'streaming', 'page still catching up after the agent ended', 'stream.renderLagAtEndMs', 'ms'],
  ['', 'streaming', 'frame interval p50 / p95 / max', ['frames.intervalMs.p50', 'frames.intervalMs.p95', 'frames.intervalMs.max'], 'ms'],
  ['', 'streaming', 'dropped frames', 'frames.droppedPct', '%'],
  ['', 'streaming', 'long tasks (count / total / max)', ['longTasks.count', 'longTasks.totalMs', 'longTasks.maxMs'], ''],
  ['', 'streaming', 'CPU main / renderer / GPU / agent', ['cpu.main', 'cpu.renderer', 'cpu.gpu', 'cpu.agent'], '%'],
  ['', 'streaming', 'IPC main→renderer: msgs/s, KB/s', ['ipc.toRendererPerSec', 'ipc.toRendererKBPerSec'], ''],
  ['', 'streaming', 'IPC main→renderer total MB / agent wire MB', ['_ipcMB', '_wireMB'], 'MB'],
  ['', 'streaming', 'main event-loop delay p99 / max', ['main.loopDelayMs.p99', 'main.loopDelayMs.max'], 'ms'],
  ['', 'streaming', 'React commits / components rendered per commit', ['app.reactCommits', 'app.fibersPerCommit'], ''],
  ['', 'streaming', 'renderer JS heap before → after (GC’d)', ['memory.rendererHeapBeforeMB', 'memory.rendererHeapAfterMB'], 'MB'],
  ['Same turn into a 16-item chat', 'streaming-short-chat', 'first update → page settled / page lag at end', ['stream.firstUpdateToSettledMs', 'stream.renderLagAtEndMs'], 'ms'],
  ['', 'streaming-short-chat', 'frame interval p50 / p95 / max', ['frames.intervalMs.p50', 'frames.intervalMs.p95', 'frames.intervalMs.max'], 'ms'],
  ['', 'streaming-short-chat', 'React commits / components rendered per commit', ['app.reactCommits', 'app.fibersPerCommit'], ''],
  ['', 'streaming-short-chat', 'CPU main / renderer / GPU', ['cpu.main', 'cpu.renderer', 'cpu.gpu'], '%']
]

/** Values computed from others, so the table can show them. */
function derived(scenario, name) {
  if (!scenario) return scenario
  const s = { ...scenario }
  if (name === 'typing' && s.app && s.chars) {
    s._perKeyCommits = Math.round((s.app.reactCommits / s.chars) * 100) / 100
    s._perKeyToMain = Math.round((s.ipc.toMain / s.chars) * 100) / 100
    s._perKeyToRenderer = Math.round((s.ipc.toRenderer / s.chars) * 100) / 100
  }
  if (name === 'switch-chats' && s.ipc) s._switchMB = Math.round(s.ipc.toRendererBytes / 1e4) / 100
  if (Array.isArray(s.longAnimationFrames)) s._worstLoaf = Math.max(0, ...s.longAnimationFrames.map((l) => l.duration))
  if (name === 'streaming') {
    if (s.ipc) s._ipcMB = Math.round(s.ipc.toRendererBytes / 1e4) / 100
    if (s.stream?.wireBytes) s._wireMB = Math.round(s.stream.wireBytes / 1e4) / 100
  }
  return s
}

function fmt(v) {
  if (v === undefined || v === null || Number.isNaN(v)) return '–'
  if (typeof v !== 'number') return String(v)
  if (Math.abs(v) >= 100) return String(Math.round(v))
  return String(Math.round(v * 10) / 10)
}

function cell(scenario, paths) {
  const list = Array.isArray(paths) ? paths : [paths]
  return list.map((p) => fmt(get(scenario, p))).join(' / ')
}

/** Spread between runs of the first number in the cell, as a percentage of
 *  their mean. */
function spread(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v))
  if (nums.length < 2) return ''
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length
  if (mean === 0) return '0%'
  return `${Math.round(((Math.max(...nums) - Math.min(...nums)) / Math.abs(mean)) * 100)}%`
}

function table(report) {
  const runs = report.runs
  const header = `| scenario | metric | ${runs.map((r) => `run ${r.run + 1}`).join(' | ')} | spread | unit |\n|---|---|${runs.map(() => '---:').join('|')}|---:|---|`
  const rows = []
  for (const [section, name, label, paths, unit] of HEADLINES) {
    const scenarios = runs.map((r) => derived(r.scenarios[name], name))
    if (scenarios.every((s) => !s)) continue
    const first = Array.isArray(paths) ? paths[0] : paths
    const errored = scenarios.some((s) => s && s.error)
    rows.push(
      `| ${section} | ${label} | ${scenarios.map((s) => (s ? (s.error ? 'error' : cell(s, paths)) : '–')).join(' | ')} | ${errored ? '' : spread(scenarios.map((s) => get(s, first)))} | ${unit} |`
    )
  }
  return [header, ...rows].join('\n')
}

function describe(report) {
  const r0 = report.runs[0] || {}
  const pf = r0.preflight || {}
  return [
    `# Spettro Desktop performance — ${report.mode} build, ${report.rev}`,
    '',
    `${report.date} · ${report.machine.cpuModel} (${report.machine.cpus} threads, ${report.machine.memGB} GB) · ${report.machine.session} · display ${pf.refreshHz ?? '?'} Hz, ${pf.w}×${pf.h} @${pf.dpr}x · Electron ${pf.window?.electron ?? '?'}`,
    '',
    `Profile: ${report.config.chats} generated chats (one of ${report.config.longItems} items)${report.config.realSessions ? ' plus a copy of real sessions' : ''}; fake agent replying in ${report.config.fake.delayMs} ms, streaming ${report.config.fake.rate} updates/s. Load average at start of each run: ${report.runs.map((r) => (r.loadavgStart || []).join(' ')).join(' | ')}.`,
    '',
    'CPU % is of one core. "→ next frame" is from the input event to the end of the first frame after it. Spread is (max − min) / mean of the first number across runs.',
    ''
  ].join('\n')
}

function attributionSection(report) {
  if (!report.attribution) return ''
  const out = ['', '## Where the time goes (CPU profiles, self time)', '']
  for (const [name, a] of Object.entries(report.attribution)) {
    for (const side of ['main', 'renderer']) {
      const busy = a[`${side}BusyMs`]
      out.push(`**${name} — ${side}**${busy !== undefined ? ` (${busy} ms on the CPU in the scenario)` : ''}`, '', '| self ms | % of busy | function |', '|---:|---:|---|')
      for (const f of a[side].slice(0, 10)) out.push(`| ${f.ms} | ${f.pct} | \`${f.fn}\` |`)
      out.push('')
    }
  }
  return out.join('\n')
}

function writeReport(report, file) {
  const md = [describe(report), table(report), attributionSection(report), ''].join('\n')
  fs.writeFileSync(file, md)
  return md
}

/** Two reports (say prod and dev) side by side, run means. */
function compare(a, b, file) {
  const mean = (report, name, p) => {
    const vals = report.runs.map((r) => get(derived(r.scenarios[name], name), p)).filter((v) => typeof v === 'number')
    return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : undefined
  }
  const lines = [`# ${a.mode} (${a.rev}) vs ${b.mode} (${b.rev})`, '', `| scenario | metric | ${a.mode} | ${b.mode} | unit |`, '|---|---|---:|---:|---|']
  for (const [section, name, label, paths, unit] of HEADLINES) {
    const list = Array.isArray(paths) ? paths : [paths]
    const va = list.map((p) => fmt(mean(a, name, p))).join(' / ')
    const vb = list.map((p) => fmt(mean(b, name, p))).join(' / ')
    if (/^[–/ ]+$/.test(va) && /^[–/ ]+$/.test(vb)) continue
    lines.push(`| ${section} | ${label} | ${va} | ${vb} | ${unit} |`)
  }
  const md = lines.join('\n') + '\n'
  if (file) fs.writeFileSync(file, md)
  return md
}

module.exports = { writeReport, compare, table, HEADLINES }

if (require.main === module) {
  const argv = process.argv.slice(2)
  if (argv[0] === '--compare') {
    const [, fa, fb, out] = argv
    process.stdout.write(compare(JSON.parse(fs.readFileSync(fa, 'utf8')), JSON.parse(fs.readFileSync(fb, 'utf8')), out))
  } else {
    const [f, out] = argv
    if (!f) {
      console.error('usage: node report.cjs <bench.json> [out.md] | --compare <a.json> <b.json> [out.md]')
      process.exit(2)
    }
    const report = JSON.parse(fs.readFileSync(f, 'utf8'))
    process.stdout.write(writeReport(report, out || f.replace(/\.json$/, '.md')))
  }
}

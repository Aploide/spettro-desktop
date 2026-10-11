#!/usr/bin/env node
// A stand-in for `spettro --acp`, for the performance benchmark: the same
// newline-delimited JSON-RPC over stdio, the same shapes, no model and no
// tokens. It answers the handshake and session calls the app makes, answers
// session/set_config_option the way the real CLI does (bridge.go
// SetSessionConfigOption: the reply carries the session's options, and every
// OTHER open session hears a config_option_update), and on session/prompt it
// streams a heavy, realistic turn as fast as asked.
//
//   fake-spettro.cjs --version            → "spettro perf-fake"
//   fake-spettro.cjs --acp --cwd <dir>    → the agent
//
// The app is pointed at it with preferences.json `explicitCLIPath` naming a
// small shell wrapper (bench.cjs writes one) that execs node on this file.
//
// Environment (all optional):
//   FAKE_SPETTRO_DELAY_MS   reply delay for set_config_option (default 20)
//   FAKE_SPETTRO_RATE       session updates per second while streaming
//                           (default 500; 0 = as fast as the pipe takes them)
//   FAKE_SPETTRO_TOKENS     agent_message_chunk updates per turn (default 3000)
//   FAKE_SPETTRO_THOUGHTS   agent_thought_chunk updates per turn (default 40)
//   FAKE_SPETTRO_TOOLS      tool_call + tool_call_update pairs (default 60)
//   FAKE_SPETTRO_DIFF_LINES lines per edit diff (default 200)
//   FAKE_SPETTRO_BASH_LINES lines of output per command (default 300)
//   FAKE_SPETTRO_LOG        append a JSON line per request / turn event here
//   FAKE_SPETTRO_CONTROL    a JSON file re-read on every request whose keys
//                           ({"delayMs":…, "rate":…, "tokens":…}) override
//                           the above — the benchmark changes the reply delay
//                           mid-run with it
//   FAKE_SPETTRO_PERMISSION, FAKE_SPETTRO_THINKING, FAKE_SPETTRO_ULTRA
//                           the starting shared settings (restricted, high,
//                           false): Ultra lights only outside Ask first
//
// A prompt may carry overrides in its text: "perf:tokens=500 perf:tools=4".
//
// For end-to-end runs (a phone paired to the app, say) a prompt may also ask
// for the CLI's interactive moments, scripted:
//   e2e:permission   an Edit asks first (session/request_permission: Allow
//                    once / Always allow / Deny); the turn waits for the
//                    answer, then the edit completes or is shown denied
//   e2e:question     the agent asks a two-question form (_spettro/question/ask)
//                    and the turn waits, then says what was answered
// And a prompt sent while a turn runs steers it the way bridge.go
// steerRunningTurn does: "→ steering queued" at once (the steer's own prompt
// ends there), "✔ steering delivered" a few updates later in the turn.

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const C = require('./content.cjs')

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'cli-fixture.json'), 'utf8'))

if (process.argv.includes('--version') || process.argv[2] === 'version') {
  process.stdout.write('spettro perf-fake\n')
  process.exit(0)
}
if (!process.argv.includes('--acp')) {
  process.stderr.write('fake-spettro: only --acp and --version are implemented\n')
  process.exit(2)
}

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d)
const BASE = {
  delayMs: env('FAKE_SPETTRO_DELAY_MS', 20),
  rate: env('FAKE_SPETTRO_RATE', 500),
  tokens: env('FAKE_SPETTRO_TOKENS', 3000),
  thoughts: env('FAKE_SPETTRO_THOUGHTS', 40),
  tools: env('FAKE_SPETTRO_TOOLS', 60),
  diffLines: env('FAKE_SPETTRO_DIFF_LINES', 200),
  bashLines: env('FAKE_SPETTRO_BASH_LINES', 300)
}
const LOG = process.env.FAKE_SPETTRO_LOG || ''
const CONTROL = process.env.FAKE_SPETTRO_CONTROL || ''

let controlCache = { mtime: 0, value: {} }
function settings() {
  if (!CONTROL) return BASE
  try {
    const st = fs.statSync(CONTROL)
    if (st.mtimeMs !== controlCache.mtime) {
      controlCache = { mtime: st.mtimeMs, value: JSON.parse(fs.readFileSync(CONTROL, 'utf8')) }
    }
  } catch {
    controlCache = { mtime: 0, value: {} }
  }
  return { ...BASE, ...controlCache.value }
}

function log(entry) {
  if (!LOG) return
  try {
    fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), pid: process.pid, ...entry }) + '\n')
  } catch {
    // The benchmark reads what it can.
  }
}

// ------------------------------------------------------------------ the pipe

let bytesOut = 0
function write(obj) {
  const line = JSON.stringify(obj) + '\n'
  bytesOut += line.length
  process.stdout.write(line)
}
const respond = (id, result) => write({ jsonrpc: '2.0', id, result })
const respondError = (id, code, message, data) =>
  write({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } })
const update = (sessionId, upd) => write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: upd } })

/** Requests to the client (permission, question), answered by id. */
let outSeq = 0
const outgoing = new Map() // id → (message) => void
function request(method, params, onReply) {
  const id = `fake-${++outSeq}`
  outgoing.set(id, onReply)
  log({ dir: 'out', method, id })
  write({ jsonrpc: '2.0', id, method, params })
}

// ------------------------------------------------------------- shared state

/** The settings every session shares (the real CLI keeps them in
 *  ~/.spettro/config.json). */
const shared = {
  model: 'anthropic:claude-sonnet-4-5',
  permission: process.env.FAKE_SPETTRO_PERMISSION || 'restricted',
  thinking: process.env.FAKE_SPETTRO_THINKING || 'high',
  ultra: process.env.FAKE_SPETTRO_ULTRA === 'true',
  workflowSize: 'medium'
}

const MODELS = [
  ['anthropic', 'Anthropic', 'claude-opus-4-1', 'Claude Opus 4.1', 200000],
  ['anthropic', 'Anthropic', 'claude-sonnet-4-5', 'Claude Sonnet 4.5', 1000000],
  ['anthropic', 'Anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', 200000],
  ['openai', 'OpenAI', 'gpt-5', 'GPT-5', 400000],
  ['openai', 'OpenAI', 'gpt-5-mini', 'GPT-5 mini', 400000],
  ['openai', 'OpenAI', 'o4-mini', 'o4-mini', 200000],
  ['openai', 'OpenAI', 'gpt-4.1', 'GPT-4.1', 1000000]
]

function modelOption() {
  const groups = []
  for (const [provider, providerName, name, displayName] of MODELS) {
    let g = groups.find((x) => x.group === providerName)
    if (!g) groups.push((g = { group: providerName, name: providerName, options: [] }))
    g.options.push({ name: displayName, value: `${provider}:${name}` })
  }
  return {
    category: 'model',
    currentValue: shared.model,
    description: 'Active model for this session',
    id: 'model',
    name: 'Model',
    options: groups,
    type: 'select'
  }
}

/** The six options in the CLI's order, live values filled into the captured
 *  shapes (config_options.go buildConfigOptions). */
function configOptions(session) {
  const o = FIXTURE.options
  const ultraDesc =
    'Ultracode: substantive tasks run as dynamic workflows' +
    (shared.ultra && shared.permission === 'ask-first'
      ? ' (suspended under Ask first — workflows need Restricted or YOLO)'
      : '')
  return [
    { ...o.mode, currentValue: session.mode },
    modelOption(),
    { ...o.permission, currentValue: shared.permission },
    { ...o.thinking, currentValue: shared.thinking },
    { ...o.ultra, currentValue: shared.ultra, description: ultraDesc },
    { ...o.workflow_size, currentValue: shared.workflowSize }
  ]
}

const sessions = new Map() // id → { id, cwd, mode, turn }
let sessionSeq = 0

function openSession(id, cwd) {
  let s = sessions.get(id)
  if (!s) {
    s = { id, cwd, mode: 'coding', turn: null }
    sessions.set(id, s)
  }
  // The CLI announces its commands just after a session attaches.
  setTimeout(() => update(id, { sessionUpdate: 'available_commands_update', availableCommands: FIXTURE.availableCommands }), 5)
  return s
}

function applyConfig(session, configId, value) {
  switch (configId) {
    case 'mode':
      session.mode = String(value)
      return true
    case 'model':
      shared.model = String(value)
      return true
    case 'permission':
      shared.permission = String(value)
      return true
    case 'thinking':
      shared.thinking = String(value)
      return true
    case 'ultra':
      shared.ultra = value === true || value === 'true'
      return true
    case 'workflow_size':
      shared.workflowSize = String(value)
      return true
    default:
      return false
  }
}

// ---------------------------------------------------------- the heavy turn

/** The whole turn as a list of session updates, in order. */
function buildTurn(seed, opts) {
  const out = []
  const sid = (u) => out.push(u)
  const text = C.markdown(seed, opts.tokens)
  let tokens = C.tokenize(text)
  // Exactly `opts.tokens` chunks: pad with words, or trim.
  if (tokens.length > opts.tokens) tokens = tokens.slice(0, opts.tokens)
  while (tokens.length < opts.tokens) tokens.push(' more')
  const thoughts = C.thought(seed + 1, opts.thoughts)

  sid({ sessionUpdate: 'usage_update', used: 41000, size: 200000, _meta: { 'spettro.app/tokensUsed': 41000 } })
  for (const t of thoughts) sid({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: t } })

  const planEntries = [
    'Read the session store and the IPC contract',
    'Trace a config change from the slider to the CLI',
    'Measure what each update costs in main and the renderer',
    'Edit the hot paths',
    'Run the tests'
  ]
  const plan = (done) =>
    sid({
      sessionUpdate: 'plan',
      entries: planEntries.map((content, i) => ({
        content,
        priority: 'medium',
        status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending'
      }))
    })
  plan(0)

  // The message is cut into segments, one before each group of tools and the
  // last after them, the way a turn alternates talk and work.
  const groups = Math.max(1, Math.ceil(opts.tools / 6))
  const per = Math.ceil(tokens.length / (groups + 1))
  let tokenAt = 0
  const talk = () => {
    const end = Math.min(tokens.length, tokenAt + per)
    for (; tokenAt < end; tokenAt++) sid({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: tokens[tokenAt] } })
  }

  let call = 0
  for (let g = 0; g < groups; g++) {
    talk()
    for (let k = 0; k < 6 && call < opts.tools; k++, call++) {
      const id = `call-perf-${seed}-${call}`
      const file = C.FILES[(call * 7) % C.FILES.length]
      const abs = `/tmp/perf/project/${file}`
      const which = call % 4
      if (which === 0) {
        sid({ sessionUpdate: 'tool_call', toolCallId: id, title: `Read ${file}`, kind: 'read', status: 'in_progress', locations: [{ path: abs }], rawInput: { path: file } })
        const output = C.readOutput(seed * 100 + call, file)
        sid({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: output } }], rawOutput: { output } })
      } else if (which === 1) {
        sid({ sessionUpdate: 'tool_call', toolCallId: id, title: `Edit ${file}`, kind: 'edit', status: 'in_progress', locations: [{ path: abs }], rawInput: { path: file, old_string: 'persist()', new_string: 'schedulePersist()' } })
        const { oldText, newText } = C.editTexts(seed * 100 + call, opts.diffLines)
        sid({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'diff', path: abs, oldText, newText }], rawOutput: { output: `Edited ${file}` }, locations: [{ path: abs }] })
      } else if (which === 2) {
        const command = C.COMMANDS[call % C.COMMANDS.length]
        sid({ sessionUpdate: 'tool_call', toolCallId: id, title: `Run ${command}`, kind: 'execute', status: 'in_progress', locations: [], rawInput: { command } })
        const output = C.bashOutput(seed * 100 + call, command, opts.bashLines)
        sid({ sessionUpdate: 'tool_call_update', toolCallId: id, status: call % 12 === 2 ? 'failed' : 'completed', content: [{ type: 'content', content: { type: 'text', text: output } }], rawOutput: { output } })
      } else {
        sid({ sessionUpdate: 'tool_call', toolCallId: id, title: `Find **/*.ts in src`, kind: 'search', status: 'in_progress', locations: [{ path: '/tmp/perf/project/src' }], rawInput: { path: 'src', pattern: '**/*.ts' } })
        const output = C.searchOutput(seed * 100 + call)
        sid({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: output } }], rawOutput: { output } })
      }
    }
    if (g % 2 === 1) plan(Math.min(planEntries.length - 1, Math.floor(((g + 1) / groups) * planEntries.length)))
    if (g % 3 === 2) sid({ sessionUpdate: 'usage_update', used: 41000 + g * 9000, size: 200000, _meta: { 'spettro.app/tokensUsed': 41000 + g * 9000 } })
  }
  talk()
  for (; tokenAt < tokens.length; tokenAt++) sid({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: tokens[tokenAt] } })
  plan(planEntries.length)
  // The scripted asks come a little way into the turn, after some talk.
  const at = Math.min(out.length, 1 + opts.thoughts + 12)
  const asks = []
  if (opts.permission) asks.push({ ask: 'permission', seed })
  if (opts.question) asks.push({ ask: 'question', seed })
  out.splice(at, 0, ...asks)
  return out
}

/** The edit that asks first: its pending card and the request for it. */
function permissionAsk(session, seed, done) {
  const id = `call-e2e-${seed}-perm`
  const file = 'src/main/model/sessionStore.ts'
  const abs = `${session.cwd || '/tmp/perf/project'}/${file}`
  const oldText = 'export function persist(chats) {\n  writeFileSync(path, JSON.stringify(chats))\n}\n'
  const newText = 'export function persist(chats) {\n  schedulePersist(chats)\n}\n'
  update(session.id, { sessionUpdate: 'tool_call', toolCallId: id, title: `Edit ${file}`, kind: 'edit', status: 'pending', locations: [{ path: abs }], rawInput: { path: file, old_string: 'writeFileSync', new_string: 'schedulePersist' } })
  request(
    'session/request_permission',
    {
      sessionId: session.id,
      toolCall: { toolCallId: id, status: 'pending', content: [{ type: 'diff', path: abs, oldText, newText }] },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Always allow edits', kind: 'allow_always' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
      ]
    },
    (msg) => {
      const chosen = msg.result?.outcome?.optionId ?? msg.result?.outcome?.outcome ?? 'error'
      log({ event: 'permission-answer', session: session.id, chosen })
      if (chosen === 'allow-once' || chosen === 'allow-always') {
        update(session.id, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'diff', path: abs, oldText, newText }], rawOutput: { output: `Edited ${file}` }, locations: [{ path: abs }] })
        update(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n\nEdited \`${file}\` (you chose ${chosen}).\n\n` } })
      } else {
        update(session.id, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'The user denied this edit.' } }], rawOutput: { output: 'denied', denied: true } })
        update(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n\nLeft \`${file}\` alone (${chosen}).\n\n` } })
      }
      done()
    }
  )
}

/** The two-question form (question_form.go formPayload, v2). */
function questionAsk(session, seed, done) {
  const questions = [
    {
      id: 'q-0',
      header: 'Storage',
      question: 'Where should the chats be saved?',
      options: [
        { id: 'opt-0', label: 'One file', description: 'sessions.json, as today', isRecommended: true },
        { id: 'opt-1', label: 'A file per chat', description: 'Smaller writes, more files' }
      ],
      multiSelect: false,
      allowCustomInput: true
    },
    {
      id: 'q-1',
      header: 'Tests',
      question: 'Which tests should I run afterwards?',
      options: [
        { id: 'opt-0', label: 'Unit' },
        { id: 'opt-1', label: 'Typecheck' },
        { id: 'opt-2', label: 'End to end' }
      ],
      multiSelect: true,
      allowCustomInput: false
    }
  ]
  const first = questions[0]
  request(
    '_spettro/question/ask',
    {
      sessionId: session.id,
      version: 2,
      header: first.header,
      question: first.question,
      options: first.options,
      multiSelect: first.multiSelect,
      allowCustomInput: first.allowCustomInput,
      context: 'Before I change how chats are stored',
      questions
    },
    (msg) => {
      const answers = msg.result?.answers
      log({ event: 'question-answer', session: session.id, answers: answers ?? msg.result ?? msg.error })
      const said = Array.isArray(answers)
        ? answers
            .map((a) => `${a.header || a.questionId}: ${a.kind === 'text' ? a.text : (a.optionIds || [a.optionId]).join(', ')}`)
            .join('; ')
        : 'no answer'
      update(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n\nYou answered — ${said}.\n\n` } })
      done()
    }
  )
}

function promptOverrides(blocks) {
  const text = (Array.isArray(blocks) ? blocks : [])
    .map((b) => (b && b.type === 'text' ? b.text : ''))
    .join(' ')
  const out = {}
  for (const m of text.matchAll(/perf:(\w+)=(\d+)/g)) out[m[1]] = Number(m[2])
  if (/\be2e:permission\b/.test(text)) out.permission = true
  if (/\be2e:question\b/.test(text)) out.question = true
  return out
}

let turnSeq = 0
function runTurn(session, rpcId, blocks) {
  const opts = { ...settings(), ...promptOverrides(blocks) }
  const seed = 1000 + turnSeq++
  const updates = buildTurn(seed, opts)
  const turn = { cancelled: false, timer: null, waiting: false, steers: [] }
  session.turn = turn
  const startBytes = bytesOut
  const t0 = Date.now()
  log({ event: 'turn-start', session: session.id, updates: updates.length, rate: opts.rate })
  let i = 0
  const finish = (stopReason) => {
    session.turn = null
    log({ event: 'turn-end', session: session.id, stopReason, updates: i, bytes: bytesOut - startBytes, ms: Date.now() - t0 })
    respond(rpcId, {
      stopReason,
      usage: { inputTokens: 52000, outputTokens: opts.tokens, totalTokens: 52000 + opts.tokens, cachedReadTokens: 30000 },
      _meta: { 'spettro.app/tokensUsed': 52000 + opts.tokens }
    })
  }
  // Paced against `t0`; an ask that waited moves it on, so the stream
  // doesn't burst to catch up afterwards.
  let t0Pace = t0
  const ask = (entry) => {
    turn.waiting = true
    const resume = () => {
      turn.waiting = false
      if (opts.rate > 0) t0Pace = Date.now() - (i / opts.rate) * 1000
      if (session.turn === turn) pump()
    }
    if (entry.ask === 'permission') permissionAsk(session, entry.seed, resume)
    else questionAsk(session, entry.seed, resume)
  }
  const emit = (upd) => {
    if (upd.ask) {
      ask(upd)
      return false
    }
    update(session.id, upd)
    // A steer is read at the agent's next step: a few updates on.
    for (const st of turn.steers) {
      if (!st.delivered && --st.left <= 0) {
        st.delivered = true
        update(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '✔ steering delivered' } })
      }
    }
    return true
  }
  turn.finish = finish
  const pump = () => {
    if (turn.cancelled) return finish('cancelled')
    if (turn.waiting) return
    if (opts.rate <= 0) {
      // As fast as possible, in slices, so a cancel can still get in.
      const end = Math.min(updates.length, i + 200)
      for (; i < end; ) if (!emit(updates[i++])) return
    } else {
      // Paced against the clock, so timer jitter doesn't slow the stream.
      const due = Math.min(updates.length, Math.floor(((Date.now() - t0Pace) / 1000) * opts.rate) + 1)
      for (; i < due; ) if (!emit(updates[i++])) return
    }
    if (i >= updates.length) {
      for (const st of turn.steers) {
        if (!st.delivered) update(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '✔ steering delivered' } })
      }
      return finish('end_turn')
    }
    turn.timer = opts.rate <= 0 ? setImmediate(pump) : setTimeout(pump, 4)
  }
  pump()
}

// -------------------------------------------------------------- requests

const later = (ms, fn) => (ms > 0 ? setTimeout(fn, ms) : setImmediate(fn))

function handleRequest(msg) {
  const { id, method } = msg
  const params = msg.params || {}
  const s = settings()
  log({ dir: 'in', method, id, configId: params.configId, value: params.value, sessionId: params.sessionId })
  switch (method) {
    case 'initialize':
      return respond(id, FIXTURE.initialize)
    case 'session/new': {
      const sidv = `session-perf-${process.pid}-${++sessionSeq}`
      const session = openSession(sidv, params.cwd)
      return respond(id, { sessionId: sidv, configOptions: configOptions(session) })
    }
    case 'session/resume':
    case 'session/load': {
      const session = openSession(params.sessionId, params.cwd)
      return respond(id, { configOptions: configOptions(session) })
    }
    case 'session/list':
      return respond(id, { sessions: [] })
    case 'session/close':
      sessions.delete(params.sessionId)
      return respond(id, {})
    case 'session/set_config_option': {
      const session = sessions.get(params.sessionId)
      if (!session) return later(s.delayMs, () => respondError(id, -32603, 'Internal error', { error: `session not found: ${params.sessionId}` }))
      return later(s.delayMs, () => {
        if (!applyConfig(session, params.configId, params.value)) {
          return respondError(id, -32602, 'Invalid params', { error: `unknown config option: ${params.configId}` })
        }
        // bridge.go: the other sessions hear it first, then the caller gets
        // its reply. (The mode is per session and not broadcast.)
        if (params.configId !== 'mode') {
          for (const other of sessions.values()) {
            if (other.id === session.id) continue
            update(other.id, { sessionUpdate: 'config_option_update', configOptions: configOptions(other) })
          }
        }
        respond(id, { configOptions: configOptions(session) })
      })
    }
    case 'session/prompt': {
      const session = sessions.get(params.sessionId)
      if (!session) return respondError(id, -32603, 'Internal error', { error: 'session not found' })
      if (session.turn) {
        // bridge.go steerRunningTurn: queued for the running agent, and
        // this prompt's own turn is over.
        session.turn.steers.push({ left: 8, delivered: false })
        log({ event: 'steer', session: session.id })
        update(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '→ steering queued: the running agent will see this message at its next step' } })
        return respond(id, { stopReason: 'end_turn' })
      }
      return runTurn(session, id, params.prompt)
    }
    case '_spettro/providers/list':
      return respond(id, {
        ...FIXTURE.providers,
        providers: FIXTURE.providers.providers.map((p) =>
          p.id === 'anthropic' || p.id === 'openai' ? { ...p, connected: true } : p
        )
      })
    case '_spettro/models/list': {
      const [provider, name] = shared.model.split(':')
      return respond(id, {
        models: MODELS.map(([p, pn, n, dn, ctx]) => ({
          provider: p,
          providerName: pn,
          name: n,
          displayName: dn,
          vision: true,
          reasoning: !n.startsWith('gpt-4'),
          toolCall: true,
          context: ctx,
          local: false,
          favorite: n === 'claude-sonnet-4-5',
          active: `${p}:${n}` === shared.model
        })),
        activeProvider: provider,
        activeModel: name
      })
    }
    case '_spettro/account/status':
      return respond(id, FIXTURE.account)
    case '_spettro/workflow/list':
      return respond(id, { workflows: [], searchPaths: [], cwd: params.cwd || '' })
    case '_spettro/workflow/runs':
      return respond(id, { runs: [] })
    case '_spettro/models/favorite':
      return respond(id, {})
    default:
      return respondError(id, -32601, `method not found: ${method}`)
  }
}

function handleNotification(msg) {
  const params = msg.params || {}
  log({ dir: 'in', method: msg.method, sessionId: params.sessionId })
  if (msg.method === 'session/cancel') {
    const s = sessions.get(params.sessionId)
    if (s && s.turn) {
      s.turn.cancelled = true
      // A turn waiting on an ask has no pump scheduled to notice.
      if (s.turn.waiting) s.turn.finish('cancelled')
    }
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      process.stderr.write('fake-spettro: unparseable line\n')
      continue
    }
    if (msg.method !== undefined && msg.id !== undefined) handleRequest(msg)
    else if (msg.method !== undefined) handleNotification(msg)
    else if (msg.id !== undefined && outgoing.has(msg.id)) {
      const onReply = outgoing.get(msg.id)
      outgoing.delete(msg.id)
      onReply(msg)
    }
    // Responses to requests we never made are ignored.
  }
})
process.stdin.on('end', () => process.exit(0))
process.stdout.on('error', () => process.exit(0))
log({ event: 'start', argv: process.argv.slice(2) })

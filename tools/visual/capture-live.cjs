// Records a real ACP session so the harness can be checked against wire data
// the CLI actually produced, not data we assumed it produces.
//
// The fixtures in fixtures.ts are hand-written from the Go source, which makes
// them precise but circular: if we misread the CLI, the fixtures encode the
// same misreading and the harness happily renders the wrong thing. This drives
// `spettro --acp` for one real turn and writes every session/update to JSONL,
// so `node tools/visual/fixtures-from-live.cjs` can turn a genuine workflow
// run into a scene.
//
//   node tools/visual/capture-live.cjs <cwd> <out.jsonl> "<prompt>"
//
// It spends real tokens against the user's own ~/.spettro, and switches
// permission to YOLO and ultracode on for the run; both are put back as they
// were when it ends, however it ends.

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const [CWD, OUT, PROMPT] = [
  path.resolve(process.argv[2] || '.'),
  path.resolve(process.argv[3] || 'live.jsonl'),
  process.argv[4] || 'ultracode: list the top-level directories, one agent each, then summarise.'
]
const EXE = process.env.SPETTRO_BIN || path.join(process.env.HOME, '.local/bin/spettro')

const child = spawn(EXE, ['--acp', '--cwd', CWD], { stdio: ['pipe', 'pipe', 'pipe'] })
const sink = fs.createWriteStream(OUT)
let nextId = 1
const pending = new Map()

function send(method, params) {
  const id = nextId++
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

function reply(id, result) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

let buf = ''
child.stdout.on('data', (chunk) => {
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
      continue
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (p) (msg.error ? p.reject : p.resolve)(msg.error || msg.result)
      continue
    }
    if (msg.method === 'session/update') {
      sink.write(JSON.stringify(msg.params) + '\n')
      const u = msg.params?.update ?? msg.params
      const kind = u?.sessionUpdate || Object.keys(u || {})[0]
      if (String(kind).startsWith('tool_call')) {
        process.stderr.write(`  ${kind}  ${String(u.title || u.toolCallId).slice(0, 90)}\n`)
      }
      continue
    }
    // The agent asks us things mid-turn. Approve permissions and decline
    // questions: a capture run has nobody to ask, and a hung prompt records
    // nothing.
    if (msg.method === 'session/request_permission') {
      const opts = msg.params?.options || []
      const allow = opts.find((o) => /allow/i.test(o.optionId || o.name || '')) || opts[0]
      reply(msg.id, { outcome: { outcome: 'selected', optionId: allow?.optionId } })
      continue
    }
    if (msg.method && msg.id !== undefined) reply(msg.id, { outcome: { kind: 'declined' } })
  }
})
child.stderr.on('data', (d) => process.stderr.write(`[cli] ${d}`))

// permission and ultra live in ~/.spettro and are shared by every session
// (config_options.go), so what the capture switches on below would outlast
// it. These are the user's values from session/new, put back on every exit.
let restoreConfig = async () => {}

/** Restores the user's settings, then exits — whatever ended the run. */
function finish(code) {
  const restored = Promise.race([
    restoreConfig().catch((e) => console.error('could not restore settings:', e?.message || e)),
    new Promise((r) => setTimeout(r, 5000))
  ])
  restored.then(() => sink.end(() => process.exit(code)))
}

;(async () => {
  await send('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'spettro-visual-harness', title: null, version: '0' }
  })
  const { sessionId, configOptions } = await send('session/new', { cwd: CWD, mcpServers: [] })
  console.error(`session ${sessionId}`)
  const original = (id) => (configOptions || []).find((o) => o.id === id)?.currentValue
  const permission = original('permission')
  const ultra = original('ultra')
  restoreConfig = async () => {
    // Ultra first: under ask-first it is only suspended, never refused.
    if (typeof ultra === 'boolean') {
      await send('session/set_config_option', { sessionId, configId: 'ultra', type: 'boolean', value: ultra })
    }
    if (typeof permission === 'string') {
      await send('session/set_config_option', { sessionId, configId: 'permission', value: permission })
    }
    console.error(`settings restored: permission=${permission} ultra=${ultra}`)
  }
  // Workflows need restricted or yolo, and the capture has no user to
  // approve. The wire field is `configId` (acp-go-sdk SetSessionConfigOption-
  // Request); a boolean option also names its type.
  await send('session/set_config_option', { sessionId, configId: 'permission', value: 'yolo' }).catch((e) =>
    console.error('permission change refused:', e?.data?.error || e?.message || e)
  )
  await send('session/set_config_option', { sessionId, configId: 'ultra', type: 'boolean', value: true }).catch((e) =>
    console.error('ultra toggle refused:', e?.data?.error || e?.message || e)
  )
  console.error(`prompting: ${PROMPT}`)
  const res = await send('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: PROMPT }]
  })
  console.error(`stopReason=${res?.stopReason}`)
  finish(0)
})().catch((err) => {
  console.error('capture failed:', err)
  finish(1)
})

process.on('SIGINT', () => finish(130))

setTimeout(() => {
  console.error('live capture timed out — writing what we have')
  finish(2)
}, 15 * 60 * 1000)

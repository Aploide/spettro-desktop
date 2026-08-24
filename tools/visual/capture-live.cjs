// Records a real ACP session so the harness can be checked against wire data
// the CLI actually produced, not data we assumed it produces.
//
// The fixtures in fixtures.ts are hand-written from the Go source, which makes
// them precise but circular: if we misread the CLI, the fixtures encode the
// same misreading and the harness happily renders the wrong thing. This drives
// `spettro --acp` for one real turn and writes every session/update to JSONL,
// so `node tools/visual/fixtures-from-live.cjs` can turn a genuine workflow or
// swarm run into a scene.
//
//   node tools/visual/capture-live.cjs <cwd> <out.jsonl> "<prompt>"

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

;(async () => {
  await send('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'spettro-visual-harness', title: null, version: '0' }
  })
  const { sessionId } = await send('session/new', { cwd: CWD, mcpServers: [] })
  console.error(`session ${sessionId}`)
  // Ultra needs restricted or yolo, and the capture has no user to approve.
  await send('session/set_config_option', { sessionId, configOptionId: 'permission', value: 'yolo' }).catch(() => {})
  await send('session/set_config_option', { sessionId, configOptionId: 'ultra', value: true }).catch((e) =>
    console.error('ultra toggle refused:', e.message || e)
  )
  console.error(`prompting: ${PROMPT}`)
  const res = await send('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: PROMPT }]
  })
  console.error(`stopReason=${res?.stopReason}`)
  sink.end(() => process.exit(0))
})().catch((err) => {
  console.error('capture failed:', err)
  sink.end(() => process.exit(1))
})

setTimeout(() => {
  console.error('live capture timed out — writing what we have')
  sink.end(() => process.exit(2))
}, 15 * 60 * 1000)

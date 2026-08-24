// Drives the real CLI's `_spettro/workflow/*` methods over a live ACP pipe.
//
// The Go tests cover the handlers and the TypeScript typechecks the client,
// and neither of those catches the thing that actually breaks: the two halves
// disagreeing about the wire, or an installed CLI that predates the surface
// entirely. This talks to a real binary and prints what comes back.
//
//   node tools/probe-workflow-ext.cjs <project-dir> <path-to-spettro>
//
// It writes and then deletes a workflow named "probe-flow" in the project you
// point it at, so point it at a scratch directory.
const { spawn } = require('node:child_process')
const path = require('node:path')

const CWD = process.argv[2]
const EXE = process.argv[3]
const child = spawn(EXE, ['--acp', '--cwd', CWD], { stdio: ['pipe', 'pipe', 'pipe'] })
let nextId = 1
const pending = new Map()
function send(method, params) {
  const id = nextId++
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise((res, rej) => pending.set(id, { res, rej }))
}
let buf = ''
child.stdout.on('data', (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.id !== undefined && m.method === undefined) {
      const p = pending.get(m.id); pending.delete(m.id)
      if (p) (m.error ? p.rej : p.res)(m.error || m.result)
    }
  }
})
child.stderr.on('data', (d) => process.stderr.write(`[cli] ${d}`))

const SCRIPT = `export const meta = {
  name: 'probe-flow',
  description: 'Written by the desktop app over ACP',
  phases: [{ title: 'One', detail: 'first' }, { title: 'Two' }],
}
phase('One')
return 'probe'
`

;(async () => {
  const init = await send('initialize', {
    protocolVersion: 1, clientCapabilities: {},
    clientInfo: { name: 'ext-probe', title: null, version: '0' }
  })
  const ext = init._meta?.['spettro.app/extensions']
  console.log('extensions version:', ext?.version)
  console.log('workflow methods advertised:',
    (ext?.methods || []).filter((m) => m.includes('workflow')))

  const { sessionId } = await send('session/new', { cwd: CWD, mcpServers: [] })

  console.log('\n-- validate (good) --')
  console.log(JSON.stringify(await send('_spettro/workflow/validate', { sessionId, script: SCRIPT })))

  console.log('\n-- validate (broken) --')
  console.log(JSON.stringify(await send('_spettro/workflow/validate', { sessionId, script: 'export const meta = {' })))

  console.log('\n-- write --')
  console.log(JSON.stringify(await send('_spettro/workflow/write', { sessionId, name: 'probe-flow', scope: 'project', script: SCRIPT })))

  console.log('\n-- list --')
  const list = await send('_spettro/workflow/list', { sessionId })
  console.log(JSON.stringify(list, null, 2).slice(0, 700))

  console.log('\n-- read --')
  const read = await send('_spettro/workflow/read', { sessionId, name: 'probe-flow' })
  console.log('script round-tripped:', read.script === SCRIPT)

  console.log('\n-- write broken (must be refused) --')
  try {
    await send('_spettro/workflow/write', { sessionId, name: 'bad', scope: 'project', script: 'not js(' })
    console.log('!! NOT REFUSED')
  } catch (e) { console.log('refused:', (e.message || '').slice(0, 90)) }

  console.log('\n-- delete --')
  console.log(JSON.stringify(await send('_spettro/workflow/delete', { sessionId, name: 'probe-flow', scope: 'project' })))

  process.exit(0)
})().catch((e) => { console.error('FAILED', e); process.exit(1) })

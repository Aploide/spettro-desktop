// Drives a real `spettro --acp` through every ACP path the desktop app relies
// on, without spending a token, and says PASS or FAIL for each.
//
// The unit tests check the app against tests/wire.ts, and wire.ts against the
// Go source as we read it. Neither catches the two halves drifting apart, or
// a binary that predates the surface: this does, by asking the binary itself.
//
//   SPETTRO_BIN=../spettro/bin/spettro node tools/e2e/acp-smoke.cjs [project-dir]
//
// The CLI runs under a throwaway HOME, so it starts unconfigured (no provider,
// permission Ask first) and the settings this changes — ultracode, workflow
// size — never reach the user's ~/.spettro. A prompt there fails at the
// provider, before any request leaves the machine, which is exactly what the
// session/list and resume checks need: the CLI saves a session once a turn
// has run, failed or not, and never before. Exits non-zero on any FAIL.

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const EXE = process.env.SPETTRO_BIN
if (!EXE) {
  console.error('usage: SPETTRO_BIN=<path to spettro> node tools/e2e/acp-smoke.cjs [project-dir]')
  process.exit(2)
}
const PROJECT = path.resolve(process.argv[2] || '/tmp/sd-e2e/proj')
fs.mkdirSync(PROJECT, { recursive: true })
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'spettro-smoke-home-'))

/** One `spettro --acp` process and the JSON-RPC pipe to it. */
function startAgent() {
  const child = spawn(EXE, ['--acp', '--cwd', PROJECT], {
    env: { ...process.env, HOME },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const pending = new Map()
  const updates = [] // every session/update params, in arrival order
  const waiters = new Set()
  const stderr = []
  let nextId = 1
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
      } else if (msg.method === 'session/update') {
        updates.push(msg.params)
        for (const w of waiters) w()
      } else if (msg.id !== undefined) {
        // Nothing here should make the agent ask the user anything.
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported' } }) + '\n')
      }
    }
  })
  child.stderr.on('data', (d) => stderr.push(String(d)))
  return {
    child,
    updates,
    stderr,
    send(method, params, ms = 15000) {
      const id = nextId++
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        setTimeout(() => {
          if (pending.delete(id)) reject({ code: 'timeout', message: `${method} timed out after ${ms} ms` })
        }, ms)
      })
    },
    /** The first update after `from` (an index into `updates`) matching
     *  `pred`, or null after `ms`. */
    waitFor(pred, ms, from = 0) {
      return new Promise((resolve) => {
        const check = () => {
          const hit = updates.slice(from).find(pred)
          if (hit) {
            waiters.delete(check)
            clearTimeout(timer)
            resolve(hit)
          }
        }
        const timer = setTimeout(() => {
          waiters.delete(check)
          resolve(null)
        }, ms)
        waiters.add(check)
        check()
      })
    },
    stop() {
      child.kill()
    }
  }
}

const kindOf = (u) => u?.update?.sessionUpdate
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      ${detail}` : ''}`)
}
async function attempt(name, fn) {
  try {
    const out = await fn()
    if (out === true || out === undefined) check(name, true)
    else check(name, false, String(out))
  } catch (err) {
    check(name, false, err && err.message ? `${err.message} ${JSON.stringify(err.data ?? '')}` : JSON.stringify(err))
  }
}
const option = (opts, id) => (opts || []).find((o) => o.id === id)
const textOf = (u) => u?.update?.content?.text ?? ''

const GOOD_SCRIPT = `export const meta = {
  name: 'smoke-flow',
  description: 'Validated by the desktop smoke test',
  phases: [{ title: 'One', detail: 'first' }, { title: 'Two' }],
}
phase('One')
return 'smoke'
`

;(async () => {
  console.log(`spettro: ${EXE}\nproject: ${PROJECT}\nHOME:    ${HOME}\n`)
  let a = startAgent()
  let sid = null
  let options = []

  await attempt('initialize: extensions v4, list/resume/close, image prompts', async () => {
    const r = await a.send('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'spettro-desktop-smoke', title: null, version: '0' },
      _meta: { 'spettro.app/extensions': { version: 4, methods: ['_spettro/question/ask'] } }
    })
    const ext = r?._meta?.['spettro.app/extensions']
    const caps = r?.agentCapabilities ?? {}
    const sc = caps.sessionCapabilities ?? {}
    if (ext?.version !== 4) return `extension version ${ext?.version}`
    if (!sc.list || !sc.resume || !sc.close) return `sessionCapabilities ${JSON.stringify(sc)}`
    if (caps.promptCapabilities?.image !== true) return `promptCapabilities ${JSON.stringify(caps.promptCapabilities)}`
    return true
  })

  await attempt('session/new: config ids in order, no modes field', async () => {
    const r = await a.send('session/new', { cwd: PROJECT, mcpServers: [] })
    sid = r.sessionId
    options = r.configOptions
    const ids = (r.configOptions || []).map((o) => o.id).join(',')
    if (ids !== 'mode,model,permission,thinking,ultra,workflow_size') return `ids ${ids}`
    if ('modes' in r) return 'has a modes field'
    return true
  })

  await attempt('available_commands_update within 1 s: ultra, never ultracode', async () => {
    const u = await a.waitFor((x) => kindOf(x) === 'available_commands_update', 1000)
    if (!u) return 'none within 1 s'
    const names = u.update.availableCommands.map((c) => c.name)
    if (!names.includes('ultra')) return `no ultra in ${names.join(' ')}`
    if (names.includes('ultracode')) return 'ultracode is advertised'
    return true
  })

  await attempt('ultra under Ask first: saved, described as suspended', async () => {
    await a.send('session/set_config_option', { sessionId: sid, configId: 'permission', value: 'ask-first' })
    const r = await a.send('session/set_config_option', { sessionId: sid, configId: 'ultra', type: 'boolean', value: true })
    const ultra = option(r.configOptions, 'ultra')
    if (ultra?.type !== 'boolean' || ultra.currentValue !== true) return `ultra ${JSON.stringify(ultra)}`
    if (!/suspended/.test(ultra.description || '')) return `description "${ultra.description}"`
    return true
  })

  await attempt('workflow_size: a select of small/medium/large/unbounded', async () => {
    const ws = option(options, 'workflow_size')
    const values = (ws?.options || []).map((o) => o.value).join(',')
    if (ws?.type !== 'select' || values !== 'small,medium,large,unbounded') return `workflow_size ${JSON.stringify(ws)}`
    return true
  })

  await attempt('a bad value is refused with the reason in data.error', async () => {
    try {
      await a.send('session/set_config_option', { sessionId: sid, configId: 'thinking', value: 'bogus' })
      return 'accepted'
    } catch (err) {
      const reason = err?.data?.error
      if (typeof reason !== 'string' || reason.trim() === '') return `error ${JSON.stringify(err)}`
      return true
    }
  })

  await attempt('/ultracode is an unknown command, ending end_turn', async () => {
    const from = a.updates.length
    const r = await a.send('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/ultracode' }] })
    const reply = a.updates.slice(from).find((u) => kindOf(u) === 'agent_message_chunk')
    if (!/unknown command/.test(textOf(reply))) return `reply "${textOf(reply)}"`
    if (r.stopReason !== 'end_turn') return `stopReason ${r.stopReason}`
    return true
  })

  await attempt('/workflow-size small pushes config_option_update', async () => {
    const from = a.updates.length
    await a.send('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/workflow-size small' }] })
    const u = await a.waitFor(
      (x) => kindOf(x) === 'config_option_update' && option(x.update.configOptions, 'workflow_size')?.currentValue === 'small',
      1000,
      from
    )
    return u ? true : 'no config_option_update with workflow_size small'
  })

  await attempt('an image-only prompt is refused: -32602 "prompt has no text content"', async () => {
    try {
      // A 1×1 PNG.
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
      await a.send('session/prompt', { sessionId: sid, prompt: [{ type: 'image', data: png, mimeType: 'image/png' }] })
      return 'accepted'
    } catch (err) {
      if (err?.code !== -32602 || err?.data?.error !== 'prompt has no text content') return JSON.stringify(err)
      return true
    }
  })

  await attempt('a turn with no provider fails with its reason, and is saved', async () => {
    try {
      await a.send('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'hello' }] }, 30000)
      return 'a provider-less turn succeeded (is a provider configured in the throwaway HOME?)'
    } catch (err) {
      if (typeof err?.data?.error !== 'string' || err.data.error === '') return `error ${JSON.stringify(err)}`
      return true
    }
  })

  await attempt('session/list includes the session', async () => {
    const r = await a.send('session/list', { cwd: PROJECT })
    return (r.sessions || []).some((s) => s.sessionId === sid) ? true : `sessions ${JSON.stringify(r.sessions)}`
  })

  await attempt('_spettro/providers/list, models/list, account/status answer', async () => {
    const p = await a.send('_spettro/providers/list', {})
    if (!Array.isArray(p?.providers) || p.providers.length === 0) return `providers ${JSON.stringify(p).slice(0, 200)}`
    const m = await a.send('_spettro/models/list', {})
    // An unconfigured CLI answers `models: null` (a nil Go slice); the app's
    // decoder treats that as none.
    if (!m || !('models' in m)) return `models ${JSON.stringify(m)}`
    const s = await a.send('_spettro/account/status', {})
    if (typeof s?.signedIn !== 'boolean') return `account ${JSON.stringify(s)}`
    return true
  })

  await attempt('_spettro/workflow/validate: a good script passes, a broken one says why', async () => {
    const good = await a.send('_spettro/workflow/validate', { sessionId: sid, script: GOOD_SCRIPT })
    if (good?.ok !== true || good.name !== 'smoke-flow') return `good ${JSON.stringify(good)}`
    const bad = await a.send('_spettro/workflow/validate', { sessionId: sid, script: 'export const meta = {' })
    if (bad?.ok !== false || !bad.error) return `broken ${JSON.stringify(bad)}`
    return true
  })

  await attempt('_spettro/workflow/list {cwd} (no session)', async () => {
    const r = await a.send('_spettro/workflow/list', { cwd: PROJECT })
    if (!Array.isArray(r?.workflows) || r.cwd !== PROJECT) return JSON.stringify(r).slice(0, 300)
    return true
  })

  await attempt('session/close', async () => {
    await a.send('session/close', { sessionId: sid })
    return true
  })
  a.stop()

  // A second process, as after a relaunch: the session comes back from disk.
  a = startAgent()
  await attempt('session/resume in a new process announces commands', async () => {
    await a.send('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'spettro-desktop-smoke', version: '0' } })
    const r = await a.send('session/resume', { sessionId: sid, cwd: PROJECT, mcpServers: [] })
    if (!Array.isArray(r?.configOptions) || r.configOptions.length === 0) return `resume ${JSON.stringify(r).slice(0, 200)}`
    const u = await a.waitFor((x) => kindOf(x) === 'available_commands_update' && x.sessionId === sid, 1500)
    return u ? true : 'no available_commands_update after resume'
  })
  a.stop()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0 && a.stderr.length > 0) console.log(`\nlast CLI stderr:\n${a.stderr.join('').slice(-1500)}`)
  fs.rmSync(HOME, { recursive: true, force: true })
  process.exit(failed.length > 0 ? 1 : 0)
})().catch((err) => {
  console.error('smoke crashed:', err)
  process.exit(1)
})

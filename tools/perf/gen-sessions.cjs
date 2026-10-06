// Writes a large, realistic sessions.json for the benchmark's scratch
// profile: `chats` conversations across four projects, one of them long
// (`longItems` transcript items: turns of thinking, reads, ~200-line edit
// diffs, long command output and markdown answers with code blocks), the
// rest 6–80 items. Deterministic: the same arguments write the same file.
//
//   node tools/perf/gen-sessions.cjs <out sessions.json> <projects dir> [chats=40] [longItems=800]
//
// Every chat has a CLI session id, so opening it resumes against the fake
// agent (which accepts any id) like a real chat would. Item shapes are
// src/shared/model.ts TranscriptItem — what ChatSession.snapshot() writes.

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const C = require('./content.cjs')
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'cli-fixture.json'), 'utf8'))

const PROJECTS = ['spettro-desktop', 'spettro', 'website', 'notes']

/** The options a chat was last saved with: what the fake agent reports. */
function storedOptions() {
  const o = FIXTURE.options
  return [
    { ...o.mode, currentValue: 'coding' },
    {
      category: 'model',
      currentValue: 'anthropic:claude-sonnet-4-5',
      description: 'Active model for this session',
      id: 'model',
      name: 'Model',
      options: [
        { group: 'Anthropic', name: 'Anthropic', options: [{ name: 'Claude Sonnet 4.5', value: 'anthropic:claude-sonnet-4-5' }, { name: 'Claude Opus 4.1', value: 'anthropic:claude-opus-4-1' }] },
        { group: 'OpenAI', name: 'OpenAI', options: [{ name: 'GPT-5', value: 'openai:gpt-5' }] }
      ],
      type: 'select'
    },
    { ...o.permission, currentValue: 'restricted' },
    { ...o.thinking, currentValue: 'high' },
    { ...o.ultra, currentValue: false },
    { ...o.workflow_size, currentValue: 'medium' }
  ]
}

/** The stored (parsed) form of an option, as ChatSession keeps it. */
function parsedOptions() {
  return storedOptions().map((o) => {
    if (o.type === 'boolean') return { id: o.id, name: o.name, description: o.description, kind: { type: 'boolean', currentValue: o.currentValue } }
    const grouped = o.options.length > 0 && o.options[0].options !== undefined
    const groups = grouped
      ? o.options.map((g) => ({ name: g.name, options: g.options.map((c) => ({ name: c.name, value: c.value })) }))
      : [{ name: '', options: o.options.map((c) => ({ name: c.name, value: c.value, ...(c.description ? { description: c.description } : {}) })) }]
    const out = { id: o.id, name: o.name, kind: { type: 'select', currentValue: o.currentValue, groups, flat: groups.flatMap((g) => g.options) } }
    if (o.description) out.description = o.description
    if (o.category) out.category = o.category
    return out
  })
}

function buildChat(index, itemTarget, projectsDir, now) {
  const r = C.rng(index * 7919 + 1)
  const project = PROJECTS[index % PROJECTS.length]
  const projectPath = path.join(projectsDir, project)
  let t = now - (index + 1) * 3_600_000 - itemTarget * 4000
  const items = []
  let seq = 0
  const id = () => `${index}-${++seq}`
  const msg = (role, text, extra = {}) =>
    items.push({ kind: 'message', message: { id: `m-${id()}`, role, text, attachments: [], isStreaming: false, timestamp: (t += 1500), ...extra } })
  const tool = (o) => items.push({ kind: 'tool', tool: { id: `call-${id()}`, status: 'completed', diffs: [], locations: [], timestamp: (t += 900), ...o } })

  let turn = 0
  while (items.length < itemTarget) {
    turn++
    const seed = index * 1000 + turn
    msg('user', `${C.sentence(r, 6, 16)} Look at ${C.FILES[turn % C.FILES.length]} and fix it.`)
    const thinkStart = t
    msg('reasoning', C.thought(seed, 8).join(''), { startedAt: thinkStart, endedAt: thinkStart + 9000 })
    const tools = itemTarget >= 200 ? 14 : 1 + Math.floor(r() * 5)
    for (let k = 0; k < tools && items.length < itemTarget - 1; k++) {
      const file = C.FILES[(turn * 3 + k) % C.FILES.length]
      const abs = path.join(projectPath, file)
      const which = (turn + k) % 5
      if (which === 0 || which === 3) {
        const output = C.readOutput(seed * 31 + k, file, 120)
        tool({ title: `Read ${file}`, kind: 'read', output, rawOutput: output, locations: [{ path: abs }], argsJSON: JSON.stringify({ path: file }) })
      } else if (which === 1) {
        const { oldText, newText } = C.editTexts(seed * 31 + k, 200)
        tool({ title: `Edit ${file}`, kind: 'edit', output: '', rawOutput: `Edited ${file}`, diffs: [{ path: abs, oldText, newText }], locations: [{ path: abs }], argsJSON: JSON.stringify({ path: file, old_string: 'persist()', new_string: 'schedulePersist()' }) })
      } else if (which === 2) {
        const command = C.COMMANDS[(turn + k) % C.COMMANDS.length]
        const output = C.bashOutput(seed * 31 + k, command, 300)
        tool({ title: `Run ${command}`, kind: 'execute', status: k % 9 === 2 ? 'failed' : 'completed', output, rawOutput: output, argsJSON: JSON.stringify({ command }) })
      } else {
        const output = C.searchOutput(seed * 31 + k, 40)
        tool({ title: 'Find **/*.ts in src', kind: 'search', output, rawOutput: output, locations: [{ path: path.join(projectPath, 'src') }], argsJSON: JSON.stringify({ path: 'src', pattern: '**/*.ts' }) })
      }
      if (k === 6) msg('assistant', C.markdown(seed + 50, 120))
    }
    msg('assistant', C.markdown(seed, itemTarget >= 200 ? 700 : 250))
  }
  items.length = Math.min(items.length, itemTarget)

  return {
    id: `perf-chat-${String(index).padStart(2, '0')}`,
    acpSessionId: `session-stored-${index}`,
    projectPath,
    title: index === 0 ? 'Long session: refactor the persistence layer' : C.sentence(r, 3, 7).replace(/\.$/, ''),
    createdAt: t - itemTarget * 5000,
    updatedAt: t,
    isPinned: index === 3 || index === 7,
    isArchived: index >= 36,
    items,
    configOptions: parsedOptions(),
    pendingConfigChanges: {},
    sessionTokens: 40000 + index * 1234
  }
}

function generate(chats = 40, longItems = 800, projectsDir = '/tmp/perf/projects', now = Date.UTC(2026, 9, 6, 12)) {
  const out = []
  for (let i = 0; i < chats; i++) {
    const r = C.rng(i + 99)
    const n = i === 0 ? longItems : 6 + Math.floor(r() * 75)
    out.push(buildChat(i, n, projectsDir, now))
  }
  return out
}

module.exports = { generate, PROJECTS }

if (require.main === module) {
  const [outFile, projectsDir, chats = '40', longItems = '800'] = process.argv.slice(2)
  if (!outFile || !projectsDir) {
    console.error('usage: node gen-sessions.cjs <out sessions.json> <projects dir> [chats] [longItems]')
    process.exit(2)
  }
  for (const p of PROJECTS) fs.mkdirSync(path.join(projectsDir, p), { recursive: true })
  const sessions = generate(Number(chats), Number(longItems), projectsDir)
  fs.writeFileSync(outFile, JSON.stringify(sessions, null, 2))
  const items = sessions.reduce((n, s) => n + s.items.length, 0)
  console.log(`${outFile}: ${sessions.length} chats, ${items} items, ${(fs.statSync(outFile).size / 1e6).toFixed(1)} MB`)
}

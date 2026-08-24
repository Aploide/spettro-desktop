// Folding the flat ACP transcript back into the shape the run actually had.
//
// The CLI streams a workflow or an Ultra swarm as a *flat* sequence of tool
// calls: one long-lived lifecycle call, one call per sub-agent, and then every
// tool each sub-agent runs, all interleaved in arrival order. Rendered
// literally that is a wall of rows where a twenty-agent fan-out drowns out the
// conversation and nothing says which agent did what — the exact readability
// problem internal/tui/view_swarm.go documents on the terminal side.
//
// The structure is recoverable, because every row carries who it belongs to:
// members name their `run_id`, and nested calls are titled `[code#3] bash …`.
// This module is the single place that reconstruction happens. It is pure and
// memo-free on purpose: a session restored from disk must fold to exactly the
// same tree as the live one that produced it, so the answer may depend only on
// the items passed in.
//
// The one thing that is *not* recoverable from structured data is a finished
// run's plan. `chatSession.applyToolEvent` overwrites `argsJSON` on every
// update carrying rawInput, and the CLI's finish update re-sends a completely
// different payload (`{run_id, workflow, agents, failed, cached, tokens}`) —
// so `phases`, `description` and `origin` are gone the moment the run ends,
// and gone forever once the session is reloaded. Since the phase tree is the
// entire point of the card, we mine them back out of the CLI's own rendered
// text (`acpWorkflow.render()` in internal/acp/workflow.go), whose format is
// stable. Structured args always win; the text only fills what is missing.

import type { JSONValue } from '@shared/acp'
import type { ToolCallItem, TranscriptItem } from '@shared/model'
import { transcriptItemId } from '@shared/model'
import { modeColor } from '@renderer/design/theme'
import { parsedTitle, subAgentCall, subAgentResult, type SubAgentResult } from './toolPresentation'

// ---------------------------------------------------------------------------
// The shapes the views render
// ---------------------------------------------------------------------------

export type OrchStatus = 'running' | 'done' | 'failed'

export interface OrchCounts {
  total: number
  running: number
  done: number
  failed: number
  cached: number
}

/** One sub-agent: a workflow member, a swarm member, or a plain delegation. */
export interface MemberCall {
  tool: ToolCallItem
  /** "review#3"; falls back to the raw agent name. */
  instance: string
  /** "review" — the part before '#', for the tint. */
  specId: string
  /** 1-based dispatch index when the CLI sent one. */
  index: number | null
  /** The label / prompt / swarm item ('' if unknown). */
  task: string
  /** '' when dispatched outside any phase. */
  phase: string
  /** Replayed from the resume journal. */
  cached: boolean
  status: OrchStatus
  /** The member's own tool calls, arrival order. */
  children: ToolCallItem[]
  result: SubAgentResult | null
}

export interface WorkflowPhase {
  /** '' is the trailing "no phase" bucket. */
  title: string
  detail: string
  members: MemberCall[]
  counts: OrchCounts
}

export interface WorkflowRun {
  kind: 'workflow'
  tool: ToolCallItem
  runId: string
  name: string
  description: string
  origin: string
  status: OrchStatus
  /** "12 agents · 1 failed · 0 replayed", '' while running. */
  summary: string
  phases: WorkflowPhase[]
  logs: string[]
  counts: OrchCounts
  /** The CLI's own text tree, kept as a raw fallback. */
  rendered: string
}

export interface SwarmRun {
  kind: 'swarm'
  tool: ToolCallItem
  description: string
  subagentType: string
  /** '' | 'worktree' */
  isolation: string
  items: string[]
  status: OrchStatus
  members: MemberCall[]
  counts: OrchCounts
}

export type OrchRun = WorkflowRun | SwarmRun

/** A row of the folded transcript. */
export type TranscriptRow =
  | { kind: 'item'; id: string; item: TranscriptItem }
  | { kind: 'agent'; id: string; member: MemberCall }
  | { kind: 'run'; id: string; run: OrchRun }

// ---------------------------------------------------------------------------
// JSON argument accessors
// ---------------------------------------------------------------------------

type Args = { [key: string]: JSONValue } | null

function argStr(args: Args, key: string): string {
  if (args === null) return ''
  const value = args[key]
  return typeof value === 'string' ? value : ''
}

function argBool(args: Args, key: string): boolean {
  return args !== null && args[key] === true
}

function argNum(args: Args, key: string): number | null {
  if (args === null) return null
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function argStrings(args: Args, key: string): string[] {
  if (args === null) return []
  const value = args[key]
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** The `phases` array the workflow observer publishes up front, so a host can
 *  draw the whole plan before the first agent runs. Tolerates the degenerate
 *  `["Review", …]` form as well as the `[{title, detail}]` one. */
function argPhases(args: Args): { title: string; detail: string }[] {
  if (args === null) return []
  const value = args['phases']
  if (!Array.isArray(value)) return []
  const out: { title: string; detail: string }[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      if (entry !== '') out.push({ title: entry, detail: '' })
      continue
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const title = typeof entry['title'] === 'string' ? entry['title'] : ''
    const detail = typeof entry['detail'] === 'string' ? entry['detail'] : ''
    if (title !== '') out.push({ title, detail })
  }
  return out
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** `pending`/`in_progress`/`unknown` → running, `failed` → failed, else done. */
function toolStatus(tool: Pick<ToolCallItem, 'status'>): OrchStatus {
  switch (tool.status) {
    case 'failed':
      return 'failed'
    case 'completed':
      return 'done'
    default:
      return 'running'
  }
}

/** The workflow lifecycle call: `workflow <name>`, args carrying `workflow`
 *  but no `agent`. Progress traces (`workflow X ▸ Phase`, `workflow X · log`)
 *  are consumed inside the CLI and normally never reach us — but when they do
 *  escape (no run open) they must not be mistaken for a run. */
function isWorkflowTool(tool: ToolCallItem, name: string, args: Args): boolean {
  if (args !== null) {
    const kind = argStr(args, 'kind')
    if (kind === 'phase' || kind === 'log') return false
    if (argStr(args, 'workflow') !== '' && argStr(args, 'agent') === '') return true
    if (argStr(args, 'workflow') !== '') return false
  }
  if (!name.startsWith('workflow')) return false
  return !tool.title.includes(' ▸ ') && !tool.title.includes(' · log')
}

function isUltraTool(name: string): boolean {
  return name === 'ultra' || name.startsWith('ultra ')
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

function countMembers(members: MemberCall[]): OrchCounts {
  const counts: OrchCounts = { total: members.length, running: 0, done: 0, failed: 0, cached: 0 }
  for (const member of members) {
    if (member.status === 'done') counts.done += 1
    else if (member.status === 'failed') counts.failed += 1
    else counts.running += 1
    if (member.cached) counts.cached += 1
  }
  return counts
}

// ---------------------------------------------------------------------------
// The CLI's rendered tree, read back
// ---------------------------------------------------------------------------

/** `"12 agents · 1 failed · 0 replayed"` — the finish output of
 *  workflowObserver.finish(). A run that failed sends the error text instead. */
const SUMMARY_RE = /^\d+ agents · \d+ failed · \d+ replayed$/

export interface RenderedWorkflow {
  summary: string
  description: string
  /** Phase titles in render order; '' for the "(no phase)" bucket. */
  phases: string[]
  logs: string[]
}

/**
 * Recovers what the finish update destroyed from the text the CLI rendered
 * into the tool's output. The format (internal/acp/workflow.go) is:
 *
 *     12 agents · 1 failed · 0 replayed   <- only once finished
 *                                          <- blank line
 *     <description>                        <- only when the script set one
 *                                          <- blank line
 *     ▸ Review — 2/3 done, 1 failed
 *         ✓ review#1  label text
 *     ○ Verify — pending
 *                                          <- blank line
 *     log:
 *       a log line
 *
 * The `log:` block is the only place the script's `log()` lines survive at
 * all: the CLI folds workflow-progress traces into this call and never emits
 * them as tool calls of their own. A parse failure degrades to empty — a
 * missing description is a cosmetic loss, a thrown exception is a blank chat.
 */
export function parseRenderedWorkflow(output: string, failed: boolean): RenderedWorkflow {
  const empty: RenderedWorkflow = { summary: '', description: '', phases: [], logs: [] }
  try {
    const text = output.trim()
    if (text === '') return empty
    const lines = text.split('\n')

    // The log block runs to the end of the output.
    const logs: string[] = []
    let end = lines.length
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== 'log:') continue
      end = i
      for (let j = i + 1; j < lines.length; j++) {
        const entry = lines[j].trim()
        if (entry !== '') logs.push(entry)
      }
      break
    }

    // Everything from the first phase header on is the tree.
    const phases: string[] = []
    let treeStart = end
    for (let i = 0; i < end; i++) {
      const line = lines[i]
      if (!line.startsWith('▸ ') && !line.startsWith('○ ')) continue
      if (treeStart === end) treeStart = i
      const rest = line.slice(2)
      const dash = rest.lastIndexOf(' — ')
      const title = dash >= 0 ? rest.slice(0, dash) : rest
      phases.push(title === '(no phase)' ? '' : title)
    }

    // The head is one or two blank-line-separated blocks: the finish summary
    // (or, on a failed run, the error) and the script's description.
    const head: string[] = []
    let block = ''
    for (let i = 0; i < treeStart; i++) {
      const line = lines[i]
      if (line.trim() === '') {
        if (block !== '') head.push(block)
        block = ''
        continue
      }
      block = block === '' ? line.trim() : `${block} ${line.trim()}`
    }
    if (block !== '') head.push(block)

    let summary = ''
    let description = ''
    if (head.length > 0 && (SUMMARY_RE.test(head[0]) || failed)) {
      summary = head[0]
      description = head[1] ?? ''
    } else {
      description = head[0] ?? ''
    }
    return { summary, description, phases, logs }
  } catch {
    return empty
  }
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

interface RunBuild {
  kind: 'workflow' | 'swarm'
  tool: ToolCallItem
  args: Args
  runId: string
  members: MemberCall[]
}

function newMember(tool: ToolCallItem, args: Args): MemberCall {
  const call = subAgentCall(tool)
  const instance = argStr(args, 'agent') !== '' ? argStr(args, 'agent') : (call?.agent ?? '')
  const task = argStr(args, 'task') !== '' ? argStr(args, 'task') : (call?.task ?? '')
  const result = subAgentResult(tool)
  const hash = instance.indexOf('#')
  return {
    tool,
    instance,
    specId: hash > 0 ? instance.slice(0, hash) : instance,
    index: argNum(args, 'index'),
    task,
    phase: argStr(args, 'phase'),
    cached: argBool(args, 'cached'),
    status: result?.status === 'error' ? 'failed' : toolStatus(tool),
    children: [],
    result
  }
}

function finishWorkflow(build: RunBuild): WorkflowRun {
  const args = build.args
  const status = toolStatus(build.tool)
  const rendered = build.tool.output.trim()
  const text = parseRenderedWorkflow(rendered, status === 'failed')

  // Structured args win; the text fills only what the finish update destroyed.
  let declared = argPhases(args)
  if (declared.length === 0) {
    declared = text.phases.filter((title) => title !== '').map((title) => ({ title, detail: '' }))
  }

  const buckets = new Map<string, MemberCall[]>()
  const order: string[] = []
  for (const phase of declared) {
    if (buckets.has(phase.title)) continue
    buckets.set(phase.title, [])
    order.push(phase.title)
  }
  let loose = false
  for (const member of build.members) {
    if (member.phase === '') {
      loose = true
      continue
    }
    const bucket = buckets.get(member.phase)
    if (bucket) {
      bucket.push(member)
      continue
    }
    buckets.set(member.phase, [member])
    order.push(member.phase)
  }
  // The unnamed bucket always trails, and only exists when something is in it.
  if (loose) {
    const bucket: MemberCall[] = []
    for (const member of build.members) if (member.phase === '') bucket.push(member)
    buckets.set('', bucket)
    order.push('')
  }

  const details = new Map(declared.map((phase) => [phase.title, phase.detail]))
  const phases: WorkflowPhase[] = order.map((title) => {
    const members = buckets.get(title) ?? []
    return { title, detail: details.get(title) ?? '', members, counts: countMembers(members) }
  })

  const name = argStr(args, 'workflow') !== ''
    ? argStr(args, 'workflow')
    : build.tool.title.startsWith('workflow ')
      ? build.tool.title.slice('workflow '.length).trim()
      : build.tool.title

  const description = argStr(args, 'description') !== '' ? argStr(args, 'description') : text.description
  const summary = status === 'running' ? '' : text.summary

  return {
    kind: 'workflow',
    tool: build.tool,
    runId: build.runId,
    name,
    description,
    origin: argStr(args, 'origin'),
    status,
    summary,
    phases,
    logs: text.logs,
    counts: countMembers(build.members),
    rendered
  }
}

function finishSwarm(build: RunBuild): SwarmRun {
  const args = build.args
  const isolation = argStr(args, 'isolation')
  return {
    kind: 'swarm',
    tool: build.tool,
    description: argStr(args, 'description'),
    subagentType: argStr(args, 'subagent_type'),
    isolation: isolation === 'worktree' ? 'worktree' : '',
    items: argStrings(args, 'items'),
    status: toolStatus(build.tool),
    members: build.members,
    counts: countMembers(build.members)
  }
}

/**
 * Folds a flat transcript into rows: workflow/ultra runs absorb their members,
 * members absorb their own tool calls, everything else passes through
 * untouched and in order.
 *
 * Two linear passes — one to index runs, members and children, one to emit —
 * because this runs on every render of a transcript that can hold thousands
 * of items, and a per-item scan of the list would make a long session crawl.
 */
export function groupTranscript(items: TranscriptItem[]): TranscriptRow[] {
  const builds = new Map<string, RunBuild>()
  const byRunId = new Map<string, RunBuild>()
  const members = new Map<string, MemberCall>()
  const standalone = new Map<string, MemberCall>()
  const absorbed = new Set<string>()
  let lastWorkflow: RunBuild | null = null
  let openWorkflow: RunBuild | null = null
  let lastSwarm: RunBuild | null = null
  let openSwarm: RunBuild | null = null

  // Pass 1 — index.
  for (const item of items) {
    if (item.kind !== 'tool') continue
    const tool = item.tool
    const { agent: prefix, name, args } = parsedTitle(tool)

    if (isWorkflowTool(tool, name, args)) {
      const runId = argStr(args, 'run_id')
      const build: RunBuild = { kind: 'workflow', tool, args, runId, members: [] }
      builds.set(tool.id, build)
      if (runId !== '') byRunId.set(runId, build)
      lastWorkflow = build
      if (toolStatus(tool) === 'running') openWorkflow = build
      continue
    }

    if (isUltraTool(name)) {
      const build: RunBuild = { kind: 'swarm', tool, args, runId: '', members: [] }
      builds.set(tool.id, build)
      lastSwarm = build
      if (toolStatus(tool) === 'running') openSwarm = build
      continue
    }

    // A member's own call is titled with its own instance in brackets, so a
    // bracket that names *someone else* is what marks a nested child.
    const owner = prefix !== null && prefix !== argStr(args, 'agent') ? members.get(prefix) : undefined
    if (owner) {
      owner.children.push(tool)
      absorbed.add(transcriptItemId(item))
      continue
    }

    if (subAgentCall(tool) === null) continue

    const member = newMember(tool, args)
    if (member.instance !== '') members.set(member.instance, member)

    const isWorkflowMember = argStr(args, 'workflow') !== '' && member.instance !== ''
    const isSwarmMember = argBool(args, 'swarm') && member.instance !== ''
    let run: RunBuild | null = null
    if (isWorkflowMember) {
      const runId = argStr(args, 'run_id')
      run = (runId !== '' ? byRunId.get(runId) : undefined) ?? openWorkflow ?? lastWorkflow
    } else if (isSwarmMember) {
      // Swarm members carry no run_id at all — they belong to the ultra call
      // they were fanned out from, which is the nearest one still in flight.
      run = openSwarm ?? lastSwarm
    }
    if (run) {
      run.members.push(member)
      absorbed.add(transcriptItemId(item))
    } else {
      standalone.set(tool.id, member)
    }
  }

  // Finalise each run once, now that every member has landed.
  const runs = new Map<string, OrchRun>()
  for (const [id, build] of builds) {
    runs.set(id, build.kind === 'workflow' ? finishWorkflow(build) : finishSwarm(build))
  }

  // Pass 2 — emit, in the original order.
  const rows: TranscriptRow[] = []
  for (const item of items) {
    const id = transcriptItemId(item)
    if (item.kind === 'tool') {
      const run = runs.get(item.tool.id)
      if (run) {
        rows.push({ kind: 'run', id: `run-${item.tool.id}`, run })
        continue
      }
      const member = standalone.get(item.tool.id)
      if (member) {
        rows.push({ kind: 'agent', id: `agent-${item.tool.id}`, member })
        continue
      }
    }
    if (absorbed.has(id)) continue
    rows.push({ kind: 'item', id, item })
  }
  return rows
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

/** Runs still in flight, in transcript order — what the live panel shows. */
export function activeRuns(rows: TranscriptRow[]): OrchRun[] {
  const out: OrchRun[] = []
  for (const row of rows) {
    if (row.kind === 'run' && row.run.status === 'running') out.push(row.run)
  }
  return out
}

/** Display title: "review-changes" / "ultra swarm · code". */
export function runTitle(run: OrchRun): string {
  if (run.kind === 'workflow') return run.name === '' ? 'workflow' : run.name
  return run.subagentType === '' ? 'ultra swarm' : `ultra swarm · ${run.subagentType}`
}

/**
 * Per-member tint. The TUI looks the spec up in the agent manifest and uses
 * its declared colour; the renderer has no manifest, so it maps the spec id
 * itself through the same palette — "code" lands on the same green either way,
 * and anything unknown falls back to the accent rather than going untinted.
 */
export function memberTint(specId: string): string {
  return modeColor(specId)
}

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
//
// The other thing the wire gets wrong for us is that a workflow arrives as TWO
// tool calls with the same name. `workflow {"save_as":…,"script":"export const
// meta = …"}` is the model's actual invocation of the `workflow` TOOL, and it
// carries the entire script as arguments; `workflow <name>` (call id `wf-…`)
// is the lifecycle trace the run is built from. Left alone the first renders
// as a full page of raw JSON directly above the card it belongs to, so it is
// folded into the run — matched by the `run_id` its `<workflow_result>` block
// declares, or, failing that, by position, since a script call can only ever
// precede the run it starts. The exception is load-bearing: a script call that
// FAILED before any run existed has no lifecycle call to hide behind, and it
// is the only trace that a workflow was attempted at all, so it survives as a
// row of its own.

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
  /**
   * What to SHOW for this member, which is not the same question as "did it
   * file a report". `subAgentResult` only recognises the `{agent,status,
   * summary}` shape the CLI wraps a plain delegation in; an `agent()` call
   * given a `schema` returns its structured value instead
   * (`{"content":"beta\n","file":"b.txt"}`), and a member that just answered
   * in prose returns the prose. Both have no `summary`, so trusting `result`
   * alone makes a finished member render as an empty row — the card would be
   * hiding output it is holding. This is the summary when there is one and
   * the raw output otherwise, and it is '' only when the member really said
   * nothing.
   */
  resultText: string
  /** `resultText` is pretty-printed JSON: show it preformatted, not as prose. */
  resultIsJSON: boolean
}

export interface WorkflowPhase {
  /** '' is the trailing "no phase" bucket. */
  title: string
  detail: string
  members: MemberCall[]
  counts: OrchCounts
}

/**
 * The `workflow` tool call the model made — the script itself, not the run.
 *
 * Kept apart from WorkflowRun because the two disagree about what they are:
 * the run is a live tree of agents, this is a submitted program and whatever
 * it evaluated to. Usually it belongs inside its run's card (a `script`
 * disclosure plus the returned value); when the call failed before a run
 * existed, it IS the whole story and renders on its own.
 */
export interface WorkflowScript {
  /** The call itself, so a card can show its status, timing and raw output. */
  tool: ToolCallItem
  /** The JS the model submitted ('' when it ran a saved workflow by name). */
  source: string
  /** `save_as` / `name` — what the workflow is called ('' when anonymous). */
  savedAs: string
  /** The run_id declared by `<workflow_result>`; '' when nothing ever ran. */
  runId: string
  /** Where the script came from: 'inline', a path, '' when unstated. */
  origin: string
  /** The value the script returned, pretty-printed when it is JSON. */
  returned: string
  status: OrchStatus
  /** The failure text of a call that never started a run ('' otherwise). */
  error: string
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
  /** The `workflow` tool call that submitted the script, when we could match
   *  one to this run. Null for a run whose script call never reached us. */
  script: WorkflowScript | null
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
  /**
   * The items no member has taken yet — the tail of `items` past the members
   * that exist, because Ultra dispatches in item order. Ultra ramps its
   * launches (five at once, then one every 700ms), so a twenty-item swarm
   * spends its first seconds with most of its work un-launched; that work is
   * pending, not absent, and the cards draw it as ghost cells.
   */
  pending: string[]
  /** Counted over `items`, not over the members that happen to exist yet: a
   *  meter whose denominator grows makes a swarm appear to go backwards. */
  counts: OrchCounts
}

export type OrchRun = WorkflowRun | SwarmRun

/** A row of the folded transcript. */
export type TranscriptRow =
  | { kind: 'item'; id: string; item: TranscriptItem }
  | { kind: 'agent'; id: string; member: MemberCall }
  | { kind: 'run'; id: string; run: OrchRun }
  /** A `workflow` tool call that started no run — the only surviving trace of
   *  a workflow that failed before its first agent. It carries `item` as well,
   *  so a renderer that has not learned this kind yet degrades to the ordinary
   *  tool row instead of dropping the row on the floor. */
  | { kind: 'script'; id: string; script: WorkflowScript; item: TranscriptItem }

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

/**
 * The `workflow` TOOL call, as opposed to the lifecycle trace of the run it
 * starts. Both are titled `workflow …`, so they are told apart by what the
 * arguments carry: an invocation carries the program (`script`, `save_as`,
 * `args`, `max_concurrency`) and knows nothing about a run yet, while the
 * trace carries `run_id` and `workflow`. Checking for the absence of those
 * two is what makes this safe — a payload with either is never an invocation,
 * whatever else is in it.
 */
function isWorkflowScriptTool(name: string, args: Args): boolean {
  if (args === null) return false
  if (argStr(args, 'run_id') !== '' || argStr(args, 'workflow') !== '') return false
  if (name !== 'workflow') return false
  return (
    argStr(args, 'script') !== '' ||
    argStr(args, 'save_as') !== '' ||
    argStr(args, 'script_path') !== '' ||
    argStr(args, 'name') !== ''
  )
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

    // The head and the tree are blank-line-separated blocks, so the tree is
    // found as a block rather than by hunting for the first glyph anywhere in
    // the output. A description is free prose the script author wrote, and
    // prose that happens to contain a line starting with "▸" would otherwise
    // invent a phase out of nothing *and* truncate the description at that
    // line. Matching a whole block — every line of it either a phase header
    // or an indented member row — costs nothing and cannot be fooled by one
    // stray character.
    const blocks: { start: number; lines: string[] }[] = []
    let current: { start: number; lines: string[] } | null = null
    for (let i = 0; i < end; i++) {
      if (lines[i].trim() === '') {
        current = null
        continue
      }
      if (current === null) {
        current = { start: i, lines: [] }
        blocks.push(current)
      }
      current.lines.push(lines[i])
    }

    const isPhaseHeader = (line: string): boolean =>
      line.startsWith('▸ ') || line.startsWith('○ ')
    // Member rows are indented under their phase; the glyph set is the one
    // acpWorkflow.render writes.
    const isMemberRow = (line: string): boolean => /^\s+[✓▶✗] /.test(line)
    const isTreeBlock = (block: { lines: string[] }): boolean =>
      block.lines.length > 0 &&
      block.lines.some(isPhaseHeader) &&
      block.lines.every((line) => isPhaseHeader(line) || isMemberRow(line))

    // The last qualifying block, not the first: the tree is always the final
    // thing before the log, and taking the last one means an earlier
    // false positive loses to the real thing.
    let treeStart = end
    const phases: string[] = []
    for (let b = blocks.length - 1; b >= 0; b--) {
      if (!isTreeBlock(blocks[b])) continue
      treeStart = blocks[b].start
      for (const line of blocks[b].lines) {
        if (!isPhaseHeader(line)) continue
        const rest = line.slice(2)
        const dash = rest.lastIndexOf(' — ')
        const title = dash >= 0 ? rest.slice(0, dash) : rest
        phases.push(title === '(no phase)' ? '' : title)
      }
      break
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
// The `workflow` tool call, read back
// ---------------------------------------------------------------------------

/**
 * The block the tool answers with (internal/acp/workflow.go):
 *
 *     <workflow_result name="check-files" run_id="wf_2026…">
 *     <summary>3 agents · 0 failed · 0 replayed from journal · 29203 tokens</summary>
 *     <phases>Read</phases>
 *     <returned>
 *     [ "…", "…" ]
 *     </returned>
 *     </workflow_result>
 *     Script: inline · transcript: /home/…/workflows/wf_2026…
 *
 * `run_id` is the reliable way to tie the call to its run, and `<returned>` is
 * the script's actual answer — the one thing in the whole exchange the model
 * wrote code to produce, and the thing a raw-JSON row buried. Anything that
 * fails to match degrades to '', never to a throw: a workflow whose output
 * shape drifts must still render.
 */
function newScript(tool: ToolCallItem, args: Args): WorkflowScript {
  const output = tool.output
  const header = /<workflow_result([^>]*)>/.exec(output)
  const attrs = header?.[1] ?? ''
  const runId = /\brun_id="([^"]*)"/.exec(attrs)?.[1] ?? ''
  const resultName = /\bname="([^"]*)"/.exec(attrs)?.[1] ?? ''
  const returned = /<returned>([\s\S]*?)<\/returned>/.exec(output)?.[1] ?? ''
  const origin = /^Script:\s*([^\n·]+)/m.exec(output)?.[1]?.trim() ?? ''

  const savedAs =
    argStr(args, 'save_as') !== ''
      ? argStr(args, 'save_as')
      : argStr(args, 'name') !== ''
        ? argStr(args, 'name')
        : resultName

  const status = toolStatus(tool)
  return {
    tool,
    source: argStr(args, 'script'),
    savedAs,
    runId,
    origin: origin !== '' ? origin : argStr(args, 'script_path'),
    returned: prettyJSON(returned.trim()),
    status,
    // A call that produced a <workflow_result> ran; anything else it printed
    // while failing is the reason it never did.
    error: status === 'failed' && header === null ? output.trim() : ''
  }
}

/** Pretty-prints JSON, and leaves anything else exactly as it came. Machine
 *  output that is shown to a human is worth re-indenting; prose is not. */
function prettyJSON(text: string): string {
  if (text === '' || (text[0] !== '{' && text[0] !== '[')) return text
  try {
    return JSON.stringify(JSON.parse(text) as JSONValue, null, 2)
  } catch {
    return text
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
  script: WorkflowScript | null
}

function newMember(tool: ToolCallItem, args: Args): MemberCall {
  const call = subAgentCall(tool)
  const instance = argStr(args, 'agent') !== '' ? argStr(args, 'agent') : (call?.agent ?? '')
  const task = argStr(args, 'task') !== '' ? argStr(args, 'task') : (call?.task ?? '')
  const result = subAgentResult(tool)
  const hash = instance.indexOf('#')
  const shown = memberOutput(tool, result)
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
    result,
    resultText: shown.text,
    resultIsJSON: shown.isJSON
  }
}

/**
 * The member's output as something showable. `subAgentResult` answers a
 * narrower question — "did this agent file a `{agent,status,summary}` report"
 * — and its contract is relied on elsewhere, so the widening happens here: a
 * schema'd `agent()` call returns its structured value and a prose answer
 * returns prose, and neither has a `summary` to find. Structured output is
 * re-indented because the CLI sends it minified onto one enormous line.
 */
function memberOutput(
  tool: ToolCallItem,
  result: SubAgentResult | null
): { text: string; isJSON: boolean } {
  if (result !== null && result.summary !== '') return { text: result.summary, isJSON: false }
  const raw = tool.output.trim()
  if (raw === '') return { text: '', isJSON: false }
  const structured = raw.startsWith('{') || raw.startsWith('[')
  return { text: structured ? prettyJSON(raw) : raw, isJSON: structured }
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

  const declaredDescription = argStr(args, 'description')
  const description = declaredDescription !== '' ? declaredDescription : text.description
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
    rendered,
    script: build.script
  }
}

function finishSwarm(build: RunBuild): SwarmRun {
  const args = build.args
  const isolation = argStr(args, 'isolation')
  const items = argStrings(args, 'items')
  // Members are dispatched in item order, so everything past the members that
  // exist is exactly what the ramp still owes.
  const pending = items.length > build.members.length ? items.slice(build.members.length) : []
  return {
    kind: 'swarm',
    tool: build.tool,
    description: argStr(args, 'description'),
    subagentType: argStr(args, 'subagent_type'),
    isolation: isolation === 'worktree' ? 'worktree' : '',
    items,
    status: toolStatus(build.tool),
    members: build.members,
    pending,
    // The denominator is the work that was ASKED for. Counting launched
    // members instead made the header say "4/7" directly above "10 items" —
    // two numbers for one swarm, neither of them the one the user requested.
    counts: { ...countMembers(build.members), total: build.members.length + pending.length }
  }
}

/**
 * Finds the script call a lifecycle trace belongs to and marks it taken.
 *
 * `run_id` is the honest link and is used whenever the `<workflow_result>`
 * block carried one. The fallback is positional and safe for the same reason
 * the swarm's is: a script call is the thing that *starts* a run, so it can
 * only ever precede its own lifecycle call, and the nearest unclaimed one
 * above is the only candidate. Earlier unclaimed calls are left alone — they
 * are failed attempts, and stealing one into this run would hide it.
 */
function claimScript(
  scripts: { script: WorkflowScript; claimed: boolean }[],
  byRunId: Map<string, { script: WorkflowScript; claimed: boolean }>,
  runId: string
): WorkflowScript | null {
  const exact = runId !== '' ? byRunId.get(runId) : undefined
  if (exact && !exact.claimed) {
    exact.claimed = true
    return exact.script
  }
  for (let i = scripts.length - 1; i >= 0; i--) {
    const entry = scripts[i]
    if (entry.claimed) continue
    // A script call that already names a *different* run is not this one's.
    if (entry.script.runId !== '' && runId !== '' && entry.script.runId !== runId) continue
    entry.claimed = true
    return entry.script
  }
  return null
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
  // Script calls seen so far, oldest first, with the ones already claimed by a
  // run marked. Whatever is still unclaimed at the end started no run and
  // becomes a row of its own.
  const scripts: { script: WorkflowScript; claimed: boolean }[] = []
  const scriptByRunId = new Map<string, { script: WorkflowScript; claimed: boolean }>()
  let lastWorkflow: RunBuild | null = null
  let openWorkflow: RunBuild | null = null
  let lastSwarm: RunBuild | null = null
  let openSwarm: RunBuild | null = null

  // Pass 1 — index.
  for (const item of items) {
    if (item.kind !== 'tool') continue
    const tool = item.tool
    const { agent: prefix, name, args } = parsedTitle(tool)

    if (isWorkflowScriptTool(name, args)) {
      const entry = { script: newScript(tool, args), claimed: false }
      scripts.push(entry)
      if (entry.script.runId !== '') scriptByRunId.set(entry.script.runId, entry)
      continue
    }

    if (isWorkflowTool(tool, name, args)) {
      const runId = argStr(args, 'run_id')
      const build: RunBuild = {
        kind: 'workflow',
        tool,
        args,
        runId,
        members: [],
        script: claimScript(scripts, scriptByRunId, runId)
      }
      builds.set(tool.id, build)
      if (runId !== '') byRunId.set(runId, build)
      lastWorkflow = build
      if (toolStatus(tool) === 'running') openWorkflow = build
      continue
    }

    if (isUltraTool(name)) {
      const build: RunBuild = { kind: 'swarm', tool, args, runId: '', members: [], script: null }
      builds.set(tool.id, build)
      lastSwarm = build
      if (toolStatus(tool) === 'running') openSwarm = build
      continue
    }

    // A member's own call is titled with its own instance in brackets, so a
    // bracket that names *someone else* is what marks a nested child.
    const owner =
      prefix !== null && prefix !== argStr(args, 'agent') ? members.get(prefix) : undefined
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

  // A script call that found a run is now part of that run's card; one that
  // did not is a workflow that never began, and dropping it would erase the
  // only evidence it was ever attempted.
  const orphans = new Map<string, WorkflowScript>()
  const claimed = new Set<string>()
  for (const entry of scripts) {
    if (entry.claimed) claimed.add(entry.script.tool.id)
    else orphans.set(entry.script.tool.id, entry.script)
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
      const orphan = orphans.get(item.tool.id)
      if (orphan) {
        rows.push({ kind: 'script', id: `script-${item.tool.id}`, script: orphan, item })
        continue
      }
      if (claimed.has(item.tool.id)) continue
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

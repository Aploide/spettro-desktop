// Folding the flat ACP transcript back into the shape the run actually had.
//
// The CLI streams a workflow as a *flat* sequence of tool calls: one
// long-lived card for the run, one call per sub-agent, and then every tool
// each sub-agent runs, all interleaved in arrival order. Rendered literally
// that is a wall of rows where a twenty-agent fan-out drowns out the
// conversation and nothing says which agent did what.
//
// The structure is recoverable, because every row carries who it belongs to:
// members name their `run_id`, and nested calls are titled `[code#3] bash …`.
// This module is the single place that reconstruction happens. It is pure and
// memo-free on purpose: a session restored from disk must fold to exactly the
// same tree as the live one that produced it, so the answer may depend only on
// the items passed in.
//
// The run's own state — phases, members, pause, stop, size — comes from one of
// two sources, best first:
//
//   1. `_meta["spettro.app/workflow"]` on the card (internal/acp/workflow.go
//      metaView), which the CLI builds from the same state as the card's text.
//      It is the whole run as structure, so when it is there it is the answer.
//   2. The card's text (`acpWorkflow.render()`), read back line by line. An
//      older CLI sends nothing else, and a session saved by an older build of
//      this app has nothing else. The format is stable and documented below;
//      structured start args, when the card kept them, win over it.
//
// The other thing the wire gets wrong for us is that a workflow arrives as TWO
// tool calls with the same name. `workflow {"save_as":…,"script":"export const
// meta = …"}` is the model's actual invocation of the `workflow` TOOL, and it
// carries the entire script as arguments; `workflow <name>` (card id
// `workflow-<run id>`) is the lifecycle card the run is built from. Left alone
// the first renders as a full page of raw JSON directly above the card it
// belongs to, so it is folded into the run — matched by the `run_id` its
// `<workflow_result>` block declares, or, failing that, by position, since a
// script call can only ever precede the run it starts. The exception is
// load-bearing: a script call that FAILED before any run existed has no
// lifecycle call to hide behind, and it is the only trace that a workflow was
// attempted at all, so it survives as a row of its own.
//
// A run can also outlive its turn: paused at a checkpoint, it waits for the
// orchestrating model, which may continue it in a later turn. The CLI then
// closes the earlier card ("continued in a later turn", `continuedIn`) and
// opens a new one (`workflow-<run id>-2`) with everything recorded so far. So
// members are pooled per run, not per card, and each card picks the members
// its own state lists.

import type { JSONValue } from '@shared/acp'
import type { ToolCallItem, TranscriptItem } from '@shared/model'
import { transcriptItemId } from '@shared/model'
import { modeColor } from '@renderer/design/theme'
import { parsedTitle, subAgentCall, subAgentResult, type SubAgentResult } from './toolPresentation'

// ---------------------------------------------------------------------------
// The shapes the views render
// ---------------------------------------------------------------------------

/** A member's (or a script call's) state. `pending` is a member the CLI
 *  reported in a status it does not name (its "·" glyph): not yet running,
 *  and certainly not done. `stopped` is one still running when its run
 *  ended (see finishWorkflow). */
export type OrchStatus = 'running' | 'done' | 'failed' | 'pending' | 'stopped'

/**
 * A run's state.
 *
 * `paused` is alive but idle — waiting at a checkpoint for the orchestrating
 * model — and must never spin like `running`. `stopped` was ended on purpose
 * (the orchestrator, the idle reaper, the session closing): neither a success
 * nor a failure, and it says why.
 */
export type RunStatus = 'running' | 'paused' | 'stopped' | 'done' | 'failed'

export interface OrchCounts {
  total: number
  running: number
  done: number
  failed: number
  pending: number
  /** Cut off by the run ending under them (a cancelled turn, a stop). */
  stopped: number
  cached: number
}

/** One sub-agent: a workflow member or a plain delegation. */
export interface MemberCall {
  /** The member's own `agent` call. For a member the card lists but whose
   *  call never reached this transcript, a stand-in built from the card. */
  tool: ToolCallItem
  /** "review#3"; falls back to the raw agent name. */
  instance: string
  /** "review" — the part before '#', for the tint. */
  specId: string
  /** 1-based dispatch index when the CLI sent one. */
  index: number | null
  /** The label / prompt ('' if unknown). */
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
  /** The script entered it at runtime instead of declaring it up front. */
  dynamic: boolean
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
  tool: ToolCallItem
  runId: string
  name: string
  description: string
  origin: string
  /** The size tier ("small", "large"…), '' when the run reported none. */
  size: string
  /** That tier's agent guideline; 0 for none. */
  sizeAgents: number
  /** The token budget the run draws on; 0 for none. */
  budgetTokens: number
  status: RunStatus
  /** Only while paused: the checkpoint it waits at and the question asked. */
  pausedAt: { checkpointId: string; message: string } | null
  /** Only when stopped: why ('' when the CLI gave no reason). */
  stoppedReason: string
  /**
   * This card was closed because a later turn continued the run on a new
   * card. Its state stays as the earlier turn left it — usually `paused` —
   * but it is superseded, not waiting, and must say so rather than spin.
   */
  continued: boolean
  /** The card that took over, when the CLI named it ('' otherwise). */
  continuedIn: string
  /** The card this one took over from ('' for a run's first card). */
  continuedFrom: string
  /** "12 agents · 1 failed · 0 replayed" (or a failure's error), '' while live. */
  summary: string
  phases: WorkflowPhase[]
  logs: string[]
  /** Log lines the CLI trimmed off the front of the tail it keeps. */
  droppedLogLines: number
  counts: OrchCounts
  /** The CLI's own text tree, kept as a raw fallback. */
  rendered: string
  /** The `workflow` tool call that submitted the script, when we could match
   *  one to this run. Null for a run whose script call never reached us. */
  script: WorkflowScript | null
  /** Where the run's state was read from. */
  source: 'meta' | 'text'
}

/** A row of the folded transcript. */
export type TranscriptRow =
  | { kind: 'item'; id: string; item: TranscriptItem }
  | { kind: 'agent'; id: string; member: MemberCall }
  | { kind: 'run'; id: string; run: WorkflowRun }
  /** A `workflow` tool call that started no run — the only surviving trace of
   *  a workflow that failed before its first agent. It carries `item` as well,
   *  so a renderer that has not learned this kind yet degrades to the ordinary
   *  tool row instead of dropping the row on the floor. */
  | { kind: 'script'; id: string; script: WorkflowScript; item: TranscriptItem }

// ---------------------------------------------------------------------------
// JSON accessors
// ---------------------------------------------------------------------------

type Args = { [key: string]: JSONValue } | null

function asObject(value: JSONValue | undefined): Args {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null
}

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

function argArray(args: Args, key: string): JSONValue[] {
  if (args === null) return []
  const value = args[key]
  return Array.isArray(value) ? value : []
}

/** The `phases` array the start payload publishes up front, so a host can
 *  draw the whole plan before the first agent runs. Tolerates the degenerate
 *  `["Review", …]` form as well as the `[{title, detail}]` one. */
function argPhases(args: Args): { title: string; detail: string }[] {
  const out: { title: string; detail: string }[] = []
  for (const entry of argArray(args, 'phases')) {
    if (typeof entry === 'string') {
      if (entry !== '') out.push({ title: entry, detail: '' })
      continue
    }
    const phase = asObject(entry)
    const title = argStr(phase, 'title')
    if (title !== '') out.push({ title, detail: argStr(phase, 'detail') })
  }
  return out
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** `pending`/`in_progress`/`unknown` → running, `failed` → failed, else done. */
function toolStatus(tool: Pick<ToolCallItem, 'status'>): 'running' | 'done' | 'failed' {
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
 * The `workflow` TOOL call, as opposed to the lifecycle card of the run it
 * starts. Both are titled `workflow …`, so they are told apart by what the
 * arguments carry: an invocation carries the program (`script`, `save_as`,
 * `args`, `max_concurrency`) and knows nothing about a run yet, while the
 * card carries `run_id` and `workflow`. Checking for the absence of those
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
    argStr(args, 'name') !== '' ||
    argStr(args, 'continue_run_id') !== ''
  )
}

/**
 * The id the CLI gives a run's card (internal/acp/workflow.go cardID):
 * `workflow-<run id>` for the first card, `workflow-<run id>-<n>` for the n-th
 * a later turn opened to continue it. A run with no id gets `wf-<n>`, which an
 * older CLI also used for every card. Run ids are `wf_<time>_<hex>`, so the
 * trailing `-<n>` can never be part of one.
 */
const CARD_ID_RE = /^workflow-(.+?)(?:-(\d+))?$/
const LEGACY_CARD_ID_RE = /^wf-\d+$/

function runIdFromCardId(id: string): string {
  return CARD_ID_RE.exec(id)?.[1] ?? ''
}

/** A card a later turn opened to continue a run (attach 2 and on). */
function isContinuingCard(tool: ToolCallItem, meta: CardState | null): boolean {
  if (meta !== null && meta.continuedFrom !== '') return true
  return CARD_ID_RE.exec(tool.id)?.[2] !== undefined
}

/**
 * The lifecycle card. Recognised by its metadata when it has some, by its id
 * when that has the card shape, and — for an older CLI — by args carrying
 * `workflow` but no `agent`.
 *
 * A progress trace (`workflow X ▸ Phase`, `workflow X · log`,
 * `workflow X ⏸ cp-1`) is consumed inside the CLI and normally never reaches
 * us — but when one does escape (its run's card was not open in that turn) it
 * arrives as an ordinary `call-N` row, and it must not be mistaken for a new
 * run: a checkpoint trace carries `workflow` and no `agent`, exactly like a
 * card, and used to open a phantom run of its own.
 */
function isWorkflowTool(tool: ToolCallItem, name: string, args: Args): boolean {
  if (asObject(tool.workflow) !== null) return true
  if (escapedTrace(tool, name, args)) return false
  if (CARD_ID_RE.test(tool.id) || LEGACY_CARD_ID_RE.test(tool.id)) return true
  if (args !== null) {
    if (argStr(args, 'workflow') !== '' && argStr(args, 'agent') === '') return true
    if (argStr(args, 'workflow') !== '') return false
  }
  return name === 'workflow' || name.startsWith('workflow ')
}

function escapedTrace(tool: ToolCallItem, name: string, args: Args): boolean {
  if (name.startsWith('workflow-progress')) return true
  if (argStr(args, 'kind') !== '' || argStr(args, 'checkpoint_id') !== '') return true
  return tool.title.includes('⏸') || tool.title.includes(' ▸ ') || tool.title.includes(' · log')
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

function countMembers(members: MemberCall[]): OrchCounts {
  const counts: OrchCounts = {
    total: members.length,
    running: 0,
    done: 0,
    failed: 0,
    pending: 0,
    stopped: 0,
    cached: 0
  }
  for (const member of members) {
    counts[member.status] += 1
    if (member.cached) counts.cached += 1
  }
  return counts
}

// ---------------------------------------------------------------------------
// The card's state, from either source
// ---------------------------------------------------------------------------

/** One member as the card itself lists it. */
interface DeclaredMember {
  instance: string
  task: string
  phase: string
  status: OrchStatus
  replayed: boolean
}

/** What a card says about its run — from the meta or from the text. */
interface CardState {
  runId: string
  name: string
  description: string
  size: string
  sizeAgents: number
  budgetTokens: number
  /** The CLI's lifecycle word: running, paused, stopped, success, failed,
   *  cancelled, or one this code does not know ('' when unstated). */
  status: string
  pausedAt: { checkpointId: string; message: string } | null
  stoppedReason: string
  continued: boolean
  continuedIn: string
  continuedFrom: string
  summary: string
  phases: { title: string; detail: string; dynamic: boolean }[]
  /** null when the source lists no members at all (an older text format),
   *  so the member calls themselves are the only record. */
  members: DeclaredMember[] | null
  logs: string[]
  droppedLogLines: number
}

const META_MEMBER_STATUS: Record<string, OrchStatus> = {
  running: 'running',
  done: 'done',
  failed: 'failed',
  pending: 'pending'
}

/**
 * Reads `_meta["spettro.app/workflow"]` (version 1). Every field is checked:
 * a newer CLI may add fields, and a malformed one must degrade to the text
 * path rather than throw — a blank chat is a worse failure than a card
 * drawn from text.
 */
export function parseWorkflowMeta(value: JSONValue | undefined): CardState | null {
  const meta = asObject(value)
  if (meta === null) return null
  const version = argNum(meta, 'version')
  // A version this code was not written for may mean fields it would
  // misread; the text is still there.
  if (version !== null && version > 1) return null

  const phases = argArray(meta, 'phases').flatMap((entry) => {
    const phase = asObject(entry)
    if (phase === null) return []
    return [{ title: argStr(phase, 'title'), detail: argStr(phase, 'detail'), dynamic: argBool(phase, 'dynamic') }]
  })
  const members = argArray(meta, 'members').flatMap((entry): DeclaredMember[] => {
    const member = asObject(entry)
    const instance = argStr(member, 'instance')
    if (member === null || instance === '') return []
    return [
      {
        instance,
        task: argStr(member, 'task'),
        phase: argStr(member, 'phase'),
        // "an unknown member status is pending" (docs/acp.md).
        status: META_MEMBER_STATUS[argStr(member, 'status')] ?? 'pending',
        replayed: argBool(member, 'replayed')
      }
    ]
  })
  const paused = asObject(meta['pausedAt'])
  const logs = argArray(meta, 'logTail').filter((line): line is string => typeof line === 'string')
  const continuedIn = argStr(meta, 'continuedIn')
  return {
    runId: argStr(meta, 'runId'),
    name: argStr(meta, 'name'),
    description: argStr(meta, 'description'),
    size: argStr(meta, 'size'),
    sizeAgents: Math.max(0, argNum(meta, 'sizeAgents') ?? 0),
    budgetTokens: Math.max(0, argNum(meta, 'budgetTokens') ?? 0),
    status: argStr(meta, 'status'),
    pausedAt:
      paused === null
        ? null
        : { checkpointId: argStr(paused, 'checkpointId'), message: argStr(paused, 'message') },
    stoppedReason: argStr(meta, 'stoppedReason'),
    continued: continuedIn !== '',
    continuedIn,
    continuedFrom: argStr(meta, 'continuedFrom'),
    summary: argStr(meta, 'summary'),
    phases,
    members,
    logs,
    droppedLogLines: Math.max(0, argNum(meta, 'droppedLogLines') ?? 0)
  }
}

// ---------------------------------------------------------------------------
// The CLI's rendered tree, read back
// ---------------------------------------------------------------------------

/** `"12 agents · 1 failed · 0 replayed"` — the finish output of
 *  workflowObserver.finish(). A run that failed sends the error text instead. */
const SUMMARY_RE = /^\d+ agents? · \d+ failed · \d+ replayed$/

/** The prefix the CLI puts on a card a later turn took over
 *  (takeWorkflowLocked). */
const CONTINUED_PREFIX = 'continued in a later turn'

/** `size: large (~30 agents, a guideline) · budget 500k tokens`. */
const SIZE_RE = /^size: (\S+) \((?:~(\d+) agents, a guideline|no guideline)\)(?: · budget (\S+) tokens)?$/

/** `⏸ paused at cp-1 — waiting for orchestrator: fix which?`; the
 *  checkpoint and the message are each optional. */
const PAUSED_RE = /^⏸ (?:paused at (.+?) — )?waiting for orchestrator(?:: ([\s\S]*))?$/

/** `■ stopped: at the orchestrator's request`; the reason is optional. */
const STOPPED_RE = /^■ stopped(?:: ([\s\S]*))?$/

/** A status the CLI does not name, shown as is on a card that stays open. */
const STATUS_RE = /^status: (.+)$/

/** `▸ Scan (added at runtime) — 2/3 done, 1 failed` / `○ Fix — pending`. */
const PHASE_RE = /^([▸○]) (.*) — (?:pending|\d+\/\d+ done(?:, \d+ failed)?)$/
const RUNTIME_SUFFIX = ' (added at runtime)'

/** `    ↳ find candidates` */
const DETAIL_RE = /^ {4}↳ (.*)$/

/** `    ✓ gp#1  replayed · scan a` — two spaces between instance and label
 *  (workflow_test.go wfMemberLine is the CLI's own reading of it). */
const MEMBER_RE = /^ {4}([✓✗▶·]) (\S+) {2}(replayed · )?(.*)$/

const GLYPH_STATUS: Record<string, OrchStatus> = {
  '✓': 'done',
  '✗': 'failed',
  '▶': 'running',
  '·': 'pending'
}

/** `500k`, `1.5m`, `950` — compactTokens() in workflow.go, read back. */
export function parseCompactTokens(text: string): number {
  const match = /^(\d+(?:\.\d+)?)([km]?)$/.exec(text.trim().toLowerCase())
  if (match === null) return 0
  const n = Number(match[1])
  const scale = match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1
  return Math.round(n * scale)
}

export interface RenderedWorkflow {
  continued: boolean
  summary: string
  description: string
  size: string
  sizeAgents: number
  budgetTokens: number
  /** 'paused' | 'stopped' | an unnamed status | '' (running or finished). */
  status: string
  pausedAt: { checkpointId: string; message: string } | null
  stoppedReason: string
  phases: { title: string; detail: string; dynamic: boolean }[]
  /** Empty for a tree that lists no members (or no tree). */
  members: DeclaredMember[]
  logs: string[]
  droppedLogLines: number
}

/**
 * Recovers the run from the text the CLI rendered into the card
 * (acpWorkflow.render in internal/acp/workflow.go, plus what the finish and
 * the continue put in front of it). The format is:
 *
 *     continued in a later turn            <- only on a card a later turn took over
 *                                          <- blank line
 *     12 agents · 1 failed · 0 replayed    <- only once finished (the error, if it failed)
 *                                          <- blank line
 *     <description>                        <- only when the script set one
 *                                          <- blank line
 *     size: large (~30 agents, a guideline) · budget 500k tokens
 *                                          <- blank line
 *     ⏸ paused at cp-1 — waiting for orchestrator: fix which?
 *       (or ■ stopped: <reason>, or status: <unnamed>)
 *                                          <- blank line
 *     ▸ Review — 2/3 done, 1 failed
 *         ↳ one agent per dimension
 *         ✓ review#1  label text
 *         · review#4  replayed · label text
 *     ○ Verify (added at runtime) — pending
 *                                          <- blank line
 *     log:
 *       … 12 earlier lines
 *       a log line
 *
 * A parse failure degrades to empty — a missing description is a cosmetic
 * loss, a thrown exception is a blank chat.
 */
export function parseRenderedWorkflow(output: string, failed: boolean): RenderedWorkflow {
  const empty: RenderedWorkflow = {
    continued: false,
    summary: '',
    description: '',
    size: '',
    sizeAgents: 0,
    budgetTokens: 0,
    status: '',
    pausedAt: null,
    stoppedReason: '',
    phases: [],
    members: [],
    logs: [],
    droppedLogLines: 0
  }
  try {
    let text = output.replace(/\r\n/g, '\n').trim()
    if (text === '') return empty
    const out = { ...empty }
    if (text === CONTINUED_PREFIX || text.startsWith(`${CONTINUED_PREFIX}\n`)) {
      out.continued = true
      text = text.slice(CONTINUED_PREFIX.length).trim()
    }
    const lines = text.split('\n')

    // The log block runs to the end of the output.
    let end = lines.length
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== 'log:') continue
      end = i
      for (let j = i + 1; j < lines.length; j++) {
        const entry = lines[j].trim()
        if (entry === '') continue
        const dropped = /^… (\d+) earlier lines?$/.exec(entry)
        if (dropped !== null && out.logs.length === 0) {
          out.droppedLogLines = Number(dropped[1])
          continue
        }
        out.logs.push(entry)
      }
      break
    }

    // The head and the tree are blank-line-separated blocks, so the tree is
    // found as a block rather than by hunting for the first glyph anywhere in
    // the output. A description is free prose the script author wrote, and
    // prose that happens to contain a line starting with "▸" would otherwise
    // invent a phase out of nothing *and* truncate the description at that
    // line. Matching a whole block — every line of it a phase header, a
    // detail line or a member row — cannot be fooled by one stray character.
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

    const isTreeLine = (line: string): boolean =>
      PHASE_RE.test(line) || DETAIL_RE.test(line) || MEMBER_RE.test(line)
    const isTreeBlock = (block: { lines: string[] }): boolean =>
      block.lines.some((line) => PHASE_RE.test(line)) && block.lines.every(isTreeLine)

    // The last qualifying block, not the first: the tree is always the final
    // thing before the log, and taking the last one means an earlier false
    // positive loses to the real thing.
    let treeIndex = blocks.length
    for (let b = blocks.length - 1; b >= 0; b--) {
      if (isTreeBlock(blocks[b])) {
        treeIndex = b
        break
      }
    }
    if (treeIndex < blocks.length) {
      let phase: { title: string; detail: string; dynamic: boolean } | null = null
      for (const line of blocks[treeIndex].lines) {
        const header = PHASE_RE.exec(line)
        if (header !== null) {
          let title = header[2]
          const dynamic = title.endsWith(RUNTIME_SUFFIX)
          if (dynamic) title = title.slice(0, -RUNTIME_SUFFIX.length)
          if (title === '(no phase)') title = ''
          phase = { title, detail: '', dynamic }
          out.phases.push(phase)
          continue
        }
        const detail = DETAIL_RE.exec(line)
        if (detail !== null) {
          if (phase !== null) phase.detail = detail[1]
          continue
        }
        const member = MEMBER_RE.exec(line)
        if (member !== null) {
          out.members.push({
            instance: member[2],
            task: member[4],
            phase: phase?.title ?? '',
            status: GLYPH_STATUS[member[1]] ?? 'pending',
            replayed: member[3] !== undefined
          })
        }
      }
    }

    // Everything before the tree is the head: the finish summary (or, on a
    // failed run, the error), the description, the size line and the state
    // line. The CLI writes them in that order, so the fixed-format lines are
    // taken off the END of the head and the summary off the front; whatever
    // is left is the description, which is free prose and can contain
    // anything — including blank lines.
    const head = blocks.slice(0, treeIndex).map((block) => block.lines.join('\n').trim())
    const last = (): string => head[head.length - 1] ?? ''
    const paused = PAUSED_RE.exec(last())
    const stopped = STOPPED_RE.exec(last())
    const unnamed = STATUS_RE.exec(last())
    if (paused !== null) {
      out.status = 'paused'
      out.pausedAt = { checkpointId: paused[1] ?? '', message: (paused[2] ?? '').trim() }
      head.pop()
    } else if (stopped !== null) {
      out.status = 'stopped'
      out.stoppedReason = (stopped[1] ?? '').trim()
      head.pop()
    } else if (unnamed !== null) {
      out.status = unnamed[1].trim()
      head.pop()
    }
    const size = SIZE_RE.exec(last())
    if (size !== null) {
      out.size = size[1]
      out.sizeAgents = size[2] !== undefined ? Number(size[2]) : 0
      out.budgetTokens = size[3] !== undefined ? parseCompactTokens(size[3]) : 0
      head.pop()
    }
    if (head.length > 0 && (SUMMARY_RE.test(head[0]) || failed)) {
      out.summary = head.shift() ?? ''
    }
    out.description = head.join(' ').split('\n').join(' ').trim()
    return out
  } catch {
    return empty
  }
}

/** The card's state from its text (and start args, which win where both
 *  speak): the path for an older CLI and an older saved session. */
function textState(tool: ToolCallItem, args: Args, name: string): CardState {
  const text = parseRenderedWorkflow(tool.output, tool.status === 'failed')

  // Structured args win; the text fills what they do not say. A phase the
  // script entered at runtime is only ever in the text, so the text's order
  // is kept for those, after the declared ones.
  const phases: CardState['phases'] = []
  const textPhase = new Map(text.phases.map((phase) => [phase.title, phase]))
  for (const declared of argPhases(args)) {
    if (phases.some((phase) => phase.title === declared.title)) continue
    phases.push({
      title: declared.title,
      detail: declared.detail !== '' ? declared.detail : (textPhase.get(declared.title)?.detail ?? ''),
      dynamic: false
    })
  }
  for (const phase of text.phases) {
    if (!phases.some((known) => known.title === phase.title)) phases.push(phase)
  }

  const size = argStr(args, 'size')
  const declaredDescription = argStr(args, 'description')
  const runId = argStr(args, 'run_id') !== '' ? argStr(args, 'run_id') : runIdFromCardId(tool.id)
  return {
    runId,
    name,
    description: declaredDescription !== '' ? declaredDescription : text.description,
    size: size !== '' ? size : text.size,
    sizeAgents: size !== '' ? Math.max(0, argNum(args, 'size_agents') ?? 0) : text.sizeAgents,
    budgetTokens: Math.max(0, argNum(args, 'budget_tokens') ?? 0) || text.budgetTokens,
    status: text.status,
    pausedAt: text.pausedAt,
    stoppedReason: text.stoppedReason,
    continued: text.continued,
    continuedIn: '',
    continuedFrom: '',
    summary: text.summary,
    phases,
    members: text.members.length > 0 ? text.members : null,
    logs: text.logs,
    droppedLogLines: text.droppedLogLines
  }
}

/**
 * The run's name. The card's title is `workflow <name>[ · <size>][ · budget
 * <n>]` (acpWorkflow.title), so the title is only a source once those
 * suffixes are off it — a card re-announced in a later turn carries no args
 * to name it otherwise.
 */
export function nameFromTitle(title: string): string {
  let text = title.trim()
  if (text.startsWith('[')) {
    const close = text.indexOf(']')
    if (close >= 0) text = text.slice(close + 1).trim()
  }
  if (text === 'workflow') return ''
  if (text.startsWith('workflow ')) text = text.slice('workflow '.length)
  const parts = text.split(' · ')
  while (parts.length > 1) {
    const tail = parts[parts.length - 1]
    if (!/^budget \S+$/.test(tail) && !/^[a-z]+$/.test(tail)) break
    parts.pop()
  }
  return parts.join(' · ').trim()
}

/** A run's display state from the CLI's lifecycle word and the card's own
 *  ACP status — which settles it whenever the two disagree, because it is
 *  the one every client is guaranteed to have. */
function runStatus(state: CardState, tool: ToolCallItem): {
  status: RunStatus
  stoppedReason: string
} {
  const closed = toolStatus(tool)
  switch (state.status) {
    case 'paused':
      // A paused card stays in progress; one that was closed with the pause
      // still showing is a continued card, which keeps saying it paused.
      return { status: closed === 'failed' ? 'failed' : 'paused', stoppedReason: '' }
    case 'stopped':
      return { status: 'stopped', stoppedReason: state.stoppedReason }
    case 'cancelled':
    case 'canceled':
      // The CLI closes a cancelled run as failed, but nothing went wrong in
      // it: the user (or the session) ended it.
      return { status: 'stopped', stoppedReason: state.stoppedReason || 'cancelled' }
  }
  if (closed === 'failed') return { status: 'failed', stoppedReason: '' }
  if (closed === 'done') return { status: 'done', stoppedReason: '' }
  return { status: 'running', stoppedReason: '' }
}

// ---------------------------------------------------------------------------
// The `workflow` tool call, read back
// ---------------------------------------------------------------------------

/**
 * The block the tool answers with (internal/agent/workflow_trace.go
 * renderWorkflowResult):
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
    runId: runId !== '' ? runId : argStr(args, 'continue_run_id'),
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
  tool: ToolCallItem
  args: Args
  name: string
  runId: string
  meta: CardState | null
  /** The member calls routed to this card as they arrived. */
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
 * A member the card lists whose own call is not in this transcript (a chat
 * reloaded from disk mid-run, or a card that carried members over from a
 * turn this one never saw). It still gets a row — the card says it exists —
 * with nothing to expand.
 */
function standInMember(card: ToolCallItem, declared: DeclaredMember): MemberCall {
  const hash = declared.instance.indexOf('#')
  return {
    tool: {
      id: `${card.id}:${declared.instance}`,
      title: `agent ${declared.instance}: ${declared.task}`,
      kind: 'think',
      status:
        declared.status === 'done'
          ? 'completed'
          : declared.status === 'failed'
            ? 'failed'
            : 'in_progress',
      output: '',
      diffs: [],
      locations: [],
      timestamp: card.timestamp
    },
    instance: declared.instance,
    specId: hash > 0 ? declared.instance.slice(0, hash) : declared.instance,
    index: null,
    task: declared.task,
    phase: declared.phase,
    cached: declared.replayed,
    status: declared.status,
    children: [],
    result: null,
    resultText: '',
    resultIsJSON: false
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

/**
 * The card's member list: the ones its own state names, in its order, each
 * matched to its call by instance across the whole run (a continued card
 * lists members an earlier card's turn dispatched), and then any call routed
 * here that the state does not mention yet. The card's word on a member's
 * status wins — it is the run's view of it, and a continued card must show
 * the run as its turn left it.
 */
function cardMembers(build: RunBuild, state: CardState, pool: Map<string, MemberCall>): MemberCall[] {
  if (state.members === null) return build.members
  const out: MemberCall[] = []
  const listed = new Set<string>()
  for (const declared of state.members) {
    if (listed.has(declared.instance)) continue
    listed.add(declared.instance)
    const call = pool.get(declared.instance)
    out.push(
      call
        ? {
            ...call,
            phase: declared.phase,
            cached: call.cached || declared.replayed,
            status: call.status === 'failed' ? 'failed' : declared.status,
            task: call.task !== '' ? call.task : declared.task
          }
        : standInMember(build.tool, declared)
    )
  }
  for (const member of build.members) {
    if (!listed.has(member.instance)) out.push(member)
  }
  return out
}

/**
 * Which member pool a run's card reads. Every card of one run shares its run
 * id's pool; a run with no id (`wf-<n>`, and every card of an older CLI) gets
 * a pool of its own, because the empty id is not one run — pooling them all
 * under it would hand one run's `code#1` to every other run's card.
 */
function poolKey(runId: string, build: RunBuild): string {
  return runId !== '' ? runId : `card:${build.tool.id}`
}

function finishWorkflow(build: RunBuild, pools: Map<string, Map<string, MemberCall>>): WorkflowRun {
  const tool = build.tool
  const state = build.meta ?? textState(tool, build.args, build.name)
  const pool = pools.get(poolKey(state.runId !== '' ? state.runId : build.runId, build)) ?? new Map()
  const { status, stoppedReason } = runStatus(state, tool)
  // A run that has ended has nobody still working in it. A member the card
  // last listed as running was cut off with it — a cancelled turn closes the
  // card without a word about its members — so it is settled as stopped
  // rather than left spinning under a finished run forever.
  const ended = status === 'done' || status === 'failed' || status === 'stopped'
  const members = cardMembers(build, state, pool).map((member) =>
    ended && member.status === 'running' ? { ...member, status: 'stopped' as const } : member
  )

  // Phases in the card's order; then phases only a member names; then the
  // unnamed bucket, which always trails and only exists when it holds
  // someone. The meta already lists them so — this keeps the text path and
  // the bare-calls path drawing the same tree.
  const order: { title: string; detail: string; dynamic: boolean }[] = []
  const seen = new Set<string>()
  for (const phase of state.phases) {
    if (phase.title === '' || seen.has(phase.title)) continue
    seen.add(phase.title)
    order.push(phase)
  }
  for (const member of members) {
    if (member.phase === '' || seen.has(member.phase)) continue
    seen.add(member.phase)
    order.push({ title: member.phase, detail: '', dynamic: false })
  }
  const phases: WorkflowPhase[] = order.map((phase) => {
    const inPhase = members.filter((member) => member.phase === phase.title)
    return { ...phase, members: inPhase, counts: countMembers(inPhase) }
  })
  const loose = members.filter((member) => member.phase === '')
  if (loose.length > 0) {
    phases.push({ title: '', detail: '', dynamic: false, members: loose, counts: countMembers(loose) })
  }

  return {
    tool,
    runId: state.runId !== '' ? state.runId : build.runId,
    name: state.name !== '' ? state.name : build.name,
    description: state.description !== '' ? state.description : argStr(build.args, 'description'),
    origin: argStr(build.args, 'origin'),
    size: state.size,
    sizeAgents: state.sizeAgents,
    budgetTokens: state.budgetTokens,
    status,
    pausedAt: status === 'paused' ? (state.pausedAt ?? { checkpointId: '', message: '' }) : null,
    stoppedReason,
    continued: state.continued,
    continuedIn: state.continuedIn,
    continuedFrom: state.continuedFrom,
    summary: status === 'done' || status === 'failed' ? state.summary : '',
    phases,
    logs: state.logs,
    droppedLogLines: state.droppedLogLines,
    counts: countMembers(members),
    rendered: tool.output.trim(),
    script: build.script,
    source: build.meta !== null ? 'meta' : 'text'
  }
}

/**
 * Finds the script call a lifecycle card belongs to and marks it taken.
 *
 * `run_id` is the honest link and is used whenever the `<workflow_result>`
 * block carried one. The fallback is positional and safe because a script
 * call is the thing that *starts* a run, so it can only ever precede its own
 * lifecycle card, and the nearest unclaimed one above is the only candidate.
 * Earlier unclaimed calls are left alone — they are failed attempts, and
 * stealing one into this run would hide it.
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
 * Folds a flat transcript into rows: workflow runs absorb their members,
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
  // Every workflow member call, by run id and then instance: a card a later
  // turn opened lists members an earlier card's turn dispatched.
  const pools = new Map<string, Map<string, MemberCall>>()
  // Script calls seen so far, oldest first, with the ones already claimed by a
  // run marked. Whatever is still unclaimed at the end started no run and
  // becomes a row of its own.
  const scripts: { script: WorkflowScript; claimed: boolean }[] = []
  const scriptByRunId = new Map<string, { script: WorkflowScript; claimed: boolean }>()
  // `workflow {"continue_run_id": …}` calls: the model answering a paused
  // run's checkpoint (or stopping it). The run's card already shows what that
  // did, so one that went through folds away; one that was refused is the
  // only place the refusal is said, and keeps a row.
  const replies: WorkflowScript[] = []
  let lastWorkflow: RunBuild | null = null
  let openWorkflow: RunBuild | null = null

  // Pass 1 — index.
  for (const item of items) {
    if (item.kind !== 'tool') continue
    const tool = item.tool
    const { agent: prefix, name, args } = parsedTitle(tool)

    if (isWorkflowScriptTool(name, args)) {
      const script = newScript(tool, args)
      if (argStr(args, 'continue_run_id') !== '') {
        replies.push(script)
        continue
      }
      const entry = { script, claimed: false }
      scripts.push(entry)
      if (script.runId !== '' && !scriptByRunId.has(script.runId)) {
        scriptByRunId.set(script.runId, entry)
      }
      continue
    }

    if (isWorkflowTool(tool, name, args)) {
      const meta = parseWorkflowMeta(tool.workflow)
      const runId =
        meta?.runId || argStr(args, 'run_id') || runIdFromCardId(tool.id)
      const build: RunBuild = {
        tool,
        args,
        name: meta?.name || argStr(args, 'workflow') || nameFromTitle(tool.title),
        runId,
        meta,
        members: [],
        // Only a run's first card claims its script: a card a later turn
        // opened continues a program that an earlier card already shows.
        script: isContinuingCard(tool, meta) ? null : claimScript(scripts, scriptByRunId, runId)
      }
      builds.set(tool.id, build)
      if (runId !== '') byRunId.set(runId, build)
      lastWorkflow = build
      if (toolStatus(tool) === 'running') openWorkflow = build
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

    let run: RunBuild | null = null
    if (argStr(args, 'workflow') !== '' && member.instance !== '') {
      const runId = argStr(args, 'run_id')
      run = (runId !== '' ? byRunId.get(runId) : undefined) ?? openWorkflow ?? lastWorkflow
      if (run) {
        const key = poolKey(runId !== '' ? runId : run.runId, run)
        let pool = pools.get(key)
        if (!pool) pools.set(key, (pool = new Map()))
        pool.set(member.instance, member)
      }
    }
    if (run) {
      run.members.push(member)
      absorbed.add(transcriptItemId(item))
    } else {
      standalone.set(tool.id, member)
    }
  }

  // Finalise each run once, now that every member has landed.
  const runs = new Map<string, WorkflowRun>()
  for (const [id, build] of builds) runs.set(id, finishWorkflow(build, pools))

  // A script call that found a run is now part of that run's card; one that
  // did not is a workflow that never began, and dropping it would erase the
  // only evidence it was ever attempted.
  const orphans = new Map<string, WorkflowScript>()
  const claimed = new Set<string>()
  for (const entry of scripts) {
    if (entry.claimed) claimed.add(entry.script.tool.id)
    else orphans.set(entry.script.tool.id, entry.script)
  }
  for (const reply of replies) {
    if (reply.status !== 'failed' && byRunId.has(reply.runId)) claimed.add(reply.tool.id)
    else orphans.set(reply.tool.id, reply)
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

/** Runs still working, in transcript order — what the live panel shows. A
 *  paused run is waiting on the model, not working, and a continued card has
 *  handed the run on to its successor. */
export function activeRuns(rows: TranscriptRow[]): WorkflowRun[] {
  const out: WorkflowRun[] = []
  for (const row of rows) {
    if (row.kind === 'run' && row.run.status === 'running' && !row.run.continued) out.push(row.run)
  }
  return out
}

/** Display title: "review-changes". */
export function runTitle(run: WorkflowRun): string {
  return run.name === '' ? 'workflow' : run.name
}

/** "Large · ~30 agents" — the size tier in plain words, '' when the run
 *  reported none. */
export function sizeLabel(run: Pick<WorkflowRun, 'size' | 'sizeAgents'>): string {
  if (run.size === '') return ''
  const tier = run.size.charAt(0).toUpperCase() + run.size.slice(1)
  return run.sizeAgents > 0 ? `${tier} · ~${run.sizeAgents} agents` : `${tier} · no agent limit`
}

/**
 * Per-member tint. The TUI looks the spec up in the agent manifest and uses
 * its declared colour; the renderer has no manifest, so it maps the spec id
 * itself through the same palette — "code" lands on the same green either way,
 * and anything unknown falls back to the sub-agent colour rather than going
 * untinted. (Not the accent itself: an accent dot sits next to the failure red, and
 * a running member must never read as a failed one.)
 */
export function memberTint(specId: string): string {
  return modeColor(specId, 'var(--agent-accent)')
}

/**
 * A workflow's failure in one plain sentence, for a card whose run died before
 * any member could carry the reason — a script that would not parse, a saved
 * workflow that is not there. The CLI's text is `error: workflow "x": script
 * does not parse: SyntaxError: (anonymous): Line 35:177 Unexpected token )`,
 * which is accurate and unreadable; the cases worth a sentence get one, and
 * anything else is shown with its plumbing ("error: workflow …:") taken off.
 * '' for an empty input. The caller keeps the full text for a tooltip.
 */
export function plainWorkflowError(raw: string): string {
  const first = raw.trim().split('\n')[0]?.trim() ?? ''
  if (first === '') return ''
  if (/does not parse|SyntaxError/.test(first)) {
    const line = /\bline (\d+)/i.exec(first)
    return line === null
      ? 'The workflow script has a syntax error.'
      : `The workflow script has a syntax error (line ${line[1]}).`
  }
  const missing = /no saved workflow named "([^"]+)"/.exec(first)
  if (missing !== null) return `There’s no saved workflow named “${missing[1]}”.`
  const text = first
    .replace(/^error:\s*/i, '')
    .replace(/^workflow(?: "[^"]*")?:\s*/i, '')
    .trim()
  if (text === '') return ''
  return text.charAt(0).toUpperCase() + text.slice(1)
}

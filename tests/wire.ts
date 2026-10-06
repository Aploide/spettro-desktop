// Builders that produce transcript items shaped exactly the way the Go CLI
// puts them on the ACP wire.
//
// These are not conveniences — they are the specification the tests are
// written against, so each one records where its shape comes from. Getting a
// builder wrong makes every test using it agree with the wrong thing, which is
// precisely how the hand-written visual fixtures encoded a misreading of the
// CLI twice before a recording caught it. Anything asserted here that is not
// obvious from the Go source is called out in a comment naming the file.

import type { ToolCallItem, TranscriptItem } from '@shared/model'
import type { ACPToolStatus } from '@shared/acp'

let seq = 0

/** Resets the id counter so ids are stable within a test. */
export function resetWire(): void {
  seq = 0
}

export function tool(partial: Partial<ToolCallItem> & { title: string }): TranscriptItem {
  seq += 1
  return {
    kind: 'tool',
    tool: {
      id: `call-${seq}`,
      status: 'completed',
      output: '',
      diffs: [],
      locations: [],
      timestamp: 1_700_000_000_000 + seq * 1000,
      ...partial
    }
  }
}

export function message(role: 'user' | 'assistant', text: string): TranscriptItem {
  seq += 1
  return {
    kind: 'message',
    message: {
      id: `msg-${seq}`,
      role,
      text,
      attachments: [],
      isStreaming: false,
      timestamp: 1_700_000_000_000 + seq * 1000
    }
  }
}

/**
 * The workflow lifecycle card at `start`, as an older CLI sent it: no
 * `_meta`, an id `wf-N`.
 *
 * internal/agent/workflow_trace.go: the observer publishes the declared phase
 * list up front, from `meta`, so a host can draw the whole plan before the
 * first agent runs. For the card the current CLI sends, see workflowCard.
 */
export function workflowStart(o: {
  runId: string
  name: string
  description?: string
  phases?: { title: string; detail?: string }[]
  rendered?: string
}): TranscriptItem {
  const item = tool({
    title: `workflow ${o.name}`,
    kind: 'think',
    status: 'in_progress',
    argsJSON: JSON.stringify({
      run_id: o.runId,
      workflow: o.name,
      description: o.description ?? '',
      origin: 'inline',
      phases: (o.phases ?? []).map((p) => ({ title: p.title, detail: p.detail ?? '' }))
    }),
    output: o.rendered ?? ''
  })
  if (item.kind === 'tool') item.tool.id = `wf-${seq}`
  return item
}

/**
 * The SAME lifecycle call after it finishes, as recorded from an older CLI.
 *
 * This is the shape that makes the text fallback necessary:
 * `chatSession.applyToolEvent` overwrites `argsJSON` on every update carrying
 * rawInput, and that CLI's finish payload was `{run_id, workflow, agents,
 * failed, cached, tokens}` — no `phases`, no `description`. A run reloaded
 * from disk has only ever seen this version.
 */
export function workflowFinished(o: {
  id: string
  runId: string
  name: string
  agents: number
  failed?: number
  cached?: number
  rendered: string
  status?: ACPToolStatus
}): TranscriptItem {
  return {
    kind: 'tool',
    tool: {
      id: o.id,
      title: `workflow ${o.name}`,
      kind: 'think',
      status: o.status ?? 'completed',
      argsJSON: JSON.stringify({
        run_id: o.runId,
        workflow: o.name,
        agents: o.agents,
        failed: o.failed ?? 0,
        // Note the type: a count here, a bool on a member trace. Decoding both
        // into one struct is what broke the CLI's own finish path.
        cached: o.cached ?? 0,
        tokens: 1234
      }),
      output: o.rendered,
      diffs: [],
      locations: [],
      timestamp: 1_700_000_000_000
    }
  }
}

/** A workflow member's `agent` call (internal/agent/workflow_trace.go). */
export function member(o: {
  instance: string
  task: string
  runId: string
  workflow: string
  phase?: string
  index?: number
  cached?: boolean
  status?: ACPToolStatus
  output?: string
}): TranscriptItem {
  return tool({
    title: `agent ${o.instance}: ${o.task}`,
    kind: 'think',
    status: o.status ?? 'in_progress',
    argsJSON: JSON.stringify({
      agent: o.instance,
      task: o.task,
      parent_agent_id: 'coding',
      workflow: o.workflow,
      run_id: o.runId,
      phase: o.phase ?? '',
      index: o.index ?? 1,
      cached: o.cached ?? false
    }),
    output: o.output ?? ''
  })
}

/**
 * The model's invocation of the `workflow` TOOL — the script, not the run.
 *
 * Confirmed from a recorded session: this arrives as an ordinary tool call
 * titled `workflow {…}` whose rawInput carries the whole program, and whose
 * output is the `<workflow_result>` block. It is a separate call from the
 * `wf-` lifecycle trace and lands just before it.
 */
export function scriptCall(o: {
  script: string
  savedAs?: string
  runId?: string
  returned?: string
  status?: ACPToolStatus
  error?: string
}): TranscriptItem {
  const output =
    o.error !== undefined
      ? o.error
      : [
          `<workflow_result name="${o.savedAs ?? ''}" run_id="${o.runId ?? ''}">`,
          '<summary>3 agents · 0 failed · 0 replayed from journal · 100 tokens</summary>',
          '<returned>',
          o.returned ?? 'ok',
          '</returned>',
          '</workflow_result>',
          'Script: inline · transcript: /tmp/x'
        ].join('\n')
  return tool({
    title: `workflow {"save_as": "${o.savedAs ?? ''}", "script": "export const meta = …`,
    kind: 'think',
    status: o.status ?? 'completed',
    argsJSON: JSON.stringify({
      script: o.script,
      save_as: o.savedAs ?? '',
      args: '{}',
      max_concurrency: 3
    }),
    output
  })
}

/**
 * A tool call made BY a sub-agent.
 *
 * internal/acp/tools.go finishTitle only brackets the instance onto the title
 * when the instance name contains '#' — so workflow members are attributable
 * and a plain delegation like `explore` is not. Verified against a recording:
 * `explore`'s own `ls` call arrives titled plainly `ls {…}`.
 */
export function childCall(instance: string, name: string, args: object): TranscriptItem {
  const prefix = instance.includes('#') ? `[${instance}] ` : ''
  return tool({
    title: `${prefix}${name} ${JSON.stringify(args)}`,
    kind: name === 'bash' ? 'execute' : 'read',
    argsJSON: JSON.stringify(args)
  })
}

/** A plain delegation — an `agent` call belonging to no run. */
export function delegation(o: {
  agent: string
  task: string
  status?: ACPToolStatus
  summary?: string
}): TranscriptItem {
  return tool({
    title: `agent ${o.agent}: ${o.task}`,
    kind: 'think',
    status: o.status ?? 'completed',
    argsJSON: JSON.stringify({ agent: o.agent, task: o.task, parent_agent_id: 'coding' }),
    output:
      o.summary === undefined
        ? ''
        : JSON.stringify({ agent: o.agent, status: 'ok', summary: o.summary })
  })
}

/** The CLI's own rendered phase tree (acpWorkflow.render), for the text
 *  recovery path. The format is stable and this mirrors it exactly. */
export function renderedTree(o: {
  summary?: string
  description?: string
  phases: { title: string; members?: { glyph: string; instance: string; label: string }[] }[]
  logs?: string[]
}): string {
  const lines: string[] = []
  if (o.summary) lines.push(o.summary, '')
  if (o.description) lines.push(o.description, '')
  for (const phase of o.phases) {
    if (!phase.members || phase.members.length === 0) {
      lines.push(`○ ${phase.title} — pending`)
      continue
    }
    const done = phase.members.filter((m) => m.glyph !== '▶').length
    lines.push(`▸ ${phase.title} — ${done}/${phase.members.length} done`)
    for (const m of phase.members) {
      lines.push(`    ${m.glyph} ${m.instance}  ${m.label}`)
    }
  }
  if (o.logs && o.logs.length > 0) {
    lines.push('', 'log:')
    for (const line of o.logs) lines.push(`  ${line}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// The workflow card the current CLI sends (internal/acp/workflow.go)
// ---------------------------------------------------------------------------

/** A member as acpWorkflow records it: the trace's own status word. */
export interface CardAgent {
  instance: string
  task: string
  phase?: string
  /** "running" | "success" | "error", or any word the runtime adds. */
  status: string
  cached?: boolean
}

/** The fields of acpWorkflow that render() and metaView() read. */
export interface CardRun {
  runId: string
  name: string
  description?: string
  size?: string
  sizeAgents?: number
  budget?: number
  /** "", "running", "paused", "stopped", "success", "error", or unnamed. */
  status?: string
  checkpointId?: string
  waiting?: string
  stopReason?: string
  /** Declared and phase()-noted phases, in addPhase order. */
  phases?: { title: string; detail?: string; dynamic?: boolean }[]
  agents?: CardAgent[]
  logs?: string[]
  dropped?: number
  attach?: number
  continuedFrom?: string
}

/** compactTokens (workflow.go): 500k, 1.5m. */
function compact(n: number): string {
  if (n >= 1_000_000) {
    const s = (n / 1e6).toFixed(2).replace(/0$/, '')
    return s.replace(/\.0$/, '') + 'm'
  }
  if (n >= 1_000) {
    const s = (n / 1e3).toFixed(1).replace(/0$/, '')
    return s.replace(/\.$/, '') + 'k'
  }
  return String(n)
}

/** acpWorkflow.title(). */
export function cardTitle(run: CardRun): string {
  let title = `workflow ${run.name}`
  if (run.size) title += ` · ${run.size}`
  if ((run.budget ?? 0) > 0) title += ` · budget ${compact(run.budget ?? 0)}`
  return title
}

interface PhaseView {
  title: string
  detail: string
  dynamic: boolean
  members: CardAgent[]
  finished: number
  failed: number
}

/** phaseOrder() + phaseViews(): declared phases, then undeclared ones a
 *  member named, then the "" bucket when anyone is in it. */
function phaseViews(run: CardRun): PhaseView[] {
  const declared = run.phases ?? []
  const order = declared.map((p) => p.title)
  let loose = false
  for (const a of run.agents ?? []) {
    if (!a.phase) loose = true
    else if (!order.includes(a.phase)) order.push(a.phase)
  }
  if (loose) order.push('')
  return order.map((title) => {
    const info = declared.find((p) => p.title === title)
    const members = (run.agents ?? []).filter((a) => (a.phase ?? '') === title)
    return {
      title,
      detail: info?.detail ?? '',
      dynamic: info?.dynamic ?? false,
      members,
      finished: members.filter((a) => a.status === 'success' || a.status === 'error').length,
      failed: members.filter((a) => a.status === 'error').length
    }
  })
}

function glyph(status: string): string {
  return status === 'success' ? '✓' : status === 'error' ? '✗' : status === 'running' ? '▶' : '·'
}

/** acpWorkflow.render(), line for line. */
export function renderCard(run: CardRun): string {
  let b = ''
  if (run.description) b += run.description + '\n\n'
  if (run.size) {
    b += (run.sizeAgents ?? 0) > 0
      ? `size: ${run.size} (~${run.sizeAgents} agents, a guideline)`
      : `size: ${run.size} (no guideline)`
    if ((run.budget ?? 0) > 0) b += ` · budget ${compact(run.budget ?? 0)} tokens`
    b += '\n\n'
  }
  switch (run.status ?? '') {
    case '':
    case 'running':
    case 'success':
    case 'error':
      break
    case 'stopped':
      b += '■ stopped' + (run.stopReason ? `: ${run.stopReason}` : '') + '\n\n'
      break
    case 'paused':
      b += '⏸ '
      if (run.checkpointId) b += `paused at ${run.checkpointId} — `
      b += 'waiting for orchestrator'
      if (run.waiting) b += `: ${run.waiting}`
      b += '\n\n'
      break
    default:
      b += `status: ${run.status}\n\n`
  }
  for (const p of phaseViews(run)) {
    let title = p.title === '' ? '(no phase)' : p.title
    if (p.dynamic) title += ' (added at runtime)'
    if (p.members.length === 0) b += `○ ${title} — pending\n`
    else {
      b += `▸ ${title} — ${p.finished}/${p.members.length} done`
      if (p.failed > 0) b += `, ${p.failed} failed`
      b += '\n'
    }
    if (p.detail) b += `    ↳ ${p.detail}\n`
    for (const a of p.members) {
      b += `    ${glyph(a.status)} ${a.instance}  ${a.cached ? 'replayed · ' : ''}${a.task}\n`
    }
  }
  if ((run.logs ?? []).length > 0) {
    b += '\nlog:\n'
    if ((run.dropped ?? 0) > 0) b += `  … ${run.dropped} earlier lines\n`
    for (const line of run.logs ?? []) b += `  ${line}\n`
  }
  return b.replace(/\n+$/, '')
}

/** workflowMetaStatus + metaView(): the `_meta["spettro.app/workflow"]`
 *  payload, from the same state renderCard reads. */
export function cardMeta(
  run: CardRun,
  extra: { continuedIn?: string; summary?: string } = {}
): JSON {
  const raw = run.status ?? ''
  const status =
    raw === '' || raw === 'running'
      ? 'running'
      : raw === 'error' || raw === 'failed'
        ? 'failed'
        : raw === 'cancelled' || raw === 'canceled'
          ? 'cancelled'
          : raw
  const meta: { [key: string]: JSON } = {
    version: 1,
    runId: run.runId,
    name: run.name,
    description: run.description ?? '',
    size: run.size ?? '',
    sizeAgents: run.sizeAgents ?? 0,
    budgetTokens: run.budget ?? 0,
    status,
    attach: run.attach ?? 1,
    phases: [],
    members: [],
    counts: { agents: 0, failed: 0, replayed: 0 },
    logTail: run.logs ?? [],
    droppedLogLines: run.dropped ?? 0
  }
  if (status === 'paused') {
    meta['pausedAt'] = { checkpointId: run.checkpointId ?? '', message: run.waiting ?? '' }
  }
  if (status === 'stopped') meta['stoppedReason'] = run.stopReason ?? ''
  if (run.continuedFrom) meta['continuedFrom'] = run.continuedFrom
  if (extra.continuedIn) meta['continuedIn'] = extra.continuedIn
  if (extra.summary) meta['summary'] = extra.summary
  const phases: JSON[] = []
  const members: JSON[] = []
  let agents = 0
  let failed = 0
  let replayed = 0
  for (const p of phaseViews(run)) {
    const phase: { [key: string]: JSON } = {
      title: p.title,
      dynamic: p.dynamic,
      done: p.finished,
      total: p.members.length,
      failed: p.failed
    }
    if (p.detail) phase['detail'] = p.detail
    phases.push(phase)
    for (const a of p.members) {
      members.push({
        instance: a.instance,
        task: a.task,
        phase: a.phase ?? '',
        status:
          a.status === 'success' ? 'done' : a.status === 'error' ? 'failed' : a.status === 'running' ? 'running' : 'pending',
        replayed: a.cached ?? false
      })
      agents += 1
      if (a.status === 'error') failed += 1
      if (a.cached) replayed += 1
    }
  }
  meta['phases'] = phases
  meta['members'] = members
  meta['counts'] = { agents, failed, replayed }
  return meta
}

/** cardID(): `workflow-<run id>`, plus `-<attach>` past the first card. */
export function cardId(run: CardRun): string {
  const attach = run.attach ?? 1
  return attach <= 1 ? `workflow-${run.runId}` : `workflow-${run.runId}-${attach}`
}

/**
 * A run's card as the transcript holds it after the CLI's latest update:
 * title, ACP status, text and (unless `meta: false`, an older CLI) the
 * `_meta` payload. `continuedIn` builds the card an earlier turn closed when
 * a later one took the run over (takeWorkflowLocked): completed, its text
 * prefixed, its state left as that turn saw it. `summary` is the finish
 * output a success or failure puts on top (finishWorkflowLocked).
 */
export function workflowCard(
  run: CardRun,
  o: { meta?: boolean; continuedIn?: string; summary?: string; rawInput?: object | null } = {}
): TranscriptItem {
  const status = run.status ?? 'running'
  let acp: ACPToolStatus
  if (o.continuedIn) acp = 'completed'
  else if (status === 'success' || status === 'stopped') acp = 'completed'
  else if (status === 'error' || status === 'failed' || status === 'cancelled') acp = 'failed'
  else acp = 'in_progress'
  let output = renderCard(run)
  if (o.summary && status !== 'stopped') output = `${o.summary}\n\n${output}`
  if (o.continuedIn) output = `continued in a later turn\n\n${output}`
  const rawInput =
    o.rawInput === undefined
      ? {
          run_id: run.runId,
          workflow: run.name,
          description: run.description ?? '',
          origin: 'inline',
          phases: (run.phases ?? [])
            .filter((p) => !p.dynamic)
            .map((p) => ({ title: p.title, detail: p.detail ?? '' })),
          size: run.size ?? '',
          size_agents: run.sizeAgents ?? 0,
          budget_tokens: run.budget ?? 0
        }
      : o.rawInput
  const item = tool({
    title: cardTitle(run),
    kind: 'think',
    status: acp,
    output,
    ...(rawInput === null ? {} : { argsJSON: JSON.stringify(rawInput) }),
    ...(o.meta === false
      ? {}
      : { workflow: cardMeta(run, { continuedIn: o.continuedIn, summary: o.summary }) })
  })
  if (item.kind === 'tool') item.tool.id = cardId(run)
  return item
}

// ---------------------------------------------------------------------------
// Raw ACP payloads, for tests that drive the main process through the pipe
// (AcpConnection.handleLine) rather than through transcript items.
// ---------------------------------------------------------------------------

type JSON = import('@shared/acp').JSONValue

/**
 * The `initialize` result (internal/acp/bridge.go Initialize): every session
 * capability as an empty object, image and embedded-context prompts, and the
 * `_spettro/*` surface under `_meta` (ext.go extensionMethods, version 4).
 */
export function initializeResult(o: { methods?: string[] } = {}): JSON {
  return {
    protocolVersion: 1,
    agentInfo: { name: 'spettro', title: 'Spettro', version: 'dev' },
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {}, close: {} },
      promptCapabilities: { image: true, embeddedContext: true }
    },
    authMethods: [],
    _meta: {
      'spettro.app/extensions': {
        version: 4,
        methods: o.methods ?? ['_spettro/account/status', '_spettro/workflow/list'],
        clientMethods: ['_spettro/question/ask']
      }
    }
  }
}

/**
 * A JSON-RPC error as acp-go-sdk writes one (errors.go): a plain Go error
 * becomes -32603 "Internal error" with the real reason in `data.error`;
 * NewInvalidParams is -32602 "Invalid params", reason likewise in `data`.
 */
export function rpcError(reason: string, code = -32603): { code: number; message: string; data: JSON } {
  return {
    code,
    message: code === -32602 ? 'Invalid params' : 'Internal error',
    data: { error: reason }
  }
}

const ALLOW_ONCE = { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }
const DENY = { optionId: 'deny', name: 'Deny', kind: 'reject_once' }

/**
 * `session/request_permission` params for an approval the CLI ATTACHES to a
 * card it is already drawing (internal/acp/permission.go requestApproval):
 * only the card's id, `status: "pending"` and the content — the command
 * fenced (approvalTextBlock), any diff (fileChangeContent), then the reason.
 * No title, no kind, no rawInput: those are on the card.
 */
export function permissionAttached(o: {
  sessionId: string
  toolCallId: string
  command?: string
  diff?: { path: string; oldText?: string; newText: string }
  reason?: string
}): JSON {
  const content: JSON[] = []
  if (o.diff) content.push({ type: 'diff', ...o.diff })
  else if (o.command) {
    content.push({ type: 'content', content: { type: 'text', text: '```sh\n' + o.command + '\n```' } })
  }
  if (o.reason) content.push({ type: 'content', content: { type: 'text', text: o.reason } })
  return {
    sessionId: o.sessionId,
    toolCall: { toolCallId: o.toolCallId, status: 'pending', content },
    options: [ALLOW_ONCE, DENY]
  }
}

/**
 * The same request when no card was open to attach to (permission.go): a
 * fresh `perm-N` id, described in full — title, kind, and rawInput
 * `{command, reason}` — because nothing else will ever describe that card.
 * The CLI settles it with a tool_call_update after the answer
 * (settleApprovalCard).
 */
export function permissionFresh(o: {
  sessionId: string
  n: number
  title: string
  command: string
  reason?: string
}): JSON {
  return {
    sessionId: o.sessionId,
    toolCall: {
      toolCallId: `perm-${o.n}`,
      status: 'pending',
      title: o.title,
      kind: 'execute',
      rawInput: { command: o.command, reason: o.reason ?? '' },
      content: [{ type: 'content', content: { type: 'text', text: '```sh\n' + o.command + '\n```' } }]
    },
    options: [
      ALLOW_ONCE,
      { optionId: 'allow-always', name: 'Always allow this command', kind: 'allow_always' },
      DENY
    ]
  }
}

/** The "context nearly full" prompt (internal/acp/compaction.go
 *  askCompactPermission): its own `compact-N` id and options. */
export function compactRequest(sessionId: string): JSON {
  return {
    sessionId,
    toolCall: {
      toolCallId: 'compact-1',
      title: 'Context nearly full (~180000/200000 tokens). Compact conversation history now?',
      kind: 'think',
      status: 'pending'
    },
    options: [
      { optionId: 'compact', name: 'Compact now', kind: 'allow_once' },
      { optionId: 'continue', name: 'Continue without compacting', kind: 'reject_once' }
    ]
  }
}

/** An `agent_message_chunk` update. */
export function agentChunk(text: string): JSON {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
}

/** A `user_message_chunk`, which spettro sends only while `session/load`
 *  replays a stored conversation, one whole message per chunk
 *  (internal/acp/sessions.go LoadSession). */
export function userChunk(text: string): JSON {
  return { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } }
}

/** The acknowledgement a prompt sent mid-turn gets before its own turn ends
 *  with end_turn (internal/acp/bridge.go steerRunningTurn), verbatim. */
export const STEERING_QUEUED_TEXT =
  '→ steering queued: the running agent will see this message at its next step'

/** The agent has read a steer (internal/acp/content.go, from llm_runtime.go's
 *  "steering delivered: <text clipped to 200>" comment trace). */
export function steeringDeliveredText(steer: string): string {
  return `✔ steering delivered: ${steer}`
}

/**
 * A `session/prompt` result (bridge.go Prompt / turnUsageResponse): usage is
 * the turn's provider accounting, `_meta["spettro.app/tokensUsed"]` the
 * runtime's own count.
 */
export function promptResult(o: {
  stopReason?: string
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number; cachedReadTokens?: number }
  tokensUsed?: number
}): JSON {
  const result: { [key: string]: JSON } = { stopReason: o.stopReason ?? 'end_turn' }
  if (o.usage) result['usage'] = o.usage
  if (o.tokensUsed !== undefined) result['_meta'] = { 'spettro.app/tokensUsed': o.tokensUsed }
  return result
}

/** A `session/list` result (sessions.go ListSessions): newest first, one
 *  page, the title being the first prompt's preview, updatedAt RFC 3339. */
export function sessionList(entries: { id: string; cwd: string; title?: string; updatedAt?: string }[]): JSON {
  return {
    sessions: entries.map((e) => {
      const info: { [key: string]: JSON } = { sessionId: e.id, cwd: e.cwd }
      if (e.title !== undefined) info['title'] = e.title
      if (e.updatedAt !== undefined) info['updatedAt'] = e.updatedAt
      return info
    })
  }
}

/**
 * A `plan` update (internal/acp/content.go planEntriesFromTodos): the whole
 * task list in dependency order, every time. ACP plans have no blocked
 * status, so a pending task waiting on unfinished prerequisites carries it
 * in its text as a " (blocked)" suffix; cancelled tasks are reported as
 * completed. An empty list is still sent, to clear the plan.
 */
export function planUpdate(
  todos: { content: string; status: 'pending' | 'in_progress' | 'completed'; blocked?: boolean; priority?: string }[]
): JSON {
  return {
    sessionUpdate: 'plan',
    entries: todos.map((t) => ({
      content: t.blocked && t.status === 'pending' ? `${t.content} (blocked)` : t.content,
      priority: t.priority ?? 'medium',
      status: t.status
    }))
  }
}

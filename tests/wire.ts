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
 * The workflow lifecycle call at `start`.
 *
 * internal/agent/workflow_trace.go: the observer publishes the declared phase
 * list up front, from `meta`, so a host can draw the whole plan before the
 * first agent runs. internal/acp/workflow.go gives this call an id prefixed
 * `wf-`, which is how it is told apart from the model's `workflow` tool call.
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
 * The SAME lifecycle call after it finishes.
 *
 * This is the shape that makes the fold hard, and it is not a hypothetical:
 * `chatSession.applyToolEvent` overwrites `argsJSON` on every update carrying
 * rawInput, and the CLI's finish payload is `{run_id, workflow, agents,
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
 * An Ultra swarm member (internal/agent/ultra.go, emitSwarmTrace).
 *
 * Deliberately carries NO run_id — swarm members have no run to name, so they
 * can only be attached to an `ultra` call by position.
 */
export function swarmMember(o: {
  instance: string
  item: string
  status?: ACPToolStatus
  output?: string
}): TranscriptItem {
  return tool({
    title: `agent ${o.instance}: ${o.item}`,
    kind: 'think',
    status: o.status ?? 'in_progress',
    argsJSON: JSON.stringify({
      agent: o.instance,
      task: o.item,
      parent_agent_id: 'coding',
      swarm: true
    }),
    output: o.output ?? ''
  })
}

/** The `ultra` tool call itself. */
export function ultra(o: {
  items: string[]
  subagentType?: string
  isolation?: string
  description?: string
  status?: ACPToolStatus
}): TranscriptItem {
  return tool({
    title: 'ultra {"description":"…"}',
    status: o.status ?? 'in_progress',
    argsJSON: JSON.stringify({
      description: o.description ?? '',
      subagent_type: o.subagentType ?? 'code',
      prompt_template: 'Do {{item}}',
      items: o.items,
      isolation: o.isolation ?? ''
    })
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
 * internal/acp/content.go only brackets the instance onto the title when the
 * instance name contains '#' — so swarm and workflow members are attributable
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

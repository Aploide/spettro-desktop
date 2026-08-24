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

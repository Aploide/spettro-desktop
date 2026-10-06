// Synthetic transcripts for the visual harness.
//
// These are not toy data: every field is shaped exactly the way the Go CLI
// puts it on the ACP wire (see internal/agent/workflow_trace.go,
// internal/acp/workflow.go and internal/agent/ultra.go in the spettro
// checkout), including the awkward parts a screenshot is the only practical
// way to catch — a finished workflow whose argsJSON has been overwritten by
// the finish payload, a swarm that has launched only part of its item list,
// members whose bracket-prefixed tool calls have to be folded back under
// them, and instance names long enough to collide under naive truncation.

import type { ToolCallItem, TranscriptItem } from '@shared/model'

let seq = 0
const T0 = 1_700_000_000_000

function tool(partial: Partial<ToolCallItem> & { title: string }): TranscriptItem {
  seq += 1
  return {
    kind: 'tool',
    tool: {
      id: `call_${seq}`,
      status: 'completed',
      output: '',
      diffs: [],
      locations: [],
      timestamp: T0 + seq * 1000,
      ...partial
    }
  }
}

function say(role: 'user' | 'assistant', text: string): TranscriptItem {
  seq += 1
  return {
    kind: 'message',
    message: {
      id: `msg_${seq}`,
      role,
      text,
      attachments: [],
      isStreaming: false,
      timestamp: T0 + seq * 1000
    }
  }
}

/** A workflow member's `agent` tool call, exactly as the bridge emits it. */
function member(o: {
  instance: string
  task: string
  phase: string
  index: number
  status: ToolCallItem['status']
  cached?: boolean
  summary?: string
  runId?: string
}): TranscriptItem {
  return tool({
    title: `agent ${o.instance}: ${o.task}`,
    kind: 'think',
    status: o.status,
    argsJSON: JSON.stringify({
      agent: o.instance,
      task: o.task,
      parent_agent_id: 'coding',
      workflow: 'review-changes',
      run_id: o.runId ?? 'wf_1',
      phase: o.phase,
      index: o.index,
      cached: o.cached ?? false
    }),
    output: o.summary
      ? JSON.stringify({ agent: o.instance, status: o.status === 'failed' ? 'error' : 'ok', summary: o.summary })
      : ''
  })
}

/** A swarm member. Note: no run_id — swarm members attach positionally. */
function swarmMember(o: {
  instance: string
  item: string
  status: ToolCallItem['status']
  summary?: string
}): TranscriptItem {
  return tool({
    title: `agent ${o.instance}: ${o.item}`,
    kind: 'think',
    status: o.status,
    argsJSON: JSON.stringify({
      agent: o.instance,
      task: o.item,
      parent_agent_id: 'coding',
      swarm: true
    }),
    output: o.summary
      ? JSON.stringify({ agent: o.instance, status: o.status === 'failed' ? 'error' : 'ok', summary: o.summary })
      : ''
  })
}

/**
 * A tool call made *by* a sub-agent. The CLI brackets the instance onto the
 * title only when the instance name contains a '#' (toolCallTitle in
 * internal/acp/content.go) — so swarm and workflow members are attributable
 * and a plain delegation like `explore` is not. Confirmed against a recorded
 * session: `explore`'s own `ls` call arrives titled plainly `ls {…}`.
 */
function childCall(instance: string, name: string, args: object, o?: {
  status?: ToolCallItem['status']
  output?: string
  kind?: string
}): TranscriptItem {
  return tool({
    title: `[${instance}] ${name} ${JSON.stringify(args)}`,
    kind: o?.kind ?? (name === 'bash' ? 'execute' : 'read'),
    status: o?.status ?? 'completed',
    argsJSON: JSON.stringify(args),
    output: o?.output ?? ''
  })
}

const WF_PHASES = [
  { title: 'Review', detail: 'one agent per dimension' },
  { title: 'Verify', detail: 'adversarial refutation' },
  { title: 'Synthesize', detail: '' }
]

const WF_DESCRIPTION = 'Review changed files across dimensions, verify each finding'

function workflowStart(status: ToolCallItem['status'], output: string): TranscriptItem {
  return tool({
    title: 'workflow review-changes',
    kind: 'think',
    status,
    argsJSON: JSON.stringify({
      run_id: 'wf_1',
      workflow: 'review-changes',
      description: WF_DESCRIPTION,
      origin: 'inline',
      phases: WF_PHASES
    }),
    output
  })
}

/**
 * The finish update. The CLI re-sends rawInput with a completely different
 * shape and chatSession.applyToolEvent overwrites argsJSON with it — so
 * `phases`, `description` and `origin` are simply gone, and the only place
 * they still exist is the text tree in `output`. Any card that reads them
 * from argsJSON alone renders a finished run as a phaseless stub.
 */
function workflowFinished(): TranscriptItem {
  const tree = [
    '4 agents · 1 failed · 1 replayed',
    '',
    WF_DESCRIPTION,
    '',
    '▸ Review — 3/3 done, 1 failed',
    '    ✓ review#1  review:bugs — correctness sweep over src/main',
    '    ✓ review#2  review:perf — hot paths in the renderer',
    '    ✗ review#3  review:a11y — keyboard + aria',
    '▸ Verify — 1/1 done',
    '    ✓ verify#4  replayed · verify:orchestration.ts:88',
    '○ Synthesize — pending',
    '',
    'log:',
    '  3/10 findings collected',
    '  dimension perf still running',
    '  2 findings survived refutation'
  ].join('\n')
  return tool({
    title: 'workflow review-changes',
    kind: 'think',
    status: 'completed',
    argsJSON: JSON.stringify({
      run_id: 'wf_1',
      workflow: 'review-changes',
      agents: 4,
      failed: 1,
      cached: 1,
      tokens: 184320
    }),
    output: tree
  })
}

function ultraCall(status: ToolCallItem['status'], items: string[], isolation: string): TranscriptItem {
  return tool({
    title: `ultra {"description":"Port each view to the new token set","subagent_type":"code","prompt_te…`,
    kind: 'other',
    status,
    argsJSON: JSON.stringify({
      description: 'Port each view to the new token set',
      subagent_type: 'code',
      prompt_template: 'Port {{item}} to the new design tokens.',
      items,
      isolation
    }),
    output: status === 'completed' ? '7 sub-agents · 1 failed' : ''
  })
}

const SWARM_ITEMS = [
  'src/main/acp/parse.ts',
  'src/main/model/chatSession.ts',
  'src/renderer/src/views/chat/ChatView.tsx',
  'src/renderer/src/views/chat/transcript/ToolCallView.tsx',
  'src/shared/model.ts',
  'src/main/remote/host.ts',
  'src/main/terminal/panels.ts',
  'src/renderer/src/views/shell/Sidebar.tsx',
  'src/renderer/src/views/sheets/PermissionSheet.tsx',
  'src/main/remote/hostSession.ts'
]

export interface Scene {
  id: string
  title: string
  note: string
  items: TranscriptItem[]
}

export const SCENES: Scene[] = [
  {
    id: 'workflow-running',
    title: 'Workflow — mid-run',
    note: 'Three declared phases; Synthesize has not been reached and must still render. One member failed, one was replayed from the journal, two are live with nested tool calls folded under them.',
    items: [
      say('user', 'ultracode: review the pending changes'),
      say('assistant', "I'll fan this out across dimensions and verify each finding."),
      workflowStart('in_progress', [
        WF_DESCRIPTION,
        '',
        '▸ Review — 2/3 done, 1 failed',
        '○ Verify — pending',
        '○ Synthesize — pending',
        '',
        'log:',
        '  3/10 findings collected',
        '  dimension perf still running'
      ].join('\n')),
      member({ instance: 'review#1', task: 'review:bugs — correctness sweep over src/main', phase: 'Review', index: 1, status: 'completed', summary: 'Found 3 issues:\n\n- `applyToolEvent` overwrites `argsJSON` on every update\n- swarm members carry no `run_id`\n- the empty phase bucket can swallow declared phases' }),
      childCall('review#1', 'bash', { command: "rg -n 'argsJSON' src/main" }, { output: 'src/main/model/chatSession.ts:413' }),
      childCall('review#1', 'read', { file_path: 'src/main/model/chatSession.ts' }),
      member({ instance: 'review#2', task: 'review:perf — hot paths in the renderer', phase: 'Review', index: 2, status: 'in_progress' }),
      childCall('review#2', 'bash', { command: 'rg -n "useMemo" src/renderer/src/views' }, { status: 'in_progress' }),
      member({ instance: 'review#3', task: 'review:a11y — keyboard + aria', phase: 'Review', index: 3, status: 'failed', summary: 'provider returned 429 after 3 attempts' }),
      member({ instance: 'verify#4', task: 'verify:orchestration.ts:88 — refute the argsJSON claim', phase: 'Verify', index: 4, status: 'in_progress', cached: true })
    ]
  },
  {
    id: 'workflow-finished',
    title: 'Workflow — finished, argsJSON overwritten',
    note: 'THE HARD CASE. The finish update replaced argsJSON with {agents,failed,cached,tokens}, so phases/description exist only in the text tree. A card that trusts argsJSON renders a phaseless stub here.',
    items: [
      workflowFinished(),
      member({ instance: 'review#1', task: 'review:bugs — correctness sweep over src/main', phase: 'Review', index: 1, status: 'completed', summary: 'Three confirmed defects.' }),
      member({ instance: 'review#2', task: 'review:perf — hot paths in the renderer', phase: 'Review', index: 2, status: 'completed', summary: 'One quadratic scan in groupTranscript.' }),
      member({ instance: 'review#3', task: 'review:a11y — keyboard + aria', phase: 'Review', index: 3, status: 'failed', summary: 'provider returned 429 after 3 attempts' }),
      member({ instance: 'verify#4', task: 'verify:orchestration.ts:88', phase: 'Verify', index: 4, status: 'completed', cached: true, summary: 'Stands. Fix: parse the text tree as a fallback.' }),
      say('assistant', 'Two findings survived refutation. Both are in the parsing layer.')
    ]
  },
  {
    id: 'workflow-wide',
    title: 'Workflow — 14 members in one phase',
    note: 'Exercises the row cap. Running and failed members must survive; successes are dropped first, with an honest "… N more".',
    items: [
      workflowStart('in_progress', WF_DESCRIPTION),
      ...Array.from({ length: 14 }, (_, i) =>
        member({
          instance: `general-purpose#${i + 1}`,
          task: `sweep ${SWARM_ITEMS[i % SWARM_ITEMS.length]}`,
          phase: 'Review',
          index: i + 1,
          status: i === 4 ? 'failed' : i > 10 ? 'in_progress' : 'completed',
          summary: i === 4 ? 'timed out' : 'nothing found'
        })
      ),
      member({ instance: 'synth#15', task: 'synthesize the surviving findings', phase: 'Synthesize', index: 15, status: 'in_progress' })
    ]
  },
  {
    id: 'swarm-running',
    title: 'Ultra swarm — ramping, worktree isolation',
    note: 'Ultra launches 5 immediately then one every 700ms, so a 10-item swarm genuinely has un-launched items. Those must show as pending, not vanish.',
    items: [
      say('user', 'port every view to the new tokens'),
      ultraCall('in_progress', SWARM_ITEMS, 'worktree'),
      ...SWARM_ITEMS.slice(0, 7).map((it, i) =>
        swarmMember({
          instance: `code#${i + 1}`,
          item: it,
          status: i < 3 ? 'completed' : i === 3 ? 'failed' : 'in_progress',
          summary: i < 3 ? 'ported, 4 tokens swapped' : i === 3 ? 'merge conflict on branch spettro/code-4' : undefined
        })
      ),
      childCall('code#5', 'edit', { file_path: 'src/shared/model.ts' }, { status: 'in_progress', kind: 'edit' }),
      childCall('code#6', 'bash', { command: 'npm run typecheck' }, { status: 'in_progress' })
    ]
  },
  {
    id: 'swarm-finished',
    title: 'Ultra swarm — settled',
    note: 'Every member stays visible with its outcome — the specific readability fix view_swarm.go documents. The card should collapse compactly without hiding the failure.',
    items: [
      ultraCall('completed', SWARM_ITEMS.slice(0, 7), ''),
      ...SWARM_ITEMS.slice(0, 7).map((it, i) =>
        swarmMember({
          instance: `code#${i + 1}`,
          item: it,
          status: i === 3 ? 'failed' : 'completed',
          summary: i === 3 ? 'merge conflict on branch spettro/code-4' : 'ported, 4 tokens swapped'
        })
      ),
      say('assistant', 'Six of seven landed. `code#4` hit a merge conflict — its branch is still there.')
    ]
  },
  {
    id: 'mixed',
    title: 'Mixed transcript',
    note: 'A plain delegation, an ordinary tool row and two runs in one turn — checks that grouping preserves order and that nothing leaks into the flat rows.',
    items: [
      say('user', 'audit the ACP layer, then port the views'),
      tool({ title: 'read {"file_path":"src/main/acp/parse.ts"}', kind: 'read', argsJSON: '{"file_path":"src/main/acp/parse.ts"}', output: '449 lines', locations: [{ path: 'src/main/acp/parse.ts' }] }),
      tool({
        title: 'agent explore: map the ACP surface',
        kind: 'think',
        status: 'completed',
        argsJSON: JSON.stringify({ agent: 'explore', task: 'map the ACP surface', parent_agent_id: 'coding' }),
        output: JSON.stringify({ agent: 'explore', status: 'ok', summary: 'The surface is `connection.ts` → `agent.ts` → `parse.ts`.' })
      }),
      // Deliberately unbracketed: `explore` has no '#', so the CLI never tags
      // this call with its instance and it is genuinely unattributable. It has
      // to stay a flat row rather than be guessed into the delegation card.
      tool({
        title: 'bash {"command":"rg -n sessionUpdate src/main/acp"}',
        kind: 'execute',
        argsJSON: '{"command":"rg -n sessionUpdate src/main/acp"}',
        output: 'src/main/acp/connection.ts:212'
      }),
      workflowStart('in_progress', WF_DESCRIPTION),
      member({ instance: 'review#1', task: 'review:bugs', phase: 'Review', index: 1, status: 'in_progress' }),
      ultraCall('in_progress', SWARM_ITEMS.slice(0, 3), ''),
      ...SWARM_ITEMS.slice(0, 3).map((it, i) =>
        swarmMember({ instance: `code#${i + 1}`, item: it, status: 'in_progress' })
      )
    ]
  }
]

// Synthetic transcripts for the visual harness.
//
// These are not toy data: every field is shaped exactly the way the Go CLI
// puts it on the ACP wire (see internal/agent/workflow_trace.go and
// internal/acp/workflow.go in the spettro checkout), including the awkward
// parts a screenshot is the only practical way to catch — a run paused at a
// checkpoint, a card a later turn took over, a finished workflow from an older
// CLI whose argsJSON was overwritten by the finish payload, members whose
// bracket-prefixed tool calls have to be folded back under them, and instance
// names long enough to collide under naive truncation.
//
// The cards the current CLI sends are built by tests/wire.ts workflowCard —
// a line-for-line port of render() and metaView() — so the harness draws the
// same text and metadata the tests are written against.

import type { ToolCallItem, TranscriptItem } from '@shared/model'
import { workflowCard, type CardAgent, type CardRun } from '../../tests/wire'

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
  workflow?: string
}): TranscriptItem {
  return tool({
    title: `agent ${o.instance}: ${o.task}`,
    kind: 'think',
    status: o.status,
    argsJSON: JSON.stringify({
      agent: o.instance,
      task: o.task,
      parent_agent_id: 'coding',
      workflow: o.workflow ?? 'review-changes',
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

/**
 * A tool call made *by* a sub-agent. The CLI brackets the instance onto the
 * title only when the instance name contains a '#' (toolCallTitle in
 * internal/acp/tools.go) — so workflow members are attributable
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

/**
 * The finish update as an older CLI sent it. It re-sent rawInput with a
 * completely different shape and chatSession.applyToolEvent overwrites
 * argsJSON with it — so
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

const FILES = [
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

/** A member call for each agent the card lists, in the same state: the card
 *  and the calls are two views of one run and must agree. */
function callsFor(
  run: CardRun,
  extra: Record<string, { summary?: string; children?: TranscriptItem[] }> = {}
): TranscriptItem[] {
  const out: TranscriptItem[] = []
  for (const [i, agent] of (run.agents ?? []).entries()) {
    out.push(
      member({
        instance: agent.instance,
        task: agent.task,
        phase: agent.phase ?? '',
        index: i + 1,
        status: callStatus(agent),
        cached: agent.cached,
        summary: extra[agent.instance]?.summary,
        runId: run.runId,
        workflow: run.name
      })
    )
    out.push(...(extra[agent.instance]?.children ?? []))
  }
  return out
}

function callStatus(agent: CardAgent): ToolCallItem['status'] {
  if (agent.status === 'success') return 'completed'
  if (agent.status === 'error') return 'failed'
  return 'in_progress'
}

const REVIEW: CardRun = {
  runId: 'wf_20261006093012_8c1d2e4f',
  name: 'review-changes',
  description: WF_DESCRIPTION,
  size: 'medium',
  sizeAgents: 10,
  budget: 500_000,
  phases: WF_PHASES,
  agents: [
    { instance: 'review#1', task: 'review:bugs — correctness sweep over src/main', phase: 'Review', status: 'success' },
    { instance: 'review#2', task: 'review:perf — hot paths in the renderer', phase: 'Review', status: 'running' },
    { instance: 'review#3', task: 'review:a11y — keyboard + aria', phase: 'Review', status: 'error' },
    { instance: 'verify#4', task: 'verify:orchestration.ts:88 — refute the argsJSON claim', phase: 'Verify', status: 'running', cached: true }
  ],
  logs: ['3/10 findings collected', 'dimension perf still running']
}

const REVIEW_EXTRA = {
  'review#1': {
    summary: 'Found 3 issues:\n\n- `applyToolEvent` overwrites `argsJSON` on every update\n- the empty phase bucket can swallow declared phases\n- a paused run spins forever',
    children: [
      childCall('review#1', 'bash', { command: "rg -n 'argsJSON' src/main" }, { output: 'src/main/model/chatSession.ts:413' }),
      childCall('review#1', 'read', { file_path: 'src/main/model/chatSession.ts' })
    ]
  },
  'review#2': {
    children: [childCall('review#2', 'bash', { command: 'rg -n "useMemo" src/renderer/src/views' }, { status: 'in_progress' })]
  },
  'review#3': { summary: 'provider returned 429 after 3 attempts' }
}

const AUDIT_PAUSED: CardRun = {
  runId: 'wf_20261006101544_3f9a7b21',
  name: 'audit-auth',
  description: 'Find auth weaknesses, then fix the ones you pick',
  size: 'small',
  sizeAgents: 5,
  phases: [
    { title: 'Scan', detail: 'one agent per package' },
    { title: 'Fix', detail: 'only what you approve' }
  ],
  agents: [
    { instance: 'scan#1', task: 'scan internal/auth', phase: 'Scan', status: 'success' },
    { instance: 'scan#2', task: 'scan internal/session', phase: 'Scan', status: 'success' },
    { instance: 'scan#3', task: 'scan internal/token', phase: 'Scan', status: 'error' }
  ],
  logs: ['4 findings', '⏸ cp-1 which findings should I fix?'],
  status: 'paused',
  checkpointId: 'cp-1',
  waiting: 'which findings should I fix?'
}

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
    note: 'The card the current CLI sends (with _meta). Three declared phases; Synthesize has not been reached and must still render. One member failed, one was replayed from the journal, two are live with nested tool calls folded under them. Size and budget in the header.',
    items: [
      say('user', 'ultracode +500k: review the pending changes'),
      say('assistant', "I'll fan this out across dimensions and verify each finding."),
      workflowCard(REVIEW),
      ...callsFor(REVIEW, REVIEW_EXTRA)
    ]
  },
  {
    id: 'workflow-finished',
    title: 'Workflow — finished, from an older CLI (argsJSON overwritten, no _meta)',
    note: 'THE HARD CASE for the text fallback. The finish update replaced argsJSON with {agents,failed,cached,tokens}, so phases/description exist only in the text tree.',
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
    items: (() => {
      const wide: CardRun = {
        ...REVIEW,
        size: 'large',
        sizeAgents: 30,
        budget: 0,
        logs: [],
        agents: [
          ...Array.from({ length: 14 }, (_, i): CardAgent => ({
            instance: `general-purpose#${i + 1}`,
            task: `sweep ${FILES[i % FILES.length]}`,
            phase: 'Review',
            status: i === 4 ? 'error' : i > 10 ? 'running' : 'success'
          })),
          { instance: 'synth#15', task: 'synthesize the surviving findings', phase: 'Synthesize', status: 'running' }
        ]
      }
      const extra: Record<string, { summary?: string }> = {}
      for (const agent of wide.agents ?? []) {
        extra[agent.instance] = { summary: agent.status === 'error' ? 'timed out' : agent.status === 'success' ? 'nothing found' : undefined }
      }
      return [workflowCard(wide), ...callsFor(wide, extra)]
    })()
  },
  {
    id: 'workflow-paused',
    title: 'Workflow — paused at a checkpoint',
    note: 'Alive but idle, waiting for Spettro to answer "which findings should I fix?". Must read as waiting (pause glyph, amber), never as a spinner, and must not appear in the live panel.',
    items: [
      say('user', 'ultracode: audit the auth code and fix what matters'),
      workflowCard(AUDIT_PAUSED),
      ...callsFor(AUDIT_PAUSED, { 'scan#3': { summary: 'context window exceeded on internal/token/jwt.go' } }),
      say('assistant', 'The scan found four issues. Which should I fix?')
    ]
  },
  {
    id: 'workflow-stopped',
    title: 'Workflow — stopped on purpose',
    note: 'The card closes as completed, but the run did not finish: "Stopped — <reason>", neither a success nor a failure.',
    items: (() => {
      const stopped: CardRun = { ...AUDIT_PAUSED, status: 'stopped', stopReason: 'paused for over 30m with no continue' }
      return [workflowCard(stopped), ...callsFor(stopped)]
    })()
  },
  {
    id: 'workflow-continued',
    title: 'Workflow — continued in a later turn',
    note: 'Turn one paused and its card was closed "continued in a later turn" (still paused in its metadata): it must fold to "Continued below", not wait forever. Turn two\'s card carries every member, including turn one\'s.',
    items: (() => {
      const resumed: CardRun = {
        ...AUDIT_PAUSED,
        status: 'running',
        attach: 2,
        continuedFrom: `workflow-${AUDIT_PAUSED.runId}`,
        checkpointId: undefined,
        waiting: undefined,
        logs: [...(AUDIT_PAUSED.logs ?? []), 'checkpoint cp-1 answered'],
        agents: [
          ...(AUDIT_PAUSED.agents ?? []),
          { instance: 'fix#4', task: 'fix: session fixation in login', phase: 'Fix', status: 'running' },
          { instance: 'fix#5', task: 'fix: token expiry off by one', phase: 'Fix', status: 'success' }
        ]
      }
      return [
        say('user', 'ultracode: audit the auth code and fix what matters'),
        workflowCard(AUDIT_PAUSED, { continuedIn: `workflow-${AUDIT_PAUSED.runId}-2` }),
        ...callsFor(AUDIT_PAUSED),
        say('assistant', 'The scan found four issues. Which should I fix?'),
        say('user', 'Fix the session fixation and the expiry bug.'),
        workflowCard(resumed, { rawInput: null }),
        ...callsFor({ ...resumed, agents: resumed.agents?.slice(3) })
      ]
    })()
  },
  {
    id: 'workflow-detail',
    title: 'Workflow — every line the card text can carry, read from text alone',
    note: 'No _meta (an older CLI): size + budget line, detail lines, a phase added at runtime, a replayed member, a member in a state the CLI does not name (·), a member outside any phase, and a log whose head was trimmed. Must draw the same tree the metadata would.',
    items: (() => {
      const detail: CardRun = {
        runId: 'wf_20261006111203_0b7c55aa',
        name: 'migrate-config',
        description: 'Move every service to the new config loader',
        size: 'unbounded',
        sizeAgents: 0,
        budget: 1_500_000,
        phases: [
          { title: 'Inventory', detail: 'list every service and its loader' },
          { title: 'Migrate', detail: 'one agent per service' },
          { title: 'Verify stragglers', detail: '2 services still on the old loader', dynamic: true }
        ],
        agents: [
          { instance: 'inv#1', task: 'list services', phase: 'Inventory', status: 'success', cached: true },
          { instance: 'mig#2', task: 'migrate billing', phase: 'Migrate', status: 'success' },
          { instance: 'mig#3', task: 'migrate search', phase: 'Migrate', status: 'running' },
          { instance: 'mig#4', task: 'migrate mailer', phase: 'Migrate', status: 'queued' },
          { instance: 'note#5', task: 'write the migration note', status: 'success' }
        ],
        logs: ['billing: 14 call sites', 'search: 9 call sites', 'mailer queued behind search'],
        dropped: 27
      }
      return [workflowCard(detail, { meta: false }), ...callsFor(detail)]
    })()
  },
  {
    id: 'mixed',
    title: 'Mixed transcript',
    note: 'A plain delegation, an ordinary tool row and a run in one turn — checks that grouping preserves order and that nothing leaks into the flat rows.',
    items: [
      say('user', 'audit the ACP layer, then review the views'),
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
      ...(() => {
        const small: CardRun = {
          ...REVIEW,
          budget: 0,
          logs: [],
          agents: [{ instance: 'review#1', task: 'review:bugs', phase: 'Review', status: 'running' }]
        }
        return [workflowCard(small), ...callsFor(small)]
      })()
    ]
  }
]

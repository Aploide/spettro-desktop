// groupTranscript is the most intricate pure function in the app and the one
// with the least margin for error: it decides which rows the user sees at all.
// Everything it does is reconstruction from evidence the CLI leaves lying
// around — a run_id here, a bracket prefix there, a text tree when the
// structured data has been overwritten — and each of those clues has a way of
// being absent that these tests pin down.
//
// Screenshots cannot catch any of this. A member attached to the wrong run
// still renders beautifully.

import { describe, expect, it, beforeEach } from 'vitest'
import {
  activeRuns,
  groupTranscript,
  nameFromTitle,
  parseCompactTokens,
  parseRenderedWorkflow,
  runTitle,
  type TranscriptRow,
  type WorkflowRun
} from '@renderer/views/chat/transcript/orchestration'
import {
  childCall,
  delegation,
  member,
  message,
  renderedTree,
  resetWire,
  scriptCall,
  tool,
  workflowCard,
  workflowFinished,
  workflowStart,
  type CardRun
} from './wire'

beforeEach(resetWire)

function runs(rows: TranscriptRow[]): WorkflowRun[] {
  return rows.flatMap((row) => (row.kind === 'run' ? [row.run] : []))
}

function onlyWorkflow(rows: TranscriptRow[]): WorkflowRun {
  const found = runs(rows)
  expect(found).toHaveLength(1)
  return found[0]
}

describe('folding a workflow', () => {
  it('absorbs its members and their tool calls, leaving one row', () => {
    const rows = groupTranscript([
      message('user', 'review this'),
      workflowStart({ runId: 'wf_1', name: 'review', phases: [{ title: 'Review' }] }),
      member({ instance: 'review#1', task: 'bugs', runId: 'wf_1', workflow: 'review', phase: 'Review' }),
      childCall('review#1', 'bash', { command: 'rg TODO' }),
      childCall('review#1', 'read', { file_path: 'a.ts' })
    ])

    // The user message, then the run. The member and both of its calls are
    // gone from the flat list — that is the whole point of the fold.
    expect(rows.map((r) => r.kind)).toEqual(['item', 'run'])
    const run = onlyWorkflow(rows)
    expect(run.phases[0].members).toHaveLength(1)
    expect(run.phases[0].members[0].children).toHaveLength(2)
  })

  it('keeps declared phases nobody has reached', () => {
    // A workflow's structure is decided before it runs, so an unreached phase
    // is information, not absence. Dropping it would make the card describe
    // only the past.
    const run = onlyWorkflow(
      groupTranscript([
        workflowStart({
          runId: 'wf_1',
          name: 'review',
          phases: [{ title: 'Review' }, { title: 'Verify' }, { title: 'Synthesize' }]
        }),
        member({ instance: 'review#1', task: 'bugs', runId: 'wf_1', workflow: 'review', phase: 'Review' })
      ])
    )
    expect(run.phases.map((p) => p.title)).toEqual(['Review', 'Verify', 'Synthesize'])
    expect(run.phases[1].members).toEqual([])
  })

  it('appends an undeclared phase after the declared ones', () => {
    const run = onlyWorkflow(
      groupTranscript([
        workflowStart({ runId: 'wf_1', name: 'review', phases: [{ title: 'Review' }] }),
        member({ instance: 'x#1', task: 't', runId: 'wf_1', workflow: 'review', phase: 'Extra' })
      ])
    )
    expect(run.phases.map((p) => p.title)).toEqual(['Review', 'Extra'])
  })

  it('puts phase-less members in a trailing bucket, and only when there are any', () => {
    const withNone = onlyWorkflow(
      groupTranscript([
        workflowStart({ runId: 'wf_1', name: 'r', phases: [{ title: 'A' }] }),
        member({ instance: 'a#1', task: 't', runId: 'wf_1', workflow: 'r', phase: 'A' })
      ])
    )
    expect(withNone.phases.map((p) => p.title)).toEqual(['A'])

    const withSome = onlyWorkflow(
      groupTranscript([
        workflowStart({ runId: 'wf_1', name: 'r', phases: [{ title: 'A' }] }),
        member({ instance: 'a#1', task: 't', runId: 'wf_1', workflow: 'r', phase: 'A' }),
        member({ instance: 'b#2', task: 't', runId: 'wf_1', workflow: 'r' })
      ])
    )
    // The unnamed bucket sorts last: named plan first, strays after.
    expect(withSome.phases.map((p) => p.title)).toEqual(['A', ''])
    expect(withSome.phases[1].members).toHaveLength(1)
  })

  it('routes members to the run whose run_id they name, not the nearest one', () => {
    // Two runs in one turn, with their members interleaved. Position would get
    // this wrong; the run_id is the only thing that gets it right.
    const rows = groupTranscript([
      workflowStart({ runId: 'wf_1', name: 'first', phases: [{ title: 'A' }] }),
      workflowStart({ runId: 'wf_2', name: 'second', phases: [{ title: 'B' }] }),
      member({ instance: 'a#1', task: 'for first', runId: 'wf_1', workflow: 'first', phase: 'A' }),
      member({ instance: 'b#1', task: 'for second', runId: 'wf_2', workflow: 'second', phase: 'B' })
    ])
    const [first, second] = runs(rows) as WorkflowRun[]
    expect(first.name).toBe('first')
    expect(first.phases[0].members.map((m) => m.task)).toEqual(['for first'])
    expect(second.phases[0].members.map((m) => m.task)).toEqual(['for second'])
  })
})

describe('a finished run, whose plan the CLI has already overwritten', () => {
  // This is the case that makes the whole text-recovery path necessary: after
  // the finish update there is no `phases` and no `description` in argsJSON,
  // and a session reloaded from disk has never seen them at all.
  const rendered = renderedTree({
    summary: '4 agents · 1 failed · 1 replayed',
    description: 'Review then verify',
    phases: [
      {
        title: 'Review',
        members: [
          { glyph: '✓', instance: 'review#1', label: 'bugs' },
          { glyph: '✗', instance: 'review#2', label: 'perf' }
        ]
      },
      { title: 'Synthesize' }
    ],
    logs: ['3/10 findings collected', 'perf still running']
  })

  const items = [
    workflowFinished({
      id: 'wf-1',
      runId: 'wf_1',
      name: 'review',
      agents: 4,
      failed: 1,
      cached: 1,
      rendered
    }),
    member({
      instance: 'review#1',
      task: 'bugs',
      runId: 'wf_1',
      workflow: 'review',
      phase: 'Review',
      status: 'completed'
    }),
    member({
      instance: 'review#2',
      task: 'perf',
      runId: 'wf_1',
      workflow: 'review',
      phase: 'Review',
      status: 'failed'
    })
  ]

  it('recovers the phase plan from the rendered tree', () => {
    const run = onlyWorkflow(groupTranscript(items))
    // "Synthesize" has no members and appears in no member's args — the text
    // tree is the only place it still exists.
    expect(run.phases.map((p) => p.title)).toContain('Synthesize')
    expect(run.phases.map((p) => p.title)).toContain('Review')
  })

  it('recovers the description and the log lines', () => {
    const run = onlyWorkflow(groupTranscript(items))
    expect(run.description).toBe('Review then verify')
    expect(run.logs).toEqual(['3/10 findings collected', 'perf still running'])
  })

  it('reports the run as finished and counts its failure', () => {
    const run = onlyWorkflow(groupTranscript(items))
    expect(run.status).toBe('done')
    expect(run.counts.failed).toBe(1)
    expect(run.summary).toContain('4 agents')
  })

  it('prefers structured args over the text when both are present', () => {
    // A running workflow still has its real phase list; the text must not be
    // allowed to override it with whatever the tree happened to show.
    const run = onlyWorkflow(
      groupTranscript([
        workflowStart({
          runId: 'wf_1',
          name: 'review',
          description: 'from args',
          phases: [{ title: 'Declared', detail: 'the real one' }],
          rendered: renderedTree({ description: 'from text', phases: [{ title: 'FromText' }] })
        })
      ])
    )
    expect(run.description).toBe('from args')
    expect(run.phases[0].title).toBe('Declared')
    expect(run.phases[0].detail).toBe('the real one')
  })

  it('survives a description that itself looks like tree syntax', () => {
    // The recovery is line-oriented, so a description containing a phase
    // glyph must not be mistaken for the tree.
    const run = onlyWorkflow(
      groupTranscript([
        workflowFinished({
          id: 'wf-1',
          runId: 'wf_1',
          name: 'r',
          agents: 0,
          rendered: renderedTree({
            summary: '0 agents · 0 failed · 0 replayed',
            description: '▸ not a phase, just prose',
            phases: [{ title: 'Real' }]
          })
        })
      ])
    )
    expect(run.phases.map((p) => p.title)).not.toContain('not a phase, just prose')
  })
})

describe('attributing a sub-agent’s own tool calls', () => {
  it('does not let a longer instance name steal a shorter one’s calls', () => {
    // "code#1" is a prefix of "code#12" as a string. Matching loosely would
    // hand #12's work to #1, and the two members would swap identities in the
    // card without anything looking broken.
    const rows = groupTranscript([
      workflowStart({ runId: 'wf_1', name: 'port', phases: [{ title: 'Port' }] }),
      member({ instance: 'code#1', task: 'a', runId: 'wf_1', workflow: 'port', phase: 'Port' }),
      member({ instance: 'code#12', task: 'b', runId: 'wf_1', workflow: 'port', phase: 'Port' }),
      childCall('code#12', 'bash', { command: 'belongs to twelve' })
    ])
    const members = onlyWorkflow(rows).phases[0].members
    const one = members.find((m) => m.instance === 'code#1')
    const twelve = members.find((m) => m.instance === 'code#12')
    expect(one?.children).toHaveLength(0)
    expect(twelve?.children).toHaveLength(1)
  })

  it('leaves an unattributable call as a flat row', () => {
    // The CLI only brackets instances containing '#', so a plain delegation's
    // own calls carry no attribution at all. Guessing would be worse than
    // leaving them where they are.
    const rows = groupTranscript([
      delegation({ agent: 'explore', task: 'map it', summary: 'done' }),
      childCall('explore', 'ls', { path: '/x' })
    ])
    expect(rows.map((r) => r.kind)).toEqual(['agent', 'item'])
  })

  it('does not make a member a child of itself', () => {
    // A member's own `agent` call is titled `[review#1] agent {…}` when the
    // instance has a '#', so a naive prefix rule swallows the member entirely.
    const rows = groupTranscript([
      workflowStart({ runId: 'wf_1', name: 'r', phases: [{ title: 'A' }] }),
      member({ instance: 'review#1', task: 't', runId: 'wf_1', workflow: 'r', phase: 'A' })
    ])
    const run = onlyWorkflow(rows)
    expect(run.phases[0].members).toHaveLength(1)
    expect(run.phases[0].members[0].children).toHaveLength(0)
  })
})

describe('the workflow tool call that carries the script', () => {
  it('folds into the run it started, matched on run_id', () => {
    const rows = groupTranscript([
      scriptCall({ script: 'export const meta = {}', savedAs: 'check', runId: 'wf_1', returned: '["a"]' }),
      workflowStart({ runId: 'wf_1', name: 'check', phases: [{ title: 'Read' }] })
    ])
    // One row, not two: the script belongs inside its card, not as a page of
    // raw JSON above it.
    expect(rows.map((r) => r.kind)).toEqual(['run'])
    const run = onlyWorkflow(rows)
    expect(run.script?.savedAs).toBe('check')
    expect(run.script?.source).toContain('export const meta')
    expect(run.script?.returned).toContain('a')
  })

  it('survives on its own when it failed before any run started', () => {
    // It is the only evidence a workflow was attempted at all. Folding it into
    // nothing, or leaving it as raw JSON, both lose that.
    const rows = groupTranscript([
      scriptCall({
        script: 'export const meta = {}',
        savedAs: 'missing',
        status: 'failed',
        error: 'error: workflow: no saved workflow named "missing"'
      })
    ])
    expect(rows.map((r) => r.kind)).toEqual(['script'])
    const row = rows[0]
    if (row.kind !== 'script') throw new Error('expected a script row')
    expect(row.script.status).toBe('failed')
    expect(row.script.error).toContain('no saved workflow')
    // It carries its item too, so a renderer that never learned this row kind
    // degrades to the ordinary tool row instead of dropping it.
    expect(row.item.kind).toBe('tool')
  })

  it('gives every row a unique, stable id', () => {
    // React keys depend on this; a collision silently reuses component state
    // between two different runs.
    const rows = groupTranscript([
      message('user', 'go'),
      workflowStart({ runId: 'wf_1', name: 'a', phases: [{ title: 'P' }] }),
      workflowStart({ runId: 'wf_2', name: 'b', phases: [{ title: 'P' }] }),
      delegation({ agent: 'explore', task: 't' })
    ])
    const ids = rows.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)

    // Stable: the same item folds to the same id every time, so a re-render
    // reuses component state instead of remounting the row.
    const item = message('user', 'go')
    expect(groupTranscript([item])[0].id).toBe(groupTranscript([item])[0].id)
  })
})

describe('what a member has to show', () => {
  it('uses the report summary when the output is the report shape', () => {
    const rows = groupTranscript([delegation({ agent: 'explore', task: 't', summary: 'I found it' })])
    const row = rows[0]
    if (row.kind !== 'agent') throw new Error('expected an agent row')
    expect(row.member.resultText).toBe('I found it')
    expect(row.member.resultIsJSON).toBe(false)
  })

  it('falls back to raw output for a structured result', () => {
    // An `agent()` call given a `schema` returns its value, which has no
    // `summary` — trusting the report parse alone renders a finished member as
    // an empty row while the card is holding its output.
    const rows = groupTranscript([
      workflowStart({ runId: 'wf_1', name: 'r', phases: [{ title: 'P' }] }),
      member({
        instance: 'code#1',
        task: 'a',
        runId: 'wf_1',
        workflow: 'r',
        phase: 'P',
        status: 'completed',
        output: '{"content":"beta\\n","file":"b.txt"}'
      })
    ])
    const [m] = onlyWorkflow(rows).phases[0].members
    expect(m.resultText).toContain('b.txt')
    expect(m.resultIsJSON).toBe(true)
  })

  it('is empty only when the member really said nothing', () => {
    const rows = groupTranscript([
      workflowStart({ runId: 'wf_1', name: 'r', phases: [{ title: 'P' }] }),
      member({ instance: 'code#1', task: 'a', runId: 'wf_1', workflow: 'r', phase: 'P', status: 'completed', output: '' })
    ])
    expect(onlyWorkflow(rows).phases[0].members[0].resultText).toBe('')
  })
})

describe('ordering and identity', () => {
  it('leaves everything that is not part of a run exactly where it was', () => {
    const rows = groupTranscript([
      message('user', 'first'),
      tool({ title: 'read {"file_path":"a.ts"}', kind: 'read', argsJSON: '{"file_path":"a.ts"}' }),
      workflowStart({ runId: 'wf_1', name: 'r', phases: [{ title: 'P' }] }),
      member({ instance: 'a#1', task: 't', runId: 'wf_1', workflow: 'r', phase: 'P' }),
      message('assistant', 'last')
    ])
    expect(rows.map((r) => r.kind)).toEqual(['item', 'item', 'run', 'item'])
  })

  it('derives a member’s spec id and index for tinting and ordering', () => {
    const run = onlyWorkflow(
      groupTranscript([
        workflowStart({ runId: 'wf_1', name: 'r', phases: [{ title: 'P' }] }),
        member({
          instance: 'general-purpose#7',
          task: 't',
          runId: 'wf_1',
          workflow: 'r',
          phase: 'P',
          index: 7,
          cached: true
        })
      ])
    )
    const [m] = run.phases[0].members
    expect(m.specId).toBe('general-purpose')
    expect(m.index).toBe(7)
    expect(m.cached).toBe(true)
  })
})

describe('activeRuns', () => {
  it('reports only what is still moving', () => {
    const rows = groupTranscript([
      workflowFinished({
        id: 'wf-9',
        runId: 'wf_1',
        name: 'done-one',
        agents: 1,
        rendered: renderedTree({ summary: '1 agents · 0 failed · 0 replayed', phases: [] })
      }),
      workflowStart({ runId: 'wf_2', name: 'live-one', phases: [] })
    ])
    const live = activeRuns(rows)
    expect(live).toHaveLength(1)
    expect(live[0].name).toBe('live-one')
  })

  it('leaves out a paused run and a card a later turn took over', () => {
    // Neither is working: one waits for Spettro, the other has handed the run
    // to the card below. A live panel holding either would never empty.
    const paused: CardRun = {
      runId: 'wf_1',
      name: 'audit',
      status: 'paused',
      checkpointId: 'cp-1',
      waiting: 'fix which?'
    }
    const rows = groupTranscript([
      workflowCard(paused, { continuedIn: 'workflow-wf_1-2' }),
      workflowCard({ runId: 'wf_2', name: 'other', status: 'paused' })
    ])
    expect(activeRuns(rows)).toEqual([])
  })

  it('titles a run for the panel', () => {
    const rows = groupTranscript([workflowStart({ runId: 'wf_1', name: 'review-changes', phases: [] })])
    expect(runs(rows).map(runTitle)).toEqual(['review-changes'])
  })
})

describe('robustness', () => {
  it('folds an empty transcript to nothing', () => {
    expect(groupTranscript([])).toEqual([])
  })

  it('does not throw on malformed args', () => {
    expect(() =>
      groupTranscript([
        tool({ title: 'workflow broken', kind: 'think', argsJSON: '{not json' }),
        tool({ title: 'agent x#1: t', kind: 'think', argsJSON: 'null' }),
        tool({ title: 'workflow audit', argsJSON: '[]', workflow: { version: 1, phases: 'nope', members: [null, 3] } })
      ])
    ).not.toThrow()
  })

  it('keeps a member whose run never arrived visible as a delegation', () => {
    // Losing the row entirely would hide work that really happened.
    const rows = groupTranscript([
      member({ instance: 'orphan#1', task: 't', runId: 'wf_missing', workflow: 'gone' })
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).not.toBe('item')
  })
})

// ---------------------------------------------------------------------------
// The card the CLI sends today
// ---------------------------------------------------------------------------

// A run in the middle of everything the card can say: a size and a budget,
// a detail line, a phase added at runtime, a replayed member, one that failed,
// one the runtime reports in a word it does not name, a member outside any
// phase, and a log whose head was trimmed.
const AUDIT: CardRun = {
  runId: 'wf_1',
  name: 'audit',
  description: 'Audit the repo',
  size: 'large',
  sizeAgents: 30,
  budget: 500_000,
  phases: [
    { title: 'Scan', detail: 'find candidates' },
    { title: 'Fix' },
    { title: 'Verify auth', detail: '3 suspects', dynamic: true }
  ],
  agents: [
    { instance: 'gp#1', task: 'scan a', phase: 'Scan', status: 'success' },
    { instance: 'gp#2', task: 'scan b', phase: 'Scan', status: 'error' },
    { instance: 'gp#3', task: 'scan c', phase: 'Scan', status: 'success', cached: true },
    { instance: 'gp#4', task: 'fix a', phase: 'Fix', status: 'running' },
    { instance: 'gp#5', task: 'fix b', phase: 'Fix', status: 'queued' },
    { instance: 'gp#6', task: 'loose', status: 'running' }
  ],
  logs: ['3 findings', '⏸ cp-1 pick targets'],
  dropped: 12
}

describe('reading the card’s text (an older CLI, or a chat saved before the metadata)', () => {
  // The exact strings internal/acp/workflow_test.go expects render() to write,
  // with the test line each comes from.

  it('reads a pause and what it waits for (workflow_test.go:467)', () => {
    const text = parseRenderedWorkflow(
      '⏸ paused at cp-1 — waiting for orchestrator: which findings to fix?\n\n▸ Scan — 1/1 done\n    ✓ gp#1  scan a',
      false
    )
    expect(text.status).toBe('paused')
    expect(text.pausedAt).toEqual({ checkpointId: 'cp-1', message: 'which findings to fix?' })
    // The pause line is not the description.
    expect(text.description).toBe('')
  })

  it('reads a pause with no checkpoint id or message', () => {
    const text = parseRenderedWorkflow('⏸ waiting for orchestrator\n\n○ Scan — pending', false)
    expect(text.status).toBe('paused')
    expect(text.pausedAt).toEqual({ checkpointId: '', message: '' })
  })

  it('reads a stop and its reason (workflow_test.go:778, :808)', () => {
    for (const reason of ["at the orchestrator's request", 'paused for over 30m with no continue']) {
      const text = parseRenderedWorkflow(`Audit\n\n■ stopped: ${reason}\n\n○ Scan — pending`, false)
      expect(text.status).toBe('stopped')
      expect(text.stoppedReason).toBe(reason)
      expect(text.description).toBe('Audit')
    }
  })

  it('reads the size line, with and without a budget (workflow_test.go:692-694)', () => {
    const large = parseRenderedWorkflow('size: large (~30 agents, a guideline)\n\n○ Scan — pending', false)
    expect([large.size, large.sizeAgents, large.budgetTokens]).toEqual(['large', 30, 0])
    const unbounded = parseRenderedWorkflow(
      'size: unbounded (no guideline) · budget 500k tokens\n\n○ Scan — pending',
      false
    )
    expect([unbounded.size, unbounded.sizeAgents, unbounded.budgetTokens]).toEqual(['unbounded', 0, 500_000])
    expect(unbounded.description).toBe('')
  })

  it('takes the size and budget suffixes off the title for the name (workflow_test.go:692-694)', () => {
    expect(nameFromTitle('workflow audit')).toBe('audit')
    expect(nameFromTitle('workflow audit · large')).toBe('audit')
    expect(nameFromTitle('workflow audit · unbounded · budget 500k')).toBe('audit')
    expect(nameFromTitle('[code#3] workflow audit · small')).toBe('audit')
    expect(parseCompactTokens('1.5m')).toBe(1_500_000)
    expect(parseCompactTokens('500k')).toBe(500_000)
  })

  it('reads detail lines and phases added at runtime (workflow_test.go:674)', () => {
    const text = parseRenderedWorkflow(
      '○ Scan — pending\n    ↳ find candidates\n○ Verify auth (added at runtime) — pending\n    ↳ 3 suspects',
      false
    )
    expect(text.phases).toEqual([
      { title: 'Scan', detail: 'find candidates', dynamic: false },
      { title: 'Verify auth', detail: '3 suspects', dynamic: true }
    ])
  })

  it('reads every member glyph, the replayed prefix and the no-phase bucket (workflow_test.go:826)', () => {
    const text = parseRenderedWorkflow(
      [
        '▸ Scan — 2/3 done, 1 failed',
        '    ✓ gp#1  scan a',
        '    ✗ gp#2  scan b',
        '    ▶ gp#3  replayed · scan c',
        '▸ (no phase) — 0/1 done',
        '    · gp#4  loose'
      ].join('\n'),
      false
    )
    expect(text.members.map((m) => [m.instance, m.status, m.replayed, m.phase, m.task])).toEqual([
      ['gp#1', 'done', false, 'Scan', 'scan a'],
      ['gp#2', 'failed', false, 'Scan', 'scan b'],
      ['gp#3', 'running', true, 'Scan', 'scan c'],
      ['gp#4', 'pending', false, '', 'loose']
    ])
    expect(text.phases.map((p) => p.title)).toEqual(['Scan', ''])
  })

  it('reads the log tail and how many lines were dropped before it', () => {
    const text = parseRenderedWorkflow('○ Scan — pending\n\nlog:\n  … 12 earlier lines\n  3 findings', false)
    expect(text.logs).toEqual(['3 findings'])
    expect(text.droppedLogLines).toBe(12)
  })

  it('reads the finish summary and the continued prefix off the front', () => {
    const finished = parseRenderedWorkflow('5 agents · 1 failed · 1 replayed\n\nAudit\n\n▸ Scan — 1/1 done\n    ✓ gp#1  a', false)
    expect(finished.summary).toBe('5 agents · 1 failed · 1 replayed')
    expect(finished.description).toBe('Audit')

    const continued = parseRenderedWorkflow(
      'continued in a later turn\n\nAudit\n\n⏸ paused at cp-1 — waiting for orchestrator: fix which?\n\n○ Scan — pending',
      false
    )
    expect(continued.continued).toBe(true)
    expect(continued.description).toBe('Audit')
    expect(continued.status).toBe('paused')
  })

  it('treats a status the CLI does not name as still running (workflow.go render default)', () => {
    const run = onlyWorkflow(
      groupTranscript([workflowCard({ runId: 'wf_1', name: 'audit', status: 'draining' }, { meta: false })])
    )
    expect(run.status).toBe('running')
  })

  it('keeps a description that looks like the size line', () => {
    const text = parseRenderedWorkflow(
      'size: whatever I like, really\n\nsize: small (~5 agents, a guideline)\n\n○ A — pending',
      false
    )
    expect(text.description).toBe('size: whatever I like, really')
    expect(text.size).toBe('small')
  })

  it('draws the same run from the text as from the metadata', () => {
    // The fallback is only worth having if it agrees with the real thing.
    // Every state the card can be in, both ways.
    const states: CardRun[] = [
      AUDIT,
      { ...AUDIT, status: 'paused', checkpointId: 'cp-1', waiting: 'fix which?' },
      { ...AUDIT, status: 'stopped', stopReason: "at the orchestrator's request" },
      { ...AUDIT, status: 'success', agents: AUDIT.agents?.map((a) => ({ ...a, status: 'success' })) }
    ]
    for (const state of states) {
      resetWire()
      const fromMeta = onlyWorkflow(groupTranscript([workflowCard(state)]))
      resetWire()
      const fromText = onlyWorkflow(groupTranscript([workflowCard(state, { meta: false, rawInput: null })]))
      expect(fromMeta.source).toBe('meta')
      expect(fromText.source).toBe('text')
      const shape = (run: WorkflowRun): unknown => ({
        name: run.name,
        runId: run.runId,
        status: run.status,
        pausedAt: run.pausedAt,
        stoppedReason: run.stoppedReason,
        size: [run.size, run.sizeAgents, run.budgetTokens],
        description: run.description,
        phases: run.phases.map((p) => ({
          title: p.title,
          detail: p.detail,
          dynamic: p.dynamic,
          members: p.members.map((m) => [m.instance, m.status, m.cached, m.task])
        })),
        logs: [run.logs, run.droppedLogLines]
      })
      expect(shape(fromText)).toEqual(shape(fromMeta))
    }
  })
})

describe('the card’s metadata (`_meta["spettro.app/workflow"]`)', () => {
  it('is the source of the run when present', () => {
    const run = onlyWorkflow(groupTranscript([workflowCard(AUDIT)]))
    expect(run.source).toBe('meta')
    expect(run.name).toBe('audit')
    expect(run.size).toBe('large')
    expect(run.sizeAgents).toBe(30)
    expect(run.budgetTokens).toBe(500_000)
    expect(run.phases.map((p) => [p.title, p.dynamic])).toEqual([
      ['Scan', false],
      ['Fix', false],
      ['Verify auth', true],
      ['', false]
    ])
    expect(run.phases[0].detail).toBe('find candidates')
    expect(run.droppedLogLines).toBe(12)
  })

  it('counts a phase’s failed members as finished, as the CLI’s “d/n done” does', () => {
    const run = onlyWorkflow(groupTranscript([workflowCard(AUDIT)]))
    const scan = run.phases[0]
    expect(scan.counts.done + scan.counts.failed).toBe(3)
    expect(scan.counts.failed).toBe(1)
    expect(scan.counts.cached).toBe(1)
  })

  it('keeps a member it reports in an unnamed state as not started', () => {
    const run = onlyWorkflow(groupTranscript([workflowCard(AUDIT)]))
    const fix = run.phases[1]
    expect(fix.members.map((m) => m.status)).toEqual(['running', 'pending'])
  })

  it('wins over text it disagrees with', () => {
    const item = workflowCard(AUDIT)
    if (item.kind === 'tool') item.tool.output = '▸ Bogus — 0/0 done'
    const run = onlyWorkflow(groupTranscript([item]))
    expect(run.phases.map((p) => p.title)).not.toContain('Bogus')
  })

  it('falls back to the text for a version it was not written for', () => {
    const item = workflowCard(AUDIT)
    if (item.kind === 'tool') item.tool.workflow = { version: 2, phases: [] }
    const run = onlyWorkflow(groupTranscript([item]))
    expect(run.source).toBe('text')
    expect(run.phases.map((p) => p.title)).toContain('Verify auth')
  })

  it('matches listed members to their own calls, and stands in for missing ones', () => {
    const rows = groupTranscript([
      workflowCard(AUDIT),
      member({ instance: 'gp#1', task: 'scan a', runId: 'wf_1', workflow: 'audit', phase: 'Scan', status: 'completed' }),
      childCall('gp#1', 'read', { file_path: 'a.go' })
    ])
    const run = onlyWorkflow(rows)
    // One row: the member and its call are inside the card.
    expect(rows).toHaveLength(1)
    const [gp1, gp2] = run.phases[0].members
    expect(gp1.children).toHaveLength(1)
    // gp#2's call never reached this transcript; the card still lists it.
    expect(gp2.instance).toBe('gp#2')
    expect(gp2.status).toBe('failed')
    expect(gp2.children).toEqual([])
  })

  it('reads a pause as waiting, never as running', () => {
    const run = onlyWorkflow(
      groupTranscript([workflowCard({ ...AUDIT, status: 'paused', checkpointId: 'cp-1', waiting: 'fix which?' })])
    )
    expect(run.status).toBe('paused')
    expect(run.pausedAt).toEqual({ checkpointId: 'cp-1', message: 'fix which?' })
  })

  it('reads a stop as stopped — not done, though the card closes completed', () => {
    const run = onlyWorkflow(
      groupTranscript([workflowCard({ ...AUDIT, status: 'stopped', stopReason: 'the session closed' })])
    )
    expect(run.tool.status).toBe('completed')
    expect(run.status).toBe('stopped')
    expect(run.stoppedReason).toBe('the session closed')
  })

  it('reads a cancelled run as stopped, not as a failure', () => {
    const run = onlyWorkflow(groupTranscript([workflowCard({ ...AUDIT, status: 'cancelled' })]))
    expect(run.tool.status).toBe('failed')
    expect(run.status).toBe('stopped')
    expect(run.stoppedReason).toBe('cancelled')
  })

  it('carries the summary of a finished run', () => {
    const done = { ...AUDIT, status: 'success', agents: AUDIT.agents?.slice(0, 3) }
    const run = onlyWorkflow(groupTranscript([workflowCard(done, { summary: '3 agents · 1 failed · 1 replayed' })]))
    expect(run.status).toBe('done')
    expect(run.summary).toBe('3 agents · 1 failed · 1 replayed')
  })
})

describe('a run continued in a later turn', () => {
  // workflow_test.go:490-540: a run pauses in turn one, turn two continues it.
  // Turn one's card closes "continued in a later turn" with `continuedIn`
  // and its state as it paused; turn two opens `workflow-wf_1-2`.
  const paused: CardRun = {
    runId: 'wf_1',
    name: 'audit',
    phases: [{ title: 'Scan' }, { title: 'Fix' }],
    agents: [{ instance: 'gp#1', task: 'scan a', phase: 'Scan', status: 'success' }],
    status: 'paused',
    checkpointId: 'cp-1',
    waiting: 'fix which?'
  }
  const resumed: CardRun = {
    ...paused,
    status: 'running',
    attach: 2,
    continuedFrom: 'workflow-wf_1',
    agents: [...(paused.agents ?? []), { instance: 'gp#2', task: 'fix a', phase: 'Fix', status: 'running' }]
  }

  function transcript(o: { meta?: boolean } = {}): TranscriptRow[] {
    return groupTranscript([
      message('user', 'ultracode audit'),
      workflowCard(paused, { continuedIn: 'workflow-wf_1-2', meta: o.meta }),
      member({ instance: 'gp#1', task: 'scan a', runId: 'wf_1', workflow: 'audit', phase: 'Scan', status: 'completed' }),
      childCall('gp#1', 'read', { file_path: 'a.go' }),
      message('user', 'fix the first one'),
      workflowCard(resumed, { meta: o.meta, rawInput: o.meta === false ? null : undefined }),
      member({ instance: 'gp#2', task: 'fix a', runId: 'wf_1', workflow: 'audit', phase: 'Fix' })
    ])
  }

  for (const meta of [true, false]) {
    describe(meta ? 'with metadata' : 'from the text', () => {
      it('marks the earlier card continued, still showing the pause', () => {
        const [first] = runs(transcript({ meta }))
        expect(first.continued).toBe(true)
        expect(first.status).toBe('paused')
        if (meta) expect(first.continuedIn).toBe('workflow-wf_1-2')
      })

      it('gives the later card every member, with the calls an earlier turn made', () => {
        const [, second] = runs(transcript({ meta }))
        expect(second.continued).toBe(false)
        expect(second.status).toBe('running')
        expect(second.runId).toBe('wf_1')
        expect(second.name).toBe('audit')
        const scan = second.phases.find((p) => p.title === 'Scan')
        expect(scan?.members[0].instance).toBe('gp#1')
        // Turn one's member call, children and all, found from turn two's card.
        expect(scan?.members[0].children).toHaveLength(1)
        expect(second.counts.total).toBe(2)
      })

      it('shows only the later card as live', () => {
        const live = activeRuns(transcript({ meta }))
        expect(live).toHaveLength(1)
        expect(live[0].tool.id).toBe('workflow-wf_1-2')
      })
    })
  }

  it('folds the model’s reply to the checkpoint into the run', () => {
    const rows = groupTranscript([
      workflowCard(paused, { continuedIn: 'workflow-wf_1-2' }),
      tool({
        title: 'workflow {"continue_run_id": "wf_1", "reply": {"fix": ["a"]}}',
        kind: 'think',
        argsJSON: JSON.stringify({ continue_run_id: 'wf_1', reply: { fix: ['a'] } }),
        output: '<workflow_result name="audit" run_id="wf_1">\n</workflow_result>'
      }),
      workflowCard(resumed)
    ])
    expect(rows.map((r) => r.kind)).toEqual(['run', 'run'])
  })

  it('keeps a refused reply visible, since it is the only place the refusal is said', () => {
    // internal/agent/workflow.go:456 — continuing under Ask first is refused.
    const rows = groupTranscript([
      workflowCard(paused),
      tool({
        title: 'workflow {"continue_run_id": "wf_1"}',
        kind: 'think',
        status: 'failed',
        argsJSON: JSON.stringify({ continue_run_id: 'wf_1', reply: 'go' }),
        output: 'workflow: continuing run wf_1 starts sub-agents again, which needs restricted or yolo permission (current: ask-first)'
      })
    ])
    expect(rows.map((r) => r.kind)).toEqual(['run', 'script'])
  })
})

describe('telling a run’s card from things that look like one', () => {
  it('never opens a run for an escaped checkpoint trace (desktop gap #21)', () => {
    // internal/acp/tools.go toolCallTitle: a progress trace that finds no open
    // card goes out as an ordinary call — `workflow audit ⏸ cp-2`, args with
    // `workflow` and no `agent`, exactly what a card's args look like.
    const rows = groupTranscript([
      tool({
        title: 'workflow audit ⏸ cp-2',
        kind: 'think',
        argsJSON: JSON.stringify({ run_id: 'wf_1', workflow: 'audit', kind: 'checkpoint', checkpoint_id: 'cp-2', message: 'm' })
      }),
      tool({
        title: 'workflow audit',
        kind: 'think',
        argsJSON: JSON.stringify({ run_id: 'wf_1', workflow: 'audit', checkpoint_id: 'cp-2', message: 'm' })
      })
    ])
    expect(runs(rows)).toEqual([])
  })

  it('recognises a re-announced card with no args by its id and title', () => {
    // A card a later turn opened through a member trace carries no rawInput
    // (announceWorkflowLocked(w, nil)), and an older desktop kept no meta.
    const rows = groupTranscript([
      workflowCard(
        { runId: 'wf_20261006_ab12cd34', name: 'audit', size: 'unbounded', budget: 1_500_000, attach: 2 },
        { meta: false, rawInput: null }
      )
    ])
    const run = onlyWorkflow(rows)
    expect(run.name).toBe('audit')
    expect(run.runId).toBe('wf_20261006_ab12cd34')
    expect(run.budgetTokens).toBe(1_500_000)
  })

  it('does not take a member’s own call for a card', () => {
    const rows = groupTranscript([
      workflowCard(AUDIT),
      member({ instance: 'gp#1', task: 'scan a', runId: 'wf_1', workflow: 'audit', phase: 'Scan' })
    ])
    expect(runs(rows)).toHaveLength(1)
  })
})

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
  runTitle,
  type SwarmRun,
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
  swarmMember,
  tool,
  ultra,
  workflowFinished,
  workflowStart
} from './wire'

beforeEach(resetWire)

function runs(rows: TranscriptRow[]): (WorkflowRun | SwarmRun)[] {
  return rows.flatMap((row) => (row.kind === 'run' ? [row.run] : []))
}

function onlyWorkflow(rows: TranscriptRow[]): WorkflowRun {
  const found = runs(rows).filter((r): r is WorkflowRun => r.kind === 'workflow')
  expect(found).toHaveLength(1)
  return found[0]
}

function onlySwarm(rows: TranscriptRow[]): SwarmRun {
  const found = runs(rows).filter((r): r is SwarmRun => r.kind === 'swarm')
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
      ultra({ items: ['a', 'b'] }),
      swarmMember({ instance: 'code#1', item: 'a' }),
      swarmMember({ instance: 'code#12', item: 'b' }),
      childCall('code#12', 'bash', { command: 'belongs to twelve' })
    ])
    const swarm = onlySwarm(rows)
    const one = swarm.members.find((m) => m.instance === 'code#1')
    const twelve = swarm.members.find((m) => m.instance === 'code#12')
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

describe('folding an Ultra swarm', () => {
  it('attaches members by position, since they carry no run id', () => {
    const rows = groupTranscript([
      ultra({ items: ['a', 'b'], subagentType: 'code' }),
      swarmMember({ instance: 'code#1', item: 'a' }),
      swarmMember({ instance: 'code#2', item: 'b' })
    ])
    expect(rows.map((r) => r.kind)).toEqual(['run'])
    expect(onlySwarm(rows).members).toHaveLength(2)
  })

  it('keeps two swarms in one turn apart', () => {
    const rows = groupTranscript([
      ultra({ items: ['a'] }),
      swarmMember({ instance: 'code#1', item: 'a' }),
      ultra({ items: ['b', 'c'] }),
      swarmMember({ instance: 'code#2', item: 'b' }),
      swarmMember({ instance: 'code#3', item: 'c' })
    ])
    const swarms = runs(rows).filter((r): r is SwarmRun => r.kind === 'swarm')
    expect(swarms.map((s) => s.members.length)).toEqual([1, 2])
  })

  it('counts un-launched items as pending work, not absent work', () => {
    // Ultra ramps: five at once, then one every 700ms. A ten-item swarm spends
    // its first seconds mostly un-launched, and a denominator that grows as
    // members appear makes the meter run backwards.
    const swarm = onlySwarm(
      groupTranscript([
        ultra({ items: ['a', 'b', 'c', 'd', 'e'] }),
        swarmMember({ instance: 'code#1', item: 'a', status: 'completed' }),
        swarmMember({ instance: 'code#2', item: 'b' })
      ])
    )
    expect(swarm.pending).toEqual(['c', 'd', 'e'])
    expect(swarm.counts.total).toBe(5)
    expect(swarm.counts.done).toBe(1)
    expect(swarm.counts.running).toBe(1)
  })

  it('reports worktree isolation and ignores any other value', () => {
    expect(
      onlySwarm(groupTranscript([ultra({ items: ['a'], isolation: 'worktree' })])).isolation
    ).toBe('worktree')
    expect(
      onlySwarm(groupTranscript([ultra({ items: ['a'], isolation: 'nonsense' })])).isolation
    ).toBe('')
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
      ultra({ items: ['x'] }),
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
      ultra({ items: ['a'] }),
      swarmMember({
        instance: 'code#1',
        item: 'a',
        status: 'completed',
        output: '{"content":"beta\\n","file":"b.txt"}'
      })
    ])
    const [m] = onlySwarm(rows).members
    expect(m.resultText).toContain('b.txt')
    expect(m.resultIsJSON).toBe(true)
  })

  it('is empty only when the member really said nothing', () => {
    const rows = groupTranscript([
      ultra({ items: ['a'] }),
      swarmMember({ instance: 'code#1', item: 'a', status: 'completed', output: '' })
    ])
    expect(onlySwarm(rows).members[0].resultText).toBe('')
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
        id: 'wf-1',
        runId: 'wf_1',
        name: 'done-one',
        agents: 1,
        rendered: renderedTree({ summary: '1 agents · 0 failed · 0 replayed', phases: [] })
      }),
      ultra({ items: ['a'] }),
      swarmMember({ instance: 'code#1', item: 'a' })
    ])
    const live = activeRuns(rows)
    expect(live).toHaveLength(1)
    expect(live[0].kind).toBe('swarm')
  })

  it('titles both kinds of run for the panel', () => {
    const rows = groupTranscript([
      workflowStart({ runId: 'wf_1', name: 'review-changes', phases: [] }),
      ultra({ items: ['a'], subagentType: 'code' })
    ])
    const titles = runs(rows).map(runTitle)
    expect(titles[0]).toContain('review-changes')
    expect(titles[1].toLowerCase()).toContain('swarm')
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
        tool({ title: 'ultra', argsJSON: '[]' })
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

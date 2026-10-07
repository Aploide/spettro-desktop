// @vitest-environment jsdom
//
// A run that died before any agent started has no member to carry the
// reason, so the card itself must say why — in words, not only behind a
// disclosure — and a run that worked must look finished, not merely quiet.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { WorkflowCard } from '@renderer/views/chat/transcript/WorkflowCard'
import {
  groupTranscript,
  plainWorkflowError,
  type WorkflowRun
} from '@renderer/views/chat/transcript/orchestration'
import { resetWire, workflowCard, type CardRun } from './wire'

beforeEach(() => resetWire())
afterEach(() => cleanup())

const base: CardRun = {
  runId: 'wf_1',
  name: 'typo-review',
  description: 'Review each file for typos',
  phases: [{ title: 'Review' }],
  logs: []
}

function runOf(card: ReturnType<typeof workflowCard>): WorkflowRun {
  const row = groupTranscript([card]).find((r) => r.kind === 'run')
  if (row?.kind !== 'run') throw new Error('no run row')
  return row.run
}

const PARSE_ERROR =
  'error: workflow "typo-review": script does not parse: SyntaxError: (anonymous): Line 35:177 Unexpected token )'

describe('plainWorkflowError', () => {
  it('names a syntax error and its line', () => {
    expect(plainWorkflowError(PARSE_ERROR)).toBe('The workflow script has a syntax error (line 35).')
  })
  it('names a missing saved workflow', () => {
    expect(
      plainWorkflowError('error: workflow: no saved workflow named "check-files" (looked in /tmp/x)')
    ).toBe('There’s no saved workflow named “check-files”.')
  })
  it('takes the plumbing off anything else', () => {
    expect(plainWorkflowError('error: workflow "x": budget exhausted')).toBe('Budget exhausted')
    expect(plainWorkflowError('')).toBe('')
  })
})

describe('the workflow card', () => {
  it('says why a run that never started failed, without the raw tree or an empty meter', () => {
    const run = runOf(workflowCard({ ...base, status: 'error', agents: [] }, { summary: PARSE_ERROR }))
    const { container } = render(<WorkflowCard run={run} />)
    expect(screen.getByText('The workflow script has a syntax error (line 35).')).toBeTruthy()
    expect(screen.getByText('Failed')).toBeTruthy()
    expect(screen.getByText('Not run')).toBeTruthy()
    expect(screen.queryByText(/raw tree/i)).toBeNull()
    expect(container.querySelector('.wfc-metrics .orch-meter')).toBeNull()
  })

  it('leaves the reason to the member when a member failed', () => {
    const run = runOf(
      workflowCard(
        {
          ...base,
          status: 'error',
          agents: [{ instance: 'review#1', task: 'review a', phase: 'Review', status: 'error' }]
        },
        { summary: '1 agent · 1 failed · 0 replayed' }
      )
    )
    const { container } = render(<WorkflowCard run={run} />)
    expect(container.querySelector('.wfc-state')).toBeNull()
  })

  it('marks a finished run done with a check, not a pill', () => {
    const run = runOf(
      workflowCard(
        {
          ...base,
          status: 'success',
          agents: [{ instance: 'review#1', task: 'review a', phase: 'Review', status: 'success' }]
        },
        { summary: '1 agent · 0 failed · 0 replayed' }
      )
    )
    const { container } = render(<WorkflowCard run={run} />)
    expect(screen.getByLabelText('Done')).toBeTruthy()
    expect(container.querySelector('.wfc-badge')).toBeNull()
  })
})

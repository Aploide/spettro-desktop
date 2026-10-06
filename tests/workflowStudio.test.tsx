// @vitest-environment jsdom
//
// The studio's rules are all about not lying to the user about what is on
// disk: Run executes the saved file, so an edited script has to be saved
// first; a CLI that cannot serve the surface at all must not be shown an
// empty state that reads as "no workflows yet"; and a compile failure has to
// stop a run before it starts. None of that is visible in a screenshot.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import WorkflowStudio from '@renderer/views/workflows/WorkflowStudio'

const calls: [string, unknown[]][] = []
let answers: Record<string, unknown | ((...args: unknown[]) => unknown)> = {}

vi.mock('@renderer/state/store', () => {
  const mocked = {
    call: (method: string, ...args: unknown[]) => {
      calls.push([method, args])
      const answer = answers[method]
      if (typeof answer === 'function') return Promise.resolve(answer(...args))
      return Promise.resolve(answer ?? null)
    },
    useChat: () => null
  }
  // quietCall is call without the failure toast; to a test they are one.
  return { ...mocked, quietCall: mocked.call }
})

const SCRIPT = "export const meta = { name: 'review', description: 'd', phases: [] }\n"

const INFO = {
  name: 'review',
  path: '/p/.spettro/workflows/review.js',
  scope: 'project' as const,
  description: 'd',
  whenToUse: '',
  phases: [{ title: 'Review', detail: '' }],
  error: null
}

const VALID = {
  ok: true,
  error: null,
  name: 'review',
  description: 'd',
  whenToUse: '',
  phases: [{ title: 'Review', detail: '' }]
}

beforeEach(() => {
  calls.length = 0
  answers = {
    workflowList: { workflows: [INFO], searchPaths: ['/p/.spettro/workflows'], cwd: '/p' },
    workflowRead: { ...INFO, script: SCRIPT },
    workflowValidate: VALID,
    workflowWrite: INFO,
    workflowRun: 'scratch-1'
  }
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

function made(method: string): [string, unknown[]][] {
  return calls.filter(([name]) => name === method)
}

async function openFirstWorkflow(): Promise<void> {
  render(<WorkflowStudio chatId="chat-1" onClose={() => undefined} />)
  await waitFor(() => expect(screen.getByText('review')).toBeTruthy())
  fireEvent.click(screen.getByText('review'))
  await waitFor(() => expect(made('workflowRead')).toHaveLength(1))
  // Let the debounced compile land so Run becomes reachable.
  await vi.advanceTimersByTimeAsync(600)
  await waitFor(() => expect(made('workflowValidate').length).toBeGreaterThan(0))
}

describe('opening a workflow', () => {
  it('lists what the project has and loads the one you pick', async () => {
    await openFirstWorkflow()
    expect(made('workflowList')).toHaveLength(1)
    expect(made('workflowRead')[0][1]).toEqual(['chat-1', 'review'])
    expect(screen.getByLabelText('Workflow script')).toBeTruthy()
  })

  it('compiles what is in the editor, not what was on disk', async () => {
    await openFirstWorkflow()
    const area = screen.getByLabelText('Workflow script')
    fireEvent.change(area, { target: { value: SCRIPT + '\nphase("X")\n' } })
    await vi.advanceTimersByTimeAsync(600)

    const last = made('workflowValidate').at(-1)!
    expect(String(last[1][1])).toContain('phase("X")')
  })

  it('waits for a pause before compiling, instead of firing per keystroke', async () => {
    await openFirstWorkflow()
    const before = made('workflowValidate').length
    const area = screen.getByLabelText('Workflow script')
    fireEvent.change(area, { target: { value: SCRIPT + 'a' } })
    fireEvent.change(area, { target: { value: SCRIPT + 'ab' } })
    fireEvent.change(area, { target: { value: SCRIPT + 'abc' } })
    await vi.advanceTimersByTimeAsync(600)

    expect(made('workflowValidate').length).toBe(before + 1)
  })
})

describe('running', () => {
  it('saves an edited script before running it', async () => {
    // Run executes the file on disk. Without this, Run would quietly test the
    // previous version and report on code the user is no longer looking at.
    await openFirstWorkflow()
    fireEvent.change(screen.getByLabelText('Workflow script'), {
      target: { value: SCRIPT + '\n// edited\n' }
    })
    await vi.advanceTimersByTimeAsync(600)

    fireEvent.click(screen.getByText('Run'))
    await waitFor(() => expect(made('workflowRun')).toHaveLength(1))

    expect(made('workflowWrite')).toHaveLength(1)
    expect(String(made('workflowWrite')[0][1][3])).toContain('// edited')
  })

  it('does not re-save a script that has not changed', async () => {
    await openFirstWorkflow()
    fireEvent.click(screen.getByText('Run'))
    await waitFor(() => expect(made('workflowRun')).toHaveLength(1))
    expect(made('workflowWrite')).toHaveLength(0)
  })

  it('refuses to run a script that does not compile', async () => {
    answers.workflowValidate = {
      ok: false,
      error: "SyntaxError: Unexpected token '}'",
      name: 'review',
      description: '',
      whenToUse: '',
      phases: []
    }
    await openFirstWorkflow()

    fireEvent.click(screen.getByText('Run'))
    await vi.advanceTimersByTimeAsync(100)

    expect(made('workflowRun')).toHaveLength(0)
    expect(screen.getByText(/SyntaxError/)).toBeTruthy()
  })
})

describe('saving', () => {
  it('saves into the project by default', async () => {
    await openFirstWorkflow()
    fireEvent.change(screen.getByLabelText('Workflow script'), { target: { value: SCRIPT + 'x' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(made('workflowWrite')).toHaveLength(1))

    const [chatId, name, scope] = made('workflowWrite')[0][1]
    expect(chatId).toBe('chat-1')
    expect(name).toBe('review')
    // A workflow automates a codebase, so the repo is where it belongs.
    expect(scope).toBe('project')
  })

  it('refreshes the list so a new script appears without reopening', async () => {
    await openFirstWorkflow()
    fireEvent.change(screen.getByLabelText('Workflow script'), { target: { value: SCRIPT + 'x' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(made('workflowList').length).toBeGreaterThan(1))
  })
})

describe('an older CLI', () => {
  it('says so, instead of showing an empty project', async () => {
    // The empty state reads as "no workflows yet" and invites the user to
    // write one into a CLI that cannot save it.
    answers.workflowList = () => {
      throw new Error("This version of the Spettro CLI doesn't support _spettro/workflow/list.")
    }
    render(<WorkflowStudio chatId="chat-1" onClose={() => undefined} />)

    await waitFor(() => expect(screen.getByText(/CLI is too old/i)).toBeTruthy())
    expect(screen.queryByText('+ New workflow')).toBeNull()
  })
})

describe('closing', () => {
  it('tears down a scratch run so nothing keeps burning tokens unwatched', async () => {
    await openFirstWorkflow()
    fireEvent.click(screen.getByText('Run'))
    await waitFor(() => expect(made('workflowRun')).toHaveLength(1))

    cleanup()
    expect(made('workflowDiscardRun')[0][1]).toEqual(['scratch-1'])
  })
})

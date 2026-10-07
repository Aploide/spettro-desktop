// @vitest-environment jsdom
//
// The inline question card: one question at a time, Enter in "Other…" is a
// newline (Ctrl/Cmd+Enter sends), the answers go out in the shape
// appModel.answerQuestion takes, "Skip all" declines, and Esc never throws
// typed answers away without asking. The form follows the CLI's
// `_spettro/question/ask` payload (docs/acp.md, version 2).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ACPQuestionRequest } from '@shared/acp'
import QuestionCard from '@renderer/views/chat/QuestionCard'
import { ARM_DELAY_MS } from '@renderer/views/chat/prompts'

const calls: [string, unknown[]][] = []

vi.mock('@renderer/state/store', () => {
  const mocked = {
    call: (method: string, ...args: unknown[]) => {
      calls.push([method, args])
      return Promise.resolve()
    }
  }
  // quietCall is call without the failure toast; to a test they are one.
  return { ...mocked, quietCall: mocked.call }
})

function form(): ACPQuestionRequest {
  return {
    id: 'q1',
    version: 2,
    sessionId: 'acp-1',
    chatId: 'c1',
    questions: [
      {
        id: 'q-1',
        header: 'Scope',
        question: 'Which files?',
        multiSelect: true,
        allowCustomInput: true,
        options: [
          { id: 'opt-1', label: 'The form', isRecommended: true },
          { id: 'opt-2', label: 'The button' },
          { id: 'opt-3', label: 'The tests', preview: 'it("saves once")' }
        ]
      },
      {
        id: 'q-2',
        header: 'Workflow',
        question: 'Run the "review" workflow? It spawns sub-agents, so it costs real tokens.',
        multiSelect: false,
        allowCustomInput: false,
        options: [
          { id: 'run', label: 'Run it', isRecommended: true },
          { id: 'save', label: "Save it, don't run" },
          { id: 'no', label: "Don't run it" }
        ]
      }
    ]
  }
}

const answers = (): unknown[][] => calls.filter((c) => c[0] === 'answerQuestion').map((c) => c[1])

function arm(): void {
  act(() => {
    vi.advanceTimersByTime(ARM_DELAY_MS)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  calls.length = 0
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the question card', () => {
  it('shows one question at a time with a step indicator', () => {
    render(<QuestionCard request={form()} />)
    expect(screen.getByText('Question 1 of 2')).toBeTruthy()
    expect(screen.getByText('Which files?')).toBeTruthy()
    expect(screen.queryByText(/Run the "review" workflow/)).toBeNull()
    expect(screen.getByText('Recommended')).toBeTruthy()
    fireEvent.click(screen.getByTestId('question-submit'))
    expect(screen.getByText('Question 2 of 2')).toBeTruthy()
  })

  it('makes Enter in "Other…" a newline, and Ctrl+Enter send', () => {
    const one = form()
    one.questions = [{ ...one.questions[0], multiSelect: false }]
    render(<QuestionCard request={one} />)
    arm()
    fireEvent.click(screen.getByTestId('question-option-other'))
    const field = screen.getByLabelText('Your own answer') as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: 'Only the header' } })
    const notPrevented = fireEvent.keyDown(field, { key: 'Enter' })
    expect(notPrevented).toBe(true) // the textarea gets its newline
    expect(answers()).toEqual([])
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true })
    expect(answers()).toEqual([['q1', [{ questionId: 'q-1', kind: 'custom', text: 'Only the header' }]]])
  })

  it('sends a multi-select answer as option ids, in option order', () => {
    render(<QuestionCard request={form()} />)
    arm()
    fireEvent.click(screen.getByTestId('question-option-opt-3'))
    fireEvent.click(screen.getByTestId('question-option-opt-1'))
    fireEvent.click(screen.getByTestId('question-submit')) // Next
    fireEvent.click(screen.getByTestId('question-option-run'))
    fireEvent.click(screen.getByTestId('question-submit')) // Send answers
    expect(answers()).toEqual([
      [
        'q1',
        [
          { questionId: 'q-1', kind: 'option', optionIds: ['opt-1', 'opt-3'] },
          { questionId: 'q-2', kind: 'option', optionId: 'run', optionIds: ['run'] }
        ]
      ]
    ])
  })

  it('declines the whole form from "Skip all"', () => {
    render(<QuestionCard request={form()} />)
    arm()
    fireEvent.click(screen.getByTestId('question-skip'))
    expect(answers()).toEqual([['q1', null]])
  })

  it('declines on Esc when nothing was answered, and asks first when something was', () => {
    render(<QuestionCard request={form()} />)
    arm()
    fireEvent.click(screen.getByTestId('question-option-opt-2'))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(answers()).toEqual([])
    expect(screen.getByText('Discard your answers?')).toBeTruthy()
    // Esc again backs out of the question, keeping the answers.
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByText('Discard your answers?')).toBeNull()
    expect(screen.getByTestId('question-option-opt-2').getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    fireEvent.click(screen.getByTestId('question-discard'))
    expect(answers()).toEqual([['q1', null]])

    cleanup()
    calls.length = 0
    render(<QuestionCard request={{ ...form(), id: 'q2' }} />)
    arm()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(answers()).toEqual([['q2', null]])
  })

  it('picks with the digits, and only once armed', () => {
    render(<QuestionCard request={form()} />)
    fireEvent.keyDown(document.body, { key: '2' })
    expect(screen.getByTestId('question-option-opt-2').getAttribute('aria-checked')).toBe('false')
    arm()
    fireEvent.keyDown(document.body, { key: '2' })
    expect(screen.getByTestId('question-option-opt-2').getAttribute('aria-checked')).toBe('true')
  })

  it('opens a preview on request', () => {
    render(<QuestionCard request={form()} />)
    expect(screen.queryByText('it("saves once")')).toBeNull()
    fireEvent.click(screen.getByText('Preview'))
    expect(screen.getByText('it("saves once")')).toBeTruthy()
  })
})

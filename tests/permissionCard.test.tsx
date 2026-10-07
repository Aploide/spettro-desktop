// @vitest-environment jsdom
//
// The inline approval card, as a user meets it: it can't be answered by a
// key or a click meant for something else, Enter never approves, the
// buttons sit in one order whatever the agent sent, a diff previews from
// the request's content, and only the asking chat shows it. Request shapes
// follow internal/acp/permission.go (requestApproval, approvalContent) and
// compaction.go (askCompactPermission).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ACPPermissionRequest, ACPQuestionRequest } from '@shared/acp'
import type { ChatDetail } from '@shared/model'
import PermissionCard from '@renderer/views/chat/PermissionCard'
import PromptDock from '@renderer/views/chat/PromptDock'
import { ARM_DELAY_MS, orderedOptions, permissionBody } from '@renderer/views/chat/prompts'

const calls: [string, unknown[]][] = []
const store: { permissions: ACPPermissionRequest[]; questions: ACPQuestionRequest[] } = {
  permissions: [],
  questions: []
}

vi.mock('@renderer/state/store', () => {
  const mocked = {
    call: (method: string, ...args: unknown[]) => {
      calls.push([method, args])
      return Promise.resolve()
    },
    useStore: <T,>(select: (s: typeof store) => T): T => select(store)
  }
  // quietCall is call without the failure toast; to a test they are one.
  return { ...mocked, quietCall: mocked.call }
})

function bash(o: Partial<ACPPermissionRequest> = {}): ACPPermissionRequest {
  return {
    id: 'p1',
    sessionId: 'acp-1',
    chatId: 'c1',
    toolCallId: 'call-3',
    title: 'Run npm test',
    toolKind: 'execute',
    content: { texts: ['```sh\nnpm test\n```', 'Runs the suite after the edit.'], diffs: [] },
    locations: [],
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow-always', name: 'Always allow this command', kind: 'allow_always' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
    ],
    ...o
  }
}

function chat(id = 'c1'): ChatDetail {
  return {
    id,
    title: 'Fix it',
    projectPath: '/app',
    acpSessionId: 'acp-1',
    isPinned: false,
    isArchived: false,
    isBusy: true,
    createdAt: 1,
    items: [],
    configOptions: [],
    commands: [],
    plan: [],
    usage: null,
    lastTurn: null,
    sessionTokens: 0
  }
}

const resolved = (): unknown[][] => calls.filter((c) => c[0] === 'resolvePermission').map((c) => c[1])

function arm(): void {
  act(() => {
    vi.advanceTimersByTime(ARM_DELAY_MS)
  })
}

function press(key: string, target: Element | Document = document.body, init: KeyboardEventInit = {}): boolean {
  let notPrevented = true
  act(() => {
    notPrevented = fireEvent.keyDown(target, { key, ...init })
  })
  return notPrevented
}

beforeEach(() => {
  vi.useFakeTimers()
  calls.length = 0
  store.permissions = []
  store.questions = []
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('the approval card', () => {
  it('never approves on Enter — on the page or on a focused Allow button', () => {
    render(<PermissionCard request={bash()} />)
    arm()
    press('Enter')
    const allow = screen.getByTestId('permission-allow-once')
    allow.focus()
    const notPrevented = press('Enter', allow)
    expect(notPrevented).toBe(false) // the button's own Enter-click is stopped
    expect(resolved()).toEqual([])
  })

  it('ignores keys and clicks until it has been up for a moment', () => {
    render(<PermissionCard request={bash()} />)
    press('1')
    fireEvent.click(screen.getByTestId('permission-allow-once'))
    expect(resolved()).toEqual([])
    arm()
    press('1')
    expect(resolved()).toEqual([['p1', 'allow-once']])
  })

  it('ignores its keys while focus is in a text field, even once armed', () => {
    const field = document.createElement('textarea')
    field.className = 'composer-input'
    document.body.appendChild(field)
    render(<PermissionCard request={bash()} />)
    arm()
    act(() => field.focus())
    press('1', field)
    press('3', field)
    press('Escape', field)
    expect(resolved()).toEqual([])
    // …and says how to get to it.
    act(() => {
      vi.runOnlyPendingTimers()
    })
    const hints = Array.from(document.querySelectorAll('.prompt-hint')).map((h) => h.textContent)
    expect(hints).toContain('Press Tab to review')
  })

  it('leaves the keys to a dialog open in front of it, modal or not', () => {
    // The tool-image viewer is a role="dialog" without aria-modal.
    const viewer = document.createElement('div')
    viewer.setAttribute('role', 'dialog')
    viewer.tabIndex = -1
    document.body.appendChild(viewer)
    render(<PermissionCard request={bash()} />)
    arm()
    act(() => viewer.focus())
    press('1', viewer)
    press('Escape', viewer)
    expect(resolved()).toEqual([])
    viewer.remove()
    press('1')
    expect(resolved()).toEqual([['p1', 'allow-once']])
  })

  it('takes 1/2/3 in its own order and Esc as Deny', () => {
    render(<PermissionCard request={bash()} />)
    arm()
    press('2')
    expect(resolved()).toEqual([['p1', 'allow-always']])
    cleanup()
    calls.length = 0
    render(<PermissionCard request={bash({ id: 'p2' })} />)
    arm()
    press('Escape')
    expect(resolved()).toEqual([['p2', 'deny']])
  })

  it('answers once, however fast the keys come', () => {
    render(<PermissionCard request={bash()} />)
    arm()
    press('1')
    press('1')
    press('3')
    expect(resolved()).toEqual([['p1', 'allow-once']])
  })

  it('puts the buttons in a fixed order whatever order the agent sent', () => {
    const shuffled = bash({
      options: [
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        { optionId: 'allow-always', name: 'Always allow this command', kind: 'allow_always' },
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }
      ]
    })
    render(<PermissionCard request={shuffled} />)
    const labels = Array.from(document.querySelectorAll('.prompt-actions .prompt-btn')).map(
      (b) => b.textContent
    )
    expect(labels).toEqual(['Allow once', 'Always allow', 'Deny'])
    // The CLI's scope for "always" is the caption, not the label.
    expect(screen.getByText('Always allow this command')).toBeTruthy()
    arm()
    press('1')
    expect(resolved()).toEqual([['p1', 'allow-once']])
  })

  it('orders by name when the agent leaves the kinds out', () => {
    const roles = orderedOptions(
      bash({
        options: [
          { optionId: 'n', name: 'Deny' },
          { optionId: 'a', name: 'Always allow' },
          { optionId: 'y', name: 'Allow' }
        ]
      })
    ).map((o) => o.option.optionId)
    expect(roles).toEqual(['y', 'a', 'n'])
  })

  it('shows the command and the reason from content', () => {
    render(<PermissionCard request={bash()} />)
    expect(screen.getByText('Spettro wants to run a command')).toBeTruthy()
    expect(screen.getByLabelText('Command').textContent).toBe('npm test')
    expect(screen.getByText('Runs the suite after the edit.')).toBeTruthy()
  })

  it('previews a diff from content, capped with "Show full diff"', () => {
    const oldText = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') + '\n'
    const newText = Array.from({ length: 60 }, (_, i) => `changed ${i}`).join('\n') + '\n'
    const edit = bash({
      title: '',
      toolKind: 'edit',
      content: { texts: [], diffs: [{ type: 'diff', path: '/app/src/a.ts', oldText, newText }] },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
      ]
    })
    render(<PermissionCard request={edit} />)
    expect(screen.getByText('Spettro wants to edit a.ts')).toBeTruthy()
    expect(screen.getByText('line 0')).toBeTruthy()
    expect(document.querySelectorAll('.tr-diff-line').length).toBe(30)
    fireEvent.click(screen.getByText('Show full diff'))
    expect(document.querySelectorAll('.tr-diff-line').length).toBe(120)
  })

  it('asks the compaction question in its own words, and Esc continues', () => {
    const compact: ACPPermissionRequest = bash({
      id: 'p9',
      toolCallId: 'compact-1',
      title: 'Context nearly full (~182000/200000 tokens). Compact conversation history now?',
      toolKind: 'think',
      content: { texts: [], diffs: [] },
      variant: 'compact',
      options: [
        { optionId: 'compact', name: 'Compact now', kind: 'allow_once' },
        { optionId: 'continue', name: 'Continue without compacting', kind: 'reject_once' }
      ]
    })
    const onDenied = vi.fn()
    render(<PermissionCard request={compact} onDenied={onDenied} />)
    expect(screen.getByText('This conversation is almost full')).toBeTruthy()
    expect(screen.getByText(/About 182k of 200k tokens/)).toBeTruthy()
    const labels = Array.from(document.querySelectorAll('.prompt-actions .prompt-btn')).map(
      (b) => b.textContent
    )
    expect(labels).toEqual(['Compact now', 'Continue without compacting'])
    arm()
    press('Escape')
    expect(resolved()).toEqual([['p9', 'continue']])
    // Not a denial worth a "what instead?".
    expect(onDenied).not.toHaveBeenCalled()
  })

  it('reads fenced command blocks, clipped ones included', () => {
    const blocks = permissionBody(
      bash({
        content: {
          texts: ['````sh\necho ```\n````\n\n[truncated: 4 KB more]', 'needs approval: rm -rf dist'],
          diffs: []
        }
      })
    )
    expect(blocks).toEqual([
      { type: 'code', lang: 'sh', text: 'echo ```' },
      { type: 'note', text: '[truncated: 4 KB more]' },
      { type: 'note', text: 'Needs your approval: rm -rf dist' }
    ])
    // The runtime's stock reason restates the headline, and "needs
    // approval" naming the whole command shown above repeats it: both go
    // (the live `touch` approval read "non-whitelisted command requires
    // approval / needs approval: touch review.txt").
    expect(
      permissionBody(
        bash({
          content: {
            texts: [
              '```sh\ntouch review.txt\n```',
              'non-whitelisted command requires approval\nneeds approval: touch review.txt'
            ],
            diffs: []
          }
        })
      )
    ).toEqual([{ type: 'code', lang: 'sh', text: 'touch review.txt' }])
    // A network approval shows its target, not the runtime's "network <tool>".
    expect(
      permissionBody(
        bash({
          toolKind: 'fetch',
          content: { texts: ['```\nnetwork web-fetch https://registry.npmjs.org/react\n```'], diffs: [] }
        })
      )
    ).toEqual([{ type: 'code', lang: '', text: 'https://registry.npmjs.org/react' }])
    // An older CLI sent only rawInput.
    expect(permissionBody(bash({ content: { texts: [], diffs: [] }, rawInput: { command: 'ls' } }))).toEqual([
      { type: 'code', lang: 'sh', text: 'ls' }
    ])
  })
})

describe('the prompt dock', () => {
  it('shows only the asking chat\'s approval, with its place in the queue', () => {
    store.permissions = [
      bash({ id: 'other', chatId: 'c2', title: 'Run make' }),
      bash({ id: 'mine', chatId: 'c1' }),
      bash({ id: 'mine-2', chatId: 'c1', title: 'Run npm run lint' })
    ]
    render(<PromptDock chat={chat('c1')} />)
    expect(screen.getAllByTestId('permission-card')).toHaveLength(1)
    expect(screen.getByText('1 of 2')).toBeTruthy()
    arm()
    press('1')
    expect(resolved()).toEqual([['mine', 'allow-once']])
  })

  it('shows nothing for a chat with nothing waiting', () => {
    store.permissions = [bash({ chatId: 'c2' })]
    render(<PromptDock chat={chat('c1')} />)
    expect(screen.queryByTestId('permission-card')).toBeNull()
  })

  it('moves focus from the composer to the card on Tab', () => {
    store.permissions = [bash()]
    const field = document.createElement('textarea')
    field.className = 'composer-input'
    document.body.appendChild(field)
    render(<PromptDock chat={chat('c1')} />)
    field.focus()
    press('Tab', field)
    expect(document.activeElement).toBe(screen.getByTestId('permission-card'))
  })

  it('after Deny, offers to tell Spettro what to do instead', () => {
    store.permissions = [bash()]
    const view = render(<PromptDock chat={chat('c1')} />)
    arm()
    fireEvent.click(screen.getByTestId('permission-deny'))
    expect(resolved()).toEqual([['p1', 'deny']])
    // Main takes the request off the queue.
    store.permissions = []
    view.rerender(<PromptDock chat={{ ...chat('c1') }} />)
    const field = screen.getByTestId('deny-feedback') as HTMLTextAreaElement
    expect(document.activeElement).toBe(field)
    fireEvent.change(field, { target: { value: 'Use pnpm instead' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(calls.find((c) => c[0] === 'send')?.[1]).toEqual(['c1', 'Use pnpm instead', []])
    expect(screen.queryByTestId('deny-feedback')).toBeNull()
  })
})

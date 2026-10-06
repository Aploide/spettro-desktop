// @vitest-environment jsdom
//
// Esc in the chat: it interrupts a running turn from the composer, but not
// while an approval or a question is up — there the sheet takes Esc as
// "deny" / "skip", and a deny must not also throw the whole turn away.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { MainEvent } from '@shared/ipc'
import type { ChatDetail } from '@shared/model'
import { initStore } from '@renderer/state/store'
import ChatView from '@renderer/views/chat/ChatView'

// The terminal drawer brings xterm, which jsdom can't draw; Esc never
// involves it.
vi.mock('@renderer/views/terminal/TerminalDrawer', () => ({ default: () => null }))

const chat: ChatDetail = {
  id: 'c1',
  title: 'Fix the bug',
  projectPath: '/app',
  acpSessionId: 'acp-1',
  isPinned: false,
  isArchived: false,
  isBusy: true,
  createdAt: 1,
  items: [
    {
      kind: 'message',
      message: { id: 'u1', role: 'user', text: 'go', attachments: [], isStreaming: false, timestamp: 1 }
    }
  ],
  configOptions: [],
  commands: [],
  plan: [],
  usage: null,
  lastTurn: null,
  sessionTokens: 0
}

/** Node's own `localStorage` (undefined without --localstorage-file)
 *  shadows jsdom's; the panel remembers its visibility there. */
function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => void data.set(k, String(v))
  }
}

let push: (event: MainEvent) => void = () => undefined
const calls: unknown[][] = []

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true })
  calls.length = 0
  ;(window as unknown as { spettro: unknown }).spettro = {
    platform: 'linux',
    onEvent: (cb: (event: MainEvent) => void) => {
      push = cb
      return () => undefined
    },
    call: (...args: unknown[]) => {
      calls.push(args)
      const answers: Record<string, unknown> = { getChat: chat, gitStat: { branch: 'main', files: [] } }
      return Promise.resolve(answers[args[0] as string] ?? null)
    }
  }
  initStore()
  act(() => push({ type: 'chat-reset', chat }))
  act(() => push({ type: 'permissions', requests: [] }))
  act(() => push({ type: 'questions', requests: [] }))
})

afterEach(cleanup)

const cancels = (): number => calls.filter((c) => c[0] === 'cancel').length

function pressEscInComposer(): void {
  const input = document.querySelector('.composer-input') as HTMLElement
  expect(input).toBeTruthy()
  input.focus()
  fireEvent.keyDown(input, { key: 'Escape' })
}

describe('Esc in the chat', () => {
  it('interrupts a running turn from the composer', () => {
    render(<ChatView chatId="c1" />)
    pressEscInComposer()
    expect(cancels()).toBe(1)
  })

  it('leaves the turn alone while an approval is up (Esc denies that instead)', () => {
    render(<ChatView chatId="c1" />)
    act(() =>
      push({
        type: 'permissions',
        requests: [
          {
            id: 'p1',
            sessionId: 'acp-1',
            chatId: 'c1',
            toolCallId: 't1',
            title: 'Run rm -rf dist',
            content: { texts: [], diffs: [] },
            locations: [],
            options: []
          }
        ]
      })
    )
    pressEscInComposer()
    expect(cancels()).toBe(0)
  })

  it('does nothing when no turn is running', () => {
    act(() => push({ type: 'chat-reset', chat: { ...chat, isBusy: false } }))
    render(<ChatView chatId="c1" />)
    pressEscInComposer()
    expect(cancels()).toBe(0)
  })
})

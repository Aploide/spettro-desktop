// @vitest-environment jsdom
//
// The transcript follows its tail. Two ways it used to let go of it, both
// seen in the live app: a scroll event that arrived after more of a reply
// had landed read as the reader leaving (so the next message stayed below
// the fold behind "Latest message"), and the user's own message didn't
// bring the column back down once it had let go. And the "Latest message"
// pill floated over the command menu that opens up from the composer.

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { MainEvent } from '@shared/ipc'
import type { ChatDetail, TranscriptItem } from '@shared/model'
import { initStore } from '@renderer/state/store'
import ChatView from '@renderer/views/chat/ChatView'

vi.mock('@renderer/views/terminal/TerminalDrawer', () => ({ default: () => null }))

function message(id: string, role: 'user' | 'assistant', text: string): TranscriptItem {
  return { kind: 'message', message: { id, role, text, attachments: [], isStreaming: false, timestamp: 1 } }
}

const chat: ChatDetail = {
  id: 'c1',
  title: 'Help',
  projectPath: '/app',
  acpSessionId: 'acp-1',
  isPinned: false,
  isArchived: false,
  isBusy: false,
  createdAt: 1,
  items: [message('u1', 'user', '/help'), message('a1', 'assistant', 'commands: …')],
  configOptions: [],
  commands: [],
  plan: [],
  usage: null,
  lastTurn: null,
  sessionTokens: 0
}

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

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true })
  ;(window as unknown as { spettro: unknown }).spettro = {
    platform: 'linux',
    onEvent: (cb: (event: MainEvent) => void) => {
      push = cb
      return () => undefined
    },
    call: (method: string) =>
      Promise.resolve(({ getChat: chat, gitStat: { branch: 'main', files: [] } } as Record<string, unknown>)[method] ?? null)
  }
  initStore()
  act(() => push({ type: 'chat-reset', chat }))
  act(() => push({ type: 'permissions', requests: [] }))
  act(() => push({ type: 'questions', requests: [] }))
})

afterEach(cleanup)

/** jsdom lays nothing out: give the transcript a 500px window on 1000px of
 *  content, and a scrollTop that keeps what it is set to. */
function geometry(): { el: HTMLElement; top: () => number; setTop: (v: number) => void } {
  const el = document.querySelector('.chat-transcript') as HTMLElement
  let top = 0
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 1000 })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 500 })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.min(v, 500)
    }
  })
  return { el, top: () => top, setTop: (v) => (top = v) }
}

const jumpPill = (): HTMLElement | null => screen.queryByRole('button', { name: 'Jump to latest message' })

describe('following the tail', () => {
  it('keeps following when a scroll event lands after the reply grew', () => {
    render(<ChatView chatId="c1" />)
    const g = geometry()
    // Put at the bottom of a shorter column; the reply then grew by 112px
    // before the scroll event was delivered.
    g.setTop(388)
    fireEvent.scroll(g.el)
    expect(g.top()).toBe(500)
    expect(jumpPill()).toBeNull()
  })

  it('lets go when the reader scrolls up, and comes back for their own message', () => {
    render(<ChatView chatId="c1" />)
    const g = geometry()
    g.setTop(500)
    fireEvent.scroll(g.el)
    fireEvent.wheel(g.el, { deltaY: -120 })
    g.setTop(200)
    fireEvent.scroll(g.el)
    expect(jumpPill()).toBeTruthy()

    // A reply streaming in while they read leaves them where they are…
    act(() => push({ type: 'chat-reset', chat: { ...chat, items: [...chat.items, message('a2', 'assistant', 'more')] } }))
    expect(g.top()).toBe(200)

    // …but what they send themselves brings the column down to it.
    act(() =>
      push({
        type: 'chat-reset',
        chat: { ...chat, items: [...chat.items, message('a2', 'assistant', 'more'), message('u2', 'user', '/plan hello')] }
      })
    )
    expect(g.top()).toBe(500)
    expect(jumpPill()).toBeNull()
  })
})

describe('the "Latest message" pill', () => {
  it('sits under the composer, whose menus open up over the transcript', () => {
    const css = readFileSync(resolve(__dirname, '../src/renderer/src/views/chat/chat.css'), 'utf8')
    const z = (selector: string): number => {
      const block = new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')} \\{([^}]*)\\}`).exec(css)?.[1] ?? ''
      return Number(/z-index:\s*(\d+)/.exec(block)?.[1] ?? 0)
    }
    expect(z('.chat-jump-latest')).toBeGreaterThan(0)
    expect(z('.composer-outer')).toBeGreaterThan(z('.chat-jump-latest'))
  })
})

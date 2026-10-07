// @vitest-environment jsdom
//
// What one streamed chunk costs the window. A long chat used to redraw every
// row of its transcript for each chunk main sent — thousands of components,
// hundreds of times a second — and every tool row re-parsed its arguments
// and rescanned its whole output on each of those redraws. These guard the
// properties that keep it cheap: the views hear of streaming changes once a
// frame, a chunk redraws the row it changed and no other, and a tool row's
// derived facts are computed once per call, not once per render.

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { MainEvent } from '@shared/ipc'
import type { ChatDetail, ToolCallItem, TranscriptItem } from '@shared/model'

vi.mock('@renderer/views/terminal/TerminalDrawer', () => ({ default: () => null }))

/** How many times each message's markdown was drawn, by its text. */
const drawn: string[] = []
vi.mock('@renderer/views/chat/transcript/MarkdownText', () => ({
  MarkdownText: ({ source }: { source: string }) => {
    drawn.push(source)
    return <div className="md">{source}</div>
  }
}))

function message(id: string, role: 'user' | 'assistant', text: string): TranscriptItem {
  return { kind: 'message', message: { id, role, text, attachments: [], isStreaming: false, timestamp: 1 } }
}

function longChat(n: number): ChatDetail {
  const items: TranscriptItem[] = []
  for (let i = 0; i < n; i++) {
    items.push(message(`u${i}`, 'user', `question ${i}`))
    items.push(message(`a${i}`, 'assistant', `answer ${i}`))
  }
  return {
    id: 'c1',
    title: 'Long',
    projectPath: '/app',
    acpSessionId: 'acp-1',
    isPinned: false,
    isArchived: false,
    isBusy: true,
    createdAt: 1,
    items,
    configOptions: [],
    commands: [],
    plan: [],
    usage: null,
    lastTurn: null,
    sessionTokens: 0
  }
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

/** A fresh store module, wired to a fake bridge. */
async function freshStore(): Promise<typeof import('@renderer/state/store')> {
  vi.resetModules()
  ;(window as unknown as { spettro: unknown }).spettro = {
    platform: 'linux',
    onEvent: (cb: (event: MainEvent) => void) => {
      push = cb
      return () => undefined
    },
    call: (method: string) =>
      Promise.resolve(method === 'gitStat' ? { branch: 'main', files: [] } : null)
  }
  const store = await import('@renderer/state/store')
  store.initStore()
  return store
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true })
  drawn.length = 0
})
afterEach(cleanup)

describe('the store', () => {
  const act_ = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  let saved: boolean | undefined
  beforeEach(() => {
    // Outside act(), as in the app.
    saved = act_.IS_REACT_ACT_ENVIRONMENT
    act_.IS_REACT_ACT_ENVIRONMENT = false
  })
  afterEach(() => {
    act_.IS_REACT_ACT_ENVIRONMENT = saved
  })

  it('tells the views of a frame’s streamed changes once, in the frame, with the state already current', async () => {
    const frames: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb))
    try {
      const store = await freshStore()
      const chat = longChat(2)
      push({ type: 'chat-reset', chat })
      const heard = vi.fn()
      const stop = store.subscribe(heard)
      for (let i = 0; i < 20; i++) {
        push({ type: 'chat-item', chatId: 'c1', item: message('a1', 'assistant', `answer ${'.'.repeat(i)}`) })
      }
      push({ type: 'chat-meta', chatId: 'c1', meta: { isBusy: false } })
      // Current at once for whoever reads it…
      const items = store.getState().chats.c1.items
      expect(items[items.length - 1]).toEqual(message('a1', 'assistant', `answer ${'.'.repeat(19)}`))
      expect(store.getState().chats.c1.isBusy).toBe(false)
      // …and the same item replaced in place, not appended.
      expect(items).toHaveLength(4)
      // The views: nothing yet, then once.
      expect(heard).not.toHaveBeenCalled()
      expect(frames).toHaveLength(1)
      frames[0](0)
      expect(heard).toHaveBeenCalledTimes(1)
      stop()
    } finally {
      raf.mockRestore()
    }
  })

  it('says at once what changes what the window is, and takes what was owed with it', async () => {
    const frames: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb))
    try {
      const store = await freshStore()
      push({ type: 'chat-reset', chat: longChat(1) })
      const heard = vi.fn()
      const stop = store.subscribe(heard)
      push({ type: 'chat-item', chatId: 'c1', item: message('a0', 'assistant', 'more') })
      expect(heard).not.toHaveBeenCalled()
      push({ type: 'permissions', requests: [] })
      expect(heard).toHaveBeenCalledTimes(1)
      // Nothing left owed for the frame to repeat.
      frames.forEach((f) => f(0))
      expect(heard).toHaveBeenCalledTimes(1)
      stop()
    } finally {
      raf.mockRestore()
    }
  })

  it('catches up without frames while the window is hidden', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    try {
      const store = await freshStore()
      push({ type: 'chat-reset', chat: longChat(1) })
      const heard = vi.fn()
      const stop = store.subscribe(heard)
      push({ type: 'chat-item', chatId: 'c1', item: message('a0', 'assistant', 'more') })
      vi.advanceTimersByTime(99)
      expect(heard).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(heard).toHaveBeenCalledTimes(1)
      stop()
    } finally {
      raf.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('a streamed chunk in a long chat', () => {
  it('redraws the row it changed, and no other', async () => {
    const store = await freshStore()
    const { default: ChatView } = await import('@renderer/views/chat/ChatView')
    const chat = longChat(40)
    act(() => push({ type: 'chat-reset', chat }))
    render(<ChatView chatId="c1" />)
    expect(drawn.length).toBeGreaterThanOrEqual(40)
    drawn.length = 0
    act(() => push({ type: 'chat-item', chatId: 'c1', item: message('a39', 'assistant', 'answer 39, and more') }))
    expect(drawn).toEqual(['answer 39, and more'])
    // The turn ending (a meta change) redraws no row at all.
    drawn.length = 0
    act(() => push({ type: 'chat-meta', chatId: 'c1', meta: { isBusy: false } }))
    expect(drawn).toEqual([])
    expect(store.getState().chats.c1.isBusy).toBe(false)
  })

  it('leaves the transcript alone when only the shell around it changes', async () => {
    await freshStore()
    const { default: ChatView } = await import('@renderer/views/chat/ChatView')
    act(() => push({ type: 'chat-reset', chat: longChat(10) }))
    const { rerender } = render(<ChatView chatId="c1" />)
    drawn.length = 0
    rerender(<ChatView chatId="c1" />)
    expect(drawn).toEqual([])
  })
})

describe('a tool row’s derived facts', () => {
  const tool = (over: Partial<ToolCallItem>): ToolCallItem => ({
    id: 't1',
    title: 'bash {"command":"npm test"}',
    kind: 'execute',
    status: 'completed',
    output: '',
    diffs: [],
    locations: [],
    ...over
  }) as ToolCallItem

  it('parses a call’s arguments once, however often it is asked', async () => {
    const { parsedTitle } = await import('@renderer/views/chat/transcript/toolPresentation')
    const t = tool({ argsJSON: '{"command":"npm test"}' })
    const parse = vi.spyOn(JSON, 'parse')
    try {
      for (let i = 0; i < 10; i++) expect(parsedTitle(t).args).toEqual({ command: 'npm test' })
      expect(parse).toHaveBeenCalledTimes(1)
      // A different call object (the store's replacement) is parsed afresh.
      parsedTitle({ ...t, argsJSON: '{"command":"ls"}' })
      expect(parse).toHaveBeenCalledTimes(2)
    } finally {
      parse.mockRestore()
    }
  })

  it('reads the exit code and counts lines without scanning the output as a copy', async () => {
    const { exitCode, rowMeta } = await import('@renderer/views/chat/transcript/toolPresentation')
    const big = 'x'.repeat(2_000_000)
    expect(exitCode(`${big}\n[exit status 3]\n  \n`)).toBe(3)
    expect(exitCode(`${big}\nexit status 12`)).toBe(12)
    expect(exitCode(`${big}\n`)).toBeNull()
    expect(rowMeta(tool({ kind: 'read', title: 'read {"path":"a.ts"}', output: 'a\nb\nc\n\n  ' }))).toBe('3 lines')
    expect(rowMeta(tool({ kind: 'read', title: 'read {"path":"a.ts"}', output: ' \n\t' }))).toBeNull()
    expect(rowMeta(tool({ kind: 'search', title: 'grep {"pattern":"x"}', output: '\n  No matches found' }))).toBe(
      'no results'
    )
  })
})

describe('what the stylesheets keep off the main thread', () => {
  const css = (file: string): string => readFileSync(resolve(__dirname, '../src/renderer/src', file), 'utf8')

  it('skips the style, layout and paint of transcript rows out of sight', () => {
    expect(css('views/chat/chat.css')).toMatch(
      /\.chat-transcript-inner > :not\([^)]*\) \{[^}]*content-visibility: auto;[^}]*contain-intrinsic-block-size: auto/
    )
  })

  it('steps the moving text it draws (the lit phrase: idleCost.test.tsx)', () => {
    expect(css('views/chat/transcript/transcript.css')).toMatch(/animation: tr-shimmer 2s steps\(\d+\) infinite/)
    expect(css('views/chat/chat.css')).toMatch(/animation: todo-shimmer 2\.4s steps\(\d+\) infinite/)
  })

  it('moves the thinking thumb and fill by transform, and breathes by opacity', () => {
    const slider = css('views/chat/thinkingSlider.css')
    for (const [, value] of slider.matchAll(/transition:([^;]*);/g)) {
      expect(value).not.toMatch(/\b(left|width)\b/)
    }
    for (const name of ['thinking-ultra-breathe', 'thinking-ultra-breathe-in']) {
      const body = new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`).exec(slider)?.[1] ?? ''
      expect(body).toMatch(/opacity/)
      expect(body).not.toMatch(/box-shadow|filter|background/)
    }
  })

  it('grows the composer in layout, not by measuring it from script', () => {
    expect(css('views/chat/chat.css')).toMatch(/\.composer-input--grow \{\s*field-sizing: content;/)
    expect(css('views/chat/Composer.tsx')).not.toMatch(/scrollHeight/)
  })
})

// @vitest-environment jsdom
//
// The persistent shell: what the global shortcuts do, that none of them fire
// while the terminal has focus (Ctrl+N there is the shell's history, not a
// new session), that a session can be renamed from the sidebar, and that the
// main column is the new-session view — never the old full-window picker —
// when nothing is selected. A screenshot shows every one of these looking
// right while doing nothing.

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { MainEvent } from '@shared/ipc'
import type { AppStateDTO, ChatSummary } from '@shared/model'
import { EMPTY_EXTENSIONS } from '@shared/extensions'
import { EMPTY_UPDATE_STATE } from '@shared/update'

const NOW = Date.now()
const calls: [string, unknown[]][] = []
const listeners = new Set<(e: MainEvent) => void>()

function chat(id: string, title: string, minutesAgo: number): ChatSummary {
  return {
    id,
    title,
    projectPath: '/work/acme',
    createdAt: NOW - minutesAgo * 60_000,
    updatedAt: NOW - minutesAgo * 60_000,
    isPinned: false,
    isArchived: false,
    isBusy: false,
    messageCount: 2,
    preview: '',
    unread: false
  }
}

const STATE: AppStateDTO = {
  phase: { kind: 'ready' },
  cli: null,
  agentVersion: null,
  selectedSessionId: null,
  sessions: [chat('a', 'Newest chat', 1), chat('b', 'Older chat', 30)],
  banner: null,
  installLog: [],
  agentLog: [],
  subscription: { plan: 'unknown', email: null },
  extensions: EMPTY_EXTENSIONS,
  update: EMPTY_UPDATE_STATE,
  remote: null,
  lastProjectPath: '/work/acme',
  defaultProjectPath: '/work/acme',
  recentProjects: ['/work/acme'],
  missingProjects: [],
  homePath: '/home/me',
  appearance: 'system'
}

/** Node's own `localStorage` global (undefined without --localstorage-file)
 *  shadows jsdom's here, so the layout store gets a plain in-memory one. */
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

beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true })
  ;(window as unknown as { spettro: unknown }).spettro = {
    platform: 'linux',
    onEvent: (l: (e: MainEvent) => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    call: (method: string, ...args: unknown[]) => {
      calls.push([method, args])
      return Promise.resolve(method === 'getState' ? STATE : null)
    }
  }
  // jsdom has neither; the shell only needs them to exist.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  })) as unknown as typeof window.matchMedia
})

afterEach(() => {
  cleanup()
  calls.length = 0
  localStorage.clear()
})

async function renderApp(): Promise<void> {
  const { default: App } = await import('@renderer/App')
  render(<App />)
  await act(async () => {
    listeners.forEach((l) => l({ type: 'app-state', state: STATE }))
  })
}

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, ...init }))
  })
}

const called = (method: string): unknown[][] => calls.filter(([m]) => m === method).map(([, a]) => a)

describe('the shell', () => {
  it('shows the new-session view, not a project picker, when nothing is selected', async () => {
    await renderApp()
    expect(screen.getByText('What should we build?')).toBeTruthy()
    expect(screen.getByTestId('project-chip').textContent).toContain('acme')
    expect(screen.queryByText(/Choose a Project Folder/)).toBeNull()
  })

  it('Ctrl+1 opens the top session in the sidebar, Ctrl+2 the next', async () => {
    await renderApp()
    press('1')
    press('2')
    expect(called('openChat')).toEqual([['a'], ['b']])
  })

  it('ignores its shortcuts while the terminal has focus', async () => {
    await renderApp()
    const xterm = document.createElement('div')
    xterm.className = 'xterm'
    const input = document.createElement('textarea')
    xterm.appendChild(input)
    document.body.appendChild(xterm)
    press('1', {}, input)
    press('k', {}, input)
    press('b', {}, input)
    expect(called('openChat')).toEqual([])
    expect(screen.queryByRole('dialog', { name: 'Switch session' })).toBeNull()
    expect(screen.getByRole('complementary', { name: 'Sessions' })).toBeTruthy()
    xterm.remove()
  })

  it('Ctrl+B collapses the sidebar, remembers it, and the header brings it back', async () => {
    await renderApp()
    press('b')
    expect(screen.queryByRole('complementary', { name: 'Sessions' })).toBeNull()
    expect(localStorage.getItem('spettro.sidebarCollapsed')).toBe('1')
    fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }))
    expect(screen.getByRole('complementary', { name: 'Sessions' })).toBeTruthy()
  })

  it('Ctrl+K finds a session by typing and opens it with Enter', async () => {
    await renderApp()
    press('k')
    const search = screen.getByRole('combobox', { name: 'Search sessions' })
    fireEvent.change(search, { target: { value: 'older' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(called('openChat')).toEqual([['b']])
    expect(screen.queryByRole('dialog', { name: 'Switch session' })).toBeNull()
  })

  it('renames a session from its "…" menu', async () => {
    await renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Older chat' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }))
    const field = screen.getByRole('textbox', { name: 'Session name' })
    fireEvent.change(field, { target: { value: 'Renamed' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(called('renameChat')).toEqual([['b', 'Renamed']])
  })

  it('asks twice before deleting', async () => {
    await renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Older chat' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    expect(called('closeChat')).toEqual([])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete permanently' }))
    expect(called('closeChat')).toEqual([['b']])
  })

  it('starts a session in the chosen folder with the first message', async () => {
    await renderApp()
    const box = screen.getByPlaceholderText(/Describe a task/)
    fireEvent.change(box, { target: { value: 'hello' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await act(async () => undefined)
    expect(called('newChat')).toEqual([['/work/acme']])
  })
})

// @vitest-environment jsdom
//
// The persistent shell: what the global shortcuts do, that none of them fire
// while the terminal has focus (Ctrl+N there is the shell's history, not a
// new session), that a session can be renamed from the sidebar, and that the
// main column is the new-session view — never the old full-window picker —
// when nothing is selected. A screenshot shows every one of these looking
// right while doing nothing.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
  connection: 'ok',
  cli: null,
  agentVersion: null,
  selectedSessionId: null,
  sessions: [chat('a', 'Newest chat', 1), chat('b', 'Older chat', 30)],
  banner: null,
  bannerNonce: 0,
  install: { stage: 'idle', failure: null },
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
  appearance: 'system',
  noModel: false,
  providerSetupSkipped: false,
  notifyWhenDone: true,
  defaultConfigOptions: [],
  busyTasks: 0
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

afterEach(async () => {
  // The store and the layout store are module singletons that outlive a
  // render: put back what a test changed so the next one starts clean.
  act(() => listeners.forEach((l) => l({ type: 'app-state', state: STATE })))
  const { closeSettings, setNewSessionPath } = await import('@renderer/state/shell')
  setNewSessionPath(null)
  closeSettings()
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

  it('closes a row menu when Tab leaves it', async () => {
    await renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Older chat' }))
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Rename…' }), { key: 'Tab' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('asks before deleting, then deletes only once Undo has run out', async () => {
    await renderApp()
    vi.useFakeTimers()
    try {
      fireEvent.click(screen.getByRole('button', { name: 'More actions for Older chat' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }))
      const alert = screen.getByRole('alertdialog', { name: 'Delete this session?' })
      expect(alert.textContent).toContain('“Older chat” will be removed')
      expect(called('closeChat')).toEqual([])
      fireEvent.click(within(alert).getByRole('button', { name: 'Delete' }))
      await act(async () => undefined)
      // Gone from the list at once, with Undo on offer — but not deleted yet.
      expect(screen.queryByRole('button', { name: 'More actions for Older chat' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
      expect(called('closeChat')).toEqual([])
      act(() => void vi.advanceTimersByTime(8000))
      expect(called('closeChat')).toEqual([['b']])
    } finally {
      vi.useRealTimers()
    }
  })

  it('puts a deleted session back with Undo, and never deletes it', async () => {
    await renderApp()
    vi.useFakeTimers()
    try {
      fireEvent.click(screen.getByRole('button', { name: 'More actions for Older chat' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }))
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
      await act(async () => undefined)
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      expect(screen.getByRole('button', { name: 'More actions for Older chat' })).toBeTruthy()
      act(() => void vi.advanceTimersByTime(10_000))
      expect(called('closeChat')).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps everything when Delete is cancelled (Escape)', async () => {
    await renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Older chat' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    press('Escape', { ctrlKey: false })
    await act(async () => undefined)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'More actions for Older chat' })).toBeTruthy()
    expect(called('closeChat')).toEqual([])
  })

  it('Ctrl+N starts a new session, but not from inside the terminal', async () => {
    await renderApp()
    await act(async () => {
      listeners.forEach((l) => l({ type: 'app-state', state: { ...STATE, selectedSessionId: 'a' } }))
    })
    const xterm = document.createElement('div')
    xterm.className = 'xterm'
    const input = document.createElement('textarea')
    xterm.appendChild(input)
    document.body.appendChild(xterm)
    press('n', {}, input)
    expect(called('selectSession')).toEqual([])
    xterm.remove()
    press('n')
    expect(called('selectSession')).toEqual([[null]])
  })

  it('keeps the switcher and session shortcuts out of the way of an open sheet', async () => {
    await renderApp()
    press(',')
    press('k')
    press('1')
    expect(screen.queryByRole('dialog', { name: 'Switch session' })).toBeNull()
    expect(called('openChat')).toEqual([])
  })

  it('keeps Tab inside the switcher, and Escape closes it', async () => {
    await renderApp()
    press('k')
    const search = screen.getByRole('combobox', { name: 'Search sessions' })
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    act(() => void search.dispatchEvent(tab))
    expect(tab.defaultPrevented).toBe(true)
    press('Escape', { ctrlKey: false })
    expect(screen.queryByRole('dialog', { name: 'Switch session' })).toBeNull()
  })

  it('refills the composer when the same starter is chosen twice', async () => {
    await renderApp()
    const box = screen.getByPlaceholderText(/Describe a task/) as HTMLTextAreaElement
    fireEvent.click(screen.getByRole('button', { name: 'Fix a bug' }))
    expect(box.value).toBe('Help me find and fix a bug: ')
    fireEvent.change(box, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Fix a bug' }))
    expect(box.value).toBe('Help me find and fix a bug: ')
  })

  it('holds the first message until starting in the home folder is confirmed', async () => {
    await renderApp()
    await act(async () => {
      listeners.forEach((l) =>
        l({ type: 'app-state', state: { ...STATE, defaultProjectPath: '/home/me', lastProjectPath: null } })
      )
    })
    const box = screen.getByPlaceholderText(/Describe a task/) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'tidy up' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await act(async () => undefined)
    expect(called('newChat')).toEqual([])
    expect(box.value).toBe('tidy up')
    expect(screen.getByRole('alert').textContent).toContain('everything in your home folder')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.keyDown(box, { key: 'Enter' })
    await act(async () => undefined)
    expect(called('newChat')).toEqual([['/home/me']])
  })

  it('refuses to start in a folder that no longer exists', async () => {
    await renderApp()
    await act(async () => {
      listeners.forEach((l) => l({ type: 'app-state', state: { ...STATE, missingProjects: ['/work/acme'] } }))
    })
    const box = screen.getByPlaceholderText(/Describe a task/)
    fireEvent.change(box, { target: { value: 'hello' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await act(async () => undefined)
    expect(called('newChat')).toEqual([])
    expect(screen.getByRole('alert').textContent).toContain('can’t be found')
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

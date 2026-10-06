// Renderer-only window state: the sidebar's width and collapsed flag, the
// terminal drawer, and the folder the next new session will start in.
//
// None of it belongs to the model in main — it describes this window, not the
// user's work — but several distant views share it (Ctrl+B in App, the
// reopen button in the chat header, the drag handle in the sidebar), so it is
// a tiny external store rather than state threaded through every view.
// Layout values persist in localStorage, the @AppStorage analog the terminal
// drawer already uses.

import { useSyncExternalStore } from 'react'
import { call, getState } from './store'

const SIDEBAR_WIDTH_KEY = 'spettro.sidebarWidth'
const SIDEBAR_COLLAPSED_KEY = 'spettro.sidebarCollapsed'
/** UserDefaults key `spettro.terminalDrawerVisible` — global, not per project. */
const TERMINAL_VISIBLE_KEY = 'spettro.terminalDrawerVisible'

export const SIDEBAR_MIN_WIDTH = 220
export const SIDEBAR_MAX_WIDTH = 360
export const SIDEBAR_DEFAULT_WIDTH = 264

/** Window event the composer listens for (Ctrl/Cmd+L, New session). An event
 *  rather than a ref so whichever composer is on screen answers it. */
export const FOCUS_COMPOSER_EVENT = 'spettro:focus-composer'

export interface ShellState {
  sidebarWidth: number
  sidebarCollapsed: boolean
  terminalVisible: boolean
  /** Where the new-session view points its folder chip; null means "the
   *  app's default folder". Set when a session is started from a specific
   *  project (its group's +, or New session while that project was open). */
  newSessionPath: string | null
}

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)))
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage full or unavailable: the layout just won't survive a relaunch.
  }
}

let state: ShellState = {
  sidebarWidth: clampSidebarWidth(Number(read(SIDEBAR_WIDTH_KEY) ?? SIDEBAR_DEFAULT_WIDTH)),
  sidebarCollapsed: read(SIDEBAR_COLLAPSED_KEY) === '1',
  terminalVisible: read(TERMINAL_VISIBLE_KEY) === '1',
  newSessionPath: null
}
const listeners = new Set<() => void>()

function update(patch: Partial<ShellState>): void {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useShell<T>(selector: (s: ShellState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state))
}

export function getShell(): ShellState {
  return state
}

/** Live width while dragging; `persist` once the drag ends, so a drag is one
 *  storage write instead of one per pointer move. */
export function setSidebarWidth(width: number, persist: boolean): void {
  const next = clampSidebarWidth(width)
  if (next !== state.sidebarWidth) update({ sidebarWidth: next })
  if (persist) write(SIDEBAR_WIDTH_KEY, String(next))
}

export function setSidebarCollapsed(collapsed: boolean): void {
  write(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0')
  update({ sidebarCollapsed: collapsed })
}

export function toggleSidebar(): void {
  setSidebarCollapsed(!state.sidebarCollapsed)
}

export function setTerminalVisible(visible: boolean): void {
  write(TERMINAL_VISIBLE_KEY, visible ? '1' : '0')
  update({ terminalVisible: visible })
}

export function toggleTerminal(): void {
  setTerminalVisible(!state.terminalVisible)
}

export function setNewSessionPath(path: string | null): void {
  update({ newSessionPath: path })
}

/** Asks whichever composer is mounted to take focus. Deferred a frame so a
 *  view that is about to mount (New session swaps the detail pane) is there
 *  to hear it. */
export function focusComposer(): void {
  requestAnimationFrame(() => window.dispatchEvent(new Event(FOCUS_COMPOSER_EVENT)))
}

/** New session: back to the empty state in the main column, pointed at
 *  `projectPath` — or, by default, at the project the user is looking at, so
 *  "another session here" is one keystroke. No chat exists until the first
 *  message is sent. */
export function startNewSession(projectPath?: string): void {
  const app = getState().app
  const selected = app?.selectedSessionId
    ? app.sessions.find((s) => s.id === app.selectedSessionId)
    : undefined
  update({ newSessionPath: projectPath ?? selected?.projectPath ?? null })
  if (app?.selectedSessionId) void call('selectSession', null)
  focusComposer()
}

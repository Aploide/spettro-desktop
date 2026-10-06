// The renderer's mirror of the main-process model. A tiny external store
// (no state library): main pushes MainEvent's, we fold them into one
// immutable snapshot, views subscribe with useSyncExternalStore.

import { useSyncExternalStore } from 'react'
import type { ACPConfigOption, ACPPermissionRequest, ACPQuestionRequest } from '@shared/acp'
import type { MainEvent, SpettroBridge } from '@shared/ipc'
import type { AppStateDTO, ChatDetail } from '@shared/model'
import { transcriptItemId } from '@shared/model'
import { applyAccent } from '@renderer/design/accent'
import { saveDraft } from './drafts'

export interface RendererState {
  app: AppStateDTO | null
  /** Full detail for every chat the renderer has opened/received. */
  chats: Record<string, ChatDetail>
  permissions: ACPPermissionRequest[]
  questions: ACPQuestionRequest[]
}

let state: RendererState = { app: null, chats: {}, permissions: [], questions: [] }
const listeners = new Set<() => void>()

/** A notification the views are owed, waiting for the next frame. */
let frameRequest = 0
let fallbackTimer: ReturnType<typeof setTimeout> | null = null
/** A window that is hidden gets no frames; it still catches up this soon. */
const HIDDEN_CATCH_UP_MS = 100

function notify(): void {
  if (frameRequest) cancelAnimationFrame(frameRequest)
  if (fallbackTimer) clearTimeout(fallbackTimer)
  frameRequest = 0
  fallbackTimer = null
  listeners.forEach((l) => l())
}

/** The frame's (or the hidden window's) notification, unless an urgent one
 *  has already paid it. */
function owed(): void {
  if (frameRequest || fallbackTimer) notify()
}

/** Under React's act() (the tests), nothing waits for a frame: act renders
 *  what was dispatched inside it before it returns. */
function inAct(): boolean {
  return (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT === true
}

/**
 * The state changes at once — getState() is always current — but the views
 * hear of a chat's streaming changes once a frame. Main sends one message per
 * changed item each frame, and each one used to be its own synchronous
 * React commit of the whole chat: renders nobody ever saw. What changes what
 * the window is (a new state from main, a chat arriving or leaving, a prompt
 * waiting on the user) is told at once, and takes anything owed with it.
 */
function emit(next: RendererState, urgent = true): void {
  state = next
  if (urgent || inAct() || typeof requestAnimationFrame !== 'function') {
    notify()
    return
  }
  if (frameRequest) return
  frameRequest = requestAnimationFrame(owed)
  fallbackTimer = setTimeout(owed, HIDDEN_CATCH_UP_MS)
}

/** The views' way in (useStore); exported for what must hear of every
 *  change without rendering. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getState(): RendererState {
  return state
}

function reduce(event: MainEvent): void {
  switch (event.type) {
    case 'app-state':
      // Before the re-render, so the frame that shows the new state is
      // already in its accent.
      applyAccent(event.state.accent)
      emit({ ...state, app: event.state })
      break
    case 'chat-reset':
      emit({ ...state, chats: { ...state.chats, [event.chat.id]: event.chat } })
      break
    case 'chat-item': {
      const chat = state.chats[event.chatId]
      if (!chat) break
      const id = transcriptItemId(event.item)
      // From the end: a streaming turn updates the items it just added.
      let idx = chat.items.length - 1
      while (idx >= 0 && transcriptItemId(chat.items[idx]) !== id) idx--
      const items = chat.items.slice()
      if (idx >= 0) items[idx] = event.item
      else items.push(event.item)
      emit({ ...state, chats: { ...state.chats, [event.chatId]: { ...chat, items } } }, false)
      break
    }
    case 'chat-meta': {
      const chat = state.chats[event.chatId]
      if (!chat) break
      emit({ ...state, chats: { ...state.chats, [event.chatId]: { ...chat, ...event.meta } } }, false)
      break
    }
    case 'chat-config-value': {
      const chat = state.chats[event.chatId]
      if (!chat) break
      const configOptions = chat.configOptions.map((o) =>
        o.id === event.configId ? withValue(o, event.value) : o
      )
      emit({ ...state, chats: { ...state.chats, [event.chatId]: { ...chat, configOptions } } }, false)
      break
    }
    case 'chat-removed': {
      // A deleted chat's unsent words go with it.
      saveDraft(event.chatId, '')
      const { [event.chatId]: _, ...rest } = state.chats
      emit({ ...state, chats: rest })
      break
    }
    case 'permissions':
      emit({ ...state, permissions: event.requests })
      break
    case 'questions':
      emit({ ...state, questions: event.requests })
      break
    // terminal-data / terminal-exit are consumed directly by the terminal
    // component via window.spettro.onEvent — they never enter this store.
    default:
      break
  }
}

/** The main events the store folds in (the terminal's and the menu's go to
 *  their own listeners): each listener gets its own copy of an event. */
const STORE_EVENTS: readonly MainEvent['type'][] = [
  'app-state',
  'chat-reset',
  'chat-item',
  'chat-meta',
  'chat-config-value',
  'chat-removed',
  'permissions',
  'questions'
]

/** An option showing a new value — what main's applyLocalConfigValue did. */
function withValue(option: ACPConfigOption, value: string | boolean): ACPConfigOption {
  if (option.kind.type === 'select' && typeof value === 'string') {
    return { ...option, kind: { ...option.kind, currentValue: value } }
  }
  if (option.kind.type === 'boolean' && typeof value === 'boolean') {
    return { ...option, kind: { ...option.kind, currentValue: value } }
  }
  return option
}

let initialized = false

/** Idempotent; call once from App. Pulls the initial snapshot and subscribes. */
export function initStore(): void {
  if (initialized) return
  initialized = true
  window.spettro.onEvent(reduce, STORE_EVENTS)
  void window.spettro.call('getState').then((app) => emit({ ...state, app }))
}

export function useStore<T>(selector: (s: RendererState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state))
}

export function useApp(): AppStateDTO | null {
  return useStore((s) => s.app)
}

export function useChat(chatId: string | null): ChatDetail | null {
  return useStore((s) => (chatId ? (s.chats[chatId] ?? null) : null))
}

/** Ensure a chat's detail is loaded into the store (fetch once on open). */
export async function ensureChatLoaded(chatId: string): Promise<void> {
  if (state.chats[chatId]) return
  const chat = await window.spettro.call('getChat', chatId)
  if (chat) reduce({ type: 'chat-reset', chat })
}

const invoke: SpettroBridge['call'] = (method, ...args) =>
  (window.spettro.call as (...a: unknown[]) => never)(method, ...args)

/**
 * window.spettro.call, with failures said out loud.
 *
 * Most actions are fire-and-forget (`void call('remoteSetEnabled', true)`),
 * and a rejection there used to vanish: the switch flipped back, or nothing
 * happened, and the user was left guessing. Every rejection now becomes a
 * toast in words (shared/humanize.ts). The promise still rejects, so a
 * caller that awaits can react as well — and a caller that shows the error
 * itself (an inline field error, a sheet's own failure state) uses
 * `quietCall` so it isn't said twice.
 */
export const call: SpettroBridge['call'] = (method, ...args) => {
  const promise = invoke(method, ...args)
  // A handler on the original marks it handled, so `void call(…)` never
  // surfaces as an unhandled rejection; awaiting callers still see it.
  ;(promise as Promise<unknown>).catch((err: unknown) => reportFailure(method, err))
  return promise
}

/** `call` for sites that show their own failure (or poll in the
 *  background, where a toast per tick would be noise). */
export const quietCall: SpettroBridge['call'] = invoke

/** Hook for the toast layer, set by App; a plain log until then (and in
 *  tests that render a view without it). */
let failureReporter: (method: string, err: unknown) => void = (method, err) => {
  console.warn(`[spettro] ${method} failed`, err)
}

export function setFailureReporter(reporter: (method: string, err: unknown) => void): void {
  failureReporter = reporter
}

function reportFailure(method: string, err: unknown): void {
  failureReporter(method, err)
}

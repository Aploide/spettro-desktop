// Deleting a chat, with a way back.
//
// "Delete…" asks first (ConfirmDialog), and even then the chat isn't deleted
// yet: it leaves the sidebar at once, a toast offers Undo for eight seconds,
// and only when that runs out does main delete it for real (closing its
// session on the CLI). Undo puts the row back exactly where it was — nothing
// on disk or on the agent was touched.
//
// The timing is a small scheduler with injectable timers, so a test can
// drive the clock; the singleton below is what the app uses.

import { useSyncExternalStore } from 'react'

/** How long Undo is offered before the delete happens. */
export const UNDO_WINDOW_MS = 8000

export interface DeleteScheduler {
  /** Hides `id` now and runs `commit` once the window passes. */
  schedule(id: string, commit: () => void): void
  /** Takes a scheduled delete back; false when it already ran (or never was). */
  undo(id: string): boolean
  /** Runs every scheduled delete now (the window is closing). */
  flush(): void
  isPending(id: string): boolean
  pending(): ReadonlySet<string>
  subscribe(listener: () => void): () => void
}

export function createDeleteScheduler(
  opts: {
    delayMs?: number
    setTimer?: (fn: () => void, ms: number) => unknown
    clearTimer?: (handle: unknown) => void
  } = {}
): DeleteScheduler {
  const delay = opts.delayMs ?? UNDO_WINDOW_MS
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const timers = new Map<string, { handle: unknown; commit: () => void }>()
  let snapshot: ReadonlySet<string> = new Set()
  const listeners = new Set<() => void>()
  const changed = (): void => {
    snapshot = new Set(timers.keys())
    listeners.forEach((l) => l())
  }
  const run = (id: string): void => {
    const entry = timers.get(id)
    if (!entry) return
    timers.delete(id)
    changed()
    entry.commit()
  }
  return {
    schedule(id, commit) {
      const existing = timers.get(id)
      if (existing) clearTimer(existing.handle)
      timers.set(id, { handle: setTimer(() => run(id), delay), commit })
      changed()
    },
    undo(id) {
      const entry = timers.get(id)
      if (!entry) return false
      clearTimer(entry.handle)
      timers.delete(id)
      changed()
      return true
    },
    flush() {
      for (const id of [...timers.keys()]) {
        const entry = timers.get(id)
        if (entry) clearTimer(entry.handle)
        run(id)
      }
    },
    isPending: (id) => timers.has(id),
    pending: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

export const pendingDeletes = createDeleteScheduler()

/** The chats on their way out, which every list of sessions leaves out. */
export function usePendingDeletes(): ReadonlySet<string> {
  return useSyncExternalStore(pendingDeletes.subscribe, pendingDeletes.pending)
}

// A window closing inside the Undo window still deletes what was deleted.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => pendingDeletes.flush())
}

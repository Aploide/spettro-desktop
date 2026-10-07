// Toasts: the app's one way of saying "that didn't work" (or "done — undo?")
// about something the user did, without taking over the screen.
//
// A tiny external store, like state/store.ts: anything can call showToast(),
// including code with no React tree around it (the central `call` wrapper),
// and the single <ToastHost/> in App draws the stack. A toast says what
// happened in one line, may add a second line, and offers at most one action —
// "Undo", "Try again", "Open Settings". Errors stay longer than news, an
// action stays longer still, and hovering holds any of them.

import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { JSX } from 'react'
import { Icon } from '@renderer/design/icons'
import './common.css'

export interface ToastAction {
  label: string
  run: () => void
}

export interface ToastOptions {
  title: string
  detail?: string
  tone?: 'info' | 'error' | 'success'
  action?: ToastAction
  /** ms on screen. Defaults by tone; `0` stays until dismissed. */
  durationMs?: number
  /** A toast with the same key replaces the one on screen instead of
   *  stacking another — the same failure ten times is one toast. */
  key?: string
}

export interface Toast extends ToastOptions {
  id: number
  tone: 'info' | 'error' | 'success'
  durationMs: number
}

/** More than this and the oldest goes: a wall of toasts reads as an alarm. */
const MAX_VISIBLE = 3

let toasts: Toast[] = []
let nextId = 1
const listeners = new Set<() => void>()

function emit(next: Toast[]): void {
  toasts = next
  listeners.forEach((l) => l())
}

function defaultDuration(o: ToastOptions): number {
  if (o.action) return 8000
  return o.tone === 'error' ? 6000 : 4000
}

/** Puts a toast up and returns its id (for dismissToast). */
export function showToast(options: ToastOptions): number {
  const toast: Toast = {
    ...options,
    id: nextId++,
    tone: options.tone ?? 'info',
    durationMs: options.durationMs ?? defaultDuration(options)
  }
  const rest = options.key ? toasts.filter((t) => t.key !== options.key) : toasts
  emit([...rest, toast].slice(-MAX_VISIBLE))
  return toast.id
}

export function dismissToast(id: number): void {
  if (toasts.some((t) => t.id === id)) emit(toasts.filter((t) => t.id !== id))
}

export function currentToasts(): Toast[] {
  return toasts
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The stack, bottom-centre over everything but modal dialogs. */
export function ToastHost(): JSX.Element | null {
  const list = useSyncExternalStore(subscribe, () => toasts)
  if (list.length === 0) return null
  return (
    <div className="toast-stack" aria-live="polite">
      {list.map((toast) => (
        <ToastView key={toast.id} toast={toast} />
      ))}
    </div>
  )
}

function ToastView({ toast }: { toast: Toast }): JSX.Element {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const arm = (): void => {
    if (timer.current) clearTimeout(timer.current)
    if (toast.durationMs > 0) timer.current = setTimeout(() => dismissToast(toast.id), toast.durationMs)
  }
  useEffect(() => {
    arm()
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id])

  return (
    <div
      className={`toast-card toast-card--${toast.tone}`}
      role={toast.tone === 'error' ? 'alert' : 'status'}
      // Reading a toast shouldn't race its timer.
      onMouseEnter={() => timer.current && clearTimeout(timer.current)}
      onMouseLeave={arm}
    >
      <span className="toast-icon" aria-hidden>
        <Icon
          name={
            toast.tone === 'error'
              ? 'exclamationmark.triangle.fill'
              : toast.tone === 'success'
                ? 'checkmark.circle.fill'
                : 'info.circle.fill'
          }
          size={14}
        />
      </span>
      <span className="toast-texts">
        <span className="toast-title">{toast.title}</span>
        {toast.detail && <span className="toast-detail">{toast.detail}</span>}
      </span>
      {toast.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            dismissToast(toast.id)
            toast.action?.run()
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        className="toast-close"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={() => dismissToast(toast.id)}
      >
        <Icon name="xmark" size={10} />
      </button>
    </div>
  )
}

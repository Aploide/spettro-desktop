// The app's alert: one question, its consequences in a sentence, and buttons
// that say what they do ("Delete", "Don't Save") — never a bare OK.
//
// Imperative, like the native alerts it stands in for: `await confirmDialog()`
// resolves to which button was pressed, so a call site reads top to bottom
// ("ask, then delete") instead of threading open-state through its parents.
// One <ConfirmHost/> in App draws whatever is being asked; a second question
// asked while one is up waits its turn.
//
// Keys follow the platform: Escape is always Cancel, and Enter presses the
// default button — which for a destructive question is Cancel, so a stray
// Enter can never delete anything.

import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { JSX } from 'react'
import { Icon } from '@renderer/design/icons'
import { quietFocus } from './quietFocus'
import './common.css'

export interface ConfirmOptions {
  title: string
  message?: string
  /** The button that does the thing: "Delete", "Save", "Update now". */
  confirmLabel: string
  cancelLabel?: string
  /** Red, and not the default button. */
  destructive?: boolean
  /** A third choice, drawn apart on the left ("Don't Save", "Update When
   *  Finished"). */
  alternateLabel?: string
  alternateDestructive?: boolean
}

export type ConfirmResult = 'confirm' | 'alternate' | 'cancel'

interface Pending {
  id: number
  options: ConfirmOptions
  resolve: (result: ConfirmResult) => void
}

let queue: Pending[] = []
let nextId = 1
const listeners = new Set<() => void>()

function emit(next: Pending[]): void {
  queue = next
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function confirmDialog(options: ConfirmOptions): Promise<ConfirmResult> {
  return new Promise((resolve) => {
    emit([...queue, { id: nextId++, options, resolve }])
  })
}

/** True while a question is on screen — global key handlers stand back. */
export function isConfirmOpen(): boolean {
  return queue.length > 0
}

function answer(id: number, result: ConfirmResult): void {
  const entry = queue.find((p) => p.id === id)
  if (!entry) return
  emit(queue.filter((p) => p.id !== id))
  entry.resolve(result)
}

export function ConfirmHost(): JSX.Element | null {
  const current = useSyncExternalStore(subscribe, () => queue[0] ?? null)
  if (!current) return null
  return <ConfirmView key={current.id} pending={current} />
}

function ConfirmView({ pending }: { pending: Pending }): JSX.Element {
  const { options, id } = pending
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    quietFocus((options.destructive ? cancelRef : confirmRef).current)
    // Captured, and stopped: an Escape that answers this alert must not also
    // close the sheet underneath it.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        answer(id, 'cancel')
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (previous && document.contains(previous)) previous.focus()
    }
  }, [id, options.destructive])

  return (
    <div className="confirm-backdrop" role="presentation">
      <div
        className="confirm-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`confirm-title-${id}`}
        aria-describedby={options.message ? `confirm-msg-${id}` : undefined}
        onKeyDown={(e) => {
          // Keep Tab inside the alert.
          if (e.key !== 'Tab') return
          const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
          const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
          const next = (at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length
          e.preventDefault()
          buttons[next]?.focus()
        }}
      >
        <span className={`confirm-icon${options.destructive ? ' confirm-icon--danger' : ''}`} aria-hidden>
          <Icon name="exclamationmark.triangle.fill" size={22} />
        </span>
        <div className="confirm-title" id={`confirm-title-${id}`}>
          {options.title}
        </div>
        {options.message && (
          <div className="confirm-message" id={`confirm-msg-${id}`}>
            {options.message}
          </div>
        )}
        <div className="confirm-buttons">
          {options.alternateLabel && (
            <button
              type="button"
              className={`btn${options.alternateDestructive ? ' btn--destructive' : ''}`}
              onClick={() => answer(id, 'alternate')}
            >
              {options.alternateLabel}
            </button>
          )}
          <span className="confirm-spacer" />
          <button type="button" ref={cancelRef} className="btn" onClick={() => answer(id, 'cancel')}>
            {options.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            ref={confirmRef}
            className={`btn ${options.destructive ? 'btn--destructive-fill' : 'btn--prominent'}`}
            data-testid="confirm-ok"
            onClick={() => answer(id, 'confirm')}
          >
            {options.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

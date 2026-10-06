// A minimal custom context menu (the web stand-in for SwiftUI's .contextMenu):
// fixed-position card clamped to the window, dismissed by outside click,
// Escape, blur, or resize. The caller owns the open state and the entries.
//
// The same menu answers a right-click and a row's "…" button, so it is also
// keyboard-driven: it takes focus when it opens, ↑/↓ move between items,
// Enter/Space activate, and Escape hands focus back to where it came from.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export type ContextMenuEntry =
  | {
      label: string
      destructive?: boolean
      disabled?: boolean
      /** Two-step entries: the first activation swaps the label for this one
       *  and keeps the menu open; only the second runs the action. A
       *  lightweight guard for actions that can't be taken back. */
      confirmLabel?: string
      action: () => void
    }
  | 'separator'

interface Props {
  x: number
  y: number
  entries: ContextMenuEntry[]
  onClose: () => void
  /** Accessible name for the menu, e.g. the chat it acts on. */
  label?: string
  /** Grow upward from `y` (a menu opened from the bottom of the window). */
  above?: boolean
}

export default function ContextMenu({ x, y, entries, onClose, label, above }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [armed, setArmed] = useState<number | null>(null)

  // Clamp inside the window once we know our size.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const top = above ? y - rect.height : y
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`
    el.style.top = `${Math.max(8, Math.min(top, window.innerHeight - rect.height - 8))}px`
  }, [x, y, entries, above])

  // Take focus on open so the keyboard works at once, and give it back on
  // close — a menu opened from a "…" button should leave you on that button.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const menu = ref.current
    menu?.querySelector<HTMLButtonElement>('.ctx-item:not(:disabled)')?.focus()
    return () => {
      // Only if focus is still ours (or was dropped with our DOM): an action
      // like Rename… moves it somewhere on purpose.
      const active = document.activeElement
      if (!active || active === document.body || menu?.contains(active)) previous?.focus?.()
    }
  }, [])

  useEffect(() => {
    const dismiss = (e: MouseEvent): void => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // Ours alone: an open menu must not also close the sheet behind it.
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('.ctx-item:not(:disabled)') ?? []
    )
    if (items.length === 0) return
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next].focus()
  }

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      aria-label={label}
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
    >
      {entries.map((entry, i) =>
        entry === 'separator' ? (
          <div key={i} className="ctx-separator" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            className={
              'ctx-item' +
              (entry.destructive ? ' ctx-item--destructive' : '') +
              (armed === i ? ' ctx-item--armed' : '')
            }
            onClick={() => {
              if (entry.confirmLabel && armed !== i) {
                setArmed(i)
                return
              }
              entry.action()
              onClose()
            }}
          >
            {armed === i && entry.confirmLabel ? entry.confirmLabel : entry.label}
          </button>
        )
      )}
    </div>
  )
}

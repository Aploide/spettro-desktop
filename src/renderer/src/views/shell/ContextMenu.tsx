// A minimal custom context menu (the web stand-in for SwiftUI's .contextMenu):
// fixed-position card clamped to the window, dismissed by outside click,
// Escape, blur, or resize. The caller owns the open state and the entries.

import { useEffect, useLayoutEffect, useRef } from 'react'

export type ContextMenuEntry =
  | { label: string; destructive?: boolean; action: () => void }
  | 'separator'

interface Props {
  x: number
  y: number
  entries: ContextMenuEntry[]
  onClose: () => void
}

export default function ContextMenu({ x, y, entries, onClose }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  // Clamp inside the window once we know our size.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`
    el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`
  }, [x, y, entries])

  useEffect(() => {
    const dismiss = (e: MouseEvent): void => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return (
    <div ref={ref} className="ctx-menu" style={{ left: x, top: y }} onContextMenu={(e) => e.preventDefault()}>
      {entries.map((entry, i) =>
        entry === 'separator' ? (
          <div key={i} className="ctx-separator" />
        ) : (
          <button
            key={i}
            className={`ctx-item${entry.destructive ? ' ctx-item--destructive' : ''}`}
            onClick={() => {
              entry.action()
              onClose()
            }}
          >
            {entry.label}
          </button>
        )
      )}
    </div>
  )
}

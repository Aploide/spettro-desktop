// A popover that escapes its ancestors' clipping.
//
// The chip rows it hangs off (the config bar, the header chip cluster) scroll
// horizontally, and `overflow: auto` establishes a clip region: an absolutely
// positioned menu inside one is cut down to the ~34px strip of the chip row,
// which is why the config menus rendered but were invisible. SwiftUI's
// `.popover` is a window-level presentation with no such constraint, so the
// faithful port is a portal into <body> positioned from the anchor's rect.
//
// It also clamps itself into the viewport and scrolls internally, which the
// model list needs — the CLI advertises 200+ models in one menu.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

const MARGIN = 8
const GAP = 6

export interface PopoverProps {
  anchorRef: RefObject<HTMLElement>
  open: boolean
  onClose: () => void
  /** Which side of the anchor to prefer; flips when there isn't room. */
  placement?: 'up' | 'down'
  /** Horizontal alignment against the anchor. */
  align?: 'start' | 'end'
  className?: string
  children: ReactNode
}

interface Position {
  left: number
  top: number
  maxHeight: number
}

export default function Popover({
  anchorRef,
  open,
  onClose,
  placement = 'down',
  align = 'start',
  className = '',
  children
}: PopoverProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<Position | null>(null)

  // Measure after paint so the panel's natural size is known, then place it.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const place = (): void => {
      const anchor = anchorRef.current
      const panel = panelRef.current
      if (!anchor || !panel) return
      const a = anchor.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const panelW = panel.offsetWidth
      // offsetHeight, not scrollHeight: it already respects the panel's own
      // CSS max-height (the config menu caps itself at 60vh), so a 200-model
      // list stays a menu instead of becoming a full-height wall.
      const panelH = panel.offsetHeight

      const spaceAbove = a.top - MARGIN - GAP
      const spaceBelow = vh - a.bottom - MARGIN - GAP
      // Keep the preferred side unless the other one has meaningfully more
      // room — a menu that flips on every open is worse than a short one.
      const up =
        placement === 'up' ? spaceAbove > 120 || spaceAbove >= spaceBelow : spaceBelow < 160 && spaceAbove > spaceBelow

      const maxHeight = Math.max(120, Math.min(panelH, up ? spaceAbove : spaceBelow))
      const top = up ? Math.max(MARGIN, a.top - GAP - Math.min(panelH, maxHeight)) : a.bottom + GAP

      let left = align === 'end' ? a.right - panelW : a.left
      left = Math.min(Math.max(MARGIN, left), Math.max(MARGIN, vw - panelW - MARGIN))

      setPos({ left, top, maxHeight })
    }
    place()
    window.addEventListener('resize', place)
    // Reposition while any ancestor scrolls (capture catches them all).
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, placement, align, anchorRef])

  // Dismiss on outside pointerdown or Escape. The anchor is excluded so its
  // own toggle handler runs instead of being double-fired.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node
      if (panelRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onClose()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose, anchorRef])

  if (!open) return null

  return createPortal(
    <div
      ref={panelRef}
      className={`popover popover--portal ${className}`}
      style={
        pos
          ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight }
          : // First paint: rendered off-screen so it can be measured without
            // flashing in the wrong place.
            { left: -9999, top: 0, visibility: 'hidden' }
      }
    >
      {children}
    </div>,
    document.body
  )
}

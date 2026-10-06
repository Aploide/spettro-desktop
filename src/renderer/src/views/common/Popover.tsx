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
import { createPortal, flushSync } from 'react-dom'

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
      // list stays a menu instead of becoming a full-height wall. The cap
      // this function set last time is lifted first, or a panel that grew
      // (the thinking slider's Ask first prompt) would stay its old height.
      const inlineCap = panel.style.maxHeight
      panel.style.maxHeight = ''
      const panelH = panel.offsetHeight
      panel.style.maxHeight = inlineCap

      const spaceAbove = a.top - MARGIN - GAP
      const spaceBelow = vh - a.bottom - MARGIN - GAP
      // Keep the preferred side unless the other one has meaningfully more
      // room — a menu that flips on every open is worse than a short one.
      // Up holds while the panel fits there; one that doesn't (the settings
      // panel over the new-session composer, mid-window) opens downward when
      // it fits there, else on whichever side shows more of it.
      const up =
        placement === 'up'
          ? panelH <= spaceAbove || (panelH > spaceBelow && spaceAbove >= spaceBelow)
          : spaceBelow < 160 && spaceAbove > spaceBelow

      let maxHeight = Math.max(120, Math.min(panelH, up ? spaceAbove : spaceBelow))
      let top = up ? Math.max(MARGIN, a.top - GAP - Math.min(panelH, maxHeight)) : a.bottom + GAP
      if (panelH > maxHeight && panelH <= vh - 2 * MARGIN) {
        // Too tall for either side but not for the window (the settings
        // panel over the new-session composer, mid-window): slide it along
        // so all of it shows, over the anchor if need be, rather than a
        // clipped panel that hides its last section behind a scroll.
        maxHeight = panelH
        top = up ? MARGIN : vh - MARGIN - panelH
      }

      let left = align === 'end' ? a.right - panelW : a.left
      left = Math.min(Math.max(MARGIN, left), Math.max(MARGIN, vw - panelW - MARGIN))

      setPos({ left, top, maxHeight })
    }
    place()
    // Content that changes size while open is placed again. Its first child
    // is watched too: a capped panel doesn't grow when its content does.
    // Placed in the frame it grew in: the observer reports after layout and
    // before paint, but a plain state update would land a task later, and
    // that frame showed the panel still capped at its old height — its
    // content clipped behind a scrollbar that narrowed it (the thinking
    // slider's Ask first prompt appearing), then jumping into place.
    const panel = panelRef.current
    const observer =
      typeof ResizeObserver === 'function' && panel ? new ResizeObserver(() => flushSync(place)) : null
    if (observer && panel) {
      observer.observe(panel)
      if (panel.firstElementChild) observer.observe(panel.firstElementChild)
    }
    window.addEventListener('resize', place)
    // Reposition while any ancestor scrolls (capture catches them all).
    window.addEventListener('scroll', place, true)
    return () => {
      observer?.disconnect()
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

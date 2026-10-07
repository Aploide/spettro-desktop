// Escape closes the topmost sheet, and only that one.
//
// Sheets stacked over Settings (Manage Providers, the model list) used to
// leave Escape to App, which closed Settings itself and everything on it —
// a half-typed API key included. A sheet that uses this hook answers Escape
// first (a capture listener on window) and stops it there. It stands back
// while an alert is up (the alert is on top) and while `enabled` is false,
// which is how a sheet hands Escape to one it opened over itself.

import { useEffect, useRef } from 'react'
import { isConfirmOpen } from './ConfirmDialog'

export function useSheetEscape(onClose: () => void, enabled = true): void {
  const latest = useRef(onClose)
  latest.current = onClose
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || isConfirmOpen()) return
      e.preventDefault()
      e.stopPropagation()
      latest.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [enabled])
}

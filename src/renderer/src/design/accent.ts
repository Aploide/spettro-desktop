// The accent lives on <html> as data-accent, which theme.css keys its accent
// tokens on (Lilac is the unattributed default; [data-accent='mono'] swaps in
// the monochrome set). Preload sets it before the first paint from the value
// main launched the window with; from then on every app-state carries the
// stored choice and this keeps the attribute in step, so a change in Settings
// recolours the whole window at once, without a reload.

import { DEFAULT_ACCENT, isAccent, type Accent } from '@shared/model'

/** Puts `accent` on <html>. Anything unrecognised falls back to the default
 *  rather than leaving a stale or empty attribute behind. Writes only on a
 *  change, so the app-state stream doesn't wake attribute observers (the
 *  terminal re-reads its colours on one) for nothing. */
export function applyAccent(accent: unknown, root: HTMLElement | null = pageRoot()): Accent {
  const next = isAccent(accent) ? accent : DEFAULT_ACCENT
  if (root && root.getAttribute('data-accent') !== next) root.setAttribute('data-accent', next)
  return next
}

/** <html>, or null where there is no page (the store under a node test). */
function pageRoot(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement
}

/** Calls `onChange` whenever the accent on <html> changes. For the few things
 *  that paint with concrete colours read from the tokens (xterm, canvases),
 *  which can't follow a CSS variable on their own. */
export function onAccentChange(onChange: () => void, root: HTMLElement | null = pageRoot()): () => void {
  if (!root || typeof MutationObserver === 'undefined') return () => undefined
  const observer = new MutationObserver(onChange)
  observer.observe(root, { attributes: true, attributeFilter: ['data-accent'] })
  return () => observer.disconnect()
}

// The lit phrase's drift, on one clock for every phrase on screen.
//
// The band of colour slides across a lit phrase once every 7 s (the TUI's
// pace, internal/tui/glow.go), a pixel or so a step, 30 steps a second. As a
// CSS animation of background-position — which only the main thread can run —
// Blink restyled the phrase on every display frame, 120 times a second at
// 120 Hz, for as long as a phrase sat in the composer, though it only moved a
// quarter as often: a fifth of a core, for a still screen. Here the steps are
// written when they are due and at no other time, so the page has a frame to
// make only when the band has actually moved.
//
// A phrase scrolled out of sight stands still (one IntersectionObserver for
// all of them), the clock stops while no phrase can be seen or the window is
// hidden, and under reduced motion nothing moves — the colour stays, at rest.

/** One sweep of the band (the ramp is drawn twice, so a sweep lands on its
 *  own start). */
export const DRIFT_PERIOD_MS = 7000
/** Steps per sweep: 30 a second. */
export const DRIFT_STEPS = 210
const STEP_MS = DRIFT_PERIOD_MS / DRIFT_STEPS

interface Phrase {
  /** On the clock's step grid, so every phrase steps on the same tick. */
  start: number
  seen: boolean
}

const phrases = new Map<HTMLElement, Phrase>()
let timer: ReturnType<typeof setTimeout> | null = null
let sight: IntersectionObserver | null = null
let listening = false

/** Where the band stands `elapsed` ms into its drift, as the old
 *  `glow-drift 7s steps(210)` keyframes put it: 0 → -200%, in whole steps. */
export function driftPosition(elapsed: number): string {
  // A tick lands on its step or a hair after; never count it a step short.
  const step = Math.floor((Math.max(0, elapsed) + 1) / STEP_MS) % DRIFT_STEPS
  return step === 0 ? '0% 0' : `${(-200 * step) / DRIFT_STEPS}% 0`
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION).matches
}

function hidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

/** Restarts the clock when what stopped it lifts: the window shown again,
 *  reduced motion turned off. */
function listen(): void {
  if (listening) return
  listening = true
  document.addEventListener('visibilitychange', wake)
  if (typeof window.matchMedia === 'function') {
    window.matchMedia(REDUCED_MOTION).addEventListener?.('change', () => {
      if (reducedMotion()) {
        for (const el of phrases.keys()) el.style.backgroundPosition = ''
      }
      wake()
    })
  }
}

function wake(): void {
  if (timer !== null || hidden() || reducedMotion()) return
  let any = false
  for (const phrase of phrases.values()) any ||= phrase.seen
  if (!any) return
  // To the next step on the grid (not the one just written, a hair behind).
  const now = performance.now()
  let next = (Math.floor(now / STEP_MS) + 1) * STEP_MS
  if (next - now < 1) next += STEP_MS
  timer = setTimeout(tick, next - now)
}

function tick(): void {
  timer = null
  if (hidden() || reducedMotion()) return
  const now = performance.now()
  for (const [el, phrase] of phrases) {
    // Writing the value a phrase already has invalidates nothing.
    if (phrase.seen) el.style.backgroundPosition = driftPosition(now - phrase.start)
  }
  wake()
}

/**
 * Sets a lit phrase drifting, from the start of a sweep, as a CSS animation
 * starting on it would. Returns what stops it.
 */
export function drift(el: HTMLElement): () => void {
  listen()
  const now = performance.now()
  // Seen once the observer says so (its first report comes with the next
  // frame): a phrase in a row that is not being drawn (chat.css skips rows
  // out of sight) may never be reported, and must not keep the clock going.
  const observed = typeof IntersectionObserver === 'function'
  phrases.set(el, { start: now - (now % STEP_MS), seen: !observed })
  if (observed) {
    sight ??= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const phrase = phrases.get(entry.target as HTMLElement)
        if (phrase) phrase.seen = entry.isIntersecting
      }
      wake()
    })
    sight.observe(el)
  }
  wake()
  return () => {
    phrases.delete(el)
    sight?.unobserve(el)
    if (phrases.size === 0 && timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
}

/** Tests only: how many phrases are drifting, and whether the clock runs. */
export function driftState(): { phrases: number; ticking: boolean } {
  return { phrases: phrases.size, ticking: timer !== null }
}

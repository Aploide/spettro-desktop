// The thinking slider: how hard the model thinks, from Low to Max, and one
// stop past Max — Ultra, where substantial tasks run as multi-agent
// workflows. It replaces both the thinking menu and the Ultra toggle: two
// controls for what users experience as one dial ("how much effort").
//
// Ultra is thinking *high* plus the CLI's ultracode switch (thinking.ts says
// why not max). Under the Ask first permission the CLI keeps Ultra saved but
// suspended — a workflow's agents would drown the user in approval prompts —
// so the stop shows as Paused and offers the way out right there, rather than
// refusing the move or hiding the stop. A control that vanishes when you
// can't use it is a control nobody learns exists.
//
// Arriving at Ultra is the one moment that changes what a turn *is*, so it is
// marked: the thumb becomes a meteor and streaks into the stop along the bar
// (meteor.ts), then stays lit. Only on the way in — never on mount, never on a
// re-render that finds it already there — and a plain glow under reduced
// motion. While it stays lit and the slider is open, the bar smoulders
// (embers.ts); under reduced motion it is simply fire, standing still.
//
// ThinkingChip is the compact form for a toolbar: the current level as a chip
// that opens the slider in a popover.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { CSSProperties, JSX, KeyboardEvent, PointerEvent } from 'react'
import type { ChatDetail } from '@shared/model'
import { call, useApp } from '@renderer/state/store'
import { Icon } from '@renderer/design/icons'
import Popover from '@renderer/views/common/Popover'
import { drawEmbers, planEmbers } from './embers'
import { drawMeteor, meteorTiming, planMeteor, readPalette } from './meteor'
import {
  PERMISSION_ID,
  RESTRICTED,
  ULTRA_CAPTION,
  ULTRA_ID,
  callsFor,
  modelReasons,
  previewState,
  thinkingState,
  type ThinkingState,
  type ThinkingStop
} from './thinking'
import './thinkingSlider.css'

const OFF_CAPTION = 'Thinking is off — the model answers straight away'
/** Where the thumb rests while thinking is off: left of the Low stop, just
 *  clear of the bar's end (its cap, 8px, plus the 12px ring's radius). */
const OFF_THUMB = '-14px'
const PAUSED_CAPTION = 'Ultra is saved, but workflows don’t run under Ask first'
/** How long a move's preview outlives its calls when the options never come
 *  round to it (the CLI refused, and rolled the option back). */
const SETTLE_MS = 1200

/** A press on the bar, and where it has been dragged. `at` is the stop under
 *  the pointer — the one a release selects, and what the words name. `rest`
 *  is where the thumb is drawn meanwhile: the same, except over Ultra while
 *  Ultra isn't on. Ultra is reached by the meteor, on release, from where
 *  the thumb stands; a thumb that slid there first, lit, and then went back
 *  for the meteor to set out from Max was the press playing twice. */
interface Press {
  at: number
  rest: number
}

interface SliderProps {
  chat: ChatDetail
  /** Whether the session's model reasons; false disables the slider. */
  reasons?: boolean | null
  /** Focus the slider once it is on screen (it opens in a popover). */
  autoFocus?: boolean
  /** Harness only: freeze a meteor at this point of its run (0…1). */
  meteorProgress?: number
  /** Harness only: the stop the frozen meteor set out from. */
  meteorFrom?: number
  /** Harness only: freeze lit Ultra's smoulder this many seconds in. */
  idleTime?: number
}

export default function ThinkingSlider({
  chat,
  reasons = null,
  autoFocus = false,
  meteorProgress,
  meteorFrom,
  idleTime
}: SliderProps): JSX.Element | null {
  const base = thinkingState(chat.configOptions)
  const [pending, setPending] = useState<ThinkingStop | null>(null)
  // The move's calls have all returned; the preview waits for the options.
  const [sent, setSent] = useState(false)
  const [drag, setDrag] = useState<Press | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const commit = useCommit(chat.id, base)
  const bodyRef = useRef<HTMLDivElement>(null)
  const railRef = useRef<HTMLDivElement>(null)

  const state: ThinkingState | null = base && pending ? previewState(base, pending) : base
  const lit = !!state && state.ultraOn && !state.paused
  const meteor = useMeteor(lit, drag?.rest ?? state?.index ?? -1, state?.stops.length ?? 0)
  const frozen = meteorProgress !== undefined || idleTime !== undefined
  const reduced = useReducedMotion()
  const visible = usePageVisible()

  useEffect(() => {
    if (!autoFocus) return
    // The popover paints once off-screen to measure itself; focus after it
    // has moved into place, or the focus lands on a hidden element.
    const id = setTimeout(() => bodyRef.current?.focus(), 0)
    return () => clearTimeout(id)
  }, [autoFocus])

  // The preview gives way once the options say what it says. A call's reply
  // and the option update it causes arrive separately, the update a beat
  // later: clearing the preview on the reply showed the old value for a
  // frame — Ultra going dark between "thinking high" and "ultra on", which
  // relaunched the meteor from High. If the options never come round (a
  // refusal rolls them back), the preview lets go shortly after the calls.
  // Only once they are all through, though: a burst that comes back to where
  // it began (Ultra, ←, →) matches the options before its first call's
  // update has even arrived, and letting go then shows that update — High,
  // the meteor relaunching — on its way back.
  const caughtUp =
    !!base &&
    !!pending &&
    base.ultraOn === pending.ultra &&
    (pending.ultra || base.thinking === pending.id)
  useEffect(() => {
    if (!pending || !sent) return
    if (caughtUp) {
      setPending(null)
      setSent(false)
      return
    }
    const id = setTimeout(() => {
      setPending(null)
      setSent(false)
    }, SETTLE_MS)
    return () => clearTimeout(id)
  }, [pending, sent, caughtUp])

  // "Keep Ask first" dismisses the prompt until Ultra next pauses.
  const paused = !!state?.paused
  useEffect(() => {
    if (!paused) setDismissed(false)
  }, [paused])

  if (!state) return null
  const { stops } = state
  const last = stops.length - 1
  const disabled = reasons === false
  const ultraIndex = stops.findIndex((s) => s.ultra)
  // Where the thumb is drawn, and the stop the words name: apart only while
  // a press is over an Ultra that isn't on yet (see Press).
  const shown = drag?.rest ?? state.index
  const aim = drag?.at ?? state.index
  const shownStop = shown >= 0 ? stops[shown] : null
  const aimStop = aim >= 0 ? stops[aim] : null
  const frac = (i: number): number => (last <= 0 ? 0 : Math.max(0, i) / last)

  const flight =
    meteorProgress !== undefined
      ? { from: meteorFrom ?? Math.max(0, ultraIndex - 1), progress: meteorProgress }
      : meteor.flight
  const landed =
    meteorProgress !== undefined && flight
      ? meteorProgress >= meteorTiming(frac(flight.from), frac(ultraIndex)).lands
      : meteor.landed
  // In flight the meteor's streak *is* the fill: the bar stays where the eye
  // last saw it and the canvas burns it the rest of the way, so fire and fill
  // can never come apart. It takes over again, whole, at impact. The hidden
  // thumb waits there too, and is put down on Ultra at impact: a thumb sent
  // on ahead would slide there unseen, and slide back into view from the
  // far end if the CLI refused the move mid-flight.
  const at = flight && !landed ? flight.from : shown
  const fillFrac = frac(at)
  // Lit and settled on Ultra, with nothing else moving: the bar smoulders —
  // for as long as someone could be looking at it.
  const smoulder =
    lit &&
    !disabled &&
    shown === ultraIndex &&
    !flight &&
    (idleTime !== undefined || (!reduced && visible))

  const select = (i: number): void => {
    if (disabled || i < 0 || i > last || i === state.index) return
    setPending(stops[i])
    setSent(false)
    void commit(stops[i]).then((settled) => {
      // Only the last move in a burst lets the preview go, so the thumb never
      // steps back through a stale value between two of them.
      if (settled) setSent(true)
    })
  }

  const indexAt = (clientX: number): number | null => {
    const rect = railRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return null
    const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return Math.round(f * last)
  }

  // Over an Ultra that isn't on, the thumb stays where it last stood.
  const pressAt = (i: number, rest: number): Press => ({
    at: i,
    rest: i === ultraIndex && state.index !== ultraIndex ? rest : i
  })
  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (disabled || e.button !== 0) return
    e.preventDefault()
    bodyRef.current?.focus()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setDrag(pressAt(indexAt(e.clientX) ?? state.index, state.index))
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (drag === null) return
    const i = indexAt(e.clientX)
    if (i !== null && i !== drag.at) setDrag(pressAt(i, drag.rest))
  }
  const onPointerUp = (): void => {
    if (drag === null) return
    setDrag(null)
    select(drag.at)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return
    const at = state.index
    let next: number | null = null
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = Math.min(last, at + 1)
        break
      case 'ArrowLeft':
      case 'ArrowDown':
        // From Off there is nothing further left.
        next = at < 0 ? null : Math.max(0, at - 1)
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = last
        break
      default:
        return
    }
    e.preventDefault()
    if (next !== null) select(next)
  }

  // The prompt's buttons go away once pressed; the slider keeps the focus
  // rather than <body>.
  const refocus = (): void => bodyRef.current?.focus()

  const showPaused = state.paused && shown === ultraIndex
  const caption = disabled
    ? `${modelName(chat) ?? 'This model'} doesn’t think before answering, so this has no effect`
    : !aimStop
      ? OFF_CAPTION
      : showPaused
        ? PAUSED_CAPTION
        : aimStop.caption
  const valueLabel = showPaused ? 'Ultra · Paused' : aimStop ? aimStop.label : 'Off'

  const className =
    'thinking-slider' +
    (shownStop?.ultra ? (showPaused ? ' thinking-slider--paused' : ' thinking-slider--ultra') : '') +
    (shown < 0 ? ' thinking-slider--off' : '') +
    (disabled ? ' thinking-slider--disabled' : '') +
    (drag !== null ? ' thinking-slider--dragging' : '') +
    (flight && !landed ? ' thinking-slider--flying' : '') +
    (flight ? ' thinking-slider--meteor' : '') +
    (frozen ? ' thinking-slider--frozen' : '') +
    (meteor.glowIn ? ' thinking-slider--glow-in' : '')

  return (
    <div className={className}>
      <div className="thinking-head">
        <span className="thinking-title">Thinking</span>
        <span className="thinking-value">{valueLabel}</span>
      </div>

      <div
        ref={bodyRef}
        className="thinking-body"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Thinking"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={Math.max(0, state.index)}
        aria-valuetext={
          state.paused
            ? 'Ultra, paused — workflows need Restricted or Don’t ask permission'
            : state.label
        }
        aria-disabled={disabled || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
        onKeyDown={onKeyDown}
      >
        {/* The rail is the stops' line, Low to Ultra; the bar is drawn round
            it, half its height further at each end, so every stop sits
            inside the pill. Positions in the bar are shares of the rail
            (--f), offset by that end cap. */}
        <div
          className="thinking-rail"
          ref={railRef}
          style={{ '--fire-start': frac(ultraIndex - 1) } as CSSProperties}
        >
          <div className="thinking-bar">
            {ultraIndex > 0 && (
              <div className="thinking-fire" style={{ '--f': frac(ultraIndex - 1) } as CSSProperties} />
            )}
            <div className="thinking-fill" style={{ '--f': fillFrac } as CSSProperties} />
            {stops.map((stop, i) => (
              <span
                key={stop.id}
                // Lit where the fill is: in flight, the ticks ahead of the head
                // wait for the streak (which covers them as it passes).
                className={
                  'thinking-tick' + (i <= shown && frac(i) <= fillFrac ? ' thinking-tick--passed' : '')
                }
                style={{ '--f': frac(i) } as CSSProperties}
              />
            ))}
            {smoulder && <EmberCanvas time={idleTime} />}
            {flight && (
              <MeteorCanvas
                key={meteor.key}
                fromFrac={frac(flight.from)}
                toFrac={frac(ultraIndex)}
                seed={frozen ? 7 : meteor.key}
                progress={flight.progress}
                onLanded={meteor.land}
                onDone={meteor.done}
              />
            )}
          </div>
          {/* Off is not a stop: its hollow thumb waits short of Low, so the
              slider never looks as if it were on Low while saying Off. */}
          <span className="thinking-thumb" style={{ left: at < 0 ? OFF_THUMB : `${frac(at) * 100}%` }}>
            {showPaused && <PauseGlyph />}
          </span>
        </div>
      </div>

      <div className="thinking-labels" aria-hidden>
        {stops.map((stop, i) => (
          <span
            key={stop.id}
            className={
              'thinking-label' +
              (i === aim ? ' thinking-label--current' : '') +
              (stop.ultra ? ' thinking-label--ultra' : '') +
              (i === 0 ? ' thinking-label--first' : i === last ? ' thinking-label--last' : '')
            }
            style={{ left: `${frac(i) * 100}%` }}
            onClick={() => select(i)}
          >
            {stop.label}
          </span>
        ))}
      </div>

      <div className="thinking-caption" title={aimStop?.ultra ? ULTRA_CAPTION : undefined}>
        {caption}
      </div>

      {disabled && state.ultraOn && (
        <div className="thinking-prompt">
          <span className="thinking-prompt-text">Ultra is still on for this model.</span>
          <div className="thinking-prompt-actions">
            <button
              type="button"
              className="thinking-prompt-btn"
              onClick={() => {
                refocus()
                void call('setBoolOption', chat.id, ULTRA_ID, false)
              }}
            >
              Turn off Ultra
            </button>
          </div>
        </div>
      )}

      {!disabled && state.paused && !dismissed && (
        <div className="thinking-prompt" role="status">
          <Icon name="pause.circle.fill" size={13} className="thinking-prompt-icon" />
          <span className="thinking-prompt-text">
            Workflows need Restricted or Don’t ask permission.
            {state.canRestrict ? ' Switch to Restricted?' : ''}
          </span>
          <div className="thinking-prompt-actions">
            {state.canRestrict && (
              <button
                type="button"
                className="thinking-prompt-btn thinking-prompt-btn--primary"
                onClick={() => {
                  refocus()
                  void call('setSelectOption', chat.id, PERMISSION_ID, RESTRICTED)
                }}
              >
                Switch
              </button>
            )}
            <button
              type="button"
              className="thinking-prompt-btn"
              onClick={() => {
                refocus()
                setDismissed(true)
              }}
            >
              Keep Ask first
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** The session's model, by the name its menu shows. */
function modelName(chat: ChatDetail): string | null {
  const model = chat.configOptions.find((o) => o.id === 'model')
  if (model?.kind.type !== 'select' || !model.kind.currentValue) return null
  const value = model.kind.currentValue
  const choice = model.kind.groups
    .flatMap((g) => g.options)
    .concat(model.kind.flat)
    .find((c) => c.value === value)
  return choice?.name ?? null
}

// ---------------------------------------------------------------------------
// Committing a move
// ---------------------------------------------------------------------------

/**
 * Sends a move to the CLI, one call at a time. Arrow keys can produce moves
 * faster than the CLI answers, so moves made while one is in flight collapse
 * into the latest: Low → Max in four presses sends one change, not four
 * interleaved ones. Resolves true when the queue has drained.
 */
function useCommit(
  chatId: string,
  base: ThinkingState | null
): (stop: ThinkingStop) => Promise<boolean> {
  const queue = useRef<{ target: ThinkingStop | null; running: boolean }>({
    target: null,
    running: false
  })
  // What the CLI's Ultra is, as far as this queue knows: the options while
  // idle, its own last call while running (the options lag a round trip).
  const ultraOn = useRef(base?.ultraOn ?? false)
  if (!queue.current.running) ultraOn.current = base?.ultraOn ?? false

  return useCallback(
    async (stop: ThinkingStop): Promise<boolean> => {
      const q = queue.current
      q.target = stop
      if (q.running) return false
      q.running = true
      try {
        while (q.target) {
          const next = q.target
          q.target = null
          for (const c of callsFor(ultraOn.current, next)) {
            try {
              if (typeof c.value === 'boolean') {
                await call('setBoolOption', chatId, c.configId, c.value)
              } else {
                await call('setSelectOption', chatId, c.configId, c.value)
              }
            } catch {
              // The main process files a refusal as a notice in the chat and
              // rolls the option back; the slider follows the options.
            }
            if (c.configId === ULTRA_ID) ultraOn.current = c.value === true
          }
        }
      } finally {
        q.running = false
      }
      return true
    },
    [chatId]
  )
}

// ---------------------------------------------------------------------------
// The meteor
// ---------------------------------------------------------------------------

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION).matches
}

/** Reduced motion, followed live: turned on with the slider open, the
 *  smoulder stops there and then. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(REDUCED_MOTION)
    const update = (): void => setReduced(query.matches)
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [])
  return reduced
}

/** Whether the window can be seen at all: minimised or hidden, nothing on
 *  it is worth a frame. */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const update = (): void => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return visible
}

/** The rail a canvas in the bar measures itself against. Found from the
 *  canvas rather than handed down as a ref: a child's layout effect runs
 *  before its parent's ref is attached, so on a slider that mounts with a
 *  canvas in it (opened on lit Ultra, or a harness frame) the ref is empty. */
function railOf(canvas: HTMLCanvasElement | null): HTMLElement | null {
  return canvas?.closest<HTMLElement>('.thinking-rail') ?? null
}

/** Sizes a canvas's backing store to its box at the screen's density, and
 *  returns its CSS size. */
function fitCanvas(canvas: HTMLCanvasElement): { width: number; height: number; dpr: number } {
  const dpr = window.devicePixelRatio || 1
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  return { width, height, dpr }
}

interface MeteorState {
  flight: { from: number; progress?: number } | null
  landed: boolean
  key: number
  glowIn: boolean
  land: () => void
  done: () => void
}

interface MeteorRun {
  /** What the last render saw: whether Ultra was lit, and where the thumb
   *  was drawn. */
  lit: boolean
  shown: number
  flight: { from: number; landed: boolean } | null
  /** Counts flights; each one's canvas is keyed by it. */
  key: number
  glowIn: boolean
}

/**
 * Starts a meteor when Ultra becomes lit — and only then. `shown` is the stop
 * the thumb was drawn at, so the flight starts where the eye last saw it.
 *
 * Decided while rendering, not in an effect after it: an effect let the
 * render that lit Ultra commit without its flight — the smoulder mounting
 * for it, the thumb and fill starting their slides to Ultra — before the
 * flight's own render undid them, all inside the frame the meteor appeared.
 */
function useMeteor(lit: boolean, shown: number, count: number): MeteorState {
  const [run, setRun] = useState<MeteorRun>(() => ({
    // Drawn lit already (on mount) is not an arrival.
    lit,
    shown,
    flight: null,
    key: 0,
    glowIn: false
  }))
  if (run.lit !== lit || run.shown !== shown) {
    let next: MeteorRun = { ...run, lit, shown }
    if (lit && !run.lit) {
      if (prefersReducedMotion()) {
        next = { ...next, glowIn: true }
      } else {
        const ultra = count - 1
        // Lit with the thumb already on Ultra (a pause lifted), fly in from
        // the stop before it rather than not at all.
        const from = run.shown >= ultra ? ultra - 1 : run.shown
        next = { ...next, flight: { from: Math.max(0, from), landed: false }, key: run.key + 1 }
      }
    } else if (!lit) {
      next = { ...next, flight: null, glowIn: false }
    }
    // React renders again at once with this, before anything is committed.
    setRun(next)
  }

  const land = useCallback(
    () => setRun((r) => (r.flight ? { ...r, flight: { ...r.flight, landed: true } } : r)),
    []
  )
  const done = useCallback(() => setRun((r) => ({ ...r, flight: null })), [])
  return {
    flight: run.flight,
    landed: run.flight?.landed ?? true,
    key: run.key,
    glowIn: run.glowIn,
    land,
    done
  }
}

/**
 * The canvas the meteor is drawn on, filling the bar, whose pill clips it.
 * Runs one flight and reports when the head lands (the CSS thumb takes over
 * from there) and when the last spark is out. With `progress` it draws that
 * one frame and stays.
 */
function MeteorCanvas({
  fromFrac,
  toFrac,
  seed,
  progress,
  onLanded,
  onDone
}: {
  fromFrac: number
  toFrac: number
  seed: number
  progress?: number
  onLanded: () => void
  onDone: () => void
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  const callbacks = useRef({ onLanded, onDone })
  callbacks.current = { onLanded, onDone }

  useLayoutEffect(() => {
    const canvas = ref.current
    const rail = railOf(canvas)
    const ctx = canvas?.getContext?.('2d') ?? null
    if (!canvas || !rail || !ctx) {
      // Nothing to draw on (no canvas support): keep the timing, so the
      // thumb still lands and lights.
      if (progress !== undefined) return
      const timing = meteorTiming(fromFrac, toFrac)
      const landT = setTimeout(() => callbacks.current.onLanded(), timing.landsMs)
      const doneT = setTimeout(() => callbacks.current.onDone(), timing.totalMs)
      return () => {
        clearTimeout(landT)
        clearTimeout(doneT)
      }
    }
    const { width, height, dpr } = fitCanvas(canvas)
    // The canvas is the bar, which runs an end cap past the rail each side.
    const run = planMeteor(
      {
        railLeft: rail.getBoundingClientRect().left - canvas.getBoundingClientRect().left,
        railWidth: rail.offsetWidth,
        y: height / 2,
        height,
        fromFrac,
        toFrac
      },
      seed
    )
    const palette = readPalette(canvas)
    const paint = (p: number): void => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      drawMeteor(ctx, run, p, palette)
    }
    if (progress !== undefined) {
      paint(progress)
      return
    }
    // The first frame now, before the browser paints: the thumb is already
    // hidden, and a frame with neither it nor the head is a blink.
    paint(0)
    let frame = 0
    let landed = false
    const start = performance.now()
    const lands = run.flight / run.total
    const tick = (now: number): void => {
      const p = (now - start) / (run.total * 1000)
      // The slider's side of each moment is committed now, before this
      // frame is drawn, not left to React's next task: from impact the canvas
      // draws its streak fading into the lit fill, and with that fill still
      // a frame away the bar showed empty behind the head for a frame.
      if (!landed && p >= lands) {
        landed = true
        flushSync(() => callbacks.current.onLanded())
      }
      if (p >= 1) {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        flushSync(() => callbacks.current.onDone())
        return
      }
      paint(p)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
    // One flight per mount: the parent keys the canvas by flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <canvas ref={ref} className="thinking-meteor" aria-hidden />
}

/** How often the smoulder is redrawn: its embers move about a pixel a
 *  frame at this rate, and it costs half of what every frame would. */
const SMOULDER_FRAME_MS = 1000 / 30

/**
 * Lit Ultra's smoulder (embers.ts), on a canvas filling the bar. Runs until
 * it unmounts — the slider takes it away when the popover closes, the window
 * is hidden or reduced motion is turned on. With `time` it draws that one
 * frame and stays.
 */
function EmberCanvas({ time }: { time?: number }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)

  useLayoutEffect(() => {
    const canvas = ref.current
    const rail = railOf(canvas)
    const ctx = canvas?.getContext?.('2d') ?? null
    if (!canvas || !rail || !ctx) return
    const { width, height, dpr } = fitCanvas(canvas)
    // Ultra is the last stop: the fill ends where the rail does.
    const field = planEmbers(
      {
        fillEnd: rail.getBoundingClientRect().right - canvas.getBoundingClientRect().left,
        height
      },
      11
    )
    const palette = readPalette(canvas)
    const paint = (t: number): void => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      drawEmbers(ctx, field, t, palette)
    }
    if (time !== undefined) {
      paint(time)
      return
    }
    let frame = 0
    let last = -Infinity
    const start = performance.now()
    const tick = (now: number): void => {
      frame = requestAnimationFrame(tick)
      if (now - last < SMOULDER_FRAME_MS - 2) return
      last = now
      paint((now - start) / 1000)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [time])

  return <canvas ref={ref} className="thinking-embers" aria-hidden />
}

function PauseGlyph(): JSX.Element {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
      <path d="M2.6 1.6v4.8M5.4 1.6v4.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Toolbar chip
// ---------------------------------------------------------------------------

/**
 * The current level as a toolbar chip ("High", "Ultra"), opening the slider.
 * Lit Ultra wears the slider's fire; paused Ultra is muted with a pause mark.
 */
export function ThinkingChip({ chat }: { chat: ChatDetail }): JSX.Element | null {
  const app = useApp()
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => {
    // The slider took focus when the popover opened; hand it back to the chip
    // on the way out, or Escape strands a keyboard user on <body>. A click
    // elsewhere closes from its pointerdown, and the mousedown after it still
    // moves the focus to wherever the click landed.
    const active = document.activeElement
    if (active && active !== document.body && dialogRef.current?.contains(active)) {
      anchorRef.current?.focus()
    }
    setOpen(false)
  }, [])
  const state = thinkingState(chat.configOptions)
  if (!state) return null

  const reasons = modelReasons(chat.configOptions, app?.extensions?.models.models ?? [])
  const lit = state.ultraOn && !state.paused
  const title = lit
    ? ULTRA_CAPTION
    : state.paused
      ? 'Ultra is paused under Ask first — workflows need Restricted or Don’t ask permission'
      : `Thinking: ${state.label}`
  const className =
    'config-chip thinking-chip' +
    (lit ? ' thinking-chip--ultra' : '') +
    (state.paused ? ' thinking-chip--paused' : '') +
    (reasons === false ? ' thinking-chip--inert' : '')

  return (
    <div className="chip-wrap">
      <button
        ref={anchorRef}
        type="button"
        className={className}
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="thinking-chip"
        onClick={() => setOpen((o) => !o)}
      >
        {state.paused ? (
          <Icon name="pause.circle.fill" size={13} />
        ) : (
          <Icon name={lit ? 'flame' : 'brain'} size={13} />
        )}
        <span className="config-chip-label">
          {/* A bare "Off" in a toolbar reads as something broken. */}
          {state.index < 0 ? 'Thinking off' : state.label}
          {state.paused && <span className="config-chip-hint"> · Paused</span>}
        </span>
        <svg className="config-chip-chevron" width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="m3 6 5 5 5-5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={close}
        placement="up"
        className="thinking-popover"
      >
        <div role="dialog" aria-label="Thinking" ref={dialogRef}>
          <ThinkingSlider chat={chat} reasons={reasons} autoFocus />
        </div>
      </Popover>
    </div>
  )
}

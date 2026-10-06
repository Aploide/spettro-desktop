// Port of spettro-apple/Spettro/Views/RunTicker.swift — the live readout of
// an in-flight turn, as one muted line at the tail of the transcript:
// "Working… 12s · 3.4k tokens · Esc to interrupt".
//
// The first word says what the turn is doing as far as the transcript can
// tell. That matters more here than in most chat apps: the CLI does not
// stream its answer (it arrives whole when the turn ends), so after the last
// tool call there is a stretch where nothing on screen moves. Saying
// "Writing the answer…" there is the difference between a turn that looks
// busy and one that looks stuck.
//
// It ticks once a second rather than per frame: the spinner carries the
// sense of motion, and re-rendering a text run at 20 fps to advance a
// seconds counter would be wasted work.
//
// The macOS model owns `runStartedAt` / `tokensAtRunStart`; here the ticker
// derives both from the mirrored ChatDetail: the run starts when `isBusy`
// flips true and ends when it flips false.

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, JSX } from 'react'
import type { ACPConfigOption } from '@shared/acp'
import type { ChatDetail, TranscriptItem } from '@shared/model'
import { modeColor } from '@renderer/design/theme'
import { useStore } from '@renderer/state/store'
import './transcript.css'

/**
 * What a running turn is doing, from the tail of its transcript: waiting on
 * the user (an approval, or an answer to its question), thinking (reasoning
 * is streaming), working (a tool is running), or — every tool settled and
 * the model on its own again — writing the answer.
 */
export function runPhase(
  items: TranscriptItem[],
  awaitingApproval: boolean,
  awaitingAnswer = false
): string {
  if (awaitingApproval) return 'Waiting for your approval…'
  if (awaitingAnswer) return 'Waiting for your answer…'
  // Only this turn counts: the tail after the newest user message that
  // started one (a steer sent mid-turn doesn't start anything).
  let start = 0
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    const startsTurn =
      item.kind === 'message' && item.message.role === 'user' && item.message.steering === undefined
    if (startsTurn) {
      start = i + 1
      break
    }
  }
  const turn = items.slice(start)
  const running = turn.some(
    (item) =>
      item.kind === 'tool' && (item.tool.status === 'in_progress' || item.tool.status === 'pending')
  )
  if (running) return 'Working…'
  const last = turn.findLast((item) => !(item.kind === 'message' && item.message.role === 'user'))
  if (!last) return 'Working…'
  if (last.kind === 'message' && last.message.role === 'reasoning' && last.message.isStreaming) {
    return 'Thinking…'
  }
  if (last.kind === 'tool' || (last.kind === 'message' && last.message.role !== 'notice')) {
    return 'Writing the answer…'
  }
  return 'Working…'
}

export function RunTicker({ chat }: { chat: ChatDetail }): JSX.Element | null {
  const busy = chat.isBusy
  const tokensUsed = chat.usage?.tokensUsed ?? 0
  const awaiting = useStore((s) => s.permissions.some((p) => p.chatId === chat.id))
  const asking = useStore((s) => s.questions.some((q) => q.chatId === chat.id))

  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const tokensAtRunStart = useRef(0)
  // Read the latest token total inside the busy-transition effect without
  // re-arming it on every usage update.
  const tokensRef = useRef(tokensUsed)
  tokensRef.current = tokensUsed

  useEffect(() => {
    if (busy) {
      tokensAtRunStart.current = tokensRef.current
      setStartedAt(Date.now())
    } else {
      setStartedAt(null)
    }
  }, [busy, chat.id])

  // Re-renders the elapsed label once a second while a run is active.
  useEffect(() => {
    if (startedAt === null) return undefined
    setNow(Date.now())
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [startedAt])

  if (startedAt === null) return null

  const elapsed = elapsedLabel(startedAt, now)
  const liveTokens = chat.usage?.tokensUsed != null ? Math.max(0, tokensUsed - tokensAtRunStart.current) : 0
  const color = tickerModeColor(chat.configOptions)
  const phase = runPhase(chat.items, awaiting, asking)
  // While the turn waits on the user, Esc answers the sheet (deny, skip)
  // rather than interrupting, so the hint would be wrong there.
  const waitingOnUser = awaiting || asking

  return (
    <div className="tk" role="status" aria-label={`${phase} ${elapsed}`}>
      <SpettroSpinner size={12} color={color} />
      <span className="tk-phase tr-shimmer">{phase}</span>
      <span className="tk-num">{elapsed}</span>
      {liveTokens > 0 && (
        <>
          <span aria-hidden="true">·</span>
          <span className="tk-num">{formatTokens(liveTokens)} tokens</span>
        </>
      )}
      {!waitingOnUser && (
        <>
          <span aria-hidden="true">·</span>
          <span className="tk-hint">Esc to interrupt</span>
        </>
      )}
    </div>
  )
}

/** The active mode's tint, so the spinner matches the agent that's running. */
function tickerModeColor(options: ACPConfigOption[]): string {
  const mode = options.find((o) => o.id === 'mode')
  if (!mode) return 'var(--accent)'
  return modeColor(currentLabel(mode))
}

/** Port of ACPConfigOption.currentLabel: the selected option's display name. */
function currentLabel(option: ACPConfigOption): string {
  if (option.kind.type === 'boolean') return option.kind.currentValue ? 'On' : 'Off'
  const current = option.kind.currentValue
  if (current === null) return ''
  for (const choice of option.kind.flat) {
    if (choice.value === current) return choice.name
  }
  for (const group of option.kind.groups) {
    for (const choice of group.options) {
      if (choice.value === current) return choice.name
    }
  }
  return current
}

function elapsedLabel(start: number, now: number): string {
  const seconds = Math.round((now - start) / 1000)
  if (seconds < 60) return `${Math.max(0, seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}

// ---------------------------------------------------------------------------
// SpettroSpinner — port of Design/Motion/SpettroSpinner.swift
// ---------------------------------------------------------------------------

/**
 * The TUI's braille busy spinner, natively: eight dots on a circle,
 * brightness falling off behind the leading one, one revolution per 400 ms
 * in eight discrete steps — the same cadence as ⣾⣽⣻⢿⡿⣟⣯⣷ at 50 ms/frame.
 */
export function SpettroSpinner({
  size = 16,
  color
}: {
  size?: number
  color?: string
}): JSX.Element {
  const dotCount = 8
  const dotRadius = Math.max(1, size * 0.11)
  const radius = size / 2 - dotRadius
  const style: CSSProperties = { width: size, height: size }
  if (color) style.color = color
  return (
    <span className="tr-spinner" style={style} aria-hidden="true">
      {Array.from({ length: dotCount }, (_, i) => {
        const angle = (i / dotCount) * 2 * Math.PI - Math.PI / 2
        return (
          <span
            key={i}
            className="tr-spinner-dot"
            style={{
              width: dotRadius * 2,
              height: dotRadius * 2,
              left: size / 2 + Math.cos(angle) * radius - dotRadius,
              top: size / 2 + Math.sin(angle) * radius - dotRadius,
              opacity: Math.max(0.12, 1 - i * 0.16)
            }}
          />
        )
      })}
    </span>
  )
}

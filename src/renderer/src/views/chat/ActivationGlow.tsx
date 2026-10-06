// Lighting up the phrase that changes what the next turn can do.
//
// "ultracode" — or "use a workflow to …" — silently arms multi-agent
// orchestration, and a phrase that looks like every other phrase gives no sign
// of that. The TUI answers this with an animated shimmer over the exact words
// that matched (internal/tui/glow.go); this is the same idea with the web's
// own tools, driven by the same matcher the CLI uses so the highlight can
// never promise a mode the run will not enter.
//
// A "+500k" budget directive lights the same way, but only when it would be
// honoured — when workflows are on for the message (budgetDirectivesLive) —
// so the glow never promises a budget nobody enforces.
//
// Under the "Ask first" permission level workflows do not run at all (the CLI
// refuses them: internal/agent/workflow.go), so the phrase is still marked —
// it is still what the user asked for — but in a muted, still variant, and
// the composer says why underneath (WorkflowHint) instead of letting a lit
// phrase promise a run that will not happen.
//
// Two renderers, one look:
//
//   * ActivationText — read-only prose (a sent message). Trivial.
//   * ActivationTextarea — a live input. This is the awkward one. A textarea
//     cannot style its own contents, so the styled copy is a mirror rendered
//     underneath and the real textarea sits on top with transparent text. The
//     mirror is only honest while the two share every metric that affects
//     wrapping, which is why they share a class rather than two lists of
//     matching declarations, and why the mirror is scrolled in lockstep.

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type {
  ChangeEvent,
  ClipboardEvent,
  JSX,
  KeyboardEvent,
  MutableRefObject,
  UIEvent
} from 'react'
import { workflowRequested } from '@shared/workflowActivation'
import { compactTokens, splitWorkflowInput } from '@shared/workflowBudget'
import { Icon } from '@renderer/design/icons'
import './activation.css'

/**
 * The matched phrases, lit; everything else plain. `budgets` defaults to what
 * the text alone decides (a directive counts beside an activating phrase): a
 * sent message no longer knows whether Ultra was on when it went.
 */
export function ActivationText({
  text,
  budgets,
  muted = false
}: {
  text: string
  budgets?: boolean
  muted?: boolean
}): JSX.Element {
  const pieces = splitWorkflowInput(text, budgets ?? workflowRequested(text))
  return (
    <>
      {pieces.map((piece, i) =>
        piece.active ? (
          <span className={muted ? 'glow glow--muted' : 'glow'} key={i}>
            {piece.text}
          </span>
        ) : (
          // Plain prose needs no element of its own: the glow paints on its own
          // glyphs and never outside them, so there is nothing here to defend
          // against. (There was, when the effect drew a pill: the pill's
          // horizontal overhang sat on top of the next character and ate it.)
          <Fragment key={i}>{piece.text}</Fragment>
        )
      )}
    </>
  )
}

interface Props {
  value: string
  onChange: (next: string) => void
  className: string
  placeholder?: string
  rows?: number
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void
  onFocus?: () => void
  onBlur?: () => void
  textareaRef?: MutableRefObject<HTMLTextAreaElement | null>
  /** Light "+500k" directives too (they would be honoured). */
  budgets?: boolean
  /** Workflows cannot run right now (Ask first): mark, but quietly. */
  muted?: boolean
}

export function ActivationTextarea({
  value,
  onChange,
  className,
  placeholder,
  rows,
  onKeyDown,
  onPaste,
  onFocus,
  onBlur,
  textareaRef,
  budgets = false,
  muted = false
}: Props): JSX.Element {
  const ownRef = useRef<HTMLTextAreaElement>(null)
  const area = textareaRef ?? ownRef
  const mirrorRef = useRef<HTMLDivElement>(null)

  // The mirror scrolls with the input rather than being a sibling that scrolls
  // itself: only the textarea knows where the caret dragged the viewport to.
  const syncScroll = useCallback(() => {
    const el = area.current
    const mirror = mirrorRef.current
    if (!el || !mirror) return
    mirror.scrollTop = el.scrollTop
    mirror.scrollLeft = el.scrollLeft
  }, [area])

  useLayoutEffect(syncScroll, [value, syncScroll])

  // The composer grows with its content, so the mirror has to be re-synced
  // when the element resizes and not only when the text changes.
  useEffect(() => {
    const el = area.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(syncScroll)
    observer.observe(el)
    return () => observer.disconnect()
  }, [area, syncScroll])

  // Only mount the mirror when there is something to light. Until then the
  // textarea renders its own text normally, so the overwhelmingly common case
  // pays nothing and cannot be misaligned.
  const lit = value !== '' && splitWorkflowInput(value, budgets).some((p) => p.active)

  return (
    <div className="glow-wrap">
      {lit && (
        <div
          ref={mirrorRef}
          className={`${className} glow-mirror`}
          aria-hidden="true"
          // The trailing newline keeps a final empty line from collapsing, so
          // the mirror's height matches the textarea's exactly.
          data-testid="activation-mirror"
        >
          <ActivationText text={value} budgets={budgets} muted={muted} />
          {'\n'}
        </div>
      )}
      <textarea
        ref={area}
        className={`${className}${lit ? ' glow-input' : ''}`}
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
        onScroll={(e: UIEvent<HTMLTextAreaElement>) => {
          const mirror = mirrorRef.current
          if (mirror) {
            mirror.scrollTop = e.currentTarget.scrollTop
            mirror.scrollLeft = e.currentTarget.scrollLeft
          }
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onFocus={onFocus}
        onBlur={onBlur}
      />
    </div>
  )
}

/**
 * The line under the composer that explains a lit phrase, when there is
 * something to explain: workflows are off under "Ask first" (with the one-click
 * way out, when the permission option offers it), or a budget directive will
 * cap the run's tokens. Renders nothing otherwise.
 */
export function WorkflowHint({
  pausedByAskFirst,
  budgetTokens,
  onSwitchPermission
}: {
  pausedByAskFirst: boolean
  budgetTokens: number | null
  onSwitchPermission?: () => void
}): JSX.Element | null {
  if (pausedByAskFirst) {
    return (
      <div className="workflow-hint workflow-hint--paused" role="status">
        <Icon name="pause.circle.fill" size={12} />
        <span className="workflow-hint-text">
          Workflows are paused under Ask first — switch permission to run them
        </span>
        {onSwitchPermission && (
          <button type="button" className="workflow-hint-action" onClick={onSwitchPermission}>
            Switch to Restricted
          </button>
        )}
      </div>
    )
  }
  if (budgetTokens !== null) {
    return (
      <div className="workflow-hint" role="status">
        <Icon name="flowchart" size={12} />
        <span className="workflow-hint-text">
          Workflows in this message share a budget of{' '}
          <strong className="workflow-hint-strong">{compactTokens(budgetTokens)} tokens</strong>
        </span>
      </div>
    )
  }
  return null
}

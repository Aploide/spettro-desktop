// Lighting up the phrase that changes what the next turn can do.
//
// "ultracode" — or "use a workflow to …" — silently arms multi-agent
// orchestration, and a phrase that looks like every other phrase gives no sign
// of that. The TUI answers this with an animated shimmer over the exact words
// that matched (internal/tui/glow.go); this is the same idea with the web's
// own tools, driven by the same matcher the CLI uses so the highlight can
// never promise a mode the run will not enter.
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

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type {
  ChangeEvent,
  ClipboardEvent,
  JSX,
  KeyboardEvent,
  MutableRefObject,
  UIEvent
} from 'react'
import { splitOnActivation } from '@shared/workflowActivation'
import './activation.css'

/** The matched phrases, lit; everything else plain. */
export function ActivationText({ text }: { text: string }): JSX.Element {
  const pieces = splitOnActivation(text)
  return (
    <>
      {pieces.map((piece, i) =>
        piece.active ? (
          <span className="glow" key={i}>
            {piece.text}
          </span>
        ) : (
          <span className="glow-plain" key={i}>
            {piece.text}
          </span>
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
  textareaRef
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
  const lit = value !== '' && splitOnActivation(value).some((p) => p.active)

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
          <ActivationText text={value} />
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

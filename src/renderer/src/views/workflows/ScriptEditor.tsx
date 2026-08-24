// A small code editor for workflow scripts.
//
// A textarea, with a gutter beside it and a syntax-highlighted mirror behind
// it. The app ships no editor component and a fifty-line script does not
// justify adding one — but an uncoloured monospace slab reads as a text box
// somebody forgot to finish, and this is the screen where people write the
// thing the whole feature exists for.
//
// The mirror is the same trick the composer's activation glow uses: a styled
// copy underneath, the real textarea on top with transparent glyphs and a
// visible caret. It only works while the two agree on every metric that
// affects where a line breaks, which is why they share a class instead of two
// lists of matching declarations, and why the editor does not soft-wrap —
// code is read by column, and a wrapped mirror is a mirror that can drift.
//
// The two things a textarea genuinely lacks for writing JavaScript — Tab that
// indents rather than leaving the field, and a newline that keeps the
// indentation you were on — are implemented here. Nothing else is.

import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ChangeEvent, JSX, KeyboardEvent, UIEvent } from 'react'
import { tokenize } from './highlight'
import './workflows.css'

const INDENT = '  '

export default function ScriptEditor({
  value,
  onChange
}: {
  value: string
  onChange: (next: string) => void
}): JSX.Element {
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const mirrorRef = useRef<HTMLPreElement>(null)

  // Re-tokenising on every keystroke is fine at this size — a 200-line script
  // is well under a millisecond — but there is no reason to redo it when the
  // component re-renders for some other reason.
  const tokens = useMemo(() => tokenize(value), [value])

  // The gutter is a separate element, so it has to be told where the text got
  // scrolled to. Doing it on the scroll event (rather than by making the
  // gutter a sibling that scrolls with it) keeps the line numbers from being
  // selectable along with the code when the user drags across both.
  const syncScroll = useCallback((e: UIEvent<HTMLTextAreaElement>) => {
    const { scrollTop, scrollLeft } = e.currentTarget
    if (gutterRef.current) gutterRef.current.scrollTop = scrollTop
    if (mirrorRef.current) {
      mirrorRef.current.scrollTop = scrollTop
      mirrorRef.current.scrollLeft = scrollLeft
    }
  }, [])

  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    if (gutterRef.current) gutterRef.current.scrollTop = area.scrollTop
    if (mirrorRef.current) {
      mirrorRef.current.scrollTop = area.scrollTop
      mirrorRef.current.scrollLeft = area.scrollLeft
    }
  }, [value])

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const area = e.currentTarget
      const { selectionStart: start, selectionEnd: end } = area

      if (e.key === 'Tab') {
        // Tab is indentation here, not focus movement. Shift+Tab still leaves
        // the field, so the editor never becomes a keyboard trap.
        if (e.shiftKey) return
        e.preventDefault()
        const next = value.slice(0, start) + INDENT + value.slice(end)
        onChange(next)
        queueMicrotask(() => {
          area.selectionStart = area.selectionEnd = start + INDENT.length
        })
        return
      }

      if (e.key === 'Enter') {
        // Carry the current line's indentation onto the new one, and add a
        // level after an opening brace or bracket. Anything cleverer starts
        // guessing at code it cannot parse.
        const lineStart = value.lastIndexOf('\n', start - 1) + 1
        const line = value.slice(lineStart, start)
        const indent = line.match(/^[ \t]*/)?.[0] ?? ''
        const opens = /[{[(]\s*$/.test(line)
        const insert = '\n' + indent + (opens ? INDENT : '')
        e.preventDefault()
        onChange(value.slice(0, start) + insert + value.slice(end))
        queueMicrotask(() => {
          area.selectionStart = area.selectionEnd = start + insert.length
        })
      }
    },
    [value, onChange]
  )

  const lineCount = value.split('\n').length

  return (
    <div className="wfs-editor">
      <div className="wfs-gutter" ref={gutterRef} aria-hidden="true">
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <div className="wfs-code-stack">
        <pre ref={mirrorRef} className="wfs-code wfs-code-mirror" aria-hidden="true">
          {tokens.map((token, i) => (
            <span className={`tok tok--${token.kind}`} key={i}>
              {token.text}
            </span>
          ))}
          {'\n'}
        </pre>
        <textarea
          ref={areaRef}
          className="wfs-code wfs-code-input"
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Workflow script"
          onScroll={syncScroll}
          onKeyDown={onKeyDown}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
        />
      </div>
    </div>
  )
}

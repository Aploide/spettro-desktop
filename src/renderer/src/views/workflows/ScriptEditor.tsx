// A small code editor for workflow scripts.
//
// Deliberately a plain <textarea> with a gutter drawn beside it rather than a
// real editor component: the app ships no editor dependency, and pulling one
// in for a screen that edits fifty-line scripts would cost more than it
// returns. What a textarea does not give you for free is the two things that
// actually matter when writing JavaScript — Tab that indents instead of
// leaving the field, and a newline that keeps the indentation you were on —
// so those are implemented here and nothing else is.

import { useCallback, useEffect, useRef } from 'react'
import type { ChangeEvent, JSX, KeyboardEvent, UIEvent } from 'react'
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

  // The gutter is a separate element, so it has to be told where the text got
  // scrolled to. Doing it on the scroll event (rather than by making the
  // gutter a sibling that scrolls with it) keeps the line numbers from being
  // selectable along with the code when the user drags across both.
  const syncScroll = useCallback((e: UIEvent<HTMLTextAreaElement>) => {
    if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop
  }, [])

  useEffect(() => {
    if (gutterRef.current && areaRef.current) {
      gutterRef.current.scrollTop = areaRef.current.scrollTop
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
      <textarea
        ref={areaRef}
        className="wfs-code"
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
  )
}

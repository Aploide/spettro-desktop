// Port of Platforms/macOS/Views/MemoryView.swift (docs 32-memory-editor.md,
// 15-memory-files.md). An editor for the CLI's two persistent memory files —
// the same plain-markdown files the CLI's /memory command and save-memory
// tool read and write. The CLI ingests memory at session start, so changes
// take effect at the next session start (the footer says so verbatim).
//
// File I/O lives in the main process (MemoryStore port) behind
// loadMemory/saveMemory; this view holds only transient editing state.
// Keyboard: Ctrl+S saves (⌘S on the Mac), Esc closes.

import { useEffect, useRef, useState } from 'react'
import { call } from '@renderer/state/store'
import './sheets.css'

type MemoryScope = 'user' | 'project'

const SCOPES: { scope: MemoryScope; title: string }[] = [
  { scope: 'user', title: 'User Memory' },
  { scope: 'project', title: 'Project Memory' }
]

/** Display-only path hint. The authoritative resolution (walking up from the
 *  project to the nearest `.spettro/` owner) happens in the main process;
 *  this shows the anchor the request is made with. */
function pathHint(scope: MemoryScope, projectPath: string | null): string {
  if (scope === 'user') return '~/.spettro/memory.md'
  return projectPath !== null ? `${projectPath}/.spettro/memory.md` : ''
}

export default function MemoryView({
  projectPath,
  onClose
}: {
  projectPath: string | null
  onClose: () => void
}): JSX.Element {
  const [scope, setScope] = useState<MemoryScope>('user')
  const [text, setText] = useState('')
  /** Last-known on-disk contents — the dirty baseline (Revert restores it). */
  const [loaded, setLoaded] = useState('')
  const [savedFlash, setSavedFlash] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadToken = useRef(0)

  const isDirty = text !== loaded

  // Project scope needs a project; fall back to user when it goes away.
  const effectiveScope: MemoryScope = scope === 'project' && projectPath === null ? 'user' : scope

  // Reload on appear and whenever scope or project changes. Switching scope
  // or project replaces the buffer — unsaved edits to the other scope are
  // discarded, matching the Mac editor.
  useEffect(() => {
    const token = ++loadToken.current
    setSaveError(null)
    void call('loadMemory', effectiveScope, projectPath ?? undefined)
      .then((content) => {
        if (loadToken.current !== token) return
        setLoaded(content)
        setText(content)
      })
      .catch(() => {
        // A missing/unreadable memory file is not an error, just empty.
        if (loadToken.current !== token) return
        setLoaded('')
        setText('')
      })
  }, [effectiveScope, projectPath])

  useEffect(() => {
    return () => {
      if (flashTimer.current !== null) clearTimeout(flashTimer.current)
    }
  }, [])

  const save = async (): Promise<void> => {
    if (!isDirty) return
    try {
      await call('saveMemory', effectiveScope, text, projectPath ?? undefined)
      setLoaded(text)
      setSaveError(null)
      setSavedFlash(true)
      if (flashTimer.current !== null) clearTimeout(flashTimer.current)
      flashTimer.current = setTimeout(() => setSavedFlash(false), 2000)
    } catch (err) {
      // Surface write failures inline rather than silently dropping: mutate
      // the baseline (keeps the editor dirty; Revert reveals the annotation)
      // and show the message in place.
      const message = err instanceof Error ? err.message : String(err)
      setLoaded(text + `\n\n(save failed: ${message})`)
      setSaveError(`Save failed: ${message}`)
    }
  }

  const revert = (): void => setText(loaded)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const path = pathHint(effectiveScope, projectPath)

  return (
    <div className="sheet-backdrop" role="presentation">
      <div className="sheet-card sheet-card--memory" role="dialog" aria-modal="true" aria-label="Memory">
        <div className="sheet-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 4.5c-1.2-1.4-3-2-4.8-1.6C5 3.4 3.5 5.2 3.5 7.4c0 .5.08 1 .24 1.44A4.4 4.4 0 0 0 2.5 12c0 1.3.56 2.46 1.44 3.27-.1.36-.14.74-.14 1.13 0 2.35 1.9 4.25 4.25 4.25.75 0 1.45-.2 2.06-.53.55.24 1.2.38 1.89.38s1.34-.14 1.89-.38c.61.34 1.31.53 2.06.53 2.35 0 4.25-1.9 4.25-4.25 0-.39-.05-.77-.14-1.13A4.38 4.38 0 0 0 21.5 12a4.4 4.4 0 0 0-1.24-3.16c.16-.45.24-.94.24-1.44 0-2.2-1.5-4-3.7-4.5-1.8-.4-3.6.2-4.8 1.6z" />
            <path d="M12 4.5v15.8" />
          </svg>
          <span className="sheet-headline">Memory</span>
          <button className="mem-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
            ✕
          </button>
        </div>

        <div className="mem-toolbar">
          <div className="mem-segmented" role="tablist">
            {SCOPES.map(({ scope: s, title }) => (
              <button
                key={s}
                role="tab"
                aria-selected={effectiveScope === s}
                className={`mem-segment ${effectiveScope === s ? 'mem-segment--active' : ''}`}
                disabled={s === 'project' && projectPath === null}
                onClick={() => setScope(s)}
              >
                {title}
              </button>
            ))}
          </div>

          <span style={{ flex: 1 }} />

          {savedFlash && (
            <span className="mem-saved">
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.4 14.2L6.8 12.4l1.4-1.4 2.4 2.4 5.2-5.2 1.4 1.4-6.6 6.6z" />
              </svg>
              Saved
            </span>
          )}
          {isDirty && !savedFlash && <span className="mem-dirty">Unsaved changes</span>}

          <button className="sheet-btn sheet-btn--subtle" style={{ minWidth: 0 }} disabled={!isDirty} onClick={revert}>
            Revert
          </button>
          <button className="sheet-btn sheet-btn--prominent" style={{ minWidth: 0 }} disabled={!isDirty} onClick={() => void save()} title="Ctrl+S">
            Save
          </button>
        </div>

        {path.length > 0 && <div className="mem-path mono">{path}</div>}
        {saveError !== null && <div className="mem-error">{saveError}</div>}

        <textarea
          className="mem-editor"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />

        <div className="mem-caption">One fact per line. Changes take effect at the next session start.</div>
      </div>
    </div>
  )
}

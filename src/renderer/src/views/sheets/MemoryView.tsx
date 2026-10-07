// Port of Platforms/macOS/Views/MemoryView.swift (docs 32-memory-editor.md,
// 15-memory-files.md), as Settings › Memory. An editor for the CLI's two
// persistent memory files — the same plain-markdown files the CLI's /memory
// command and save-memory tool read and write — named for what they hold:
// facts about you (every project) and facts about this project. The CLI reads
// memory when a session starts, so changes take effect at the next one (the
// caption says so).
//
// File I/O lives in the main process (MemoryStore port) behind
// loadMemory/saveMemory; this view holds only transient editing state.
// Edits are never dropped silently: switching between the two files, or
// leaving Settings (Escape, Done, another pane) with changes, asks "Save
// changes?" first. Ctrl+S (⌘S on the Mac) saves.

import { useCallback, useEffect, useRef, useState } from 'react'
import { humanizeError } from '@shared/humanize'
import { quietCall } from '@renderer/state/store'
import { askToSave, useCloseGuard } from '@renderer/views/common/closeGuard'
import './sheets.css'

type MemoryScope = 'user' | 'project'

const SCOPES: { scope: MemoryScope; title: string; noun: string }[] = [
  { scope: 'user', title: 'Facts about you', noun: 'facts about you' },
  { scope: 'project', title: 'Facts about this project', noun: 'facts about this project' }
]

/** Display-only path hint. The authoritative resolution (walking up from the
 *  project to the nearest `.spettro/` owner) happens in the main process;
 *  this shows the anchor the request is made with. */
function pathHint(scope: MemoryScope, projectPath: string | null): string {
  if (scope === 'user') return '~/.spettro/memory.md'
  return projectPath !== null ? `${projectPath}/.spettro/memory.md` : ''
}

export default function MemoryView({ projectPath }: { projectPath: string | null }): JSX.Element {
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
  const noun = SCOPES.find((s) => s.scope === effectiveScope)?.noun ?? 'memory'

  // Reload on appear and whenever scope or project changes. A switch with
  // edits has already been asked about (switchScope).
  useEffect(() => {
    const token = ++loadToken.current
    setSaveError(null)
    void quietCall('loadMemory', effectiveScope, projectPath ?? undefined)
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

  /** Resolves true once the text is on disk. A failed save keeps the edits
   *  (and says why), so whoever asked to leave stays. */
  const save = useCallback(async (): Promise<boolean> => {
    if (!isDirty) return true
    try {
      await quietCall('saveMemory', effectiveScope, text, projectPath ?? undefined)
      setLoaded(text)
      setSaveError(null)
      setSavedFlash(true)
      if (flashTimer.current !== null) clearTimeout(flashTimer.current)
      flashTimer.current = setTimeout(() => setSavedFlash(false), 2000)
      return true
    } catch (err) {
      const human = humanizeError(err)
      setSaveError(`Couldn’t save. ${human.known ? `${human.title}. ${human.detail}` : human.detail}`)
      return false
    }
  }, [isDirty, effectiveScope, text, projectPath])

  // Leaving Settings with edits asks first (App's Escape, Done, another pane).
  useCloseGuard('settings', async () => (isDirty ? askToSave(noun, save) : true))

  const switchScope = async (next: MemoryScope): Promise<void> => {
    if (next === effectiveScope) return
    if (isDirty && !(await askToSave(noun, save))) return
    setScope(next)
  }

  const revert = (): void => setText(loaded)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [save])

  const path = pathHint(effectiveScope, projectPath)

  return (
    <div className="mem-pane" aria-label="Memory">
      <div className="mem-toolbar">
        <div className="mem-segmented" role="tablist" aria-label="Which memory">
          {SCOPES.map(({ scope: s, title }) => (
            <button
              key={s}
              role="tab"
              aria-selected={effectiveScope === s}
              className={`mem-segment ${effectiveScope === s ? 'mem-segment--active' : ''}`}
              disabled={s === 'project' && projectPath === null}
              onClick={() => void switchScope(s)}
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
        <button
          className="sheet-btn sheet-btn--prominent"
          style={{ minWidth: 0 }}
          disabled={!isDirty}
          onClick={() => void save()}
          title="Ctrl+S"
        >
          Save
        </button>
      </div>

      {path.length > 0 && <div className="mem-path mono">{path}</div>}
      {saveError !== null && <div className="mem-error">{saveError}</div>}

      <textarea
        className="mem-editor"
        aria-label={SCOPES.find((s) => s.scope === effectiveScope)?.title}
        value={text}
        placeholder={
          effectiveScope === 'user'
            ? 'For example: Call me Anna. I run a bakery and I’m new to code.'
            : 'For example: Keep the website’s colours cream and brown.'
        }
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />

      <div className="mem-caption">One fact per line. Spettro reads these when a session starts.</div>
    </div>
  )
}

// Ctrl/Cmd+K: jump to any session by typing part of its title or folder.
// A small floating list near the top of the window — the type-ahead from
// Spotlight and the Claude app — that filters as you type; ↑/↓ choose,
// Enter opens, Escape (or a click outside) closes without doing anything.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatSummary } from '@shared/model'
import { call, useApp } from '@renderer/state/store'
import { MagnifyIcon } from './icons'
import { groupSessions } from './sessionGroups'
import { basename, relativeTime } from './util'

/** Most matches worth showing; past this, typing more is faster than reading. */
const LIMIT = 12

export default function QuickSwitcher({
  onClose,
  hidden
}: {
  onClose: () => void
  /** Chats on their way out (deleted, Undo still offered): not offered. */
  hidden?: ReadonlySet<string>
}): JSX.Element {
  const app = useApp()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Same order as the sidebar, archived last: what you see there is what
  // comes up here.
  const { results, more } = useMemo((): { results: ChatSummary[]; more: number } => {
    const sessions = (app?.sessions ?? []).filter((s) => !hidden?.has(s.id))
    const { groups, archived } = groupSessions(sessions, query)
    const all = [...groups.flatMap((g) => g.sessions), ...archived]
    return { results: all.slice(0, LIMIT), more: Math.max(0, all.length - LIMIT) }
  }, [app?.sessions, query, hidden])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setIndex(0)
  }, [query])

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${index}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [index])

  const open = (session: ChatSummary | undefined): void => {
    if (!session) return
    void call('openChat', session.id)
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (results.length === 0) return
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setIndex((i) => (i + delta + results.length) % results.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      open(results[index])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Tab') {
      // The field is the only stop: Tab would otherwise walk focus out to the
      // page behind, leaving the switcher open with nothing listening to it.
      e.preventDefault()
    }
  }

  return (
    <div className="switcher-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="switcher"
        role="dialog"
        aria-label="Switch session"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="switcher-search">
          <MagnifyIcon size={14} />
          <input
            ref={inputRef}
            type="text"
            placeholder="Switch to a session…"
            aria-label="Search sessions"
            role="combobox"
            aria-expanded="true"
            aria-controls="switcher-list"
            aria-activedescendant={results[index] ? `switcher-${results[index].id}` : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="switcher-list" id="switcher-list" role="listbox" ref={listRef}>
          {results.length === 0 && (
            <div className="switcher-empty">
              {(app?.sessions.length ?? 0) === 0 ? 'No sessions yet' : 'No sessions match'}
            </div>
          )}
          {results.map((s, i) => (
            <div
              key={s.id}
              id={`switcher-${s.id}`}
              data-index={i}
              role="option"
              aria-selected={i === index}
              className={'switcher-row' + (i === index ? ' switcher-row--active' : '')}
              onMouseMove={() => setIndex(i)}
              onClick={() => open(s)}
            >
              <span className="switcher-title">{s.title}</span>
              <span className="switcher-project">
                {basename(s.projectPath)}
                {s.isArchived ? ' · Archived' : ''}
              </span>
              <span className="switcher-time">{relativeTime(s.updatedAt)}</span>
            </div>
          ))}
        </div>
        {more > 0 && (
          // Past the cut, the list would otherwise end as if that were all.
          <div className="switcher-more" role="status">
            {more} more {more === 1 ? 'session' : 'sessions'} — type to narrow it down
          </div>
        )}
      </div>
    </div>
  )
}

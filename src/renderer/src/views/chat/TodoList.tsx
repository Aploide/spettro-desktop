// The agent's task list, pinned above the composer.
//
// spettro publishes its todo graph as ACP `plan` updates (content.go
// planEntriesFromTodos) — the whole list each time, in dependency order, an
// empty one when the last task goes. It used to live behind a header chip,
// which is the one place nobody looks while a turn runs. The Claude app
// keeps it right above where you type: open while the agent works, so "what
// is it doing and how far along is it" is answered without asking, and
// folded to one line once the turn is over.
//
// ACP plans have no "blocked" status, so the CLI folds it into the text as a
// " (blocked)" suffix; it is split off here and drawn as a quiet tag.

import { useEffect, useId, useState } from 'react'
import type { JSX } from 'react'
import type { ACPPlanEntry } from '@shared/acp'
import { Icon } from '@renderer/design/icons'

const BLOCKED_SUFFIX = ' (blocked)'

export interface TodoEntry {
  text: string
  status: 'pending' | 'in_progress' | 'completed'
  blocked: boolean
}

/** A plan entry as the list draws it. Unknown statuses read as pending. */
export function todoEntry(entry: ACPPlanEntry): TodoEntry {
  const blocked = entry.content.endsWith(BLOCKED_SUFFIX)
  const text = blocked ? entry.content.slice(0, -BLOCKED_SUFFIX.length) : entry.content
  const status =
    entry.status === 'in_progress' || entry.status === 'completed' ? entry.status : 'pending'
  return { text, status, blocked }
}

/** "3 of 7 tasks done", or "All 7 tasks done". */
export function todoSummary(entries: TodoEntry[]): string {
  const done = entries.filter((e) => e.status === 'completed').length
  const total = entries.length
  const noun = total === 1 ? 'task' : 'tasks'
  if (done === total) return total === 1 ? '1 task done' : `All ${total} tasks done`
  return `${done} of ${total} ${noun} done`
}

export default function TodoList({
  plan,
  busy
}: {
  plan: ACPPlanEntry[]
  busy: boolean
}): JSX.Element | null {
  // Open while the agent works, folded when it stops — unless the user has
  // said otherwise during this stretch, which holds until busy flips again.
  const [override, setOverride] = useState<boolean | null>(null)
  useEffect(() => setOverride(null), [busy])
  const listId = useId()
  if (plan.length === 0) return null

  const entries = plan.map(todoEntry)
  const open = override ?? busy
  const current =
    entries.find((e) => e.status === 'in_progress') ??
    entries.find((e) => e.status === 'pending' && !e.blocked)

  return (
    <div
      className={'todo-list' + (open ? ' todo-list--open' : '') + (busy ? ' todo-list--busy' : '')}
      data-testid="todo-list"
    >
      <button
        type="button"
        className="todo-head"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOverride(!open)}
      >
        <Icon name="checklist" size={13} className="todo-head-icon" />
        <span className="todo-summary">{todoSummary(entries)}</span>
        {!open && current && (
          <span className="todo-current">
            {current.status === 'in_progress' ? 'Now: ' : 'Next: '}
            {current.text}
          </span>
        )}
        <Icon name="chevron.down" size={11} className="todo-chevron" />
      </button>
      {open && (
        <ol className="todo-items" id={listId}>
          {entries.map((entry, i) => (
            <li
              key={i}
              className={`todo-item todo-item--${entry.status}${entry.blocked ? ' todo-item--blocked' : ''}`}
            >
              <span className="todo-glyph" aria-hidden>
                {entry.status === 'completed' ? (
                  <Icon name="checkmark" size={12} />
                ) : entry.status === 'in_progress' ? (
                  <Icon name="circle.lefthalf.filled" size={12} />
                ) : (
                  <Icon name="circle" size={12} />
                )}
              </span>
              <span className="todo-text">
                <span className="visually-hidden">
                  {entry.status === 'completed'
                    ? 'Done: '
                    : entry.status === 'in_progress'
                      ? 'In progress: '
                      : 'To do: '}
                </span>
                {entry.text}
              </span>
              {entry.blocked && <span className="todo-tag">Blocked</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

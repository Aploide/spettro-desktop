// The @-mention menu: the project's files that match what follows the "@",
// floating above the composer the way the slash-command menu does, driven by
// the same keys (↑/↓ to move, Tab or Enter to choose, Esc to dismiss — the
// composer owns those, this only draws).
//
// A row is the file's name first and its folder after, muted: people
// remember files by name, and a list of paths that all begin "src/renderer/
// src/views/" is a list of identical prefixes.

import type { JSX } from 'react'
import { Icon } from '@renderer/design/icons'

export default function MentionMenu({
  files,
  selected,
  loading,
  query,
  onPick,
  onHover
}: {
  files: string[]
  selected: number
  loading: boolean
  query: string
  onPick: (path: string) => void
  onHover: (index: number) => void
}): JSX.Element {
  return (
    <div className="composer-menu mention-menu" role="listbox" aria-label="Files" data-testid="mention-menu">
      {files.length === 0 ? (
        <div className="composer-menu-empty">
          {loading
            ? 'Looking through the project…'
            : query === ''
              ? 'No files in this folder'
              : `No file matches “${query}”`}
        </div>
      ) : (
        files.map((path, i) => {
          const slash = path.lastIndexOf('/')
          const name = path.slice(slash + 1)
          const dir = slash >= 0 ? path.slice(0, slash) : ''
          return (
            <button
              type="button"
              key={path}
              role="option"
              aria-selected={i === selected}
              className={'composer-menu-row' + (i === selected ? ' composer-menu-row--selected' : '')}
              // Keep the caret in the composer: the click must not blur it.
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => onHover(i)}
              onClick={() => onPick(path)}
            >
              <Icon name="doc.text" size={13} className="mention-menu-icon" />
              <span className="mention-menu-name">{name}</span>
              {dir && <span className="mention-menu-dir">{dir}</span>}
            </button>
          )
        })
      )}
    </div>
  )
}

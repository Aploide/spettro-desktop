// In-place title editing, shared by the sidebar row and the chat header: the
// title becomes a text field holding the current name, fully selected, so
// typing replaces it. Enter or leaving the field saves; Escape puts the old
// name back. A blank field saves nothing — main refuses blank titles too.

import { useEffect, useRef, useState } from 'react'
import { call } from '@renderer/state/store'

interface Props {
  chatId: string
  title: string
  className?: string
  onDone: () => void
}

export default function InlineRename({ chatId, title, className, onDone }: Props): JSX.Element {
  const [value, setValue] = useState(title)
  const ref = useRef<HTMLInputElement>(null)
  // Enter commits and then blurs; without this the blur would commit twice.
  const settled = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const finish = (save: boolean): void => {
    if (settled.current) return
    settled.current = true
    const next = value.trim()
    if (save && next !== '' && next !== title) void call('renameChat', chatId, next)
    onDone()
  }

  return (
    <input
      ref={ref}
      className={'inline-rename' + (className ? ` ${className}` : '')}
      value={value}
      aria-label="Session name"
      maxLength={120}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        // Keep keys here: the row underneath treats Enter as "open".
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        }
      }}
    />
  )
}

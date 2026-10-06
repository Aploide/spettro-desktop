// What a transcript row can ask of the chat around it, and the small buttons
// that ask.
//
// Rows are drawn in three places — the chat, the workflow studio's run pane
// and the visual harness — and only the chat can put text in a composer or
// resend a prompt. So the actions come from context rather than props: the
// chat provides them, everywhere else the defaults below are empty, and a row
// simply doesn't offer what it can't do.

import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Icon } from '@renderer/design/icons'

export interface TranscriptActions {
  /** Puts a sent message's text back in the composer ("Edit & resend"). */
  editMessage?: (text: string) => void
  /** Sends the last prompt again ("Try again" on a failed turn). */
  retry?: () => void
  /** The newest user message: the only one that offers Edit & resend, since
   *  resending an older one would answer a conversation that has moved on. */
  lastUserMessageId?: string | null
  /** The error notice that ended the last turn, while nothing is running:
   *  the only one with a Try again. */
  retryNoticeId?: string | null
}

const TranscriptActionsContext = createContext<TranscriptActions>({})

export const TranscriptActionsProvider = TranscriptActionsContext.Provider

export function useTranscriptActions(): TranscriptActions {
  return useContext(TranscriptActionsContext)
}

/** How long "Copied" stays before the button goes back to "Copy". */
const COPIED_MS = 1200

/**
 * A copy button that says it worked. With `label` the word shows beside the
 * glyph (a code block's header has the room); without it the button is a
 * bare glyph with the word as its tooltip and accessible name.
 */
export function CopyButton({
  text,
  label,
  className
}: {
  text: string
  label?: string
  className?: string
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const copy = (): void => {
    void navigator.clipboard?.writeText(text)
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), COPIED_MS)
  }
  const word = copied ? 'Copied' : (label ?? 'Copy')
  return (
    <button
      type="button"
      className={className ?? 'tr-action'}
      onClick={copy}
      title={label ? undefined : word}
      aria-label={word}
    >
      <Icon name={copied ? 'checkmark' : 'doc.on.doc'} size={13} />
      {label && <span>{word}</span>}
    </button>
  )
}

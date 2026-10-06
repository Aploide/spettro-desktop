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
import type { TranscriptItem } from '@shared/model'
import { Icon } from '@renderer/design/icons'

export interface TranscriptActions {
  /** Puts a sent message's text, and the files it mentioned, back in the
   *  composer ("Edit & resend"). */
  editMessage?: (text: string, mentions?: string[]) => void
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

/**
 * The two messages the transcript's actions hang off: the newest user
 * message (Edit & resend), and — once the turn it ended is over — the error
 * a turn ended on after it (Try again). An error from an earlier turn has
 * been answered by everything since, so it offers nothing; nor does an error
 * that ended no turn (a settings change the agent refused), since resending
 * the prompt would not fix it.
 */
export function transcriptAnchors(
  items: TranscriptItem[],
  busy: boolean
): Pick<TranscriptActions, 'lastUserMessageId' | 'retryNoticeId'> {
  let lastUserMessageId: string | null = null
  let retryNoticeId: string | null = null
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind !== 'message') continue
    const { message } = item
    if (message.role === 'user') {
      lastUserMessageId = message.id
      break
    }
    if (
      retryNoticeId === null &&
      message.role === 'notice' &&
      message.noticeIsError === true &&
      message.endsTurn === true
    ) {
      retryNoticeId = message.id
    }
  }
  if (busy || lastUserMessageId === null) retryNoticeId = null
  return { lastUserMessageId, retryNoticeId }
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
    // "Copied" only once it is true: a refused write (no focus, no
    // clipboard) leaves the button saying Copy, so trying again is obvious.
    const write = navigator.clipboard?.writeText(text) ?? Promise.reject(new Error('no clipboard'))
    write.then(
      () => {
        setCopied(true)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), COPIED_MS)
      },
      () => undefined
    )
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

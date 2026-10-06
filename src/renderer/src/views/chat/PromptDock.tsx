// What sits on top of the composer while the chat is waiting on the user:
// the oldest approval, else the oldest question — only this chat's (other
// chats' prompts badge their sidebar rows instead). After a Deny it offers a
// field for what Spettro should do instead, sent as the next message, or as
// guidance the running turn reads at its next step.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { ACPPermissionRequest } from '@shared/acp'
import type { ChatDetail } from '@shared/model'
import { call, useStore } from '@renderer/state/store'
import { Icon } from '@renderer/design/icons'
import PermissionCard from './PermissionCard'
import QuestionCard from './QuestionCard'
import { promptsFor } from './prompts'
import './prompts.css'

/** The id of the chat's newest user message: a message the user sends some
 *  other way answers the "what instead?" offer too. */
function lastUserMessageId(chat: ChatDetail): string | null {
  for (let i = chat.items.length - 1; i >= 0; i--) {
    const item = chat.items[i]
    if (item.kind === 'message' && item.message.role === 'user') return item.message.id
  }
  return null
}

export default function PromptDock({ chat }: { chat: ChatDetail }): JSX.Element | null {
  const permissions = useStore((s) => s.permissions)
  const questions = useStore((s) => s.questions)
  const mine = useMemo(
    () => promptsFor(chat.id, permissions, questions),
    [chat.id, permissions, questions]
  )
  const [denied, setDenied] = useState<{
    requestId: string
    title: string
    after: string | null
  } | null>(null)
  const dockRef = useRef<HTMLDivElement>(null)

  const total = mine.permissions.length + mine.questions.length
  const permission = mine.permissions[0]
  const question = permission ? undefined : mine.questions[0]

  // From the composer, Tab goes to the card rather than along the toolbar —
  // unless a menu in the composer has Tab for itself.
  const hasCard = total > 0
  useEffect(() => {
    if (!hasCard) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
      if (!(event.target instanceof Element) || !event.target.closest('.composer-input')) return
      if (document.querySelector('.composer-menu')) return
      const card = dockRef.current?.querySelector<HTMLElement>('.prompt-card')
      if (!card) return
      event.preventDefault()
      card.focus()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [hasCard])

  // The offer lapses once the user has said something anyway.
  const lastUser = lastUserMessageId(chat)
  useEffect(() => {
    if (denied && lastUser !== denied.after) setDenied(null)
  }, [lastUser, denied])

  // …and once something new asks: the answer to that comes first, and the
  // offer would be stale by the time it was back on screen.
  const headId = permission?.id ?? question?.id ?? null
  useEffect(() => {
    if (denied && headId !== null && headId !== denied.requestId) setDenied(null)
  }, [headId, denied])

  const onDenied = (request: ACPPermissionRequest): void =>
    setDenied({ requestId: request.id, title: request.title, after: lastUser })

  return (
    <div className="prompt-dock" ref={dockRef} aria-live="polite">
      {permission ? (
        <PermissionCard
          key={permission.id}
          request={permission}
          position={1}
          total={total}
          onDenied={onDenied}
        />
      ) : question ? (
        <QuestionCard key={question.id} request={question} position={1} total={total} />
      ) : denied ? (
        <DeniedFeedback chatId={chat.id} title={denied.title} onDone={() => setDenied(null)} />
      ) : null}
    </div>
  )
}

/** "Denied — tell Spettro what to do instead." Optional: closing it leaves
 *  the agent to carry on from the denial alone. */
function DeniedFeedback({
  chatId,
  title,
  onDone
}: {
  chatId: string
  title: string
  onDone: () => void
}): JSX.Element {
  const [text, setText] = useState('')
  const fieldRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    fieldRef.current?.focus()
  }, [])

  const send = (): void => {
    const trimmed = text.trim()
    if (trimmed === '') return
    // While the turn still runs this goes to it as guidance (steering);
    // after, it is the next message.
    void call('send', chatId, trimmed, [])
    onDone()
  }

  return (
    <section className="prompt-card prompt-card--feedback" aria-label="Tell Spettro what to do instead">
      <header className="prompt-head">
        <span className="prompt-icon prompt-icon--muted">
          <Icon name="hand.raised" size={13} />
        </span>
        <h2 className="prompt-title prompt-title--quiet">
          Denied{title ? <span className="prompt-title-detail"> — {title}</span> : null}
        </h2>
        <button
          type="button"
          className="prompt-close"
          aria-label="Dismiss"
          title="Dismiss (Esc)"
          onClick={onDone}
        >
          <Icon name="xmark" size={11} />
        </button>
      </header>
      <div className="prompt-feedback-row">
        <textarea
          ref={fieldRef}
          className="prompt-field"
          rows={1}
          placeholder="Tell Spettro what to do instead (optional)"
          aria-label="Tell Spettro what to do instead"
          data-testid="deny-feedback"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Escape') {
              e.preventDefault()
              onDone()
            } else if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button
          type="button"
          className="prompt-btn prompt-btn--primary"
          disabled={text.trim() === ''}
          onClick={send}
        >
          Send
        </button>
      </div>
    </section>
  )
}

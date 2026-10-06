// Port of spettro-apple/Spettro/Views/TranscriptItemView.swift, redrawn after
// the Claude Code tab.
//
// Dispatches a transcript entry to the right renderer: the user's bubble,
// the agent's full-width prose, a one-line "Thought for 12s" disclosure for
// reasoning, a muted line (or, for an error, a card with Try again) for a
// notice, and a tool row (or sub-agent card) for a tool call.
//
// Since the transcript is folded before it is drawn (orchestration.ts, then
// toolGroups.ts), the unit ChatView actually hands us is a *row*, not an
// item: a row can be a plain transcript entry, a whole workflow run that
// swallowed its members, a lone sub-agent that swallowed the tools it ran,
// or a run of reads folded into one line. Keeping that second dispatch here
// rather than in ChatView is deliberate — ChatView is about layout, and the
// question "what does this row look like" already has exactly one home.

import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { ChatMessage, TranscriptItem } from '@shared/model'
import { MarkdownText } from './MarkdownText'
import { Icon, SubAgentCallView, ToolCallView } from './ToolCallView'
import { subAgentCall } from './toolPresentation'
import { ActivationText } from '../ActivationGlow'
import type { MemberCall } from './orchestration'
import type { DisplayRow } from './toolGroups'
import { ToolGroup } from './ToolGroup'
import { ScriptCallRow } from './OrchestrationBits'
import { WorkflowCard } from './WorkflowCard'
import { CopyButton, useTranscriptActions } from './TranscriptActions'
import Disclosure from '@renderer/views/common/Disclosure'
import './transcript.css'

/**
 * One row of the folded transcript.
 *
 * A run row is the card; the members and nested tool calls it absorbed are
 * gone from the flat list and only exist inside it. An agent row is a
 * delegation nobody claimed — a bare `agent` call outside any run — and it
 * still carries the tools that sub-agent ran, so it renders as the ordinary
 * sub-agent card with those folded in.
 */
export function TranscriptRowView({ row }: { row: DisplayRow }): JSX.Element {
  switch (row.kind) {
    case 'item':
      return <TranscriptItemView item={row.item} />
    case 'run':
      return <WorkflowCard run={row.run} />
    case 'agent':
      return <StandaloneAgentRow member={row.member} />
    case 'tools':
      return <ToolGroup group={row} />
    case 'script':
      // A workflow tool call that never started a run: the script is all
      // there is, so it gets a readable row of its own rather than the raw
      // JSON blob the generic tool row would make of a whole JS program.
      return <ScriptCallRow script={row.script} />
  }
}

/** A sub-agent that belongs to no run. `groupTranscript` only ever builds a
 *  member from a call `subAgentCall` recognised, but the parse is re-run here
 *  for the types, and a null falls back to the generic tool card rather than
 *  dropping the row. */
function StandaloneAgentRow({ member }: { member: MemberCall }): JSX.Element {
  const call = subAgentCall(member.tool)
  if (call === null) return <ToolCallView tool={member.tool} />
  return <SubAgentCallView tool={member.tool} call={call} children={member.children} />
}

export function TranscriptItemView({ item }: { item: TranscriptItem }): JSX.Element {
  if (item.kind === 'tool') return <ToolCallView tool={item.tool} />
  const message = item.message
  switch (message.role) {
    case 'user':
      return <UserBubble message={message} />
    case 'assistant':
      return <AssistantBubble message={message} />
    case 'reasoning':
      return <ReasoningView message={message} />
    case 'notice':
      return <NoticeView message={message} isError={message.noticeIsError === true} />
  }
}

// ---------------------------------------------------------------------------
// User bubbles — the only renderer with classic chat-bubble framing.
// ---------------------------------------------------------------------------

/** How long "Delivered" stays under a steer the agent has just read. */
const DELIVERED_MS = 2400

function UserBubble({ message }: { message: ChatMessage }): JSX.Element {
  const { editMessage, lastUserMessageId } = useTranscriptActions()
  const canEdit =
    editMessage !== undefined && lastUserMessageId === message.id && message.text !== ''
  return (
    <div className="tr-user-row">
      <div className="tr-user-stack">
        {message.attachments.length > 0 && (
          <div className="tr-attachments">
            {message.attachments.map((a) => (
              <img
                key={a.id}
                className="tr-attachment"
                src={`data:${a.mimeType};base64,${a.data}`}
                alt="Attached image"
              />
            ))}
          </div>
        )}
        {message.text !== '' && (
          <div className="tr-user-bubble">
            {/* The phrase stays lit after sending: what armed the turn should
                still be visible in the turn it armed. */}
            <ActivationText text={message.text} />
          </div>
        )}
        <SteeringCaption state={message.steering} />
        {message.text !== '' && (
          <div className="tr-actions tr-actions--end">
            <CopyButton text={message.text} />
            {canEdit && (
              <button
                type="button"
                className="tr-action"
                title="Edit & resend"
                aria-label="Edit & resend"
                onClick={() => editMessage(message.text)}
              >
                <Icon name="pencil" size={13} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Where a message sent mid-turn stands. Waiting, it says so plainly — the
 * agent reads it at its next step, not now. Once read it says "Delivered"
 * for a moment and then gets out of the way; a steer that was already
 * delivered when the chat was opened is history and says nothing.
 */
function SteeringCaption({ state }: { state: ChatMessage['steering'] }): JSX.Element | null {
  const previous = useRef(state)
  const [showDelivered, setShowDelivered] = useState(false)
  useEffect(() => {
    const was = previous.current
    previous.current = state
    if (state !== 'delivered' || was === 'delivered') return undefined
    setShowDelivered(true)
    const timer = setTimeout(() => setShowDelivered(false), DELIVERED_MS)
    return () => clearTimeout(timer)
  }, [state])

  if (state === 'sending' || state === 'queued') {
    return (
      <div className="tr-steering">
        <Icon name="clock" size={11} />
        <span>Queued · will be seen at the next step</span>
      </div>
    )
  }
  if (state === 'delivered' && showDelivered) {
    return (
      <div className="tr-steering tr-steering--delivered">
        <Icon name="checkmark" size={11} />
        <span>Delivered</span>
      </div>
    )
  }
  return null
}

// ---------------------------------------------------------------------------
// Assistant answers render as plain full-width prose: no bubble chrome and
// no avatar — the agent's output owns the whole centred column, only the
// user's messages keep chat-bubble framing.
// ---------------------------------------------------------------------------

function AssistantBubble({ message }: { message: ChatMessage }): JSX.Element {
  return (
    <div className="tr-assistant">
      <MarkdownText source={message.text} />
      {message.isStreaming ? (
        <TypingDots />
      ) : (
        <div className="tr-actions">
          <CopyButton text={message.text} />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Reasoning: one quiet line that opens to the model's thinking.
// ---------------------------------------------------------------------------

/** "Thought for 12s" / "Thought for 2m 5s"; null for a span under a second —
 *  a replayed session delivers its reasoning in one burst, and "1s" would be
 *  made up. */
export function thoughtDuration(
  message: Pick<ChatMessage, 'startedAt' | 'endedAt'>
): string | null {
  if (message.startedAt === undefined || message.endedAt === undefined) return null
  const seconds = Math.round((message.endedAt - message.startedAt) / 1000)
  if (seconds < 1) return null
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function ReasoningView({ message }: { message: ChatMessage }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const duration = thoughtDuration(message)
  const label = message.isStreaming
    ? 'Thinking…'
    : duration !== null
      ? `Thought for ${duration}`
      : 'Thought'
  return (
    <div className="tr-reasoning">
      <button
        className="tr-reasoning-header"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
      >
        <span className={`tr-reasoning-label${message.isStreaming ? ' tr-shimmer' : ''}`}>
          {label}
        </span>
        <span className={`tr-chevron${expanded ? ' tr-chevron--open' : ''}`}>
          <Icon name="chevron.right" size={8} />
        </span>
      </button>
      {expanded && <div className="tr-reasoning-body">{message.text}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Notices — said by the app, not by either party. Information is a muted
// line; an error is a card that says what went wrong and offers the obvious
// next step.
// ---------------------------------------------------------------------------

function NoticeView({ message, isError }: { message: ChatMessage; isError: boolean }): JSX.Element {
  const { retry, retryNoticeId } = useTranscriptActions()
  if (!isError) {
    return (
      <div className="tr-notice" role="note">
        <Icon name="info.circle.fill" size={12} />
        <span className="tr-notice-text">{message.text}</span>
      </div>
    )
  }
  const canRetry = retry !== undefined && retryNoticeId === message.id
  return (
    <div className="tr-error" role="alert">
      <span className="tr-error-icon">
        <Icon name="exclamationmark.triangle.fill" size={14} />
      </span>
      <span className="tr-error-body">
        <span className="tr-error-text">{message.text}</span>
        {/* The error as it arrived, for the curious and for bug reports. */}
        {message.detail && (
          <Disclosure className="tr-error-details">
            <span className="tr-error-raw">{message.detail}</span>
          </Disclosure>
        )}
      </span>
      {canRetry && (
        <button type="button" className="tr-error-retry" onClick={retry}>
          <Icon name="arrow.clockwise" size={12} />
          <span>Try again</span>
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Typing dots — three 5px dots pulsing 0.3 → 1 opacity, cascading.
// ---------------------------------------------------------------------------

function TypingDots(): JSX.Element {
  return (
    <span className="tr-dots" aria-label="Assistant is typing">
      <span />
      <span />
      <span />
    </span>
  )
}

export default TranscriptItemView

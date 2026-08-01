// Port of spettro-apple/Spettro/Views/TranscriptItemView.swift.
//
// Dispatches a transcript entry to the right renderer: message bubbles for
// user/assistant/notice, a collapsible panel for streamed reasoning, and a
// card (or sub-agent card) for tool calls.

import { useState } from 'react'
import type { JSX } from 'react'
import type { ChatMessage, TranscriptItem } from '@shared/model'
import { MarkdownText } from './MarkdownText'
import { Icon, ToolCallView } from './ToolCallView'
import './transcript.css'

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

function UserBubble({ message }: { message: ChatMessage }): JSX.Element {
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
                alt="attachment"
              />
            ))}
          </div>
        )}
        {message.text !== '' && <div className="tr-user-bubble">{message.text}</div>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Assistant answers render as plain full-width prose (synara-style): no
// bubble chrome and no avatar — the agent's output owns the whole centered
// column, only the user's messages keep chat-bubble framing.
// ---------------------------------------------------------------------------

function AssistantBubble({ message }: { message: ChatMessage }): JSX.Element {
  return (
    <div className="tr-assistant">
      <MarkdownText source={message.text} />
      {message.isStreaming && <TypingDots />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Reasoning: the collapsible "Thinking" panel.
// ---------------------------------------------------------------------------

function ReasoningView({ message }: { message: ChatMessage }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="tr-reasoning">
      <button
        className="tr-reasoning-header"
        type="button"
        onClick={() => setExpanded((e) => !e)}
      >
        <Icon name="brain" size={11} />
        <span className="tr-reasoning-label">{message.isStreaming ? 'Thinking…' : 'Reasoning'}</span>
        <span className={`tr-chevron${expanded ? ' tr-chevron--open' : ''}`}>
          <Icon name="chevron.right" size={8} />
        </span>
      </button>
      {expanded && <div className="tr-reasoning-body">{message.text}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Notices — quiet inline banners, not messages from either party.
// ---------------------------------------------------------------------------

function NoticeView({ message, isError }: { message: ChatMessage; isError: boolean }): JSX.Element {
  return (
    <div className={`tr-notice${isError ? ' tr-notice--error' : ''}`}>
      <span className="tr-notice-icon">
        <Icon name={isError ? 'exclamationmark.triangle.fill' : 'info.circle.fill'} size={12} />
      </span>
      <span className="tr-notice-text">{message.text}</span>
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

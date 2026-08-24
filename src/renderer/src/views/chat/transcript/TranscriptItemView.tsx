// Port of spettro-apple/Spettro/Views/TranscriptItemView.swift.
//
// Dispatches a transcript entry to the right renderer: message bubbles for
// user/assistant/notice, a collapsible panel for streamed reasoning, and a
// card (or sub-agent card) for tool calls.
//
// Since the transcript is folded before it is drawn (orchestration.ts), the
// unit ChatView actually hands us is a *row*, not an item: a row can be a
// plain transcript entry, a whole workflow / swarm run that swallowed its
// members, or a lone sub-agent that swallowed the tools it ran. Keeping that
// second dispatch here rather than in ChatView is deliberate — ChatView is
// about layout, and the question "what does this row look like" already has
// exactly one home.

import { useState } from 'react'
import type { JSX } from 'react'
import type { ChatMessage, TranscriptItem } from '@shared/model'
import { MarkdownText } from './MarkdownText'
import { Icon, SubAgentCallView, ToolCallView } from './ToolCallView'
import { subAgentCall } from './toolPresentation'
import type { MemberCall, TranscriptRow } from './orchestration'
import { ScriptCallRow } from './OrchestrationBits'
import { SwarmCard } from './SwarmCard'
import { WorkflowCard } from './WorkflowCard'
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
export function TranscriptRowView({ row }: { row: TranscriptRow }): JSX.Element {
  switch (row.kind) {
    case 'item':
      return <TranscriptItemView item={row.item} />
    case 'run':
      return row.run.kind === 'workflow' ? (
        <WorkflowCard run={row.run} />
      ) : (
        <SwarmCard run={row.run} />
      )
    case 'agent':
      return <StandaloneAgentRow member={row.member} />
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

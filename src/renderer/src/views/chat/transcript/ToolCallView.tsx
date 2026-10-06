// Port of spettro-apple/Spettro/Views/ToolCallView.swift.
//
// Renders one tool call as a quiet, expandable row (synara-style): an icon,
// a short verb, the human-readable detail (command, file, pattern — never
// raw JSON), a +N/-N diff stat, and a live status glyph. Expanding reveals
// the output or a red/green line diff. `agent` tool calls render as the
// dedicated purple sub-agent card instead.

import { useState } from 'react'
import type { JSX } from 'react'
import { Icon } from '@renderer/design/icons'
import type { ToolCallItem, ToolDiff } from '@shared/model'
import {
  changedLines,
  diffStat,
  displayDetail,
  displayName,
  shortPath,
  subAgentCall,
  subAgentResult,
  symbolName,
  type SubAgentCall
} from './toolPresentation'
import { MarkdownText } from './MarkdownText'
import { SpettroSpinner } from './RunTicker'
import './transcript.css'
import './orchestration.css'

export function ToolCallView({ tool }: { tool: ToolCallItem }): JSX.Element {
  const call = subAgentCall(tool)
  if (call) return <SubAgentCallView tool={tool} call={call} />
  return <ToolRow tool={tool} />
}

// ---------------------------------------------------------------------------
// The standard row
// ---------------------------------------------------------------------------

export function ToolRow({ tool }: { tool: ToolCallItem }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const hasDetail = tool.output !== '' || tool.diffs.length > 0
  const stat = diffStat(tool)

  return (
    <div className={`tr-tool${expanded ? ' tr-tool--expanded' : ''}`}>
      <button
        className="tr-tool-header"
        type="button"
        title={tool.title}
        onClick={() => {
          if (hasDetail) setExpanded((e) => !e)
        }}
      >
        <span className="tr-tool-icon">
          <Icon name={symbolName(tool)} size={11} />
        </span>
        <span className="tr-tool-verb">{displayName(tool)}</span>
        <span className="tr-tool-detailtext">{displayDetail(tool)}</span>
        {stat && (stat.added > 0 || stat.removed > 0) && (
          <DiffStatLabel added={stat.added} removed={stat.removed} />
        )}
        <StatusIndicator status={tool.status} />
        {hasDetail && (
          <span className={`tr-chevron${expanded ? ' tr-chevron--open' : ''}`}>
            <Icon name="chevron.right" size={8} />
          </span>
        )}
      </button>
      {expanded && hasDetail && (
        <div className="tr-tool-detail">
          {tool.diffs.map((diff, i) => (
            <ToolDiffView key={i} diff={diff} />
          ))}
          {tool.output !== '' && <pre className="tr-tool-output">{tool.output.trim()}</pre>}
        </div>
      )}
    </div>
  )
}

export function StatusIndicator({
  status
}: {
  status: ToolCallItem['status']
}): JSX.Element | null {
  switch (status) {
    case 'pending':
    case 'in_progress':
      return <SpettroSpinner size={11} color="var(--text-secondary)" />
    case 'completed':
      return <span className="tr-status-dot" />
    case 'failed':
      return (
        <span className="tr-status-fail">
          <Icon name="xmark.circle.fill" size={11} />
        </span>
      )
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// The +N -N label (shared with the chat header's git stat)
// ---------------------------------------------------------------------------

export function DiffStatLabel({ added, removed }: { added: number; removed: number }): JSX.Element {
  return (
    <span className="tr-diffstat">
      {added > 0 && <span className="tr-diffstat-added">+{added}</span>}
      {removed > 0 && <span className="tr-diffstat-removed">-{removed}</span>}
    </span>
  )
}

// ---------------------------------------------------------------------------
// The diff view
// ---------------------------------------------------------------------------

const MAX_DIFF_LINES = 80

function ToolDiffView({ diff }: { diff: ToolDiff }): JSX.Element {
  const { old, new: added } = changedLines(diff)
  return (
    <div className="tr-diff">
      <div className="tr-diff-head">
        <span className="tr-diff-icon">
          <Icon name="doc.text" size={10} />
        </span>
        <span className="tr-diff-path">{shortPath(diff.path)}</span>
        <DiffStatLabel added={added.length} removed={old.length} />
      </div>
      <div className="tr-diff-lines">
        {old.slice(0, MAX_DIFF_LINES).map((line, i) => (
          <DiffLine key={`o${i}`} line={line} kind="removed" />
        ))}
        {old.length > MAX_DIFF_LINES && <TruncationNote count={old.length - MAX_DIFF_LINES} />}
        {added.slice(0, MAX_DIFF_LINES).map((line, i) => (
          <DiffLine key={`n${i}`} line={line} kind="added" />
        ))}
        {added.length > MAX_DIFF_LINES && <TruncationNote count={added.length - MAX_DIFF_LINES} />}
      </div>
    </div>
  )
}

function DiffLine({ line, kind }: { line: string; kind: 'added' | 'removed' }): JSX.Element {
  return (
    <div className={`tr-diff-line tr-diff-line--${kind}`}>
      <span className="tr-diff-prefix">{kind === 'added' ? '+' : '-'}</span>
      <span className="tr-diff-text">{line === '' ? ' ' : line}</span>
    </div>
  )
}

function TruncationNote({ count }: { count: number }): JSX.Element {
  return <div className="tr-diff-more">… {count} more lines</div>
}

// ---------------------------------------------------------------------------
// Sub-agent calls
// ---------------------------------------------------------------------------

/**
 * A dedicated card for `agent` tool calls: makes it obvious another agent
 * has spun up, who it is, what it was asked to do, and — once it reports
 * back — its summary rendered as markdown.
 */
export function SubAgentCallView({
  tool,
  call,
  children
}: {
  tool: ToolCallItem
  call: SubAgentCall
  /** The sub-agent's own tool calls, when the caller has folded them in
   *  (ChatView does the grouping); they render above the summary. */
  children?: ToolCallItem[]
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const result = subAgentResult(tool)
  const isRunning = tool.status === 'pending' || tool.status === 'in_progress'
  const failed = tool.status === 'failed' || result?.status === 'error'
  const hasSummary = result !== null && result.summary !== ''
  const nested = children ?? []
  // Without children this is exactly the old `hasSummary` gate, so a plain
  // delegation card behaves as it always did.
  const hasBody = hasSummary || nested.length > 0

  return (
    <div className="tr-agent">
      <button
        className="tr-agent-header"
        type="button"
        title={tool.title}
        onClick={() => {
          if (hasBody) setExpanded((e) => !e)
        }}
      >
        <span className="tr-agent-icon">
          <Icon name="person.crop.circle.badge.plus" size={13} />
        </span>
        <span className="tr-agent-main">
          <span className="tr-agent-titlerow">
            <span className="tr-agent-name">{call.agent}</span>
            <span className="tr-agent-badge">agent</span>
            {isRunning && <span className="tr-agent-working">working…</span>}
          </span>
          {call.task != null && call.task !== '' && (
            <span className={`tr-agent-task${expanded ? '' : ' tr-agent-task--clamped'}`}>
              {call.task}
            </span>
          )}
        </span>
        {isRunning ? (
          <SpettroSpinner size={11} color="var(--text-secondary)" />
        ) : failed ? (
          <span className="tr-status-fail">
            <Icon name="xmark.circle.fill" size={11} />
          </span>
        ) : (
          <span className="tr-status-dot" />
        )}
        {hasBody && (
          <span className={`tr-chevron${expanded ? ' tr-chevron--open' : ''}`}>
            <Icon name="chevron.right" size={8} />
          </span>
        )}
      </button>
      {expanded && hasBody && (
        <div className="tr-agent-summary">
          {nested.length > 0 && (
            <div className="orch-nested">
              {nested.map((child) => (
                <ToolRow key={child.id} tool={child} />
              ))}
            </div>
          )}
          {hasSummary && <MarkdownText source={result.summary} />}
        </div>
      )}
    </div>
  )
}

// The icon registry moved to design/icons.tsx; re-exported so the many views
// that import it from here keep working.
export { Icon, type IconName } from '@renderer/design/icons'

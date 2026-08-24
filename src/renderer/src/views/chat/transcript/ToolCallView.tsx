// Port of spettro-apple/Spettro/Views/ToolCallView.swift.
//
// Renders one tool call as a quiet, expandable row (synara-style): an icon,
// a short verb, the human-readable detail (command, file, pattern — never
// raw JSON), a +N/-N diff stat, and a live status glyph. Expanding reveals
// the output or a red/green line diff. `agent` tool calls render as the
// dedicated purple sub-agent card instead.

import { useState } from 'react'
import type { JSX, ReactNode } from 'react'
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

// ---------------------------------------------------------------------------
// Icons — inline SVG stand-ins for the SF Symbol set the Swift views use.
// ---------------------------------------------------------------------------

export type IconName =
  | 'doc.text'
  | 'pencil'
  | 'trash'
  | 'arrow.right.doc.on.clipboard'
  | 'magnifyingglass'
  | 'terminal'
  | 'brain'
  | 'globe'
  | 'arrow.triangle.2.circlepath'
  | 'wrench.and.screwdriver'
  | 'person.crop.circle.badge.plus'
  | 'xmark.circle.fill'
  | 'chevron.right'
  | 'chevron.down'
  | 'info.circle.fill'
  | 'exclamationmark.triangle.fill'
  | 'flowchart'
  | 'bolt'
  | 'checkmark.circle.fill'
  | 'arrow.triangle.branch'
  | 'arrow.counterclockwise'
  | 'sidebar.right'

const STROKE_ICONS: Record<string, ReactNode> = {
  'doc.text': (
    <>
      <path d="M4.5 1.5H9l3 3v9.5a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5z" />
      <path d="M9 1.5V5h3.5" />
      <path d="M5.8 8.5h4.4M5.8 11h4.4" />
    </>
  ),
  pencil: (
    <>
      <path d="M2.5 13.5l.8-3.2 8-8a1.1 1.1 0 0 1 1.55 0l.85.85a1.1 1.1 0 0 1 0 1.55l-8 8-3.2.8z" />
      <path d="M10.4 3.4l2.2 2.2" />
    </>
  ),
  trash: (
    <>
      <path d="M2.5 4h11" />
      <path d="M5.5 4V2.5h5V4" />
      <path d="M3.8 4l.65 9a1 1 0 0 0 1 .9h5.1a1 1 0 0 0 1-.9l.65-9" />
      <path d="M6.5 6.5v5M9.5 6.5v5" />
    </>
  ),
  'arrow.right.doc.on.clipboard': (
    <>
      <path d="M3 2.5h6.5v11H3z" />
      <path d="M8 8h6M11.5 5.5L14 8l-2.5 2.5" />
    </>
  ),
  magnifyingglass: (
    <>
      <circle cx="6.5" cy="6.5" r="4.5" />
      <path d="M9.8 9.8L14 14" />
    </>
  ),
  terminal: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4 6l2.5 2L4 10" />
      <path d="M8 10.5h4" />
    </>
  ),
  brain: (
    <>
      <path d="M8 2.5a3 3 0 0 0-3 3 2.5 2.5 0 0 0-1.4 4.4A2.5 2.5 0 0 0 6 13.5c.8 0 1.5-.35 2-.9.5.55 1.2.9 2 .9a2.5 2.5 0 0 0 2.4-3.6A2.5 2.5 0 0 0 11 5.5a3 3 0 0 0-3-3z" />
      <path d="M8 3.5v9" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="6" />
      <ellipse cx="8" cy="8" rx="2.6" ry="6" />
      <path d="M2 8h12" />
    </>
  ),
  'arrow.triangle.2.circlepath': (
    <>
      <path d="M12.7 6.3A5 5 0 0 0 4 4.5" />
      <path d="M3.6 2v3h3" />
      <path d="M3.3 9.7A5 5 0 0 0 12 11.5" />
      <path d="M12.4 14v-3h-3" />
    </>
  ),
  'wrench.and.screwdriver': (
    <>
      <path d="M13.6 4.4a3.8 3.8 0 0 1-5 4.8l-4.1 4.1a1.35 1.35 0 0 1-1.9-1.9l4.1-4.1a3.8 3.8 0 0 1 4.8-5L9.2 4.6l2.2 2.2 2.2-2.4z" />
    </>
  ),
  'person.crop.circle.badge.plus': (
    <>
      <circle cx="7.2" cy="7.2" r="5.7" />
      <circle cx="7.2" cy="5.8" r="1.8" />
      <path d="M3.9 11.3a4 4 0 0 1 6.6 0" />
      <path d="M12.7 10.8v3.4M11 12.5h3.4" />
    </>
  ),
  'chevron.right': <path d="M5.5 3l5 5-5 5" strokeWidth="2.4" />,
  'chevron.down': <path d="M3 5.5l5 5 5-5" strokeWidth="2.4" />,
  // A workflow is a plan drawn before the run: one root fanning into phases.
  // A root that fans out into two: the shape of a phase that dispatches and a
  // phase that collects. Drawn on a wider, flatter grid than the first attempt
  // — squat 5x3 nodes with a full-width bus — because the earlier 4.4x3.2
  // boxes with a 1-unit radius rendered as three rounded blobs the moment the
  // glyph was used above ~20px.
  flowchart: (
    <>
      <rect x="5.5" y="1.4" width="5" height="3" rx="0.8" />
      <rect x="1.1" y="11.6" width="5" height="3" rx="0.8" />
      <rect x="9.9" y="11.6" width="5" height="3" rx="0.8" />
      <path d="M8 4.4v3.2" />
      <path d="M3.6 11.6V7.6h8.8v4" />
    </>
  ),
  // Ultra: the fan-out that hits all at once.
  bolt: <path d="M9.3 1.5L3.6 9.3h3.5l-.4 5.2 5.7-7.8H8.9z" />,
  // Worktree isolation: each member on its own branch, merged back after.
  'arrow.triangle.branch': (
    <>
      <circle cx="4.4" cy="3.4" r="1.8" />
      <circle cx="4.4" cy="12.6" r="1.8" />
      <circle cx="11.6" cy="3.4" r="1.8" />
      <path d="M4.4 5.2v5.6" />
      <path d="M11.6 5.2v1.5a3.4 3.4 0 0 1-3.4 3.4H4.4" />
    </>
  ),
  // Replayed from the resume journal rather than re-run.
  'arrow.counterclockwise': (
    <>
      <path d="M2.7 9.4A5.5 5.5 0 1 0 4.1 4.1" />
      <path d="M7.1 3.9L4.1 4.1 4.4 1.1" />
    </>
  ),
  'sidebar.right': (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M10.3 2.5v11" />
    </>
  )
}

const FILLED_ICONS: Record<string, ReactNode> = {
  'checkmark.circle.fill': (
    <>
      <circle cx="8" cy="8" r="7" fill="currentColor" stroke="none" />
      <path d="M4.9 8.2l2.1 2.2 4.1-4.6" stroke="var(--canvas)" strokeWidth="1.7" />
    </>
  ),
  'xmark.circle.fill': (
    <>
      <circle cx="8" cy="8" r="7" fill="currentColor" stroke="none" />
      <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="var(--canvas)" strokeWidth="1.6" />
    </>
  ),
  'info.circle.fill': (
    <>
      <circle cx="8" cy="8" r="7" fill="currentColor" stroke="none" />
      <path d="M8 7.2v3.8" stroke="var(--canvas)" strokeWidth="1.6" />
      <circle cx="8" cy="4.6" r="1" fill="var(--canvas)" stroke="none" />
    </>
  ),
  'exclamationmark.triangle.fill': (
    <>
      <path
        d="M8 1.8l6.9 11.6a.9.9 0 0 1-.78 1.35H1.88a.9.9 0 0 1-.78-1.35z"
        fill="currentColor"
        stroke="none"
      />
      <path d="M8 6v4" stroke="var(--canvas)" strokeWidth="1.5" />
      <circle cx="8" cy="12.2" r=".9" fill="var(--canvas)" stroke="none" />
    </>
  )
}

export function Icon({
  name,
  size = 12,
  className
}: {
  name: IconName | string
  size?: number
  className?: string
}): JSX.Element {
  const filled = FILLED_ICONS[name]
  const children = filled ?? STROKE_ICONS[name] ?? STROKE_ICONS['wrench.and.screwdriver']
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={strokeFor(size)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/**
 * Stroke width in viewBox units for a given rendered size.
 *
 * These glyphs live at 8–14px, where a flat 1.5 is right. The same 1.5 on a
 * 40px empty-state icon is a 3.75px stroke — heavy enough that the shapes
 * close up and the icon reads as a blob rather than a diagram. Past the row
 * sizes the stroke thins toward a constant *rendered* weight, so a glyph looks
 * like itself at any size; below that nothing changes, because every icon in
 * the transcript was drawn against 1.5 and should stay exactly as it is.
 */
function strokeFor(size: number): number {
  if (size <= 16) return 1.5
  return Math.max(0.9, (1.5 * 16) / size)
}

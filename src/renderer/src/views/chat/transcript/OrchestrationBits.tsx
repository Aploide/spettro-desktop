// The small pieces every orchestration surface is built from — the workflow
// card, the swarm card and the live side panel all draw the same meter, the
// same status glyph, the same member line.
//
// They live together because consistency here is the whole readability story:
// a run shown in the transcript and the same run shown in the side panel must
// be recognisably one thing, and a member row must look identical whether it
// sits under a phase, in a swarm grid, or in the panel. Splitting these across
// the three call sites is how the three drift apart.
//
// These are ports of the TUI's internal/tui/view_workflow.go and view_swarm.go
// primitives, and they carry the decisions those files argue for: a failure is
// never rounded away to nothing, an instance name is never truncated through
// its "#N" suffix, and a running member shows what it is doing NOW rather than
// the item it was handed at launch.

import type { JSX, ReactNode } from 'react'
import { displayDetail } from './toolPresentation'
import type { MemberCall, OrchCounts, OrchStatus } from './orchestration'
import { Icon } from './ToolCallView'
import { MarkdownText } from './MarkdownText'
import { SpettroSpinner } from './RunTicker'
import './orchestration.css'

// ---------------------------------------------------------------------------
// Progress meter
// ---------------------------------------------------------------------------

/**
 * A slim segmented bar: green for done, red for failed, muted track for what
 * is still to come. Done and failed both count as finished — a failed agent is
 * not still working — but failures get their own colour so a red-heavy bar
 * reads as trouble at a glance.
 *
 * Port of progressBar() in internal/tui/view_workflow.go, including its one
 * non-obvious rule: a single failure among fifty agents rounds to zero cells
 * and would vanish, so any failure at all is forced to a visible width.
 */
export function ProgressMeter({
  counts,
  width
}: {
  counts: OrchCounts
  width?: number
}): JSX.Element {
  const total = Math.max(0, counts.total)
  const finished = counts.done + counts.failed
  const style = width != null ? { width: `${width}px` } : undefined
  if (total === 0) {
    return (
      <span
        className="orch-meter"
        style={style}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={0}
        aria-valuenow={0}
        aria-label="Nothing dispatched yet"
      >
        <span className="orch-meter-track" />
      </span>
    )
  }
  const MIN_VISIBLE = 6 // percent — enough to read as a segment, not a hairline
  let failedPct = (counts.failed / total) * 100
  if (counts.failed > 0 && failedPct < MIN_VISIBLE) failedPct = MIN_VISIBLE
  let donePct = (counts.done / total) * 100
  if (donePct + failedPct > 100) donePct = 100 - failedPct
  return (
    <span
      className="orch-meter"
      style={style}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={finished}
      aria-label={`${finished} of ${total} finished`}
    >
      <span className="orch-meter-track">
        {donePct > 0 && <span className="orch-meter-done" style={{ width: `${donePct}%` }} />}
        {failedPct > 0 && <span className="orch-meter-failed" style={{ width: `${failedPct}%` }} />}
      </span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Status glyph
// ---------------------------------------------------------------------------

/** ▶ running / ✓ done / ✗ failed — the three states anything orchestrated is
 *  ever in, drawn the same size everywhere so rows stay aligned. */
export function StatusGlyph({
  status,
  size = 11
}: {
  status: OrchStatus
  size?: number
}): JSX.Element {
  if (status === 'running') {
    return (
      <span className="orch-glyph orch-glyph--running" aria-label="running">
        <SpettroSpinner size={size} color="var(--accent)" />
      </span>
    )
  }
  const failed = status === 'failed'
  return (
    <span
      className={`orch-glyph orch-glyph--${failed ? 'failed' : 'done'}`}
      aria-label={failed ? 'failed' : 'done'}
    >
      <Icon name={failed ? 'xmark.circle.fill' : 'checkmark.circle.fill'} size={size} />
    </span>
  )
}

// ---------------------------------------------------------------------------
// Counts label
// ---------------------------------------------------------------------------

/**
 * "3 running · 5 done · 1 failed · 2 replayed", with the zero terms dropped —
 * port of workflowRun.headline(). A run that has dispatched nothing yet has
 * nothing to say here and renders empty rather than a row of zeroes.
 */
export function CountsLabel({ counts }: { counts: OrchCounts }): JSX.Element {
  const terms: { key: string; text: string; failed?: boolean }[] = []
  if (counts.running > 0) terms.push({ key: 'running', text: `${counts.running} running` })
  if (counts.done > 0) terms.push({ key: 'done', text: `${counts.done} done` })
  if (counts.failed > 0) terms.push({ key: 'failed', text: `${counts.failed} failed`, failed: true })
  if (counts.cached > 0) terms.push({ key: 'cached', text: `${counts.cached} replayed` })
  return (
    <span className="orch-counts">
      {terms.map((term, i) => (
        <span
          key={term.key}
          className={`orch-counts-term${term.failed === true ? ' orch-counts-failed' : ''}`}
        >
          {i > 0 && <span className="orch-counts-sep">·</span>}
          {term.text}
        </span>
      ))}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Member row
// ---------------------------------------------------------------------------

/** How wide an instance name may get before it is clipped, in characters. */
const INSTANCE_MAX = 22

/**
 * One sub-agent line: status glyph, instance in its spec's tint, and its live
 * detail. Expanding reveals the tool calls it made and the summary it reported.
 *
 * The detail is deliberately the member's *latest* tool call rather than the
 * task it was launched with: in a twenty-member fan-out the launch items are
 * near-identical and tell you nothing about progress, which is the readability
 * fix internal/tui/view_swarm.go was written for. Once a member finishes, the
 * live detail stops meaning anything and the row falls back to its task.
 */
export function MemberRow({
  member,
  tint,
  expanded,
  onToggle,
  children
}: {
  member: MemberCall
  tint: string
  expanded: boolean
  onToggle: () => void
  children?: ReactNode
}): JSX.Element {
  const running = member.status === 'running'
  const summary = member.result?.summary ?? ''
  const hasDetail = member.children.length > 0 || summary !== ''
  const last = member.children[member.children.length - 1]
  const live = running && last ? displayDetail(last) : ''
  const detail = live !== '' ? live : member.task

  return (
    <div className={`orch-member${expanded ? ' orch-member--expanded' : ''}`}>
      <button
        className="orch-member-header"
        type="button"
        title={member.task === '' ? member.instance : `${member.instance}: ${member.task}`}
        onClick={() => {
          if (hasDetail) onToggle()
        }}
      >
        <StatusGlyph status={member.status} />
        <span
          className={`orch-member-name${running ? '' : ' orch-member-name--faint'}`}
          style={{ color: tint }}
        >
          {truncateInstance(member.instance, INSTANCE_MAX)}
        </span>
        {member.cached && (
          <span className="orch-pill orch-pill--replayed">
            <Icon name="arrow.counterclockwise" size={9} />
            replayed
          </span>
        )}
        <span className="orch-member-detail">{detail.split('\n').join(' ')}</span>
        {member.children.length > 0 && (
          <span className="orch-member-tools">{member.children.length}</span>
        )}
        {hasDetail && (
          <span className={`tr-chevron${expanded ? ' tr-chevron--open' : ''}`}>
            <Icon name="chevron.right" size={8} />
          </span>
        )}
      </button>
      {expanded && hasDetail && (
        <div className="orch-member-body">
          {children}
          {summary !== '' && (
            <div className="orch-member-summary">
              <MarkdownText source={summary} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Name truncation
// ---------------------------------------------------------------------------

/**
 * Shortens an instance name while KEEPING its "#N" suffix — port of
 * truncateAgentName() in internal/tui/view_workflow.go. Members of a run share
 * a long spec prefix ("general-purpose#7"), so a plain clip throws away the
 * only part of the name that tells one member from another.
 */
export function truncateInstance(name: string, max: number): string {
  if (max < 4 || name.length <= max) return truncateLabel(name, max)
  const hash = name.lastIndexOf('#')
  if (hash <= 0) return truncateLabel(name, max)
  const suffix = name.slice(hash)
  const keep = max - suffix.length - 1
  if (keep < 1) return truncateLabel(name, max)
  return name.slice(0, keep) + '…' + suffix
}

function truncateLabel(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  if (max <= 1) return text.slice(0, max)
  return text.slice(0, max - 1) + '…'
}

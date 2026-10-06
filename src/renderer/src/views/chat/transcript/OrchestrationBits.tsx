// The small pieces every orchestration surface is built from — the workflow
// card and the live side panel draw the same meter, the same status glyph,
// the same member line.
//
// They live together because consistency here is the whole readability story:
// a run shown in the transcript and the same run shown in the side panel must
// be recognisably one thing, and a member row must look identical whether it
// sits under a phase or in the panel. Splitting these across the call sites is
// how they drift apart.
//
// These are ports of the TUI's internal/tui/view_workflow.go primitives, and
// they carry the decisions that file argues for: a failure is never rounded
// away to nothing, an instance name is never truncated through its "#N"
// suffix, and a running member shows what it is doing NOW rather than the
// task it was handed at launch.

import { useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { displayDetail } from './toolPresentation'
import type { MemberCall, OrchCounts, OrchStatus, RunStatus, WorkflowScript } from './orchestration'
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

/**
 * One glyph per state, drawn the same size everywhere so rows stay aligned:
 * a spinner while running, a tick or a cross once over, a pause for a run
 * waiting at a checkpoint (it is not hung, and must not spin as if working),
 * a square for a run stopped on purpose, and a dashed ring for a member that
 * has not started.
 */
export function StatusGlyph({
  status,
  size = 11
}: {
  status: OrchStatus | RunStatus
  size?: number
}): JSX.Element {
  if (status === 'running') {
    return (
      <span className="orch-glyph orch-glyph--running" aria-label="running">
        <SpettroSpinner size={size} color="var(--accent)" />
      </span>
    )
  }
  const icon = GLYPHS[status]
  return (
    <span className={`orch-glyph orch-glyph--${status}`} aria-label={icon.label}>
      <Icon name={icon.name} size={size} />
    </span>
  )
}

const GLYPHS: Record<Exclude<OrchStatus | RunStatus, 'running'>, { name: string; label: string }> = {
  done: { name: 'checkmark.circle.fill', label: 'done' },
  failed: { name: 'xmark.circle.fill', label: 'failed' },
  pending: { name: 'circle.dashed', label: 'not started' },
  paused: { name: 'pause.circle.fill', label: 'waiting' },
  stopped: { name: 'stop.circle.fill', label: 'stopped' }
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
  if (counts.failed > 0) {
    terms.push({ key: 'failed', text: `${counts.failed} failed`, failed: true })
  }
  if (counts.pending > 0) terms.push({ key: 'pending', text: `${counts.pending} queued` })
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
 * task it was launched with: in a twenty-member fan-out the launch tasks are
 * near-identical and tell you nothing about progress. Once a member finishes,
 * the live detail stops meaning anything and the row falls back to its task.
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
  // `resultText` rather than `result?.summary`: an agent given a schema
  // returns its structured value and one asked a question returns prose, and
  // neither carries a `summary` field. A member that produced output must
  // never render as a row with nothing behind it.
  const summary = member.resultText
  const hasDetail = member.children.length > 0 || summary !== ''
  const last = member.children[member.children.length - 1]
  // displayDetail re-applies the "[code#3] " title prefix; here the row
  // already says whose work this is, so repeating it just eats the width.
  const live = running && last ? stripInstance(displayDetail(last), member.instance) : ''
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
              {member.resultIsJSON ? (
                <pre className="orch-code">{summary}</pre>
              ) : (
                <MarkdownText source={summary} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// A workflow that never started
// ---------------------------------------------------------------------------

/**
 * The `workflow` tool call on its own — a script the model submitted that
 * started no run, which in practice means it failed on the way in (a saved
 * workflow that does not exist, a script that would not parse).
 *
 * It is drawn here rather than by the ordinary tool row because that row shows
 * a call's arguments, and this call's arguments are an entire JavaScript
 * program: several hundred characters of escaped source, rendered as one line
 * of raw JSON with a red badge on the end. The failure is the point and the
 * source is the detail, so that is the order they appear in — the program is
 * behind a disclosure, and what the reader gets for free is which workflow
 * failed and why.
 */
export function ScriptCallRow({ script }: { script: WorkflowScript }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const name = script.savedAs === '' ? 'workflow' : script.savedAs
  const reason = script.error !== '' ? script.error : script.tool.output.trim()
  const hasSource = script.source !== '' || script.returned !== ''

  return (
    <div className={`orch-script orch-script--${script.status}`}>
      <button
        className="orch-script-head"
        type="button"
        aria-expanded={expanded}
        onClick={() => {
          if (hasSource) setExpanded((value) => !value)
        }}
      >
        <span className="orch-script-icon">
          <Icon name="flowchart" size={13} />
        </span>
        <span className="orch-script-title">
          Workflow<span className="orch-script-name"> · {name}</span>
        </span>
        <StatusGlyph status={script.status} />
        {reason !== '' && <span className="orch-script-reason">{reason.split('\n')[0]}</span>}
        <span className="orch-script-spacer" />
        {hasSource && (
          <span className={`tr-chevron${expanded ? ' tr-chevron--open' : ''}`}>
            <Icon name="chevron.right" size={8} />
          </span>
        )}
      </button>
      {expanded && hasSource && (
        <div className="orch-script-body">
          {script.source !== '' && <pre className="orch-code">{script.source}</pre>}
          {script.returned !== '' && (
            <>
              <span className="orch-script-label">returned</span>
              <pre className="orch-code">{script.returned}</pre>
            </>
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

function stripInstance(detail: string, instance: string): string {
  const prefix = `[${instance}] `
  return detail.startsWith(prefix) ? detail.slice(prefix.length) : detail
}

function truncateLabel(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  if (max <= 1) return text.slice(0, max)
  return text.slice(0, max - 1) + '…'
}

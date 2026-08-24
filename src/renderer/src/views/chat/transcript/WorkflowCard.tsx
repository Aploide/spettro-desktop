// The workflow card: a phase tree in the transcript, not a list of agents.
//
// A workflow is the one kind of run whose shape was decided before it started
// — the script declared its phases up front — so the card draws the whole plan
// from the first frame and fills it in as agents land. That is the point being
// defended here, and it is the same argument internal/tui/view_workflow.go
// makes on the terminal side: a flat agent list turns a 3-phase, 20-agent run
// into twenty indistinguishable lines, and worse, it can only ever show work
// that has already happened. A phase nobody has reached yet is exactly the
// information a reader wants, so it is drawn dimmed rather than omitted.
//
// The other tension is with the conversation itself: a finished run is history
// and history must not own half the scrollback. The first cut resolved that by
// collapsing a settled run to a single line — and that was the wrong trade, as
// a screenshot made obvious. The one line said "4 agents · 1 failed" and the
// failure survived only as a red sliver in the meter, so the state a reader
// scrolls BACK to was the state that told them least.
//
// So a settled run drops successful *detail*, never *structure*. The phase
// spine stays, each phase keeps its meter and its "3/3 done", every failed
// member keeps its row AND gains the reason it failed, and the successes —
// the least interesting rows on the card, a fact this file already believed
// while a run was live — fold into one "N done" per phase that expands. The
// card is a few lines tall instead of one, and it answers "what did this run
// do, and what broke" without a click.
//
// Same reason each phase caps its visible rows while running: when a fan-out
// is wider than the eye can scan, the rows that survive are the ones still
// running and the ones that failed.

import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { MemberCall, OrchCounts, WorkflowPhase, WorkflowRun } from './orchestration'
import { memberTint } from './orchestration'
import { CountsLabel, MemberRow, ProgressMeter } from './OrchestrationBits'
import { Icon, ToolRow } from './ToolCallView'
import { SpettroSpinner } from './RunTicker'
import './workflowCard.css'

/** How many member rows a single phase shows before it starts hiding them. */
const PHASE_ROW_CAP = 12

/** Log lines shown inline before the tail hides behind a disclosure. */
const LOG_INLINE_MAX = 3

export function WorkflowCard({ run }: { run: WorkflowRun }): JSX.Element {
  // `null` means "nobody has decided yet". The body is open in both states —
  // a settled run compacts rather than disappears — but a reader who closes
  // the card keeps it closed as further updates arrive.
  const [override, setOverride] = useState<boolean | null>(null)
  const [rawOpen, setRawOpen] = useState(false)
  const running = run.status === 'running'
  const settled = !running
  const open = override ?? true

  const elapsed = useElapsed(running, run.tool.timestamp)
  const finished = run.counts.done + run.counts.failed
  const total = run.counts.total
  const bodyId = `wfc-body-${run.tool.id}`

  // The one-line form is a readout, not a truncation of the open one: while
  // running it says how far along and how long, and once finished it says what
  // the run concluded — the line the CLI itself prints.
  const tail = running
    ? total > 0
      ? `${finished}/${total}${elapsed === '' ? '' : ` · ${elapsed}`}`
      : elapsed === '' ? 'dispatching…' : elapsed
    : summaryText(run)

  const phases = run.phases.filter((phase) => phase.title !== '' || phase.members.length > 0)

  return (
    <section
      className={`wfc wfc--${run.status}${open ? ' wfc--open' : ''}${settled ? ' wfc--settled' : ''}`}
    >
      <button
        className="wfc-head"
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        title={run.origin === '' ? run.name : `${run.name} — ${run.origin}`}
        onClick={() => setOverride(!open)}
      >
        <span className="wfc-mark">
          <Icon name="flowchart" size={14} />
        </span>
        <span className="wfc-headmain">
          <span className="wfc-titlerow">
            <span className="wfc-name">{run.name === '' ? 'workflow' : run.name}</span>
            {running && (
              <span className="wfc-badge wfc-badge--running">
                <SpettroSpinner size={9} color="currentColor" />
                running
              </span>
            )}
            {run.status === 'failed' && (
              <span className="wfc-badge wfc-badge--failed">
                <Icon name="xmark.circle.fill" size={9} />
                failed
              </span>
            )}
            <span className="wfc-tail">{open ? run.description : tail}</span>
          </span>
          {open && (
            <span className="wfc-metrics">
              <ProgressMeter counts={run.counts} width={128} />
              {total > 0 && (
                <span className="wfc-ratio">
                  {finished}/{total}
                </span>
              )}
              <CountsLabel counts={run.counts} />
              {/* Only the clock: the ratio beside the meter already said
                  "2/4", and printing it twice on one line was noise. */}
              {running && elapsed !== '' && <span className="wfc-readout">{elapsed}</span>}
            </span>
          )}
        </span>
        {!open && <ProgressMeter counts={run.counts} width={56} />}
        <span className={`tr-chevron${open ? ' tr-chevron--open' : ''}`}>
          <Icon name="chevron.right" size={8} />
        </span>
      </button>

      {open && (
        <div className="wfc-body" id={bodyId}>
          {phases.length === 0 ? (
            <p className="wfc-empty">{running ? 'waiting for the first agent…' : 'no agents ran'}</p>
          ) : (
            <div className="wfc-tree">
              {phases.map((phase, i) => (
                <PhaseGroup key={`${phase.title}-${i}`} phase={phase} compact={settled} />
              ))}
            </div>
          )}
          {run.logs.length > 0 && <LogBlock logs={run.logs} compact={settled} />}
          {run.rendered !== '' && (
            <div className="wfc-raw">
              <button
                className="wfc-disclose"
                type="button"
                aria-expanded={rawOpen}
                onClick={() => setRawOpen((value) => !value)}
              >
                <span className={`tr-chevron${rawOpen ? ' tr-chevron--open' : ''}`}>
                  <Icon name="chevron.right" size={8} />
                </span>
                raw tree
              </button>
              {rawOpen && <pre className="wfc-pre">{run.rendered}</pre>}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// One phase
// ---------------------------------------------------------------------------

type PhaseState = 'pending' | 'running' | 'failed' | 'done'

/**
 * A phase header plus its members. Running outranks failed outranks done when
 * colouring the header, matching workflowPhaseGroup(): what is happening now
 * is what the header should be reporting, even if something already went wrong
 * beside it — the failure still has its own row and its own count.
 *
 * `compact` is the settled form. The header is unchanged — a phase that is
 * over still owes the reader its meter and its ratio — and so is every row
 * that did not succeed. What goes is the roll of successes, which becomes a
 * single "N done" the reader can open if they want it.
 */
function PhaseGroup({ phase, compact }: { phase: WorkflowPhase; compact: boolean }): JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const state = phaseState(phase)
  const total = phase.members.length
  const finished = phase.counts.done + phase.counts.failed
  const quiet = phase.members.filter((member) => member.status === 'done').length

  let shown: MemberCall[]
  let hidden: number
  if (compact && !showAll) {
    shown = phase.members.filter((member) => member.status !== 'done')
    hidden = quiet
  } else {
    const capped = capMembers(phase.members, showAll ? total : PHASE_ROW_CAP)
    shown = capped.shown
    hidden = capped.hidden
  }

  const toggleable = compact ? quiet > 0 : hidden > 0 || (showAll && total > PHASE_ROW_CAP)
  const toggleLabel = showAll
    ? 'show fewer'
    : compact
      ? `${hidden} done`
      : `… ${hidden} more`

  return (
    <div className={`wfc-phase wfc-phase--${state}`}>
      <span className="wfc-rail" aria-hidden="true">
        <span className="wfc-dot" />
      </span>
      <div className="wfc-phasebody">
        <div className="wfc-phasehead">
          <span className="wfc-phasetitle">{phase.title === '' ? 'no phase' : phase.title}</span>
          {phase.detail !== '' && <span className="wfc-phasedetail">{phase.detail}</span>}
          {state === 'pending' ? (
            <span className="wfc-phasepending">pending</span>
          ) : (
            <>
              <ProgressMeter counts={phase.counts} width={56} />
              <span className="wfc-phaseratio">
                {finished}/{total} done
              </span>
            </>
          )}
        </div>
        {(shown.length > 0 || toggleable) && (
          <div className="wfc-members">
            {shown.map((member) => (
              <MemberLine key={member.tool.id} member={member} />
            ))}
            {toggleable && (
              <button
                className={`wfc-more${compact ? ' wfc-more--quiet' : ''}`}
                type="button"
                aria-expanded={showAll}
                onClick={() => setShowAll((value) => !value)}
              >
                {compact && (
                  <span className={`tr-chevron${showAll ? ' tr-chevron--open' : ''}`}>
                    <Icon name="chevron.right" size={8} />
                  </span>
                )}
                {toggleLabel}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * One member, owning its own disclosure. Expansion state lives here rather
 * than in a set on the card so it is keyed by React identity: a member keeps
 * whatever the user did to it as siblings arrive above and below it.
 *
 * MemberRow already renders the agent's reported summary as markdown, so all
 * this passes down is the agent's own tool calls — plus, for a failure only,
 * the reason printed straight onto the card. A failure whose cause is one
 * click away is a failure the card hid, and the text is already in hand.
 */
function MemberLine({ member }: { member: MemberCall }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const reason = failureReason(member)
  return (
    <div className="wfc-memberline">
      <MemberRow
        member={member}
        tint={memberTint(member.specId)}
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
      >
        {member.children.length > 0 && (
          <div className="orch-nested">
            {member.children.map((child) => (
              <ToolRow key={child.id} tool={child} />
            ))}
          </div>
        )}
      </MemberRow>
      {reason !== '' && <p className="wfc-reason">{reason}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The script's log
// ---------------------------------------------------------------------------

/**
 * The `log()` lines the script emitted. They are the only narration a workflow
 * has — the CLI folds its progress traces into the lifecycle call and never
 * emits them as rows — so they are always reachable, but a chatty script must
 * not out-shout the phase tree it is narrating. Once the run is over the tree
 * is the record and the narration is not, so a settled card always folds it
 * away however short it is.
 */
function LogBlock({ logs, compact }: { logs: string[]; compact: boolean }): JSX.Element {
  const [open, setOpen] = useState(false)
  if (!compact && logs.length <= LOG_INLINE_MAX) {
    return (
      <div className="wfc-log">
        {logs.map((line, i) => (
          <span key={i} className="wfc-logline">
            {line}
          </span>
        ))}
      </div>
    )
  }
  return (
    <div className="wfc-log">
      <button
        className="wfc-disclose"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`tr-chevron${open ? ' tr-chevron--open' : ''}`}>
          <Icon name="chevron.right" size={8} />
        </span>
        log ({logs.length})
        {!open && <span className="wfc-logpeek">{logs[logs.length - 1]}</span>}
      </button>
      {open &&
        logs.map((line, i) => (
          <span key={i} className="wfc-logline">
            {line}
          </span>
        ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

/**
 * Why a member failed, in one string. The agent's reported summary is the
 * best answer and is already parsed; when the output was not the report shape
 * we take the error-ish field out of whatever JSON it was, and failing that
 * the raw text — a provider's plain "429 after 3 attempts" is the case that
 * matters most and never arrives as a report.
 *
 * Deliberately duplicated in SwarmCard.tsx rather than lifted: it is ten lines
 * of card presentation, and the two cards are the only surfaces that print a
 * reason on the row.
 */
function failureReason(member: MemberCall): string {
  if (member.status !== 'failed') return ''
  const reported = (member.result?.summary ?? '').trim()
  if (reported !== '') return reported
  const raw = member.tool.output.trim()
  if (raw === '') return ''
  if (raw.startsWith('{')) {
    try {
      const value: unknown = JSON.parse(raw)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>
        for (const key of ['error', 'message', 'summary', 'reason']) {
          const found = record[key]
          if (typeof found === 'string' && found.trim() !== '') return found.trim()
        }
        return ''
      }
    } catch {
      // Not JSON after all — fall through and show it as text.
    }
  }
  return raw
}

function phaseState(phase: WorkflowPhase): PhaseState {
  if (phase.members.length === 0) return 'pending'
  if (phase.counts.running > 0) return 'running'
  if (phase.counts.failed > 0) return 'failed'
  return 'done'
}

/**
 * Trims a phase to `cap` rows. Port of the `prio` ordering in
 * view_workflow.go's workflowRow: running rows are never dropped, then
 * failures are kept ahead of successes, because a failure is the row a reader
 * most wants to see among work that is already over. Survivors stay in
 * dispatch order — reordering them would make the list churn as it fills.
 */
function capMembers(
  members: MemberCall[],
  cap: number
): { shown: MemberCall[]; hidden: number } {
  if (members.length <= cap) return { shown: members, hidden: 0 }
  const keep = new Set<MemberCall>()
  for (const member of members) if (member.status === 'running') keep.add(member)
  let budget = Math.max(cap - keep.size, 0)
  for (const status of ['failed', 'done'] as const) {
    for (const member of members) {
      if (budget === 0) break
      if (member.status !== status || keep.has(member)) continue
      keep.add(member)
      budget -= 1
    }
  }
  const shown = members.filter((member) => keep.has(member))
  return { shown, hidden: members.length - shown.length }
}

/** The line a finished run settles to: what the CLI concluded, or — when the
 *  finish output never arrived — the same shape rebuilt from the counts. */
function summaryText(run: WorkflowRun): string {
  if (run.summary !== '') return run.summary
  const counts: OrchCounts = run.counts
  if (counts.total === 0) return run.status === 'failed' ? 'failed' : 'no agents'
  const parts = [`${counts.total} ${counts.total === 1 ? 'agent' : 'agents'}`]
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  if (counts.cached > 0) parts.push(`${counts.cached} replayed`)
  return parts.join(' · ')
}

/**
 * Ticking elapsed time while the run is live. The tool call's timestamp is
 * set once, when the call first appears, and never updated — so it is a true
 * start time. The clock only runs while the card needs it: a finished run has
 * no end timestamp to subtract from, and would be counting up forever.
 */
function useElapsed(active: boolean, since: number): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [active])
  if (!active || since <= 0) return ''
  const seconds = Math.floor((now - since) / 1000)
  if (seconds < 0 || seconds > 24 * 3600) return ''
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${pad(seconds % 60)}s`
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : `${value}`
}

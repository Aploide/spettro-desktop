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
//
// Two states are neither live nor over, and each says so in words rather than
// with a spinner. A run *paused* at a checkpoint is waiting for Spettro to
// answer a question it asked; a spinner there reads as hung. A card a later
// turn *continued* is superseded by the card further down — it keeps the
// state its turn left (usually paused), so it starts folded with "Continued
// below" instead of waiting forever. A *stopped* run was ended on purpose and
// says why, rather than passing for a success.

import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { MemberCall, OrchCounts, WorkflowPhase, WorkflowRun } from './orchestration'
import { memberTint, sizeLabel } from './orchestration'
import { compactTokens } from '@shared/workflowBudget'
import { CountsLabel, MemberRow, ProgressMeter, StatusGlyph } from './OrchestrationBits'
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
  const continued = run.continued
  const running = run.status === 'running' && !continued
  const settled = !running
  // Finished, failed or stopped: nothing more will run. A paused run (and the
  // card a later turn continued) may still reach its remaining phases.
  const over = !continued && (run.status === 'done' || run.status === 'failed' || run.status === 'stopped')
  // A continued card is history the card below repeats in full, so it starts
  // folded; everything else starts open.
  const open = override ?? !continued

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
      : elapsed === '' ? 'starting…' : elapsed
    : stateDetail(run)

  const phases = run.phases.filter((phase) => phase.title !== '' || phase.members.length > 0)
  const plan = planLabel(run)
  const state = stateLine(run)
  const tone = continued ? 'continued' : run.status

  return (
    <section
      className={`wfc wfc--${tone}${open ? ' wfc--open' : ''}${settled ? ' wfc--settled' : ''}`}
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
            <StatusBadge run={run} />
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
              {plan !== '' && (
                <span className={`wfc-plan${running && elapsed !== '' ? '' : ' wfc-plan--end'}`}>
                  {plan}
                </span>
              )}
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
          {state !== '' && (
            <p className={`wfc-state wfc-state--${tone}`}>
              {continued ? (
                <span className="orch-glyph wfc-state-arrow" aria-hidden="true">
                  <Icon name="arrow.down" size={11} />
                </span>
              ) : (
                <StatusGlyph status={run.status} size={11} />
              )}
              <span className="wfc-state-text">{state}</span>
              {!continued && run.pausedAt !== null && run.pausedAt.checkpointId !== '' && (
                <span className="wfc-state-meta">at {run.pausedAt.checkpointId}</span>
              )}
            </p>
          )}
          {phases.length === 0 ? (
            <p className="wfc-empty">{running ? 'Waiting for the first agent…' : 'No agents ran'}</p>
          ) : (
            <div className="wfc-tree">
              {phases.map((phase, i) => (
                <PhaseGroup
                  key={`${phase.title}-${i}`}
                  phase={phase}
                  compact={settled}
                  over={over}
                />
              ))}
            </div>
          )}
          {run.logs.length > 0 && (
            <LogBlock logs={run.logs} dropped={run.droppedLogLines} compact={settled} />
          )}
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
function PhaseGroup({
  phase,
  compact,
  over
}: {
  phase: WorkflowPhase
  compact: boolean
  /** The run has ended, so a phase nobody reached never will: it says "not
   *  run" rather than "pending", which would promise work that is not coming. */
  over: boolean
}): JSX.Element {
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
          <span className="wfc-phasetitle">{phase.title === '' ? 'No phase' : phase.title}</span>
          {phase.dynamic && (
            <span className="wfc-phasetag" title="The workflow added this phase while it ran">
              added
            </span>
          )}
          {phase.detail !== '' && <span className="wfc-phasedetail">{phase.detail}</span>}
          {state === 'pending' ? (
            <span className="wfc-phasepending">{over ? 'not run' : 'pending'}</span>
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
function LogBlock({
  logs,
  dropped,
  compact
}: {
  logs: string[]
  dropped: number
  compact: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  // The CLI keeps the last 40 lines; saying how many went before keeps the
  // tail from passing for the whole log.
  const earlier =
    dropped > 0 ? (
      <span className="wfc-logline wfc-logline--dropped">
        … {dropped} earlier {dropped === 1 ? 'line' : 'lines'}
      </span>
    ) : null
  if (!compact && logs.length <= LOG_INLINE_MAX) {
    return (
      <div className="wfc-log">
        {earlier}
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
        Log ({logs.length + dropped})
        {!open && <span className="wfc-logpeek">{logs[logs.length - 1]}</span>}
      </button>
      {open && earlier}
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
  if (phase.counts.running > 0 || phase.counts.pending > 0) return 'running'
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
  for (const member of members) {
    if (member.status === 'running' || member.status === 'pending') keep.add(member)
  }
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

/** The status pill beside the name. A finished success needs none — the
 *  meter and the counts already say it — but every other state is spelled
 *  out, so none of them depends on colour alone. */
function StatusBadge({ run }: { run: WorkflowRun }): JSX.Element | null {
  if (run.continued) {
    return (
      <span className="wfc-badge wfc-badge--continued">
        <Icon name="arrow.down" size={9} />
        Continued below
      </span>
    )
  }
  switch (run.status) {
    case 'running':
      return (
        <span className="wfc-badge wfc-badge--running">
          <SpettroSpinner size={9} color="currentColor" />
          Running
        </span>
      )
    case 'paused':
      return (
        <span className="wfc-badge wfc-badge--paused">
          <Icon name="pause.circle.fill" size={9} />
          Paused
        </span>
      )
    case 'stopped':
      return (
        <span className="wfc-badge wfc-badge--stopped">
          <Icon name="stop.circle.fill" size={9} />
          Stopped
        </span>
      )
    case 'failed':
      return (
        <span className="wfc-badge wfc-badge--failed">
          <Icon name="xmark.circle.fill" size={9} />
          Failed
        </span>
      )
    case 'done':
      return null
  }
}

/**
 * The sentence for a run that is neither working nor finished, '' otherwise.
 * "Waiting" is the paused run's whole story — the checkpoint's question is
 * what it waits on, and Spettro (the orchestrating model) is who answers.
 */
function stateLine(run: WorkflowRun): string {
  if (run.continued) return 'Continued below — this run went on in a later turn'
  if (run.status === 'paused') {
    const message = run.pausedAt?.message ?? ''
    return message === '' ? 'Waiting for Spettro to continue it' : `Waiting — ${message}`
  }
  if (run.status === 'stopped') {
    return run.stoppedReason === '' ? 'Stopped' : `Stopped — ${run.stoppedReason}`
  }
  return ''
}

/** The folded card's one line beside its badge: the badge already names the
 *  state, so this is what it is about — the question a paused run asks, why
 *  a stopped one stopped, what a finished one concluded. */
function stateDetail(run: WorkflowRun): string {
  if (run.continued) return run.description
  if (run.status === 'paused') {
    const message = run.pausedAt?.message ?? ''
    return message === '' ? 'Waiting for Spettro to continue it' : message
  }
  if (run.status === 'stopped') return run.stoppedReason
  return summaryText(run)
}

/** "Large · ~30 agents · 500k token budget" — what the run was sized for, in
 *  plain words. '' when it reported neither. */
function planLabel(run: WorkflowRun): string {
  const parts: string[] = []
  const size = sizeLabel(run)
  if (size !== '') parts.push(size)
  if (run.budgetTokens > 0) parts.push(`${compactTokens(run.budgetTokens)} token budget`)
  return parts.join(' · ')
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

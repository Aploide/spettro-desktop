// The live panel — what is happening RIGHT NOW, docked beside the transcript.
//
// The transcript card is the record of a run: every phase, every member, every
// tool it called, kept forever and scrolled past. That is the wrong instrument
// for the twenty seconds while a fan-out is in flight, because the thing you
// want then is a single question answered continuously — who is still working,
// and on what — and in the card that answer is buried under the members that
// have already finished and scrolls away the moment the model says anything.
//
// So this is the desktop analogue of the TUI's ctrl+b side panel
// (internal/tui/view_sidepanel.go): a narrow, pinned column that shows only
// the live edge of each run. Phases stay listed — including the ones nothing
// has reached, because knowing what is still coming is half the value of a
// declared plan — but only *running* members get a row, and each of those rows
// shows its most recent tool call rather than the task it was handed at
// launch. In a twenty-member fan-out the launch tasks are near-identical and
// tell you nothing about progress; the live detail is the entire reason to
// watch this column instead of the card.
//
// Two behaviours here are not in the TUI and exist because a mouse-driven
// panel is glanced at rather than watched:
//
//   1. A finished run does not disappear. `activeRuns()` drops it the instant
//      its status flips, which in a fast workflow means the section you were
//      reading vanishes mid-sentence. Instead the panel holds the last
//      snapshot for a beat, collapses it to one settled summary line, and only
//      then lets it go — so the eye always lands on an answer.
//   2. Nothing that moves here moves layout. This re-renders several times a
//      second during a big fan-out, so every animation is opacity/transform
//      only, rows are keyed by tool id so React updates text in place instead
//      of rebuilding them, and every string is clamped to one line: a detail
//      that wrapped would make the whole column shiver on each update.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import {
  runTitle,
  memberTint,
  type MemberCall,
  type OrchCounts,
  type RunStatus,
  type WorkflowRun
} from './transcript/orchestration'
import {
  CountsLabel,
  ProgressMeter,
  StatusGlyph,
  truncateInstance
} from './transcript/OrchestrationBits'
import { displayDetail } from './transcript/toolPresentation'
import { Icon } from './transcript/ToolCallView'
import './orchestrationPanel.css'

// How long a finished run keeps its full section before collapsing, and how
// long the collapsed line survives after that. Long enough to be read on a
// glance back at the screen, short enough that the panel never becomes a log.
const HOLD_MS = 1600
const EXIT_MS = 7000

/** Running members listed under one phase before the panel says "… N more
 *  running". A phase that fans out to thirty agents would otherwise push
 *  every other phase off the column. */
const MAX_PHASE_MEMBERS = 4

/** Instance names are clipped hard: this column is narrow and the detail beside
 *  the name is the part that changes. `truncateInstance` keeps the "#N". */
const INSTANCE_MAX = 14

// ---------------------------------------------------------------------------
// Derived shapes — everything the JSX below needs, computed once per update
// ---------------------------------------------------------------------------

interface PanelMember {
  key: string
  instance: string
  tint: string
  /** The member's latest tool call, or the task it was launched with. */
  activity: string
}

type GroupState = 'pending' | 'active' | 'done' | 'failed'

interface PanelGroup {
  key: string
  /** '' renders headerless — the agents dispatched outside any phase. */
  title: string
  state: GroupState
  counts: OrchCounts
  members: PanelMember[]
  hidden: number
}

interface PanelSection {
  key: string
  title: string
  meta: string
  status: RunStatus
  counts: OrchCounts
  groups: PanelGroup[]
  /** True once the run has finished: one line, no tree. */
  collapsed: boolean
  /** The settled line's right-hand text. */
  note: string
  /** Sort position, fixed at first sight so a settling run does not jump. */
  seq: number
}

/** A run's identity across updates: the lifecycle tool call it was born from. */
function runKey(run: WorkflowRun): string {
  return run.tool.id
}

/**
 * What the member is doing now. `displayDetail` re-applies the "[code#3] "
 * prefix it parsed out of the title, but this row already says whose work it
 * is and the column has no width to spend saying it twice.
 */
function liveActivity(member: MemberCall): string {
  const last = member.children[member.children.length - 1]
  if (last) {
    const prefix = `[${member.instance}] `
    const detail = displayDetail(last)
    const stripped = (detail.startsWith(prefix) ? detail.slice(prefix.length) : detail).trim()
    if (stripped !== '') return stripped
  }
  return member.task.split('\n').join(' ')
}

function toPanelMembers(
  members: MemberCall[],
  limit: number
): { rows: PanelMember[]; hidden: number } {
  const running = members.filter((member) => member.status === 'running')
  const rows = running.slice(0, limit).map((member) => ({
    key: member.tool.id,
    instance: member.instance,
    tint: memberTint(member.specId),
    activity: liveActivity(member)
  }))
  return { rows, hidden: running.length - rows.length }
}

/** Port of the phase glyph rule in workflowPhaseGroup(): a phase with nothing
 *  running and nothing finished has not been reached yet and stays dimmed. */
function groupState(counts: OrchCounts): GroupState {
  if (counts.running > 0) return 'active'
  if (counts.failed > 0) return 'failed'
  if (counts.done > 0) return 'done'
  return 'pending'
}

function buildGroups(run: WorkflowRun): PanelGroup[] {
  return run.phases.map((phase, i) => {
    const { rows, hidden } = toPanelMembers(phase.members, MAX_PHASE_MEMBERS)
    return {
      key: phase.title === '' ? `phase-${i}` : `phase-${phase.title}`,
      title: phase.title,
      state: groupState(phase.counts),
      counts: phase.counts,
      members: rows,
      hidden
    }
  })
}

/** The status a run that merely *vanished* from the live list gets: the panel
 *  never saw the final update, so it reports what the last snapshot knew
 *  rather than claiming a success it cannot vouch for. */
function settledStatus(run: WorkflowRun): RunStatus {
  if (run.status !== 'running') return run.status
  return run.counts.failed > 0 ? 'failed' : 'done'
}

/** The settled line's words. A run that left the live list because it is
 *  waiting at a checkpoint, or was stopped, says that — "done" would be a
 *  claim about a run that has not finished. */
function settledNote(run: WorkflowRun): string {
  if (run.status === 'paused') {
    const message = run.pausedAt?.message ?? ''
    return message === '' ? 'Waiting for Spettro' : `Waiting — ${message}`
  }
  if (run.status === 'stopped') {
    return run.stoppedReason === '' ? 'Stopped' : `Stopped — ${run.stoppedReason}`
  }
  if (run.summary !== '') return run.summary
  const { total, done, failed } = run.counts
  if (total === 0) return 'finished'
  return failed > 0 ? `${done} done · ${failed} failed` : `${done} done`
}

function fraction(counts: OrchCounts): string {
  if (counts.total === 0) return ''
  return `${counts.done + counts.failed}/${counts.total}`
}

function buildSection(run: WorkflowRun, collapsed: boolean, seq: number): PanelSection {
  const status = collapsed ? settledStatus(run) : run.status
  return {
    key: runKey(run),
    title: runTitle(run),
    meta: run.description,
    status,
    counts: run.counts,
    groups: collapsed ? [] : buildGroups(run),
    collapsed,
    note: collapsed ? settledNote(run) : '',
    seq
  }
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

interface Settled {
  key: string
  run: WorkflowRun
  collapsed: boolean
}

export default function OrchestrationPanel({
  runs,
  current,
  onClose
}: {
  runs: WorkflowRun[]
  /** Every run in the transcript as it stands now, by card id. A run leaves
   *  `runs` the moment it stops running — paused at a checkpoint, stopped,
   *  finished — and its settled line must say which, from the state it left
   *  in rather than the last running snapshot (which can only guess "done"). */
  current?: ReadonlyMap<string, WorkflowRun>
  onClose: () => void
}): JSX.Element | null {
  const [settled, setSettled] = useState<Settled[]>([])
  // Position is assigned once per run and never recomputed, so a run that
  // settles keeps the slot the eye already found it in.
  const order = useRef(new Map<string, number>())
  const seq = useRef(0)
  const seen = useRef(new Map<string, WorkflowRun>())
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  // Read through a ref: it changes with every transcript update, exactly as
  // `runs` does, and must not become a second trigger for the effect below.
  const currentRef = useRef(current)
  currentRef.current = current

  // Hold, collapse, release. The dependency is the array identity, which the
  // parent rebuilds on every update — the body only acts on differences, so
  // running it that often costs a map walk and nothing else.
  useEffect(() => {
    const live = new Map<string, WorkflowRun>()
    const latest = new Map<string, WorkflowRun>()
    for (const run of runs) {
      const key = runKey(run)
      latest.set(key, run)
      if (run.status === 'running') live.set(key, run)
    }

    const gone: Settled[] = []
    for (const [key, run] of seen.current) {
      if (live.has(key)) continue
      // Prefer the run as it is now — it carries the run's own summary line,
      // or the pause or stop that took it off the live list.
      gone.push({
        key,
        run: latest.get(key) ?? currentRef.current?.get(key) ?? run,
        collapsed: false
      })
    }
    seen.current = live

    setSettled((prev) => {
      const kept = prev.filter(
        (entry) => !live.has(entry.key) && !gone.some((g) => g.key === entry.key)
      )
      if (gone.length === 0 && kept.length === prev.length) return prev
      return [...kept, ...gone]
    })

    for (const entry of gone) {
      timers.current.push(
        setTimeout(() => {
          setSettled((prev) =>
            prev.some((e) => e.key === entry.key && !e.collapsed)
              ? prev.map((e) => (e.key === entry.key ? { ...e, collapsed: true } : e))
              : prev
          )
        }, HOLD_MS),
        setTimeout(() => {
          setSettled((prev) =>
            prev.some((e) => e.key === entry.key) ? prev.filter((e) => e.key !== entry.key) : prev
          )
        }, EXIT_MS)
      )
    }
  }, [runs])

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending) clearTimeout(timer)
      pending.length = 0
    }
  }, [])

  const sections = useMemo(() => {
    const position = (key: string): number => {
      const known = order.current.get(key)
      if (known !== undefined) return known
      const next = seq.current++
      order.current.set(key, next)
      return next
    }
    const out: PanelSection[] = []
    for (const run of runs) {
      const key = runKey(run)
      // A finished run arriving in `runs` is rendered settled straight away;
      // the hold only applies to the ones that vanish under us.
      out.push(buildSection(run, run.status !== 'running', position(key)))
    }
    const liveKeys = new Set(out.map((section) => section.key))
    for (const entry of settled) {
      if (liveKeys.has(entry.key)) continue
      out.push(buildSection(entry.run, entry.collapsed, position(entry.key)))
    }
    out.sort((a, b) => a.seq - b.seq)
    return out
  }, [runs, settled])

  if (sections.length === 0) return null

  const liveCount = sections.filter((section) => !section.collapsed).length

  return (
    <div className="orp" aria-label="Live orchestration">
      <header className="orp-head">
        <span className="orp-head-dot" aria-hidden="true" />
        <span className="orp-head-title">Live</span>
        <span className="orp-head-count">{liveCount > 0 ? liveCount : sections.length}</span>
        <span className="orp-head-spacer" />
        <button className="orp-close" type="button" aria-label="Hide live panel" onClick={onClose}>
          <Icon name="sidebar.right" size={14} />
        </button>
      </header>
      <div className="orp-body">
        {sections.map((section) =>
          section.collapsed ? (
            <SettledLine key={section.key} section={section} />
          ) : (
            <RunSection key={section.key} section={section} />
          )
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function RunSection({ section }: { section: PanelSection }): JSX.Element {
  const frac = fraction(section.counts)
  return (
    <section className="orp-run">
      <div className="orp-run-head">
        <StatusGlyph status={section.status} size={11} />
        <span className="orp-run-name">{section.title}</span>
        {frac !== '' && <span className="orp-run-frac">{frac}</span>}
      </div>
      {section.meta !== '' && <div className="orp-run-meta">{section.meta}</div>}
      <div className="orp-run-meter">
        <ProgressMeter counts={section.counts} />
      </div>
      <div className="orp-run-counts">
        <CountsLabel counts={section.counts} />
      </div>
      {section.groups.length === 0 ? (
        <div className="orp-empty">waiting for the first agent</div>
      ) : (
        <div className="orp-groups">
          {section.groups.map((group) => (
            <PhaseGroup key={group.key} group={group} />
          ))}
        </div>
      )}
    </section>
  )
}

function PhaseGroup({ group }: { group: PanelGroup }): JSX.Element {
  const frac = fraction(group.counts)
  const flat = group.title === '' ? ' orp-phase--flat' : ''
  return (
    <div className={`orp-phase orp-phase--${group.state}${flat}`}>
      {group.title !== '' && (
        <div className="orp-phase-head">
          <span className="orp-phase-dot" aria-hidden="true" />
          <span className="orp-phase-title">{group.title}</span>
          <span className="orp-phase-frac">{group.state === 'pending' ? 'pending' : frac}</span>
        </div>
      )}
      {/* Drawn even for a phase nothing has reached: an empty track holds the
          row's height, so a phase starting mid-run tints in place instead of
          pushing everything under it down. A headerless group (agents outside
          any phase) has no meter of its own: it would sit directly under the
          run's, and two bars stacked read as one thing said twice. */}
      {group.title !== '' && (
        <div className="orp-phase-meter">
          <ProgressMeter counts={group.counts} />
        </div>
      )}
      {group.members.length > 0 && (
        <div className="orp-members">
          {group.members.map((member) => (
            <MemberLine key={member.key} member={member} />
          ))}
          {group.hidden > 0 && <div className="orp-more">… {group.hidden} more running</div>}
        </div>
      )}
    </div>
  )
}

/** One running sub-agent: its name in the spec's tint, and the tool it is in
 *  the middle of. The dot pulses instead of spinning — a column of eight
 *  spinners reads as noise, and opacity is the one property that can animate
 *  this often without touching layout. */
function MemberLine({ member }: { member: PanelMember }): JSX.Element {
  return (
    <div className="orp-member" title={`${member.instance}: ${member.activity}`}>
      <span className="orp-member-dot" style={{ background: member.tint }} aria-hidden="true" />
      <span className="orp-member-name" style={{ color: member.tint }}>
        {truncateInstance(member.instance, INSTANCE_MAX)}
      </span>
      <span className="orp-member-live">{member.activity}</span>
    </div>
  )
}

function SettledLine({ section }: { section: PanelSection }): JSX.Element {
  return (
    <section className="orp-settled" title={`${section.title} — ${section.note}`}>
      <StatusGlyph status={section.status} size={11} />
      <span className="orp-settled-name">{section.title}</span>
      <span className="orp-settled-note">{section.note}</span>
    </section>
  )
}

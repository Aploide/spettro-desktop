// The Ultra fan-out, in the transcript, as one object instead of twenty rows.
//
// This is the web port of the block internal/tui/view_swarm.go argues for, and
// it exists to fix the same two failures. First, a swarm member used to look
// exactly like an ordinary sub-agent, so a fan-out of twenty dissolved into a
// wall of identical purple cards and the conversation around it disappeared.
// Second, only the running members were ever drawn, so the list *shrank* as the
// swarm made progress — the moment it mattered most, the card said least, and a
// finished swarm left no trace of what it had actually done.
//
// So: one header owns the whole run (meter, counts, isolation), and every
// member stays on screen with its outcome from launch to finish. A member shows
// what it is doing RIGHT NOW rather than the item it was handed, because in a
// fan-out the items are near-identical by construction and tell you nothing
// about progress — MemberRow implements that rule for every surface.
//
// That second failure came back in a different costume: the card opened
// collapsed once the run was over, so a settled swarm was one line and its one
// failure was a red sliver in the meter. A finished swarm showing nothing is
// the exact bug view_swarm.go was written to prevent, so the settled card is
// not collapsed — it is *filtered*. Members that failed keep their cell and
// gain the reason they failed; the successes, which in a fan-out are twenty
// near-identical lines saying the same thing, fold into one "N done" that
// expands. What broke is on screen; what worked is one click away.
//
// The layout departs from the workflow card on purpose. A workflow is deep: a
// handful of agents inside an ordered spine of phases, which wants a tree. A
// swarm is flat and wide: N peers, no order, no dependencies. Rendering peers
// as a tall list makes the reader scroll to learn a single fact (how far
// along?), so the members are a responsive grid — twenty of them read as one
// shape you take in at a glance rather than a scroll.
//
// One thing here is not in the transcript and has to be reasoned about: Ultra
// ramps its launches (5 at once, then one every 700ms), so a 20-item swarm
// spends its first fifteen seconds with most members not yet born. They are
// drawn as ghost cells and counted in the meter's denominator; without that,
// an early swarm shows two thirds of a full bar and then appears to go
// backwards as the rest of the roster arrives.

import { useState } from 'react'
import type { JSX } from 'react'
import { memberTint, type MemberCall, type OrchCounts, type SwarmRun } from './orchestration'
import { CountsLabel, MemberRow, ProgressMeter, StatusGlyph } from './OrchestrationBits'
import { Icon, ToolRow } from './ToolCallView'
import './swarmCard.css'

export function SwarmCard({ run }: { run: SwarmRun }): JSX.Element {
  // Open in both states: a settled swarm compacts rather than vanishes. The
  // reader can still close it, and it stays closed.
  const [collapsed, setCollapsed] = useState(false)
  const [showDone, setShowDone] = useState(false)
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set<string>())

  const settled = run.status !== 'running'
  const members = orderMembers(run.members)
  const quiet = settled ? members.filter((member) => member.status === 'done').length : 0
  const visible = quiet > 0 && !showDone
    ? members.filter((member) => member.status !== 'done')
    : members
  // `run.pending` and `run.counts.total` both already account for the items
  // the ramp has not reached — the derivation layer counts progress against
  // the swarm that was *asked for*. Re-adding them here is what made the
  // card's meter run over 13 for a 10-item swarm while the live panel, reading
  // the same run, correctly said 10.
  const pending = run.pending
  const counts = run.counts
  const empty = run.members.length === 0 && pending.length === 0
  const note = empty ? run.tool.output.trim() : ''

  const toggle = (id: string): void => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  return (
    <section className={`swc swc--${run.status}${settled ? ' swc--settled' : ''}`}>
      <button
        className="swc-head"
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        <span className="swc-bolt">
          <Icon name="bolt" size={13} />
        </span>
        <span className="swc-title">
          Ultra swarm
          {run.subagentType !== '' && <span className="swc-type"> · {run.subagentType}</span>}
        </span>
        {run.isolation === 'worktree' && <WorktreePill />}
        <span className="swc-spacer" />
        <ProgressMeter counts={counts} />
        <CountsLabel counts={counts} />
        {pending.length > 0 && <span className="swc-queued">{pending.length} queued</span>}
        <StatusGlyph status={run.status} />
        <span className={`tr-chevron${collapsed ? '' : ' tr-chevron--open'}`}>
          <Icon name="chevron.right" size={8} />
        </span>
      </button>

      {!collapsed && run.description !== '' && <p className="swc-desc">{run.description}</p>}

      {!collapsed && note !== '' && <p className="swc-note">{note}</p>}

      {!collapsed && (visible.length > 0 || pending.length > 0) && (
        <div className="swc-grid">
          {visible.map((member) => {
            const expanded = open.has(member.tool.id)
            const reason = failureReason(member)
            return (
              <div
                key={member.tool.id}
                className={`swc-cell${expanded ? ' swc-cell--open' : ''}${
                  reason === '' ? '' : ' swc-cell--failed'
                }`}
              >
                <MemberRow
                  member={member}
                  tint={memberTint(member.specId)}
                  expanded={expanded}
                  onToggle={() => toggle(member.tool.id)}
                >
                  {member.children.length > 0 && (
                    <div className="orch-nested">
                      {member.children.map((child) => (
                        <ToolRow key={child.id} tool={child} />
                      ))}
                    </div>
                  )}
                </MemberRow>
                {reason !== '' && <p className="swc-reason">{reason}</p>}
              </div>
            )
          })}
          {pending.map((item, i) => (
            <GhostCell key={`ghost-${i}`} item={item} />
          ))}
        </div>
      )}

      {!collapsed && quiet > 0 && (
        <button
          className="swc-quiet"
          type="button"
          aria-expanded={showDone}
          onClick={() => setShowDone((value) => !value)}
        >
          <span className={`tr-chevron${showDone ? ' tr-chevron--open' : ''}`}>
            <Icon name="chevron.right" size={8} />
          </span>
          {showDone ? 'hide the members that succeeded' : `${quiet} done`}
        </button>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Header pieces
// ---------------------------------------------------------------------------

/** Isolation is invisible in the output but changes what the swarm may do to
 *  your checkout, so it gets a badge and a sentence rather than a mode word. */
function WorktreePill(): JSX.Element {
  return (
    <span
      className="orch-pill swc-pill-worktree"
      title="Each member works in its own git worktree on its own branch, under .spettro/worktrees/. Every branch is merged back into the main checkout and deleted when the swarm finishes; a branch that conflicts is kept for you to resolve."
    >
      <Icon name="arrow.triangle.branch" size={9} />
      worktree isolation
    </span>
  )
}

// ---------------------------------------------------------------------------
// Members not yet launched
// ---------------------------------------------------------------------------

/**
 * An item Ultra has accepted but not yet dispatched. It is drawn at the same
 * rhythm as a real member — glyph, label, item — so the grid keeps its shape
 * as the ramp fills it in, and nothing below the card moves when a ghost turns
 * into an agent.
 */
function GhostCell({ item }: { item: string }): JSX.Element {
  return (
    <div className="swc-cell swc-ghost" title={item}>
      <span className="swc-ghost-dot" aria-hidden="true" />
      <span className="swc-ghost-label">queued</span>
      <span className="swc-ghost-item">{item.split('\n').join(' ')}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

/**
 * Why a member failed, in one string — the twin of the same function in
 * WorkflowCard.tsx, duplicated rather than lifted because it is ten lines of
 * card presentation and these two cards are the only surfaces that print a
 * reason on the row. The agent's reported summary is the best answer and is
 * already parsed; when the output was not the report shape we take the
 * error-ish field out of whatever JSON it was, and failing that the raw text —
 * a provider's plain "429 after 3 attempts" never arrives as a report.
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

/**
 * Running members first, dispatch order kept inside each group — the grid's
 * form of prioritiseRunning() in view_swarm.go. What is still moving is the
 * only part of a swarm you can act on; the finished half is a record. Once
 * nothing is moving, failures lead for the same reason: they are the rows the
 * reader came back for. Array.sort is stable, so launch order survives inside
 * every group for free.
 */
function orderMembers(members: MemberCall[]): MemberCall[] {
  return [...members].sort((a, b) => rank(a) - rank(b))
}

function rank(member: MemberCall): number {
  if (member.status === 'running') return 0
  return member.status === 'failed' ? 1 : 2
}

/**
 * The items no member has taken yet. Members are dispatched in item order, so
 * the tail of the list past the members that exist is exactly what the ramp
 * still owes. A swarm whose args never carried `items` simply has none.
 */
function pendingItems(run: SwarmRun): string[] {
  if (run.items.length <= run.members.length) return []
  return run.items.slice(run.members.length)
}

/** Counts the un-launched members into the meter's denominator, so progress is
 *  measured against the swarm that was asked for and never runs backwards. */
function withPending(counts: OrchCounts, pending: number): OrchCounts {
  if (pending <= 0) return counts
  return { ...counts, total: counts.total + pending }
}

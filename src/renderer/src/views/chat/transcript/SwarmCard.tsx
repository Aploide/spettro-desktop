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
// The layout departs from the workflow card on purpose. A workflow is deep: a
// handful of agents inside an ordered spine of phases, which wants a tree. A
// swarm is flat and wide: N peers, no order, no dependencies. Rendering peers
// as a tall list makes the reader scroll to learn a single fact (how far
// along?), so the members are a responsive grid — twenty of them read as one
// shape you take in at a glance rather than a scroll.
//
// Two things here are not in the transcript and have to be reasoned about:
//   * Ultra ramps its launches (5 at once, then one every 700ms), so a 20-item
//     swarm spends its first fifteen seconds with most members not yet born.
//     They are drawn as ghost cells and counted in the meter's denominator;
//     without that, an early swarm shows two thirds of a full bar and then
//     appears to go backwards as the rest of the roster arrives.
//   * The card never collapses itself out from under the reader. Whether it
//     opens collapsed is decided once, at mount, from the run's status: a run
//     restored from disk is history and stays out of the way, while a run you
//     watched finish keeps the shape it had a second ago.

import { useState } from 'react'
import type { JSX } from 'react'
import { memberTint, type MemberCall, type OrchCounts, type SwarmRun } from './orchestration'
import { CountsLabel, MemberRow, ProgressMeter, StatusGlyph } from './OrchestrationBits'
import { Icon, ToolRow } from './ToolCallView'
import './swarmCard.css'

export function SwarmCard({ run }: { run: SwarmRun }): JSX.Element {
  // Decided once, deliberately: see the note at the top of the file.
  const [collapsed, setCollapsed] = useState(() => run.status !== 'running')
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set<string>())

  const members = orderMembers(run.members)
  const pending = pendingItems(run)
  const counts = withPending(run.counts, pending.length)
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
    <section className={`swc swc--${run.status}`}>
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

      {!collapsed && (members.length > 0 || pending.length > 0) && (
        <div className="swc-grid">
          {members.map((member) => {
            const expanded = open.has(member.tool.id)
            return (
              <div key={member.tool.id} className={`swc-cell${expanded ? ' swc-cell--open' : ''}`}>
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
              </div>
            )
          })}
          {pending.map((item, i) => (
            <GhostCell key={`ghost-${i}`} item={item} />
          ))}
        </div>
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
 * Running members first, dispatch order kept inside each group — the grid's
 * form of prioritiseRunning() in view_swarm.go. What is still moving is the
 * only part of a swarm you can act on; the finished half is a record.
 * Array.sort is stable, so the second group stays in launch order for free.
 */
function orderMembers(members: MemberCall[]): MemberCall[] {
  return [...members].sort((a, b) => rank(a) - rank(b))
}

function rank(member: MemberCall): number {
  return member.status === 'running' ? 0 : 1
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

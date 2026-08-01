// Port of PlanBadge.swift: bold uppercase tier label in the tier color, with
// the max plan rendered as the TUI's travelling six-color rainbow (the CSS
// animation in shell.css scrolls a doubled palette so all six colors stay
// visible at every instant, in phase across every badge on screen).

import type { Plan } from '@shared/model'

/** Tier → CSS class, mirroring PlanBadge.swift's `tierColor` switch.
 *  SubscriptionPlan is an open enum, so an unrecognized tier takes the same
 *  neutral grey as free and renders its own name rather than disappearing. */
function tierClass(tier: string): string {
  switch (tier) {
    case 'lite':
      return 'plan-badge--lite'
    case 'plus':
      return 'plan-badge--plus'
    case 'pro':
      return 'plan-badge--pro'
    case 'unknown':
      return 'plan-badge--none'
    default:
      return 'plan-badge--free'
  }
}

export default function PlanBadge({ plan, size = 11 }: { plan: Plan; size?: number }): JSX.Element {
  const tier = (plan || 'unknown').toLowerCase()
  if (tier === 'max') {
    return (
      <span className="plan-badge plan-badge--max" style={{ fontSize: size }} aria-label="MAX">
        MAX
      </span>
    )
  }
  const cls = tierClass(tier)
  const label = tier === 'unknown' ? 'NO PLAN' : tier.toUpperCase()
  return (
    <span className={`plan-badge ${cls}`} style={{ fontSize: size }}>
      {label}
    </span>
  )
}

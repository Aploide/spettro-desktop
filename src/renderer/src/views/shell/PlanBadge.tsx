// Port of PlanBadge.swift: bold uppercase tier label in the tier color, with
// the max plan rendered as the TUI's travelling six-color rainbow (the CSS
// animation in shell.css scrolls a doubled palette so all six colors stay
// visible at every instant, in phase across every badge on screen).

import type { Plan } from '@shared/model'

export default function PlanBadge({ plan, size = 11 }: { plan: Plan; size?: number }): JSX.Element {
  if (plan === 'max') {
    return (
      <span className="plan-badge plan-badge--max" style={{ fontSize: size }} aria-label="MAX">
        MAX
      </span>
    )
  }
  const cls = plan === 'pro' ? 'plan-badge--pro' : plan === 'free' ? 'plan-badge--free' : 'plan-badge--none'
  const label = plan === 'unknown' ? 'NO PLAN' : plan.toUpperCase()
  return (
    <span className={`plan-badge ${cls}`} style={{ fontSize: size }}>
      {label}
    </span>
  )
}

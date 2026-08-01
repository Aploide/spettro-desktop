// Inline SVG stand-ins for the SF Symbols the provider/account Swift views
// draw, plus the one small mapping helper they share. Everything renders in
// currentColor so the surrounding style tints it.

import type { AccountStatus } from '@shared/extensions'
import { effectivePlan } from '@shared/extensions'
import type { Plan } from '@shared/model'

interface IconProps {
  size?: number
}

/** The tier label PlanBadge should render. `Plan` covers the tiers the badge
 *  colors (free/pro/max); the CLI can report others (lite, plus, a bespoke
 *  tier name), and the badge falls back to a quiet uppercase label for those,
 *  which is what we want rather than losing the tier entirely. */
export function badgePlan(account: AccountStatus): Plan {
  const plan = effectivePlan(account)
  if (plan === '') return 'unknown'
  return plan as Plan
}

/** checkmark.seal.fill / checkmark.circle.fill */
export function CheckSealIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 .8a7.2 7.2 0 1 0 0 14.4A7.2 7.2 0 0 0 8 .8zm-.9 10.6L3.9 8.2l1.2-1.2 2 2 4-4 1.2 1.2z" />
    </svg>
  )
}

/** key */
export function KeyIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="5.2" cy="5.2" r="2.9" />
      <circle cx="5.2" cy="5.2" r="0.85" fill="currentColor" stroke="none" />
      <path d="M7.4 7.4 13.4 13.4M11.5 11.5l-1.5 1.5M13 10l-1.5 1.5" />
    </svg>
  )
}

/** person.crop.circle */
export function PersonIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.6" />
      <circle cx="8" cy="6.3" r="2.3" />
      <path d="M3.6 13.2a4.9 4.9 0 0 1 8.8 0" />
    </svg>
  )
}

/** desktopcomputer */
export function DesktopIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.6" y="2.2" width="12.8" height="9" rx="1.2" />
      <path d="M6 13.6h4M8 11.2v2.4" />
    </svg>
  )
}

/** exclamationmark.triangle.fill */
export function WarningTriangleIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 1.4 15.4 14a.8.8 0 0 1-.7 1.2H1.3A.8.8 0 0 1 .6 14zM7.2 5.6v4.2h1.6V5.6zm0 5.4v1.6h1.6V11z" />
    </svg>
  )
}

/** star / star.fill — the TUI's favorite marker (its F2 cycle). */
export function StarIcon({ size = 16, filled = false }: IconProps & { filled?: boolean }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 1.9l1.85 3.9 4.15.6-3 3 .7 4.3L8 11.7l-3.7 2 .7-4.3-3-3 4.15-.6z" />
    </svg>
  )
}

/** checkmark */
export function CheckIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.2 8.4 6.4 11.6 12.8 4.6" />
    </svg>
  )
}

/** magnifyingglass */
export function SearchIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="6.75" cy="6.75" r="4.25" />
      <path d="M10 10l3.5 3.5" />
    </svg>
  )
}

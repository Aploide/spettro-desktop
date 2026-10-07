// The provider/account views' icons — now part of the app-wide set in
// design/icons.tsx and re-exported here so existing imports keep working —
// plus the one small mapping helper those views share.

import type { AccountStatus } from '@shared/extensions'
import { effectivePlan } from '@shared/extensions'
import type { Plan } from '@shared/model'

/** The tier label PlanBadge should render. `Plan` covers the tiers the badge
 *  colors (free/pro/max); the CLI can report others (lite, plus, a bespoke
 *  tier name), and the badge falls back to a quiet uppercase label for those,
 *  which is what we want rather than losing the tier entirely. */
export function badgePlan(account: AccountStatus): Plan {
  const plan = effectivePlan(account)
  if (plan === '') return 'unknown'
  return plan as Plan
}

export {
  CheckIcon,
  CheckSealIcon,
  DesktopIcon,
  KeyIcon,
  PersonIcon,
  SearchIcon,
  StarIcon,
  WarningTriangleIcon
} from '@renderer/design/icons'

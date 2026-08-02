// Update state for the two things this app ships: the desktop app itself and
// the Spettro CLI it drives. Both are checked against their GitHub releases —
// the newest tag wins if it sorts higher than what is installed — and both are
// applied by the user pressing a button, never silently.
//
// The main process owns this state (see main/model/updater.ts); the renderer
// mirrors it inside AppStateDTO and renders the Updates pane from it.

export type UpdateComponent = 'app' | 'cli'

export type UpdateStatus =
  /** Nothing in flight. `available` still says whether one is waiting. */
  | 'idle'
  /** Asking GitHub for the latest release. */
  | 'checking'
  /** Fetching the installer (app only — the CLI's own script downloads). */
  | 'downloading'
  /** Running the installer / install script. */
  | 'installing'
  /** The installer was handed off and the app is about to quit (app only). */
  | 'relaunching'
  /** Installed; for the CLI the agent has already been reconnected. */
  | 'done'
  | 'failed'

export interface ComponentUpdate {
  /** Installed version, as far as we can tell (null before it is known). */
  current: string | null
  /** Newest published release, without the leading `v`. */
  latest: string | null
  /** latest sorts strictly higher than current. */
  available: boolean
  releaseUrl: string | null
  /** Release body, trimmed to something a pane can show. */
  releaseNotes: string | null
  status: UpdateStatus
  /** 0…1 while downloading, else null. */
  progress: number | null
  /** Last installer line, or the error text when status is 'failed'. */
  message: string | null
  /** ms since epoch of the last successful check. */
  checkedAt: number | null
}

export interface UpdateState {
  app: ComponentUpdate
  cli: ComponentUpdate
  /** False when this build can't replace itself — a dev run, or a Linux
   *  install that isn't an AppImage. The UI then offers the download page
   *  instead of an Update button. */
  canInstallApp: boolean
}

export const EMPTY_COMPONENT_UPDATE: ComponentUpdate = {
  current: null,
  latest: null,
  available: false,
  releaseUrl: null,
  releaseNotes: null,
  status: 'idle',
  progress: null,
  message: null,
  checkedAt: null
}

export const EMPTY_UPDATE_STATE: UpdateState = {
  app: EMPTY_COMPONENT_UPDATE,
  cli: EMPTY_COMPONENT_UPDATE,
  canInstallApp: false
}

/** True while a component is mid-update and its button must stay disabled. */
export function isUpdateBusy(update: ComponentUpdate): boolean {
  return (
    update.status === 'downloading' ||
    update.status === 'installing' ||
    update.status === 'relaunching'
  )
}

/** Pulls a semantic version out of whatever a tag or `--version` prints —
 *  `v2.6.8`, `spettro version 2.6.8 (abc123)`, `2.7.0-beta.1`. */
export function extractVersion(raw: string | null | undefined): string | null {
  if (!raw) return null
  const match = /(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(raw)
  return match ? match[0] : null
}

interface Parsed {
  numbers: number[]
  prerelease: string[]
}

function parse(version: string): Parsed | null {
  const found = extractVersion(version)
  if (!found) return null
  const [core, pre] = found.split('-', 2)
  const numbers = core.split('.').map((part) => Number.parseInt(part, 10))
  if (numbers.some((n) => Number.isNaN(n))) return null
  while (numbers.length < 3) numbers.push(0)
  return { numbers, prerelease: pre ? pre.split('.') : [] }
}

/** Semver-ish ordering: -1 / 0 / 1, with a prerelease sorting below the
 *  release it leads to (2.7.0-beta.1 < 2.7.0). Unparseable input compares
 *  equal, so a version we can't read never claims an update exists. */
export function compareVersions(a: string | null, b: string | null): number {
  const left = a ? parse(a) : null
  const right = b ? parse(b) : null
  if (!left || !right) return 0

  const width = Math.max(left.numbers.length, right.numbers.length)
  for (let i = 0; i < width; i++) {
    const l = left.numbers[i] ?? 0
    const r = right.numbers[i] ?? 0
    if (l !== r) return l < r ? -1 : 1
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1

  const parts = Math.max(left.prerelease.length, right.prerelease.length)
  for (let i = 0; i < parts; i++) {
    const l = left.prerelease[i]
    const r = right.prerelease[i]
    if (l === r) continue
    if (l === undefined) return -1
    if (r === undefined) return 1
    const ln = Number.parseInt(l, 10)
    const rn = Number.parseInt(r, 10)
    const bothNumeric = !Number.isNaN(ln) && !Number.isNaN(rn)
    if (bothNumeric) return ln < rn ? -1 : 1
    return l < r ? -1 : 1
  }
  return 0
}

/** True when `latest` is a strictly higher version than `current`. */
export function isNewer(latest: string | null, current: string | null): boolean {
  return compareVersions(latest, current) > 0
}

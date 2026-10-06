// Small shared helpers for the shell views.

import type { AppStateDTO } from '@shared/model'

/** Last path component (URL.lastPathComponent equivalent, / and \ aware). */
export function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const parts = trimmed.split(/[/\\]/)
  return parts[parts.length - 1] || trimmed || path
}

/** Port of AppModel.defaultProjectURL: the selected chat's folder, else the
 *  persisted last project path, else the home directory the main process
 *  resolved for us. */
export function defaultProjectPath(app: AppStateDTO): string | undefined {
  const selected = app.selectedSessionId
    ? app.sessions.find((s) => s.id === app.selectedSessionId)
    : undefined
  return selected?.projectPath ?? app.lastProjectPath ?? app.defaultProjectPath ?? undefined
}

/** True on macOS, where shortcuts read ⌘ and the phone app exists. Read from
 *  the preload bridge (process.platform), which the harness stubs too. */
export function isMac(): boolean {
  return typeof window !== 'undefined' && window.spettro?.platform === 'darwin'
}

/** "Ctrl+N" / "⌘N" — the platform's spelling of a Ctrl/Cmd shortcut, for
 *  tooltips and the hints beside buttons. */
export function shortcutLabel(key: string, opts?: { shift?: boolean }): string {
  if (isMac()) return `${opts?.shift ? '⇧' : ''}⌘${key}`
  return `Ctrl+${opts?.shift ? 'Shift+' : ''}${key}`
}

/** "Name (Ctrl+N)" — a tooltip that teaches its own shortcut. */
export function withShortcut(label: string, key: string, opts?: { shift?: boolean }): string {
  return `${label} (${shortcutLabel(key, opts)})`
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const SHORT_DATE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const LONG_DATE = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric'
})

/** Compact age for a sidebar row: "now", "5m", "3h", "2d", then a date. */
export function relativeTime(timestamp: number, now: number = Date.now()): string {
  const age = Math.max(0, now - timestamp)
  if (age < MINUTE) return 'now'
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m`
  if (age < DAY) return `${Math.floor(age / HOUR)}h`
  if (age < 7 * DAY) return `${Math.floor(age / DAY)}d`
  const date = new Date(timestamp)
  return date.getFullYear() === new Date(now).getFullYear()
    ? SHORT_DATE.format(date)
    : LONG_DATE.format(date)
}

/** The folder a person would call "everything": $HOME or the filesystem
 *  root. A session there can read all of it, which deserves a warning. */
export function isBroadFolder(path: string, homePath: string): boolean {
  const norm = (p: string): string => p.replace(/[/\\]+$/, '') || '/'
  const p = norm(path)
  return p === '/' || /^[a-zA-Z]:$/.test(p) || (homePath !== '' && p === norm(homePath))
}

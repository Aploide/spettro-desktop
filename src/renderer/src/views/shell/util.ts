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

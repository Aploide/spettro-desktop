// The whole persistence story for chat sessions — the port of
// Spettro/Model/SessionStore.swift (docs/13). One JSON file holding an array
// of StoredSession snapshots. All policy (what and when to save) lives in
// AppModel; this store only loads and atomically saves.
//
//   macOS: ~/Library/Application Support/Spettro/sessions.json
//   here:  app.getPath('userData')/sessions.json
//
// Both operations are fail-silent: a corrupt file loads as [], an unwritable
// file makes save a no-op — persistence problems never crash the app.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { StoredSession } from '../../shared/model'

export class SessionStore {
  private readonly file: string

  constructor(userDataDir: string) {
    try {
      mkdirSync(userDataDir, { recursive: true })
    } catch {
      // best-effort, matching the macOS store's try? createDirectory
    }
    this.file = join(userDataDir, 'sessions.json')
  }

  load(): StoredSession[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      return Array.isArray(parsed) ? (parsed as StoredSession[]) : []
    } catch {
      return []
    }
  }

  /** Atomic write (tmp + rename), so quitting mid-save can't tear the file. */
  save(sessions: StoredSession[]): void {
    try {
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(sessions, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch {
      // The session keeps working in memory.
    }
  }
}

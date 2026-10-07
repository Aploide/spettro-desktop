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
//
// Saving is off the event loop. The file holds every chat (tens of MB for a
// long history) and Electron's main thread is also the one that presents the
// window, so a synchronous stringify + write freezes the whole app for as long
// as it takes. Each session hands over its JSON as a list of UTF-8 buffers
// (ChatSession.persistParts keeps one per transcript item, re-encoded only
// when that item changes), and they are gathered into the file with writev:
// nothing is re-encoded or joined on the main thread.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { open, rename } from 'fs/promises'
import { join } from 'path'
import type { StoredSession } from '../../shared/model'

/** One session's stored JSON, as consecutive UTF-8 pieces. */
export type SessionParts = Buffer[]

const OPEN = Buffer.from('[')
const COMMA = Buffer.from(',')
const CLOSE = Buffer.from(']')
/** writev takes at most IOV_MAX (1024 on Linux) buffers per call. */
const IOV_CHUNK = 1000

export class SessionStore {
  private readonly file: string
  /** A write is in flight; the next one waits for it (see saveParts). */
  private writing: Promise<void> | null = null
  /** The newest snapshot handed over while a write was in flight. Only the
   *  latest matters: each one is the whole file. */
  private queued: SessionParts[] | null = null
  /** Set by the synchronous final save: a background write still running
   *  must not rename an older snapshot over it. */
  private closed = false

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
      writeFileSync(tmp, JSON.stringify(sessions), 'utf8')
      renameSync(tmp, this.file)
    } catch {
      // The session keeps working in memory.
    }
  }

  /** Writes the sessions in the background (tmp + rename). One write at a
   *  time; a save handed over meanwhile replaces any other still waiting, so
   *  the file always ends at the newest state. Resolves once that state (or
   *  a newer one) is on disk, or the write has failed silently. */
  saveParts(sessions: SessionParts[]): Promise<void> {
    if (this.writing) {
      this.queued = sessions
      return this.writing.then(() => this.writing ?? undefined)
    }
    const run = async (): Promise<void> => {
      let next: SessionParts[] | null = sessions
      while (next) {
        await this.writeParts(next).catch(() => undefined)
        next = this.queued
        this.queued = null
      }
    }
    this.writing = run().finally(() => {
      this.writing = null
    })
    return this.writing
  }

  /** The same, synchronously — for quitting, when nothing may be left in
   *  flight. Supersedes any write still running. */
  savePartsSync(sessions: SessionParts[]): void {
    this.queued = null
    this.closed = true
    try {
      // Its own tmp file, so a background write finishing meanwhile can't
      // rename a half-written file over it.
      const tmp = `${this.file}.final.tmp`
      writeFileSync(tmp, Buffer.concat(gather(sessions)))
      renameSync(tmp, this.file)
    } catch {
      // The session keeps working in memory.
    }
  }

  private async writeParts(sessions: SessionParts[]): Promise<void> {
    const tmp = `${this.file}.tmp`
    const buffers = gather(sessions)
    const handle = await open(tmp, 'w')
    try {
      for (let i = 0; i < buffers.length; i += IOV_CHUNK) {
        const chunk = buffers.slice(i, i + IOV_CHUNK)
        const expected = chunk.reduce((n, b) => n + b.length, 0)
        const { bytesWritten } = await handle.writev(chunk)
        // A short write (rare on a regular file): writeFile carries on from
        // the current position and loops until everything is down.
        if (bytesWritten < expected) await handle.writeFile(Buffer.concat(chunk).subarray(bytesWritten))
      }
    } finally {
      await handle.close()
    }
    if (this.closed) return
    await rename(tmp, this.file)
  }
}

function gather(sessions: SessionParts[]): Buffer[] {
  const out: Buffer[] = [OPEN]
  sessions.forEach((parts, i) => {
    if (i > 0) out.push(COMMA)
    for (const part of parts) out.push(part)
  })
  out.push(CLOSE)
  return out
}

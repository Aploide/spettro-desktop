// Reads and writes the Spettro CLI's persistent memory files directly —
// the port of Platforms/macOS/Model/MemoryStore.swift (docs/15).
//
// user scope:    ~/.spettro/memory.md
// project scope: the first directory (walking UP from the project) that
//                already contains a `.spettro` directory gets
//                `<dir>/.spettro/memory.md`; otherwise the project root
//                itself (`<project>/.spettro/memory.md`, created on save).
//
// The CLI ingests memory at session start, so edits apply to the next
// session, not mid-conversation. Load returns '' on any failure; save is
// atomic (tmp + rename); clear removes only memory.md.

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

export type MemoryScope = 'user' | 'project'

export function memoryPath(scope: MemoryScope, projectPath: string): string {
  if (scope === 'user') {
    return join(homedir(), '.spettro', 'memory.md')
  }
  let dir = projectPath
  for (;;) {
    const candidate = join(dir, '.spettro')
    try {
      if (statSync(candidate).isDirectory()) {
        return join(candidate, 'memory.md')
      }
    } catch {
      // not there; keep walking up
    }
    const parent = dirname(dir)
    if (parent === dir) break // filesystem root
    dir = parent
  }
  return join(projectPath, '.spettro', 'memory.md')
}

/** The file's UTF-8 contents, or '' for any failure — a missing file is
 *  indistinguishable from "no memory yet". */
export function loadMemory(scope: MemoryScope, projectPath: string): string {
  try {
    return readFileSync(memoryPath(scope, projectPath), 'utf8')
  } catch {
    return ''
  }
}

/** Creates intermediate directories, then writes atomically. Throws on
 *  failure; the caller decides how to surface it. */
export function saveMemory(text: string, scope: MemoryScope, projectPath: string): void {
  const file = memoryPath(scope, projectPath)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/** Deletes memory.md (never the .spettro directory). Missing file is a no-op. */
export function clearMemory(scope: MemoryScope, projectPath: string): void {
  try {
    rmSync(memoryPath(scope, projectPath))
  } catch {
    // clearing an empty scope is a no-op
  }
}

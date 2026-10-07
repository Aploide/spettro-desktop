// The files a session's folder holds, for the composer's @-mention menu.
//
// In a git repository git already knows the answer, and knows it the way the
// user means it: tracked files plus untracked ones that aren't ignored
// (`ls-files -co --exclude-standard`), so build output and dependencies never
// crowd the list. Anywhere else the folder is walked instead, skipping
// node_modules and .git and stopping at WALK_CAP entries — a mention menu
// over a home folder must open, not index the disk.

import { execFile } from 'child_process'
import { readdir } from 'fs/promises'
import { join, relative, sep } from 'path'

/** Files listed by the walk before it stops. */
export const WALK_CAP = 5000
/** Files taken from git; past this the menu is searching a monorepo and the
 *  first slice is as good as any. */
const GIT_CAP = 50_000
const SKIP_DIRS = new Set(['node_modules', '.git'])

function gitFiles(root: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'],
      { timeout: 5000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null)
        const files = stdout.split('\0').filter((f) => f !== '')
        resolve(files.slice(0, GIT_CAP))
      }
    )
  })
}

/** Breadth-first, so a capped walk still covers the top of the tree rather
 *  than one deep corner of it. */
export async function walkFiles(root: string, cap = WALK_CAP): Promise<string[]> {
  const out: string[] = []
  const queue = [root]
  let seen = 0
  while (queue.length > 0 && seen < cap) {
    const dir = queue.shift() as string
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (seen >= cap) break
      seen += 1
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(full)
      } else if (entry.isFile()) {
        out.push(relative(root, full).split(sep).join('/'))
      }
    }
  }
  return out
}

/** Project-relative paths with forward slashes; empty when the folder can't
 *  be read. */
export async function listProjectFiles(projectPath: string): Promise<string[]> {
  if (!projectPath) return []
  return (await gitFiles(projectPath)) ?? (await walkFiles(projectPath))
}

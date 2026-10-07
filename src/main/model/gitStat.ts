// Port of GitStatModel's working-tree polling (ChatHeaderView.swift): branch
// name plus per-file added/removed counts for uncommitted changes, including
// untracked files counted as pure additions. The renderer polls this on a
// timer; each call is a fresh snapshot.

import { execFile } from 'child_process'
import { readFile, stat } from 'fs/promises'
import { join } from 'path'
import type { GitStat } from '../../shared/model'

/** Untracked files larger than this are listed without a line count, like
 *  an unreadable one: the chip is polled every few seconds, and reading a
 *  stray dump or build artefact in full each time is not worth a number. */
const MAX_COUNTED_BYTES = 2 * 1024 * 1024

/** Line counts of untracked files, kept while the file's size and mtime
 *  stay the same: most polls find nothing changed. */
const lineCounts = new Map<string, { size: number; mtimeMs: number; lines: number }>()
const MAX_REMEMBERED = 5000

async function untrackedLines(path: string): Promise<number> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_COUNTED_BYTES) return 0
    const known = lineCounts.get(path)
    if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return known.lines
    // Counted as bytes: a newline is never part of a multi-byte character,
    // so this is the decoded text's split('\n').length.
    const bytes = await readFile(path)
    let lines = 1
    for (let i = bytes.indexOf(0x0a); i !== -1; i = bytes.indexOf(0x0a, i + 1)) lines++
    if (lineCounts.size >= MAX_REMEMBERED) lineCounts.clear()
    lineCounts.set(path, { size: info.size, mtimeMs: info.mtimeMs, lines })
    return lines
  } catch {
    // unreadable — keep 0, still list the file
    return 0
  }
}

function git(root: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, ...args],
      { timeout: 4000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout)
    )
  })
}

export async function gitStat(projectPath: string): Promise<GitStat> {
  const branch =
    (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() ?? ''
  const files: GitStat['files'] = []

  const numstat = await git(projectPath, ['diff', 'HEAD', '--numstat'])
  if (numstat) {
    for (const line of numstat.split('\n')) {
      const cols = line.split('\t')
      if (cols.length < 3) continue
      // Binary files report "-": count them as a changed file with no stats.
      files.push({
        path: cols.slice(2).join('\t'),
        added: parseInt(cols[0], 10) || 0,
        removed: parseInt(cols[1], 10) || 0
      })
    }
  }

  const untracked = await git(projectPath, ['ls-files', '--others', '--exclude-standard'])
  if (untracked) {
    for (const line of untracked.split('\n')) {
      if (!line) continue
      files.push({ path: line, added: await untrackedLines(join(projectPath, line)), removed: 0 })
    }
  }

  return { branch, files }
}

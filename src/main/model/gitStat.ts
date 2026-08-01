// Port of GitStatModel's working-tree polling (ChatHeaderView.swift): branch
// name plus per-file added/removed counts for uncommitted changes, including
// untracked files counted as pure additions. The renderer polls this on a
// timer; each call is a fresh snapshot.

import { execFile } from 'child_process'
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { GitStat } from '../../shared/model'

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
      let lineCount = 0
      try {
        lineCount = (await readFile(join(projectPath, line), 'utf8')).split('\n').length
      } catch {
        // unreadable/binary — keep 0, still list the file
      }
      files.push({ path: line, added: lineCount, removed: 0 })
    }
  }

  return { branch, files }
}

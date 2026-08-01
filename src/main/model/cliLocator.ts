// Finds the `spettro` CLI on disk — the Linux/Windows port of
// Platforms/macOS/Model/CLILocator.swift.
//
// Search order: explicit override (validated executable) → ~/.local/bin,
// /usr/local/bin, /usr/bin → every directory on PATH (plus spettro.exe and
// %LOCALAPPDATA%\Programs\spettro on Windows) → dev-checkout fallback
// (a `spettro/bin/spettro` or `spettro/spettro` build in a parent directory
// of the app, e.g. ../spettro when running from the desktop repo).

import { spawnSync } from 'child_process'
import { accessSync, constants, statSync } from 'fs'
import { homedir } from 'os'
import { delimiter, dirname, join } from 'path'

export interface LocatedCLI {
  path: string
  version: string | null
  /** true when resolved from a dev checkout fallback */
  isDev: boolean
}

const WIN = process.platform === 'win32'

function isExecutable(path: string): boolean {
  try {
    const st = statSync(path)
    if (!st.isFile()) return false
    if (WIN) return true
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Dev-checkout candidates: walk up to 6 parents of the app and of cwd
 *  looking for a freshly built CLI (`spettro/bin/spettro`, or `spettro`
 *  at the CLI repo root) — the port of the macOS bundle-parent walk. */
function devCandidates(): string[] {
  const bin = WIN ? 'spettro.exe' : 'spettro'
  const roots = new Set<string>()
  for (const start of [__dirname, process.cwd()]) {
    let dir = start
    for (let i = 0; i < 6; i++) {
      roots.add(dir)
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  const out: string[] = []
  for (const root of roots) {
    out.push(join(root, 'spettro', 'bin', bin))
    out.push(join(root, 'spettro', bin))
  }
  return out
}

function candidatePaths(): { path: string; isDev: boolean }[] {
  const list: { path: string; isDev: boolean }[] = []
  const pathEnv = process.env.PATH ?? ''
  if (WIN) {
    for (const dir of pathEnv.split(delimiter)) {
      if (!dir) continue
      list.push({ path: join(dir, 'spettro.exe'), isDev: false })
      list.push({ path: join(dir, 'spettro'), isDev: false })
    }
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) {
      list.push({ path: join(localAppData, 'Programs', 'spettro', 'spettro.exe'), isDev: false })
    }
  } else {
    const home = homedir()
    list.push({ path: join(home, '.local', 'bin', 'spettro'), isDev: false })
    list.push({ path: '/usr/local/bin/spettro', isDev: false })
    list.push({ path: '/usr/bin/spettro', isDev: false })
    for (const dir of pathEnv.split(delimiter)) {
      if (!dir) continue
      list.push({ path: join(dir, 'spettro'), isDev: false })
    }
  }
  for (const dev of devCandidates()) {
    list.push({ path: dev, isDev: true })
  }
  return list
}

/** Best-effort `spettro --version` (then `spettro version`) with a short
 *  timeout; the authoritative version comes from the ACP handshake. */
function readVersion(path: string): string | null {
  for (const args of [['--version'], ['version']]) {
    try {
      const result = spawnSync(path, args, { timeout: 6000, encoding: 'utf8' })
      const out = (result.stdout ?? '').trim()
      if (out !== '' && out.length < 200) return out
    } catch {
      // fall through
    }
  }
  return null
}

/** Returns the first usable CLI, honoring an explicit user override first. */
export function locateCLI(explicitPath: string | null): LocatedCLI | null {
  if (explicitPath && explicitPath.trim() !== '' && isExecutable(explicitPath)) {
    return { path: explicitPath, version: readVersion(explicitPath), isDev: false }
  }
  const seen = new Set<string>()
  for (const candidate of candidatePaths()) {
    if (seen.has(candidate.path)) continue
    seen.add(candidate.path)
    if (isExecutable(candidate.path)) {
      return { path: candidate.path, version: readVersion(candidate.path), isDev: candidate.isDev }
    }
  }
  return null
}

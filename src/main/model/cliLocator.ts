// Finds the `spettro` CLI on disk — the Linux/Windows port of
// Platforms/macOS/Model/CLILocator.swift.
//
// Search order: explicit override (validated executable) → ~/.local/bin,
// /usr/local/bin, /usr/bin → every directory on PATH (plus spettro.exe and
// %LOCALAPPDATA%\Programs\spettro on Windows) → dev-checkout fallback
// (a `spettro/bin/spettro` or `spettro/spettro` build in a parent directory
// of the app, e.g. ../spettro when running from the desktop repo).
//
// Everything that runs the binary is asynchronous: `--version` against a
// broken or hung binary used to block the main process — the whole window —
// for up to twelve seconds while it said "Looking for Spettro…".
//
// SPETTRO_IGNORE_DEV_CLI=1 skips the dev-checkout fallback, so a dev run from
// beside the CLI repo can still see the first-run setup screens.

import { execFile } from 'child_process'
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
  if (process.env.SPETTRO_IGNORE_DEV_CLI !== '1') {
    for (const dev of devCandidates()) {
      list.push({ path: dev, isDev: true })
    }
  }
  return list
}

/** How long `--version` may take before the binary is assumed not to say. */
const VERSION_TIMEOUT_MS = 6000

function runVersion(path: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(path, args, { timeout: VERSION_TIMEOUT_MS, encoding: 'utf8', windowsHide: true }, (_err, stdout) => {
        // Whatever it printed counts, even with a non-zero exit.
        const out = (stdout ?? '').trim()
        resolve(out !== '' && out.length < 200 ? out : null)
      })
    } catch {
      resolve(null)
    }
  })
}

/** Best-effort `spettro --version` (then `spettro version`) with a short
 *  timeout, off the main thread; the authoritative version comes from the
 *  ACP handshake. */
async function readVersion(path: string): Promise<string | null> {
  return (await runVersion(path, ['--version'])) ?? (await runVersion(path, ['version']))
}

/** Returns the first usable CLI, honoring an explicit user override first. */
export async function locateCLI(explicitPath: string | null): Promise<LocatedCLI | null> {
  if (explicitPath && explicitPath.trim() !== '' && isExecutable(explicitPath)) {
    return { path: explicitPath, version: await readVersion(explicitPath), isDev: false }
  }
  const seen = new Set<string>()
  for (const candidate of candidatePaths()) {
    if (seen.has(candidate.path)) continue
    seen.add(candidate.path)
    if (isExecutable(candidate.path)) {
      return {
        path: candidate.path,
        version: await readVersion(candidate.path),
        isDev: candidate.isDev
      }
    }
  }
  return null
}

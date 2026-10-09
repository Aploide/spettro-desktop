// Finds a cloudflared to run the tunnel with.
//
// Search order: the user's explicit choice → PATH (cloudflared, and
// cloudflared.exe on Windows) → where the packages and installers put it
// (/usr/bin, /usr/local/bin, ~/.local/bin; the MSI's Program Files folders
// and WinGet's links) → the copy Spettro downloaded into userData. A copy too
// old for the flags the tunnel is run with is passed over, so an ancient
// distro package falls through to Spettro's own.
//
// `--version` runs off the main thread with a short timeout, like the CLI's
// locator: a hung binary must not hang the window.

import { execFile } from 'child_process'
import { homedir } from 'os'
import { delimiter, join, win32 } from 'path'
import { isExecutable as isExecutableFile } from '../../model/cliLocator'

export interface LocatedCloudflared {
  path: string
  version: string | null
  source: 'system' | 'downloaded'
}

/** `--output json` and the token in TUNNEL_TOKEN are what the tunnel needs;
 *  any 2024 release has both, and a floor this old excludes little. */
export const MIN_CLOUDFLARED_VERSION = '2024.1.0'

const VERSION_TIMEOUT_MS = 6000

/** "cloudflared version 2026.8.2 (built 20260818-01:23:47)" → "2026.8.2". */
export function parseCloudflaredVersion(output: string | null): string | null {
  const match = /cloudflared version (\d{4}\.\d+\.\d+)/.exec(output ?? '')
  return match ? match[1] : null
}

function versionParts(version: string): number[] {
  return version.split('.').map((part) => Number.parseInt(part, 10) || 0)
}

export function versionAtLeast(version: string, minimum: string): boolean {
  const a = versionParts(version)
  const b = versionParts(minimum)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

/** True when a release (versions are year.month.patch) is over a year old —
 *  about how long Cloudflare keeps supporting one. */
export function isOutdated(version: string, now: number = Date.now()): boolean {
  const [year, month] = versionParts(version)
  if (!year || !month) return false
  const date = new Date(now)
  const ageMonths = (date.getUTCFullYear() - year) * 12 + (date.getUTCMonth() + 1 - month)
  return ageMonths > 12
}

/** Where Spettro keeps the copy it downloads. */
export function downloadedCloudflaredPath(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  return join(dataDir, 'bin', platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
}

export interface LocatorOptions {
  dataDir: string
  explicitPath?: string | null
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
  isExecutable?: (path: string) => boolean
  readVersion?: (path: string) => Promise<string | null>
}

/** Every place a cloudflared might be, in the order they are tried. */
export function cloudflaredCandidates(options: LocatorOptions): { path: string; source: 'system' | 'downloaded' }[] {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const win = platform === 'win32'
  const pathJoin = win ? win32.join : join
  const list: string[] = []
  if (options.explicitPath && options.explicitPath.trim() !== '') list.push(options.explicitPath.trim())
  for (const dir of (env.PATH ?? env.Path ?? '').split(win ? ';' : delimiter)) {
    if (!dir) continue
    if (win) list.push(pathJoin(dir, 'cloudflared.exe'))
    list.push(pathJoin(dir, 'cloudflared'))
  }
  if (win) {
    for (const root of [env['ProgramFiles(x86)'], env.ProgramFiles]) {
      if (root) list.push(pathJoin(root, 'cloudflared', 'cloudflared.exe'))
    }
    if (env.LOCALAPPDATA) list.push(pathJoin(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'))
  } else {
    list.push('/usr/bin/cloudflared', '/usr/local/bin/cloudflared', join(home, '.local', 'bin', 'cloudflared'))
  }
  const downloaded = win
    ? win32.join(options.dataDir, 'bin', 'cloudflared.exe')
    : downloadedCloudflaredPath(options.dataDir, platform)
  const seen = new Set<string>()
  const out: { path: string; source: 'system' | 'downloaded' }[] = []
  for (const path of list) {
    if (path === downloaded || seen.has(path)) continue
    seen.add(path)
    out.push({ path, source: 'system' })
  }
  out.push({ path: downloaded, source: 'downloaded' })
  return out
}

/** `cloudflared --version`, whichever stream it lands on. */
export function readCloudflaredVersion(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(path, ['--version'], { timeout: VERSION_TIMEOUT_MS, encoding: 'utf8', windowsHide: true }, (_err, stdout, stderr) => {
        resolve(parseCloudflaredVersion(`${stdout ?? ''}\n${stderr ?? ''}`))
      })
    } catch {
      resolve(null)
    }
  })
}

/** The cloudflared to run, or null. The first copy that runs and is new
 *  enough wins, except that Spettro's own download is taken over an older
 *  system copy: getting it is how the user answers "your cloudflared is
 *  old". A user's explicit choice always wins. A copy that won't say its
 *  version is passed over: that is what a binary built for another
 *  architecture, or on a noexec mount, does. */
export async function locateCloudflared(options: LocatorOptions): Promise<LocatedCloudflared | null> {
  const isExecutable = options.isExecutable ?? isExecutableFile
  const readVersion = options.readVersion ?? readCloudflaredVersion
  const explicit = options.explicitPath?.trim() ?? ''
  let system: LocatedCloudflared | null = null
  for (const candidate of cloudflaredCandidates(options)) {
    if (system && candidate.source === 'system') continue
    if (!isExecutable(candidate.path)) continue
    const version = await readVersion(candidate.path)
    if (version === null || !versionAtLeast(version, MIN_CLOUDFLARED_VERSION)) continue
    const found: LocatedCloudflared = { path: candidate.path, version, source: candidate.source }
    if (candidate.source === 'downloaded') {
      if (system && versionAtLeast(system.version ?? '0', version)) return system
      return found
    }
    if (candidate.path === explicit) return found
    system = found
  }
  return system
}

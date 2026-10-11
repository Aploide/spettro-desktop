// What builds that offered access over the internet (a Cloudflare tunnel)
// left in the app's own data folder, cleared at launch.
//
// Only paths the app itself wrote, at exactly the names it wrote them:
//   <dataDir>/remote-tunnel.json             token, hostname, switch, port…
//   <dataDir>/bin/cloudflared[.exe]          the copy Spettro downloaded,
//     with the installer's cloudflared.json, <binary>.part and
//     cloudflared-new[.exe] beside it
//   <dataDir>/cloudflared.pid                the running copy's pid
//   <dataDir>/cloudflared/config.yml         the empty config it ran with
// A cloudflared anywhere else — on PATH, installed as a service — is the
// user's and is never touched, and the binaryPath remote-tunnel.json may
// name is never read. Nothing but regular files is removed (no following
// symlinks), and the two folders only once they are empty.
//
// Sync, quiet and best-effort: a file that can't be removed stays, and the
// next launch tries again.

import { lstatSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from 'fs'
import { basename, join } from 'path'

export interface LegacyTunnelCleanupOptions {
  platform?: NodeJS.Platform
  /** Reads /proc/<pid>/cmdline (tests); null when it can't. */
  readCmdline?: (pid: number) => string | null
  /** Signals a process (tests). */
  kill?: (pid: number) => void
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

function removeFile(path: string, removed: string[]): void {
  if (!isFile(path)) return
  try {
    unlinkSync(path)
    removed.push(path)
  } catch {
    /* stays; tried again next launch */
  }
}

function removeDirIfEmpty(path: string, removed: string[]): void {
  if (!isDirectory(path)) return
  try {
    if (readdirSync(path).length > 0) return
    rmdirSync(path)
    removed.push(path)
  } catch {
    /* stays */
  }
}

/** Whether a NUL-separated /proc cmdline is a cloudflared binary run with
 *  `configFile` as an argument of its own — not merely naming the file, as
 *  an editor that opened it would. */
function isOurCloudflared(cmdline: string, configFile: string): boolean {
  const argv = cmdline.split('\0').filter((arg) => arg.length > 0)
  if (argv.length < 2 || basename(argv[0]) !== 'cloudflared') return false
  return argv.slice(1).includes(configFile)
}

/** Removes what the tunnel left in `dataDir` (the app's userData folder).
 *  Returns the paths it removed. */
export function cleanUpLegacyTunnel(dataDir: string, options: LegacyTunnelCleanupOptions = {}): string[] {
  const platform = options.platform ?? process.platform
  const removed: string[] = []
  const configDir = join(dataDir, 'cloudflared')
  const configFile = join(configDir, 'config.yml')
  const pidFile = join(dataDir, 'cloudflared.pid')

  // A cloudflared the app started and a crash left running is ended first —
  // on Linux, and only when /proc says that pid is still a cloudflared
  // (argv[0]) run with the app's own config file as one of its arguments,
  // since pids get reused.
  if (isFile(pidFile) && platform === 'linux') {
    try {
      const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
      if (Number.isInteger(pid) && pid > 1) {
        const readCmdline =
          options.readCmdline ??
          ((p: number): string | null => {
            try {
              return readFileSync(`/proc/${p}/cmdline`, 'utf8')
            } catch {
              return null
            }
          })
        const cmdline = readCmdline(pid)
        if (cmdline && isOurCloudflared(cmdline, configFile)) {
          ;(options.kill ?? ((p: number) => process.kill(p, 'SIGTERM')))(pid)
        }
      }
    } catch {
      /* gone already */
    }
  }
  removeFile(pidFile, removed)

  removeFile(join(dataDir, 'remote-tunnel.json'), removed)

  const binDir = join(dataDir, 'bin')
  if (isDirectory(binDir)) {
    const binary = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
    const candidate = platform === 'win32' ? 'cloudflared-new.exe' : 'cloudflared-new'
    for (const name of [binary, `${binary}.part`, candidate, 'cloudflared.json']) {
      removeFile(join(binDir, name), removed)
    }
    removeDirIfEmpty(binDir, removed)
  }

  if (isDirectory(configDir)) {
    removeFile(configFile, removed)
    removeDirIfEmpty(configDir, removed)
  }
  return removed
}

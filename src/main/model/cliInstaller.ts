// Runs the official Spettro install script, streaming output lines to a
// callback — the port of CLIInstaller in CLILocator.swift.
//
// POSIX: `sh -c "curl -sSfL <install.sh> | sh"`, installing to ~/.local/bin.
//
// Windows: `powershell -Command "irm <install.ps1> | iex"`, installing to
// %LOCALAPPDATA%\Programs\spettro. The script adds that directory to the user
// PATH, which the already-running app never sees — but cliLocator probes the
// install directory directly, so the freshly installed binary is still found.
//
// Both scripts are per-user and need no elevation. stdout and stderr are
// merged into one line stream, kept for "Show details"; what the setup screen
// draws is the phase each line implies (checking → downloading → verifying →
// installing), which is all a person needs to see move.
//
// An install can be cancelled, and gives up on its own after three minutes:
// a curl stuck on a dead network would otherwise spin forever. Before it
// starts, it checks that the tools the script needs are there, so a machine
// without curl hears "install curl" instead of watching a log fail.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { accessSync, constants } from 'fs'
import { delimiter, join } from 'path'

export type InstallPhase = 'checking' | 'downloading' | 'verifying' | 'installing'

/** Why an install ended without a CLI. */
export type InstallFailure =
  | { kind: 'missing-tool'; tool: string }
  | { kind: 'cancelled' }
  | { kind: 'timeout' }
  | { kind: 'launch'; message: string }
  | { kind: 'failed'; code: number | null }

export type InstallerEvent =
  | { type: 'output'; line: string }
  | { type: 'phase'; phase: InstallPhase }
  | { type: 'finished'; success: true }
  | { type: 'finished'; success: false; failure: InstallFailure }

const REPO_RAW = 'https://raw.githubusercontent.com/aploide/spettro/main'

/** How long an install may take before it is called a failure. */
export const INSTALL_TIMEOUT_MS = 3 * 60_000

/** The phase an output line of install.sh / install.ps1 announces, or null
 *  when it announces none ("Fetching latest release..." is still checking;
 *  "Downloading checksums..." is part of verifying, not a second download). */
export function phaseForLine(line: string): InstallPhase | null {
  const l = line.toLowerCase()
  if (/checksum|verif|sha256/.test(l)) return 'verifying'
  if (/download/.test(l)) return 'downloading'
  if (/installed to|installing to|extract|copying/.test(l)) return 'installing'
  if (/fetching latest|latest release|detecting/.test(l)) return 'checking'
  return null
}

/** True when `name` resolves to an executable on PATH. */
export function onPath(name: string, pathEnv: string = process.env.PATH ?? ''): boolean {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    try {
      accessSync(join(dir, name), constants.X_OK)
      return true
    } catch {
      // not here
    }
  }
  return false
}

export interface CLIInstallerOptions {
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  /** Which tools exist; PATH lookup by default. */
  hasTool?: (name: string) => boolean
  timeoutMs?: number
  platform?: NodeJS.Platform
}

export class CLIInstaller {
  static readonly installScriptURL = `${REPO_RAW}/install.sh`
  static readonly windowsInstallScriptURL = `${REPO_RAW}/install.ps1`

  /** The one-liner shown behind "Advanced" in setup. */
  static manualCommand(platform: NodeJS.Platform = process.platform): string {
    return platform === 'win32'
      ? `irm ${CLIInstaller.windowsInstallScriptURL} | iex`
      : `curl -sSfL ${CLIInstaller.installScriptURL} | sh`
  }

  private readonly spawn: NonNullable<CLIInstallerOptions['spawn']>
  private readonly hasTool: (name: string) => boolean
  private readonly timeoutMs: number
  private readonly platform: NodeJS.Platform
  private child: ChildProcess | null = null
  /** Ends the install in flight with a given failure (cancel, timeout). */
  private abort: ((failure: InstallFailure) => void) | null = null

  constructor(options: CLIInstallerOptions = {}) {
    this.spawn = options.spawn ?? nodeSpawn
    this.hasTool = options.hasTool ?? ((name) => onPath(name))
    this.timeoutMs = options.timeoutMs ?? INSTALL_TIMEOUT_MS
    this.platform = options.platform ?? process.platform
  }

  get isRunning(): boolean {
    return this.abort !== null
  }

  /** Stops the install in flight, if any; it finishes as `cancelled`. */
  cancel(): void {
    this.abort?.({ kind: 'cancelled' })
  }

  install(onEvent: (event: InstallerEvent) => void): void {
    // One at a time: a second install racing the first would have two
    // scripts writing the same binary.
    if (this.abort) this.abort({ kind: 'cancelled' })

    let finished = false
    let timer: NodeJS.Timeout | null = null
    const finish = (event: InstallerEvent & { type: 'finished' }): void => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      this.abort = null
      this.child = null
      onEvent(event)
    }
    const fail = (failure: InstallFailure): void => finish({ type: 'finished', success: false, failure })

    onEvent({ type: 'phase', phase: 'checking' })
    if (this.platform !== 'win32') {
      for (const tool of ['sh', 'curl']) {
        if (!this.hasTool(tool)) {
          onEvent({ type: 'output', line: `${tool} was not found on PATH.` })
          fail({ kind: 'missing-tool', tool })
          return
        }
      }
    }

    const [command, args] = installCommand(this.platform)
    let child: ChildProcess
    try {
      child = this.spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Its own process group, so cancelling takes curl down with sh
        // instead of orphaning a download.
        detached: this.platform !== 'win32'
      })
    } catch (err) {
      const message = errText(err)
      onEvent({ type: 'output', line: `Failed to launch installer: ${message}` })
      fail({ kind: 'launch', message })
      return
    }
    this.child = child

    this.abort = (failure) => {
      killTree(child, this.platform)
      onEvent({
        type: 'output',
        line: failure.kind === 'timeout' ? 'Gave up: the installer took too long.' : 'Cancelled.'
      })
      fail(failure)
    }
    timer = setTimeout(() => this.abort?.({ kind: 'timeout' }), this.timeoutMs)
    timer.unref?.()

    let phase: InstallPhase = 'checking'
    let buffer = ''
    const emitLine = (line: string): void => {
      if (line.trim() === '' || finished) return
      onEvent({ type: 'output', line })
      const next = phaseForLine(line)
      // Phases only move forward: "Downloading checksums" after the tarball
      // must not send the bar back to downloading.
      if (next && PHASE_ORDER.indexOf(next) > PHASE_ORDER.indexOf(phase)) {
        phase = next
        onEvent({ type: 'phase', phase })
      }
    }
    const feed = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const idx = buffer.search(/[\r\n]/)
        if (idx < 0) break
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        emitLine(line)
      }
    }
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)
    child.on('error', (err) => {
      onEvent({ type: 'output', line: `Failed to launch installer: ${err.message}` })
      fail({ kind: 'launch', message: err.message })
    })
    child.on('close', (code) => {
      emitLine(buffer.trim())
      buffer = ''
      if (code === 0) finish({ type: 'finished', success: true })
      else fail({ kind: 'failed', code })
    })
  }
}

const PHASE_ORDER: InstallPhase[] = ['checking', 'downloading', 'verifying', 'installing']

/** The shell invocation for this platform. */
function installCommand(platform: NodeJS.Platform): [string, string[]] {
  if (platform === 'win32') {
    // -NoProfile keeps a user's profile out of the pipeline, and silencing the
    // progress preference stops Invoke-WebRequest's progress bar, which makes
    // a redirected download an order of magnitude slower on PowerShell 5.1.
    const script = `$ProgressPreference = 'SilentlyContinue'; irm ${CLIInstaller.windowsInstallScriptURL} | iex`
    return [
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]
    ]
  }
  return ['sh', ['-c', `curl -sSfL ${CLIInstaller.installScriptURL} | sh`]]
}

function killTree(child: ChildProcess, platform: NodeJS.Platform): void {
  try {
    if (platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGTERM')
    else child.kill()
  } catch {
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

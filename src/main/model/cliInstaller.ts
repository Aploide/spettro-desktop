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
// merged into one line stream so the onboarding log reads like a terminal.

import { spawn, type ChildProcess } from 'child_process'

export type InstallerEvent =
  | { type: 'output'; line: string }
  | { type: 'finished'; success: boolean }

const REPO_RAW = 'https://raw.githubusercontent.com/aploide/spettro/main'

export class CLIInstaller {
  static readonly installScriptURL = `${REPO_RAW}/install.sh`
  static readonly windowsInstallScriptURL = `${REPO_RAW}/install.ps1`

  /** The one-liner shown as the manual fallback in onboarding. */
  static manualCommand(platform: NodeJS.Platform = process.platform): string {
    return platform === 'win32'
      ? `irm ${CLIInstaller.windowsInstallScriptURL} | iex`
      : `curl -sSfL ${CLIInstaller.installScriptURL} | sh`
  }

  private child: ChildProcess | null = null

  install(onEvent: (event: InstallerEvent) => void): void {
    let finished = false
    const finish = (success: boolean): void => {
      if (finished) return
      finished = true
      this.child = null
      onEvent({ type: 'finished', success })
    }

    const [command, args] = installCommand()

    let child: ChildProcess
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      onEvent({ type: 'output', line: `Failed to launch installer: ${errText(err)}` })
      finish(false)
      return
    }
    this.child = child

    let buffer = ''
    const feed = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const idx = buffer.search(/[\r\n]/)
        if (idx < 0) break
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (line.trim() !== '') onEvent({ type: 'output', line })
      }
    }
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)
    child.on('error', (err) => {
      onEvent({ type: 'output', line: `Failed to launch installer: ${err.message}` })
      finish(false)
    })
    child.on('close', (code) => {
      if (buffer.trim() !== '') onEvent({ type: 'output', line: buffer.trim() })
      finish(code === 0)
    })
  }
}

/** The shell invocation for this platform. */
function installCommand(): [string, string[]] {
  if (process.platform === 'win32') {
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

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

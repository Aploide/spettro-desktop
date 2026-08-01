// Runs the official Spettro install script, streaming output lines to a
// callback — the port of CLIInstaller in CLILocator.swift.
//
// POSIX: `sh -c "curl -sSfL https://spettro.app/install | sh"` with stdout
// and stderr merged into one line stream.
//
// Windows: the official install script only supports macOS and Linux (the
// CLI repo ships no install.ps1), so automatic install reports a clear
// failure telling the user to install manually and use the explicit-path
// setting instead.

import { spawn, type ChildProcess } from 'child_process'

export type InstallerEvent =
  | { type: 'output'; line: string }
  | { type: 'finished'; success: boolean }

export class CLIInstaller {
  static readonly installScriptURL = 'https://spettro.app/install'

  private child: ChildProcess | null = null

  install(onEvent: (event: InstallerEvent) => void): void {
    if (process.platform === 'win32') {
      onEvent({ type: 'output', line: 'Automatic install is not available on Windows yet.' })
      onEvent({
        type: 'output',
        line: 'Install the Spettro CLI manually, then point the app at it with the explicit CLI path setting.'
      })
      onEvent({ type: 'finished', success: false })
      return
    }

    let finished = false
    const finish = (success: boolean): void => {
      if (finished) return
      finished = true
      onEvent({ type: 'finished', success })
    }

    let child: ChildProcess
    try {
      child = spawn('sh', ['-c', `curl -sSfL ${CLIInstaller.installScriptURL} | sh`], {
        stdio: ['ignore', 'pipe', 'pipe']
      })
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

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

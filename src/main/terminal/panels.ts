// Port of TerminalPanel.swift / TerminalPanelStore (doc 17: terminal drawer).
//
// Each entry is one terminal tab: a node-pty pseudo-terminal running the
// user's interactive login shell rooted at a project folder. Panels are
// scoped per project (mirroring how ChatSession is scoped to one) and live
// for the whole app run, independent of the chat/ACP lifecycle — hiding the
// drawer or switching chats never tears a shell down; only an explicit
// dispose (tab ✕) or app quit does.
//
// Persistence: per doc 17, panels themselves do NOT survive relaunches
// (shells are re-spawned on demand); only drawer visibility/height persist,
// and those are renderer-side concerns. So there is no state file here.

import { spawn, type IPty } from 'node-pty'
import type { MainEvent } from '../../shared/ipc'

interface Panel {
  pty: IPty
  projectPath: string
  alive: boolean
  /** The shell's own process name ("bash", "powershell.exe"). */
  shellName: string
}

export class TerminalManager {
  private readonly panels = new Map<string, Panel>()
  private readonly push: (e: MainEvent) => void
  private counter = 0

  constructor(push: (e: MainEvent) => void) {
    this.push = push
  }

  /** Spawns the user's shell in `projectPath` and returns the new termId. */
  create(projectPath: string): string {
    const id = `term-${++this.counter}-${Date.now().toString(36)}`
    const isWindows = process.platform === 'win32'
    const shell = isWindows ? 'powershell.exe' : process.env.SHELL || '/bin/bash'
    // "-il": interactive *login* shell, so the user's profile (PATH, aliases,
    // prompt) loads exactly as in their terminal app — per doc 17.
    const args = isWindows ? [] : ['-il']

    // Inherit the app environment, pinning TERM (and a LANG fallback, as the
    // macOS app appends LANG=en_US.UTF-8 to SwiftTerm's baseline env).
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value
    }
    env.TERM = 'xterm-256color'
    if (!env.LANG) env.LANG = 'en_US.UTF-8'

    const pty = spawn(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: projectPath,
      env
    })

    const panel: Panel = {
      pty,
      projectPath,
      alive: true,
      shellName: shell.split(/[\\/]/).pop() ?? shell
    }
    this.panels.set(id, panel)

    pty.onData((data) => {
      this.push({ type: 'terminal-data', termId: id, data })
    })
    pty.onExit(({ exitCode }) => {
      panel.alive = false
      this.push({ type: 'terminal-exit', termId: id, exitCode })
    })

    return id
  }

  write(id: string, data: string): void {
    const panel = this.panels.get(id)
    if (!panel || !panel.alive) return
    panel.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const panel = this.panels.get(id)
    if (!panel || !panel.alive) return
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return
    try {
      panel.pty.resize(cols, rows)
    } catch {
      // Resizing a pty that raced to exit throws; the exit event follows.
    }
  }

  dispose(id: string): void {
    const panel = this.panels.get(id)
    if (!panel) return
    this.panels.delete(id)
    if (panel.alive) {
      panel.alive = false
      try {
        panel.pty.kill()
      } catch {
        // Already gone.
      }
    }
  }

  /** Whether something other than the shell itself is in the foreground
   *  (node-pty names the foreground process) — closing the tab would kill
   *  it, which deserves a question first. */
  hasProcess(id: string): boolean {
    const panel = this.panels.get(id)
    if (!panel || !panel.alive) return false
    try {
      const running = (panel.pty.process ?? '').split(/[\\/]/).pop() ?? ''
      return running !== '' && running !== panel.shellName
    } catch {
      return false
    }
  }

  /** Tabs with a command running in them, across every project. */
  runningCount(): number {
    let count = 0
    for (const id of this.panels.keys()) if (this.hasProcess(id)) count += 1
    return count
  }

  /** termIds scoped to one project — per-project tabs, doc 17. */
  list(projectPath: string): string[] {
    const ids: string[] = []
    for (const [id, panel] of this.panels) {
      if (panel.projectPath === projectPath) ids.push(id)
    }
    return ids
  }

  disposeAll(): void {
    for (const id of [...this.panels.keys()]) this.dispose(id)
  }
}

// What keeps setup and restarts from losing the user (WP9): the installer can
// be cancelled and gives up on a hung download, says which tool is missing,
// and moves its bar forward only; an engine restart under a shell already on
// screen keeps the phase (so nothing unmounts) and says "reconnecting"; a
// banner is shown once per nonce, so the same bad path twice is said twice,
// and isn't repeated to phones afterwards; a deleted chat waits out its Undo.

import { EventEmitter } from 'events'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ChildProcess } from 'child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@main/model/cliLocator', () => ({ locateCLI: vi.fn(async () => null) }))

const { CLIInstaller, phaseForLine } = await import('@main/model/cliInstaller')
const { AppModel } = await import('@main/model/appModel')
const { createDeleteScheduler } = await import('@renderer/state/pendingDeletes')
type InstallerEvent = import('@main/model/cliInstaller').InstallerEvent

/** A child process that does nothing until told to. */
function fakeChild(): ChildProcess & { emitLine(line: string): void; exit(code: number): void; killed: boolean } {
  const child = new EventEmitter() as ChildProcess & {
    emitLine(line: string): void
    exit(code: number): void
    killed: boolean
  }
  const stdout = new EventEmitter()
  Object.assign(child, {
    stdout,
    stderr: new EventEmitter(),
    pid: undefined,
    killed: false,
    kill: () => {
      child.killed = true
      queueMicrotask(() => child.emit('close', null))
      return true
    },
    emitLine: (line: string) => stdout.emit('data', Buffer.from(`${line}\n`)),
    exit: (code: number) => child.emit('close', code)
  })
  return child
}

function installer(o: { tools?: string[]; timeoutMs?: number } = {}) {
  const child = fakeChild()
  const spawn = vi.fn(() => child)
  const events: InstallerEvent[] = []
  const inst = new CLIInstaller({
    spawn: spawn as never,
    hasTool: (name) => (o.tools ?? ['sh', 'curl']).includes(name),
    timeoutMs: o.timeoutMs ?? 60_000,
    platform: 'linux'
  })
  return { inst, child, spawn, events, onEvent: (e: InstallerEvent) => events.push(e) }
}

const finished = (events: InstallerEvent[]) => events.filter((e) => e.type === 'finished')
const phases = (events: InstallerEvent[]) => events.flatMap((e) => (e.type === 'phase' ? [e.phase] : []))

describe('CLIInstaller', () => {
  it('reads its phases from the script’s lines, and only ever moves forward', () => {
    const { inst, child, events, onEvent } = installer()
    inst.install(onEvent)
    child.emitLine('Fetching latest release...')
    child.emitLine('Installing spettro v2.9.0 (linux/amd64)...')
    child.emitLine('Downloading https://github.com/aploide/spettro/releases/download/v2.9.0/x.tar.gz...')
    child.emitLine('Downloading checksums...')
    child.emitLine('Checksum verified.')
    child.emitLine('spettro v2.9.0 installed to /home/me/.local/bin/spettro.')
    child.exit(0)
    expect(phases(events)).toEqual(['checking', 'downloading', 'verifying', 'installing'])
    expect(finished(events)).toEqual([{ type: 'finished', success: true }])
    expect(phaseForLine('Downloading checksums...')).toBe('verifying')
  })

  it('cancels: kills the script and finishes once, as cancelled', async () => {
    const { inst, child, events, onEvent } = installer()
    inst.install(onEvent)
    expect(inst.isRunning).toBe(true)
    inst.cancel()
    await Promise.resolve()
    expect(child.killed).toBe(true)
    expect(finished(events)).toEqual([{ type: 'finished', success: false, failure: { kind: 'cancelled' } }])
    expect(inst.isRunning).toBe(false)
  })

  it('gives up on a hung download', () => {
    vi.useFakeTimers()
    try {
      const { inst, child, events, onEvent } = installer({ timeoutMs: 180_000 })
      inst.install(onEvent)
      vi.advanceTimersByTime(179_000)
      expect(finished(events)).toEqual([])
      vi.advanceTimersByTime(2_000)
      expect(child.killed).toBe(true)
      expect(finished(events)).toEqual([{ type: 'finished', success: false, failure: { kind: 'timeout' } }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('says which tool is missing instead of running a script that can’t work', () => {
    const { inst, spawn, events, onEvent } = installer({ tools: ['sh'] })
    inst.install(onEvent)
    expect(spawn).not.toHaveBeenCalled()
    expect(finished(events)).toEqual([
      { type: 'finished', success: false, failure: { kind: 'missing-tool', tool: 'curl' } }
    ])
  })

  it('reports a script that fails as failed, with its exit code', () => {
    const { inst, child, events, onEvent } = installer()
    inst.install(onEvent)
    child.emitLine('curl: (6) Could not resolve host: raw.githubusercontent.com')
    child.exit(6)
    expect(finished(events)).toEqual([{ type: 'finished', success: false, failure: { kind: 'failed', code: 6 } }])
  })
})

// ---------------------------------------------------------------------------

let dir: string | null = null
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

function model() {
  dir = mkdtempSync(join(tmpdir(), 'spettro-wp9-'))
  const m = new AppModel({ userDataDir: dir, appVersion: '0.0.0-test' })
  const events: { type: string; state?: { banner: string | null; bannerNonce: number } }[] = []
  const host: { message?: string }[] = []
  m.on('event', (e) => events.push(e))
  m.on('host-state', (s) => host.push(s))
  return { m, events, host, internals: m as unknown as { phase: { kind: string }; shellShown: boolean } }
}

describe('reconnecting under the shell', () => {
  it('keeps the phase ready and flags the connection, so nothing unmounts', () => {
    const { m, internals } = model()
    internals.phase = { kind: 'ready' }
    internals.shellShown = true
    void m.reconnect()
    const state = m.getState()
    expect(state.phase.kind).toBe('ready')
    expect(state.connection).toBe('reconnecting')
  })

  it('uses the loading screen before any shell was shown', () => {
    const { m } = model()
    void m.reconnect()
    expect(m.getState().phase.kind).toBe('locating')
    expect(m.getState().connection).toBe('ok')
  })

  it('a crash restart keeps the shell too, and says so once', () => {
    const { m, internals, host } = model()
    internals.phase = { kind: 'ready' }
    internals.shellShown = true
    ;(m as unknown as { handleTermination(code: number): void }).handleTermination(1)
    expect(m.getState().phase.kind).toBe('ready')
    expect(m.getState().connection).toBe('reconnecting')
    expect(host.some((h) => h.message?.includes('Restarting'))).toBe(true)
    // Not carried into later snapshots, nor to phones later.
    expect(m.getState().banner).toBeNull()
  })
})

describe('banners', () => {
  it('a bad path picked twice is said twice', async () => {
    const { m, events } = model()
    await m.useExplicitPath('/nope/spettro')
    await m.useExplicitPath('/nope/spettro')
    const shown = events.flatMap((e) =>
      e.type === 'app-state' && e.state?.banner ? [[e.state.banner, e.state.bannerNonce] as const] : []
    )
    expect(shown).toHaveLength(2)
    expect(shown[0][0]).toBe(shown[1][0])
    expect(shown[1][1]).toBe(shown[0][1] + 1)
    expect(m.getState().banner).toBeNull()
  })
})

describe('delete with undo', () => {
  function scheduler() {
    vi.useFakeTimers()
    return createDeleteScheduler({ delayMs: 8000 })
  }
  afterEach(() => vi.useRealTimers())

  it('hides the chat at once and deletes it only when the window runs out', () => {
    const s = scheduler()
    const commit = vi.fn()
    s.schedule('a', commit)
    expect(s.isPending('a')).toBe(true)
    vi.advanceTimersByTime(7999)
    expect(commit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(s.isPending('a')).toBe(false)
  })

  it('Undo takes it back for good', () => {
    const s = scheduler()
    const commit = vi.fn()
    s.schedule('a', commit)
    expect(s.undo('a')).toBe(true)
    vi.advanceTimersByTime(20_000)
    expect(commit).not.toHaveBeenCalled()
    expect(s.undo('a')).toBe(false)
  })

  it('flush deletes everything still waiting (the window is closing)', () => {
    const s = scheduler()
    const a = vi.fn()
    const b = vi.fn()
    s.schedule('a', a)
    s.schedule('b', b)
    s.flush()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_000)
    expect(a).toHaveBeenCalledTimes(1)
    expect(s.pending().size).toBe(0)
  })

  it('tells subscribers when the hidden set changes', () => {
    const s = scheduler()
    const seen: number[] = []
    s.subscribe(() => seen.push(s.pending().size))
    s.schedule('a', () => undefined)
    s.undo('a')
    expect(seen).toEqual([1, 0])
  })
})

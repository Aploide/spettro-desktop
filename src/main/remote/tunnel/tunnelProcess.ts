// One cloudflared, kept running: started with the token in its environment,
// read through its log and its metrics server's /ready, restarted with
// backoff when it dies for a reason that might pass, and left stopped when
// it died for one that won't (a refused token, a deleted tunnel).
//
// The command is `cloudflared tunnel … run` with no --url: the tunnel is
// remotely managed, so the route from the public hostname to
// localhost:<port> is the dashboard's, and any remote config replaces a
// local one anyway. --config points at an empty file of our own so a
// ~/.cloudflared/config.yml written for something else changes nothing, and
// every inherited TUNNEL_* variable is dropped for the same reason. The
// token travels in TUNNEL_TOKEN, never argv, where `ps` would show it.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { get as httpGet } from 'http'
import { displayLine, parseLogLine, signalFor, type FatalKind, type IngressRule } from './tunnelLog'
import { redactTokens } from './tunnelToken'

/** Seconds to wait before each restart in a row; the last repeats. */
export const RESTART_BACKOFF_S = [1, 2, 5, 10, 30, 60] as const

/** The wait before restart number `attempt` (0-based). */
export function backoffDelayMs(attempt: number): number {
  return RESTART_BACKOFF_S[Math.min(Math.max(attempt, 0), RESTART_BACKOFF_S.length - 1)] * 1000
}

/** Connected this long, the next failure starts the backoff over. */
export const STABLE_RESET_MS = 120_000
/** How often /ready is asked while cloudflared runs. */
export const READY_POLL_MS = 5_000
/** No connection for this long while alive — stuck after a sleep, say —
 *  and the process is restarted. */
export const STUCK_RESTART_MS = 90_000
/** How long a stop waits before SIGKILL. */
export const KILL_AFTER_MS = 3_000
/** How long after exiting a process's output may take to drain before the
 *  exit is acted on without it. */
export const EXIT_DRAIN_MS = 1_000
/** Diagnostics lines kept. */
export const LOG_LIMIT = 60

export type TunnelProcessPhase = 'starting' | 'connected' | 'reconnecting' | 'stopped' | 'failed'

export type TunnelProcessErrorKind = FatalKind | 'network' | 'exited' | 'binary-missing'

export interface TunnelProcessSnapshot {
  phase: TunnelProcessPhase
  connections: number
  locations: string[]
  protocol: 'quic' | 'http2' | null
  /** This connector's id: what cloudflared puts in Cf-Warp-Tag-Id. */
  connectorId: string | null
  error: { kind: TunnelProcessErrorKind; message: string } | null
  udpBlocked: boolean
  /** The dashboard's ingress rules, once cloudflared has them. */
  ingress: IngressRule[] | null
  retryAt: number | null
  log: string[]
}

export interface ReadyReport {
  readyConnections: number
  connectorId: string | null
}

export interface TunnelProcessOptions {
  binaryPath: string
  token: string
  /** An empty config file that keeps the user's own config out. */
  configPath: string
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  probeReady?: (port: number) => Promise<ReadyReport | null>
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  now?: () => number
  /** Told the pid of each process started, and null once it exits. */
  onPid?: (pid: number | null) => void
}

/** The arguments cloudflared is run with. Tunnel-level flags go before
 *  `run`; without `run` it would start a quick tunnel instead. */
export function tunnelArgs(configPath: string): string[] {
  return [
    'tunnel',
    '--no-autoupdate',
    '--config',
    configPath,
    '--metrics',
    '127.0.0.1:0',
    '--loglevel',
    'info',
    '--output',
    'json',
    '--grace-period',
    '2s',
    'run'
  ]
}

/** The environment cloudflared gets: ours without any TUNNEL_* setting, plus
 *  the token. */
export function tunnelEnv(token: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (/^TUNNEL_/i.test(key) || key === 'NO_AUTOUPDATE') continue
    env[key] = value
  }
  env.TUNNEL_TOKEN = token
  env.NO_AUTOUPDATE = 'true'
  return env
}

/** GET /ready on cloudflared's metrics server. */
export function probeReady(port: number): Promise<ReadyReport | null> {
  return new Promise((resolve) => {
    const req = httpGet({ host: '127.0.0.1', port, path: '/ready', timeout: 2000 }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
          resolve({
            readyConnections: typeof body.readyConnections === 'number' ? body.readyConnections : 0,
            connectorId: typeof body.connectorId === 'string' ? body.connectorId.toLowerCase() : null
          })
        } catch {
          resolve(null)
        }
      })
      res.on('error', () => resolve(null))
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
  })
}

const FATAL_MESSAGES: Record<FatalKind, string> = {
  'bad-token': 'That tunnel token wasn’t accepted. Copy it again from the Cloudflare dashboard.',
  unauthorized: 'Cloudflare rejected this tunnel. It may have been deleted, or its token rotated.',
  launch: 'This cloudflared can’t run the tunnel. Update it, or let Spettro use its own copy.'
}

export class TunnelProcess {
  private readonly options: TunnelProcessOptions
  private readonly onChange: (snapshot: TunnelProcessSnapshot) => void
  private readonly spawnFn: NonNullable<TunnelProcessOptions['spawn']>
  private readonly probe: NonNullable<TunnelProcessOptions['probeReady']>
  private readonly platform: NodeJS.Platform
  private readonly now: () => number

  private child: ChildProcess | null = null
  private stopping = false
  private attempt = 0
  private restartTimer: NodeJS.Timeout | null = null
  private stableTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private killTimers: NodeJS.Timeout[] = []
  private metricsPort: number | null = null
  /** When the process last had no connection while alive (for STUCK_RESTART_MS). */
  private disconnectedSince: number | null = null
  private everConnected = false
  private fatal: { kind: FatalKind; message: string } | null = null
  private lastNetworkError: string | null = null
  private lastPlainLine: string | null = null
  private readonly links = new Map<number, { location: string | null; protocol: 'quic' | 'http2' | null }>()
  private exitWaiters: (() => void)[] = []

  private snapshot: TunnelProcessSnapshot = {
    phase: 'stopped',
    connections: 0,
    locations: [],
    protocol: null,
    connectorId: null,
    error: null,
    udpBlocked: false,
    ingress: null,
    retryAt: null,
    log: []
  }

  constructor(options: TunnelProcessOptions, onChange: (snapshot: TunnelProcessSnapshot) => void) {
    this.options = options
    this.onChange = onChange
    this.spawnFn = options.spawn ?? nodeSpawn
    this.probe = options.probeReady ?? probeReady
    this.platform = options.platform ?? process.platform
    this.now = options.now ?? Date.now
  }

  get state(): TunnelProcessSnapshot {
    return this.snapshot
  }

  get isRunning(): boolean {
    return this.child !== null
  }

  /** Starts cloudflared (again), forgetting any wait for a restart. */
  start(): void {
    this.stopping = false
    this.clearRestart()
    if (this.child) return
    this.fatal = null
    this.lastNetworkError = null
    this.lastPlainLine = null
    this.metricsPort = null
    this.links.clear()
    this.everConnected = false
    this.disconnectedSince = this.now()
    this.update({ phase: 'starting', connections: 0, locations: [], protocol: null, error: null, retryAt: null })

    let child: ChildProcess
    try {
      child = this.spawnFn(this.options.binaryPath, tunnelArgs(this.options.configPath), {
        env: tunnelEnv(this.options.token, this.options.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      this.launchFailed(error)
      return
    }
    this.child = child
    if (child.pid !== undefined) this.options.onPid?.(child.pid)
    this.publish()

    let buffer = ''
    const feed = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const idx = buffer.search(/[\r\n]/)
        if (idx < 0) break
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        this.readLine(line)
      }
    }
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)
    child.on('error', (error) => {
      if (this.child !== child) return
      this.child = null
      this.options.onPid?.(null)
      this.launchFailed(error)
    })
    // 'exit' can come before the last of stdout and stderr has been read —
    // the line saying why, often — so the exit is acted on at 'close', once
    // both are drained. A grandchild holding them open would keep 'close'
    // from ever coming; cloudflared starts none, but the wait is bounded.
    let exitCode: number | null = null
    let drainTimer: NodeJS.Timeout | null = null
    const finish = (code: number | null): void => {
      if (drainTimer) clearTimeout(drainTimer)
      drainTimer = null
      if (buffer.trim() !== '') this.readLine(buffer)
      buffer = ''
      if (this.child !== child) return
      this.child = null
      this.options.onPid?.(null)
      this.exited(code)
    }
    child.on('exit', (code) => {
      exitCode = code
      drainTimer = setTimeout(() => finish(exitCode), EXIT_DRAIN_MS)
      drainTimer.unref?.()
    })
    child.on('close', (code: number | null) => finish(code ?? exitCode))
  }

  /** Stops cloudflared and waits (a few seconds at most) for it to go. */
  stop(): Promise<void> {
    this.stopping = true
    this.clearRestart()
    this.clearRunTimers()
    const child = this.child
    if (!child) {
      this.update({ phase: 'stopped', retryAt: null, connections: 0, locations: [] })
      return Promise.resolve()
    }
    const gone = new Promise<void>((resolve) => this.exitWaiters.push(resolve))
    this.signal(child, 'SIGTERM')
    if (this.platform !== 'win32') {
      // A second SIGTERM skips the grace period; SIGKILL if even that hangs.
      this.killTimers.push(setTimeout(() => this.signal(child, 'SIGTERM'), 200))
      this.killTimers.push(setTimeout(() => this.signal(child, 'SIGKILL'), KILL_AFTER_MS))
    }
    return gone
  }

  /** Quitting: one signal, no waiting. cloudflared winds down within its
   *  2 s grace period on its own once the app is gone. */
  stopNow(): void {
    this.stopping = true
    this.clearRestart()
    this.clearRunTimers()
    if (this.child) this.signal(this.child, 'SIGTERM')
  }

  /** Restart now, as if nothing had failed yet (Try again, waking up). */
  retryNow(): void {
    this.attempt = 0
    if (this.child) {
      // A process that's up but stuck is replaced.
      if (this.snapshot.phase !== 'connected') void this.stop().then(() => this.start())
      return
    }
    this.start()
  }

  /** The machine woke: the next failure starts the backoff over. */
  resetBackoff(): void {
    this.attempt = 0
    if (this.restartTimer) {
      this.clearRestart()
      this.start()
    }
  }

  // MARK: Log

  private readLine(raw: string): void {
    if (raw.trim() === '') return
    const entry = parseLogLine(raw)
    if (entry.level === null) this.lastPlainLine = redactTokens(entry.message)
    const log = [...this.snapshot.log, displayLine(entry)].slice(-LOG_LIMIT)
    this.snapshot = { ...this.snapshot, log }
    const signal = signalFor(entry)
    if (!signal) {
      this.publish()
      return
    }
    switch (signal.kind) {
      case 'metrics':
        this.metricsPort = signal.port
        this.startPolling()
        break
      case 'connector':
        this.snapshot = { ...this.snapshot, connectorId: signal.id }
        break
      case 'registered':
        this.links.set(signal.connIndex, { location: signal.location, protocol: signal.protocol })
        this.lastNetworkError = null
        this.connectedChanged()
        break
      case 'unregistered':
        if (signal.connIndex === null) this.links.clear()
        else this.links.delete(signal.connIndex)
        this.connectedChanged()
        break
      case 'retrying':
        if (this.links.size === 0 && this.everConnected) this.update({ phase: 'reconnecting' })
        break
      case 'network':
        this.lastNetworkError = signal.message
        if (this.links.size === 0) {
          this.update({
            phase: this.everConnected ? 'reconnecting' : this.snapshot.phase,
            error: { kind: 'network', message: 'Can’t reach Cloudflare. Check your connection.' }
          })
        }
        break
      case 'udp-blocked':
        this.update({ udpBlocked: true })
        break
      case 'fatal':
        this.fatal = { kind: signal.fatal, message: FATAL_MESSAGES[signal.fatal] }
        // A refused token or a deleted tunnel won't get better: stop now
        // rather than let cloudflared retry against the edge.
        if (this.child && signal.fatal === 'unauthorized') this.signal(this.child, 'SIGTERM')
        break
      case 'config':
        this.update({ ingress: signal.ingress })
        break
    }
    this.publish()
  }

  private connectedChanged(): void {
    const connections = this.links.size
    const locations = [...new Set([...this.links.values()].map((l) => l.location).filter((l): l is string => !!l))]
    const protocol = [...this.links.values()].find((l) => l.protocol)?.protocol ?? null
    if (connections > 0) {
      this.everConnected = true
      this.disconnectedSince = null
      if (!this.stableTimer) {
        this.stableTimer = setTimeout(() => {
          this.stableTimer = null
          this.attempt = 0
        }, STABLE_RESET_MS)
      }
      this.update({ phase: 'connected', connections, locations, protocol, error: null, retryAt: null })
    } else {
      if (this.stableTimer) clearTimeout(this.stableTimer)
      this.stableTimer = null
      this.disconnectedSince ??= this.now()
      this.update({ phase: 'reconnecting', connections, locations, protocol })
    }
  }

  // MARK: /ready

  private startPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    const poll = (): void => {
      const port = this.metricsPort
      const child = this.child
      if (port === null || !child) return
      void this.probe(port).then((report) => {
        if (this.child !== child || !report) return
        if (report.connectorId && report.connectorId !== this.snapshot.connectorId) {
          this.update({ connectorId: report.connectorId })
        }
        if (report.readyConnections > 0) {
          this.disconnectedSince = null
          if (this.snapshot.connections !== report.readyConnections && this.links.size === 0) {
            this.update({ phase: 'connected', connections: report.readyConnections, error: null })
          }
        } else {
          this.disconnectedSince ??= this.now()
          if (this.now() - this.disconnectedSince >= STUCK_RESTART_MS) {
            this.disconnectedSince = null
            this.signal(child, 'SIGTERM')
          }
        }
        this.publish()
      })
    }
    this.pollTimer = setInterval(poll, READY_POLL_MS)
    this.pollTimer.unref?.()
    poll()
  }

  // MARK: Exit and restart

  private exited(code: number | null): void {
    this.clearRunTimers()
    this.links.clear()
    const waiters = this.exitWaiters
    this.exitWaiters = []
    if (this.stopping) {
      this.update({ phase: 'stopped', connections: 0, locations: [], retryAt: null })
      this.publish()
      for (const resolve of waiters) resolve()
      return
    }
    for (const resolve of waiters) resolve()
    // 255 is cloudflared's usage error: the same arguments fail the same way.
    if (this.fatal || code === 255) {
      const error = this.fatal ?? {
        kind: 'launch' as const,
        message: this.lastPlainLine ? `cloudflared couldn’t start: ${this.lastPlainLine}` : FATAL_MESSAGES.launch
      }
      this.update({ phase: 'failed', connections: 0, locations: [], error, retryAt: null })
      this.publish()
      return
    }
    const delay = backoffDelayMs(this.attempt)
    this.attempt += 1
    const retryAt = this.now() + delay
    this.update({
      phase: 'reconnecting',
      connections: 0,
      locations: [],
      retryAt,
      error: this.lastNetworkError
        ? { kind: 'network', message: 'Can’t reach Cloudflare. Check your connection.' }
        : { kind: 'exited', message: `cloudflared stopped${code !== null ? ` (exit ${code})` : ''}. Starting it again.` }
    })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.start()
    }, delay)
    this.publish()
  }

  private launchFailed(error: unknown): void {
    const code = (error as { code?: unknown }).code
    const message = error instanceof Error ? error.message : String(error)
    this.clearRunTimers()
    this.update({
      phase: 'failed',
      connections: 0,
      locations: [],
      retryAt: null,
      error:
        code === 'ENOENT'
          ? { kind: 'binary-missing', message: 'cloudflared isn’t where it was. Turn the tunnel off and on to look again.' }
          : { kind: 'launch', message: `cloudflared couldn’t start: ${redactTokens(message)}` }
    })
    this.publish()
  }

  private signal(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      child.kill(signal)
    } catch {
      // Already gone.
    }
  }

  private clearRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
  }

  private clearRunTimers(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.stableTimer = null
    for (const timer of this.killTimers) clearTimeout(timer)
    this.killTimers = []
  }

  private update(patch: Partial<TunnelProcessSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
  }

  private publish(): void {
    this.onChange(this.snapshot)
  }
}

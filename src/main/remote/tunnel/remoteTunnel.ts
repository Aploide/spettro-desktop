// The tunnel as the remote host sees it: settings, a cloudflared to run
// (found, or fetched), the process kept up, and the one state the settings
// pane draws.
//
// It runs exactly while all of these hold: the switch is on, there is a
// token, and the relay is listening on the pinned port — the one the
// dashboard's service URL names. The host says when it listens (attach) and
// stops (detach); everything else is the user's.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import WebSocket from 'ws'
import type {
  RemoteTunnelCheck,
  RemoteTunnelConfigureResult,
  RemoteTunnelErrorKind,
  RemoteTunnelPatch,
  RemoteTunnelState
} from '../../../shared/model'
import { RemoteMethod } from '../../../shared/remote'
import { CloudflaredInstaller, CloudflaredInstallError, type InstalledCloudflared } from './cloudflaredInstaller'
import { isOutdated, locateCloudflared, type LocatedCloudflared, type LocatorOptions } from './cloudflaredLocator'
import { checkIngress, type IngressRule } from './tunnelLog'
import { TunnelProcess, type TunnelProcessOptions, type TunnelProcessSnapshot } from './tunnelProcess'
import { isValidTunnelPort, TunnelStore } from './tunnelStore'
import { extractToken, normalizeHostname, parseToken } from './tunnelToken'

/** What the facade needs from a TunnelProcess (a fake, in tests). */
export interface TunnelProcessLike {
  readonly isRunning: boolean
  readonly state: TunnelProcessSnapshot
  start(): void
  stop(): Promise<void>
  stopNow(): void
  retryNow(): void
  resetBackoff(): void
}

export interface RemoteTunnelOptions {
  dataDir: string
  /** Anything in the tunnel's state changed. */
  onChange: () => void
  locate?: (options: LocatorOptions) => Promise<LocatedCloudflared | null>
  installer?: Pick<CloudflaredInstaller, 'install' | 'cancel' | 'isRunning'>
  createProcess?: (options: TunnelProcessOptions, onChange: (s: TunnelProcessSnapshot) => void) => TunnelProcessLike
  platform?: NodeJS.Platform
  now?: () => number
  /** Opens the self-test connection (ws, in the app). */
  openSocket?: (url: string) => WebSocket
}

const TOKEN_REFUSED =
  'That doesn’t look like a tunnel token. Paste the token, or the whole install command, from the Cloudflare dashboard.'
const UDP_BLOCKED = 'UDP is blocked on this network, so the tunnel uses HTTP/2. It works, but QUIC is faster.'
const OUTDATED = 'Your cloudflared is over a year old. Spettro can use its own up-to-date copy.'
const LOG_LIMIT = 60
const CHECK_TIMEOUT_MS = 10_000

export function portInUseMessage(port: number): string {
  return `Port ${port} is in use by another program, so the tunnel can’t reach Spettro. Close it, or choose another port and update the service URL in Cloudflare.`
}

export class RemoteTunnel {
  readonly store: TunnelStore
  private readonly options: RemoteTunnelOptions
  private readonly installer: Pick<CloudflaredInstaller, 'install' | 'cancel' | 'isRunning'>
  private readonly platform: NodeJS.Platform
  private readonly pidFile: string
  private readonly configFile: string

  /** The port the relay listens on right now, or null while it is off. */
  private listenPort: number | null = null
  /** Bumped by every start and stop, so a start that finishes after it
   *  was overtaken does nothing. */
  private generation = 0
  private starting = false
  private stage: 'idle' | 'locating' | 'downloading' | 'running' = 'idle'
  private process: TunnelProcessLike | null = null
  private snapshot: TunnelProcessSnapshot | null = null
  private localError: { kind: RemoteTunnelErrorKind; message: string } | null = null
  private downloadProgress: number | null = null
  private binary: LocatedCloudflared | null = null
  private ingress: IngressRule[] | null = null
  private ingressWarning: string | null = null
  private notes: string[] = []

  constructor(options: RemoteTunnelOptions) {
    this.options = options
    this.store = new TunnelStore(options.dataDir)
    this.platform = options.platform ?? process.platform
    this.installer = options.installer ?? new CloudflaredInstaller({ dataDir: options.dataDir, platform: this.platform })
    this.pidFile = join(options.dataDir, 'cloudflared.pid')
    this.configFile = join(options.dataDir, 'cloudflared', 'config.yml')
  }

  // MARK: What the host asks

  /** The pinned local port (the dashboard's service URL names it). */
  get port(): number {
    return this.store.get().port
  }

  get enabled(): boolean {
    return this.store.get().enabled
  }

  /** The hostname phones are given: only while the switch is on. */
  get publicHost(): string | undefined {
    const { enabled, hostname } = this.store.get()
    return enabled && hostname !== '' ? hostname : undefined
  }

  get allowInternetPairing(): boolean {
    return this.store.get().allowInternetPairing
  }

  /** For the kill switch: whether our cloudflared is up, and its id. */
  get gate(): { running: boolean; connectorId: string | null } {
    return {
      running: this.enabled && this.process !== null && this.process.isRunning,
      connectorId: this.snapshot?.connectorId ?? null
    }
  }

  getState(): RemoteTunnelState {
    const settings = this.store.get()
    const parsed = settings.token ? parseToken(settings.token) : null
    const snap = this.process ? this.snapshot : null
    let status: RemoteTunnelState['status']
    let error = this.localError
    if (!settings.enabled) status = 'off'
    else if (!settings.token) status = 'needs-setup'
    else if (this.localError) status = 'error'
    else if (this.listenPort === null) status = 'off'
    else if (this.stage === 'locating') status = 'locating'
    else if (this.stage === 'downloading') status = 'downloading'
    else if (snap) {
      error = snap.error
      status =
        snap.phase === 'connected'
          ? 'connected'
          : snap.phase === 'reconnecting'
            ? 'reconnecting'
            : snap.phase === 'failed'
              ? 'error'
              : 'starting'
    } else status = 'starting'
    const live = snap !== null && status !== 'off' ? snap : null
    return {
      enabled: settings.enabled,
      hostname: settings.hostname,
      hasToken: settings.token !== null,
      tunnelId: parsed?.tunnelId ?? null,
      port: settings.port,
      allowInternetPairing: settings.allowInternetPairing,
      status,
      downloadProgress: this.stage === 'downloading' ? this.downloadProgress : null,
      connections: live?.connections ?? 0,
      locations: live?.locations ?? [],
      protocol: live?.protocol ?? null,
      error: status === 'error' || status === 'reconnecting' ? error : null,
      warning: this.warning(),
      retryAt: live?.retryAt ?? null,
      binary: this.binary ? { ...this.binary } : null,
      log: [...this.notes, ...(this.snapshot?.log ?? [])].slice(-LOG_LIMIT)
    }
  }

  private warning(): string | null {
    if (this.ingressWarning) return this.ingressWarning
    if (this.binary?.source === 'system' && this.binary.version && isOutdated(this.binary.version, this.now())) return OUTDATED
    if (this.snapshot?.udpBlocked && this.snapshot.protocol === 'http2') return UDP_BLOCKED
    return null
  }

  /** The relay is listening on `port`. */
  attach(port: number): void {
    this.listenPort = port
    this.sync()
  }

  /** The relay stopped listening. */
  detach(): void {
    this.listenPort = null
    this.sync()
  }

  /** Quitting: cloudflared is signalled now, without waiting on anything. */
  shutdown(): void {
    this.generation++
    this.listenPort = null
    this.installer.cancel()
    this.process?.stopNow()
    this.process = null
    this.starting = false
    this.stage = 'idle'
  }

  /** The machine woke up: a tunnel waiting out a backoff tries now. */
  resume(): void {
    this.process?.resetBackoff()
  }

  // MARK: What the user asks

  setEnabled(enabled: boolean): void {
    if (enabled !== this.enabled) this.store.update({ enabled })
    if (!enabled) this.localError = null
    this.sync()
  }

  /** Validates every field first, so a refused patch saves nothing. */
  configure(patch: RemoteTunnelPatch): RemoteTunnelConfigureResult & { changed?: { token: boolean; port: boolean; hostname: boolean } } {
    const next: { token?: string; hostname?: string; port?: number; allowInternetPairing?: boolean } = {}
    if (patch.token !== undefined) {
      const token = typeof patch.token === 'string' ? extractToken(patch.token) : null
      if (!token || !parseToken(token)) return { ok: false, field: 'token', message: TOKEN_REFUSED }
      next.token = token
    }
    if (patch.hostname !== undefined) {
      const result = normalizeHostname(typeof patch.hostname === 'string' ? patch.hostname : '')
      if (!result.ok) return { ok: false, field: 'hostname', message: result.message }
      next.hostname = result.hostname
    }
    if (patch.port !== undefined) {
      if (!isValidTunnelPort(patch.port)) return { ok: false, field: 'port', message: 'Choose a port from 1024 to 65535.' }
      next.port = patch.port
    }
    if (patch.allowInternetPairing !== undefined) next.allowInternetPairing = patch.allowInternetPairing === true

    const before = this.store.get()
    const changed = {
      token: next.token !== undefined && next.token !== before.token,
      port: next.port !== undefined && next.port !== before.port,
      hostname: next.hostname !== undefined && next.hostname !== before.hostname
    }
    this.store.update(next)
    if (changed.hostname || changed.port) this.recheckIngress()
    if (changed.token) {
      // A new token is a new tunnel, maybe: what the old one reported is moot.
      this.ingress = null
      this.ingressWarning = null
      if (this.localError?.kind === 'bad-token' || this.localError?.kind === 'unauthorized') this.localError = null
      void this.restart()
    } else if (changed.port) {
      // The host re-listens on the new port and attaches again.
      if (this.localError?.kind === 'port-in-use') this.localError = null
      this.sync()
    } else {
      this.publish()
    }
    return { ok: true, changed }
  }

  forgetToken(): void {
    this.store.update({ token: null })
    this.ingress = null
    this.ingressWarning = null
    this.localError = null
    this.sync()
  }

  /** Try again now: after an error, or to cut a backoff short. */
  retry(): void {
    if (this.localError?.kind !== 'port-in-use') this.localError = null
    if (this.process) this.process.retryNow()
    else this.sync()
    this.publish()
  }

  /** Gets (or updates) Spettro's own cloudflared, then runs the tunnel with
   *  it if it should be running. */
  async installCloudflared(): Promise<void> {
    if (this.installer.isRunning) return
    const wasRunning = this.process !== null
    await this.stopProcess()
    this.stage = 'downloading'
    this.downloadProgress = null
    this.publish()
    try {
      const installed = await this.installer.install((p) => {
        this.downloadProgress = p
        this.publish()
      })
      this.binary = { path: installed.path, version: installed.version, source: 'downloaded' }
      this.note(`Downloaded cloudflared ${installed.version}.`)
      this.localError = null
    } catch (error) {
      this.installFailed(error)
    } finally {
      this.stage = 'idle'
    }
    if (wasRunning || !this.localError) this.sync()
    this.publish()
  }

  /** Connects to wss://<hostname>/ the way a phone away from home would, and
   *  waits for this host's hello. */
  checkFromInternet(hostId: string): Promise<RemoteTunnelCheck> {
    const { hostname, port } = this.store.get()
    if (hostname === '') return Promise.resolve({ ok: false, message: 'Add the public hostname first.' })
    const open = this.options.openSocket ?? ((url: string) => new WebSocket(url, { handshakeTimeout: CHECK_TIMEOUT_MS }))
    return new Promise((resolve) => {
      let done = false
      let socket: WebSocket
      const finish = (result: RemoteTunnelCheck): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        try {
          socket.terminate()
        } catch {
          /* gone */
        }
        resolve(result)
      }
      const timer = setTimeout(
        () => finish({ ok: false, message: `${hostname} didn’t answer in time. Check that the tunnel is connected.` }),
        CHECK_TIMEOUT_MS
      )
      try {
        socket = open(`wss://${hostname}/`)
      } catch (error) {
        finish({ ok: false, message: `Couldn’t connect to ${hostname}: ${error instanceof Error ? error.message : String(error)}` })
        return
      }
      socket.on('message', (data) => {
        try {
          const frame = JSON.parse(data.toString()) as { method?: string; params?: { hostID?: string } }
          if (frame.method !== RemoteMethod.hello) return
          finish(
            frame.params?.hostID === hostId
              ? { ok: true, message: `This computer answers at ${hostname}.` }
              : { ok: false, message: `Something else answers at ${hostname}. Check which tunnel its public hostname belongs to.` }
          )
        } catch {
          /* not ours */
        }
      })
      socket.on('unexpected-response', (_req, res) => {
        finish({ ok: false, message: describeHttpFailure(res.statusCode ?? 0, hostname, port) })
      })
      socket.on('error', (error: Error & { code?: string }) => {
        if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
          finish({ ok: false, message: `${hostname} doesn’t exist yet. Check the public hostname in Cloudflare.` })
        } else {
          finish({ ok: false, message: `Couldn’t connect to ${hostname}: ${error.message}` })
        }
      })
    })
  }

  // MARK: Running

  /** Starts or stops cloudflared to match what should be. */
  private sync(): void {
    const { enabled, token, port } = this.store.get()
    const relayUp = this.listenPort !== null
    const wanted = enabled && token !== null && relayUp
    if (wanted && this.listenPort !== port) {
      // The relay fell back to another port (the pinned one was taken), so
      // the dashboard's route leads nowhere: don't start cloudflared at all.
      void this.stopProcess()
      this.localError = { kind: 'port-in-use', message: portInUseMessage(port) }
      this.publish()
      return
    }
    if (this.localError?.kind === 'port-in-use') this.localError = null
    if (wanted && !this.process && !this.starting && !this.localError) {
      void this.startProcess()
      return
    }
    if (!wanted) void this.stopProcess()
    this.publish()
  }

  private async restart(): Promise<void> {
    await this.stopProcess()
    this.sync()
  }

  private async startProcess(): Promise<void> {
    const generation = ++this.generation
    const settings = this.store.get()
    if (!settings.token) return
    this.starting = true
    this.stage = 'locating'
    this.localError = null
    this.publish()
    try {
      this.killOrphan()
      let found = await (this.options.locate ?? locateCloudflared)({
        dataDir: this.options.dataDir,
        explicitPath: settings.binaryPath,
        platform: this.platform
      })
      if (generation !== this.generation) return
      if (!found) {
        this.stage = 'downloading'
        this.downloadProgress = null
        this.publish()
        let installed: InstalledCloudflared
        try {
          installed = await this.installer.install((p) => {
            this.downloadProgress = p
            this.publish()
          })
        } catch (error) {
          if (generation === this.generation) this.installFailed(error)
          return
        }
        if (generation !== this.generation) return
        this.note(`Downloaded cloudflared ${installed.version}.`)
        found = { path: installed.path, version: installed.version, source: 'downloaded' }
      }
      this.binary = found
      this.note(found.version ? `Using cloudflared ${found.version} at ${found.path}.` : `Using cloudflared at ${found.path}.`)
      mkdirSync(dirname(this.configFile), { recursive: true })
      // An empty config of our own: without --config, cloudflared would
      // load ~/.cloudflared/config.yml and whatever it says.
      writeFileSync(this.configFile, '{}\n')
      const create =
        this.options.createProcess ?? ((options, onChange) => new TunnelProcess(options, onChange))
      const proc = create(
        {
          binaryPath: found.path,
          token: settings.token,
          configPath: this.configFile,
          platform: this.platform,
          onPid: (pid) => this.writePid(pid)
        },
        (snapshot) => {
          if (this.process !== proc) return
          this.processChanged(snapshot)
        }
      )
      this.process = proc
      this.stage = 'running'
      this.snapshot = proc.state
      proc.start()
    } catch (error) {
      if (generation === this.generation) {
        this.localError = { kind: 'launch', message: `cloudflared couldn’t start: ${error instanceof Error ? error.message : String(error)}` }
      }
    } finally {
      if (generation === this.generation) {
        this.starting = false
        if (this.stage !== 'running') this.stage = 'idle'
      }
      this.publish()
    }
  }

  private async stopProcess(): Promise<void> {
    this.generation++
    this.starting = false
    if (this.stage === 'downloading' || this.stage === 'locating') this.installer.cancel()
    this.stage = 'idle'
    const proc = this.process
    this.process = null
    if (!proc) return
    this.publish()
    await proc.stop()
    this.snapshot = proc.state
    this.publish()
  }

  private processChanged(snapshot: TunnelProcessSnapshot): void {
    const ingressArrived = snapshot.ingress !== null && snapshot.ingress !== this.ingress
    this.snapshot = snapshot
    if (ingressArrived) {
      this.ingress = snapshot.ingress
      this.recheckIngress()
    }
    this.publish()
  }

  /** Checks the dashboard's routes against the hostname and port, filling
   *  in the hostname when the user left it blank and one route fits. */
  private recheckIngress(): void {
    if (!this.ingress) {
      this.ingressWarning = null
      return
    }
    const { hostname, port } = this.store.get()
    const check = checkIngress(this.ingress, hostname, port)
    if (check.suggestedHostname) {
      this.store.update({ hostname: check.suggestedHostname })
      this.note(`Found the public hostname ${check.suggestedHostname} in the tunnel’s settings.`)
    }
    this.ingressWarning = check.warning
  }

  private installFailed(error: unknown): void {
    if (error instanceof CloudflaredInstallError && error.kind === 'cancelled') return
    const kind: RemoteTunnelErrorKind =
      error instanceof CloudflaredInstallError && error.kind === 'unsupported-platform' ? 'unsupported-platform' : 'download-failed'
    const message = error instanceof Error ? error.message : String(error)
    this.localError = { kind, message }
    this.note(message)
  }

  // MARK: A cloudflared left behind

  private writePid(pid: number | null): void {
    try {
      if (pid === null) rmSync(this.pidFile, { force: true })
      else writeFileSync(this.pidFile, String(pid))
    } catch {
      /* best effort */
    }
  }

  /** A crash of the app leaves its cloudflared running, still serving the
   *  hostname (the kill switch refuses it, but it keeps a connector up).
   *  The next start ends it — on Linux only once /proc confirms the pid is
   *  still a cloudflared, since pids get reused; elsewhere it is left to
   *  the kill switch. */
  private killOrphan(): void {
    if (!existsSync(this.pidFile)) return
    try {
      const pid = Number.parseInt(readFileSync(this.pidFile, 'utf8').trim(), 10)
      if (Number.isInteger(pid) && pid > 1 && this.platform === 'linux') {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        if (/cloudflared/.test(cmdline) && cmdline.includes(this.configFile)) process.kill(pid, 'SIGTERM')
      }
    } catch {
      // Gone already, or not ours.
    }
    rmSync(this.pidFile, { force: true })
  }

  private note(line: string): void {
    this.notes = [...this.notes, line].slice(-10)
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private publish(): void {
    this.options.onChange()
  }
}

function describeHttpFailure(status: number, hostname: string, port: number): string {
  switch (status) {
    case 530:
      return `Cloudflare can’t reach this computer’s tunnel. Check that it’s connected.`
    case 502:
      return `Cloudflare reached the tunnel but not Spettro. In Cloudflare, set ${hostname}’s service to HTTP, localhost:${port}.`
    case 404:
      return `${hostname} isn’t routed to this tunnel. Add it as a public hostname of the tunnel in Cloudflare.`
    case 401:
    case 403:
      return `Cloudflare blocked the connection, probably a Cloudflare Access policy on ${hostname}. Phones can’t sign in to Access.`
    default:
      return `${hostname} answered with HTTP ${status} instead of Spettro.`
  }
}

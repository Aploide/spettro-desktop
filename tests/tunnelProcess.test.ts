// cloudflared as the tunnel sees it: its log read line by line (the message
// strings are cloudflared's own), the dashboard's route checked against the
// relay's port, and the process kept alive — restarted with backoff, and not
// restarted when it was told no. No cloudflared runs: a fake child is fed
// the lines a real one writes.

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkIngress,
  displayLine,
  hostnameMatches,
  parseIngress,
  parseLogLine,
  servicePointsAt,
  signalFor
} from '@main/remote/tunnel/tunnelLog'
import {
  RESTART_BACKOFF_S,
  EXIT_DRAIN_MS,
  STABLE_RESET_MS,
  STUCK_RESTART_MS,
  TunnelProcess,
  backoffDelayMs,
  tunnelArgs,
  tunnelEnv,
  type ReadyReport,
  type TunnelProcessSnapshot
} from '@main/remote/tunnel/tunnelProcess'

const CONNECTOR = '6f0c9a52-6f43-4bd4-9a7e-3b55e2d3c1aa'
const CONFIG =
  '{"ingress":[{"hostname":"spettro.example.com","originRequest":{},"service":"http://localhost:7879"},{"service":"http_status:404"}],"warp-routing":{"enabled":false}}'

/** A JSON log line the way `--output json` writes one. */
function json(message: string, fields: Record<string, unknown> = {}, level = 'info'): string {
  return JSON.stringify({ level, time: '2026-10-09T09:07:20Z', ...fields, message })
}

const LINES = {
  metrics: json('Starting metrics server on 127.0.0.1:41234/metrics'),
  connector: json(`Generated Connector ID: ${CONNECTOR}`),
  registered: (connIndex: number, location: string, protocol = 'quic') =>
    json('Registered tunnel connection', {
      connIndex,
      connection: '0d8f1d0b-1111-4a2b-9c3d-1234567890ab',
      event: 0,
      ip: '198.41.200.13',
      location,
      protocol
    }),
  terminated: (connIndex: number) =>
    json('Connection terminated', { connIndex, error: 'timeout: no recent network activity' }, 'error'),
  unregistered: (connIndex: number) => json('Unregistered tunnel connection', { connIndex, ip: '198.41.200.13' }),
  retrying: json('Retrying connection in up to 4s', { connIndex: 0, event: 0, ip: '198.41.200.13' }),
  dialFailed: json('Failed to dial a quic connection', { connIndex: 0, error: 'failed to dial to edge with quic: timeout' }, 'error'),
  serverRefused: json('Register tunnel error from server side', { connIndex: 0, error: 'Unauthorized: Invalid tunnel secret' }, 'error'),
  udp: json(
    'If this log occurs persistently, and cloudflared is unable to connect to Cloudflare Network with `quic` protocol, then most likely your machine/network is getting its egress UDP to port 7844 (or others) blocked or dropped. Make sure to allow egress connectivity as per https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/configuration/ports-and-ips/',
    { connIndex: 0 },
    'warn'
  ),
  config: json('Updated to new configuration', { version: 3, config: CONFIG }),
  badToken: 'Provided Tunnel token is not valid.'
}

describe('reading the log', () => {
  it('reads JSON lines, plain usage errors and the default format', () => {
    expect(parseLogLine(LINES.metrics)).toEqual({
      level: 'info',
      message: 'Starting metrics server on 127.0.0.1:41234/metrics',
      fields: {}
    })
    expect(parseLogLine(LINES.badToken)).toEqual({ level: null, message: LINES.badToken, fields: {} })
    expect(
      parseLogLine('2026-10-09T09:07:20Z INF Registered tunnel connection connIndex=1 location=ams02 protocol=http2')
    ).toEqual({ level: 'info', message: 'Registered tunnel connection', fields: { connIndex: '1', location: 'ams02', protocol: 'http2' } })
  })

  it('knows what each line means', () => {
    const signal = (line: string): unknown => signalFor(parseLogLine(line))
    expect(signal(LINES.metrics)).toEqual({ kind: 'metrics', port: 41234 })
    expect(signal(LINES.connector)).toEqual({ kind: 'connector', id: CONNECTOR })
    expect(signal(LINES.registered(2, 'fra08'))).toEqual({ kind: 'registered', connIndex: 2, location: 'fra08', protocol: 'quic' })
    expect(signal(LINES.terminated(2))).toEqual({ kind: 'unregistered', connIndex: 2 })
    expect(signal(LINES.unregistered(1))).toEqual({ kind: 'unregistered', connIndex: 1 })
    expect(signal(LINES.retrying)).toEqual({ kind: 'retrying' })
    expect(signal(LINES.dialFailed)).toMatchObject({ kind: 'network' })
    expect(signal(LINES.serverRefused)).toMatchObject({ kind: 'fatal', fatal: 'unauthorized' })
    expect(signal(json('Register tunnel error from server side', { error: 'server busy, try again' }, 'error'))).toMatchObject({
      kind: 'network'
    })
    expect(signal(LINES.udp)).toEqual({ kind: 'udp-blocked' })
    expect(signal(LINES.badToken)).toMatchObject({ kind: 'fatal', fatal: 'bad-token' })
    expect(signal('flag provided but not defined: -output')).toMatchObject({ kind: 'fatal', fatal: 'launch' })
    expect(signal(LINES.config)).toEqual({
      kind: 'config',
      ingress: [{ hostname: 'spettro.example.com', service: 'http://localhost:7879' }, { service: 'http_status:404' }]
    })
    expect(signal(json('Initial protocol quic'))).toBeNull()
  })

  it('keeps the token out of what it shows', () => {
    const token = Buffer.from(JSON.stringify({ a: 'x'.repeat(32), t: CONNECTOR, s: 'c2VjcmV0' })).toString('base64')
    const line = displayLine(parseLogLine(json('Settings', { token })))
    expect(line).not.toContain(token)
    expect(line).toContain('[token]')
    // The config is long and says nothing a person needs.
    expect(displayLine(parseLogLine(LINES.config))).toBe('INFO Updated to new configuration version=3')
  })
})

describe('the dashboard’s route', () => {
  const rules = parseIngress(CONFIG) ?? []

  it('matches hostnames as cloudflared does', () => {
    expect(hostnameMatches('spettro.example.com', 'Spettro.Example.com')).toBe(true)
    expect(hostnameMatches('*.example.com', 'spettro.example.com')).toBe(true)
    expect(hostnameMatches('*.example.com', 'example.com')).toBe(false)
    expect(hostnameMatches(undefined, 'anything.example.com')).toBe(true)
    expect(hostnameMatches('other.example.com', 'spettro.example.com')).toBe(false)
  })

  it('accepts plain HTTP to this computer on the pinned port', () => {
    expect(servicePointsAt('http://localhost:7879', 7879)).toBe(true)
    expect(servicePointsAt('http://127.0.0.1:7879', 7879)).toBe(true)
    expect(servicePointsAt('http://[::1]:7879', 7879)).toBe(true)
    expect(servicePointsAt('ws://localhost:7879', 7879)).toBe(true)
    expect(servicePointsAt('https://localhost:7879', 7879)).toBe(false)
    expect(servicePointsAt('http://localhost:8080', 7879)).toBe(false)
    expect(servicePointsAt('http://192.168.1.20:7879', 7879)).toBe(false)
    expect(servicePointsAt('http_status:404', 7879)).toBe(false)
  })

  it('is quiet when the hostname reaches the relay', () => {
    expect(checkIngress(rules, 'spettro.example.com', 7879)).toEqual({ warning: null, suggestedHostname: null })
    const wildcard = [{ hostname: '*.example.com', service: 'http://localhost:7879' }]
    expect(checkIngress(wildcard, 'spettro.example.com', 7879).warning).toBeNull()
  })

  it('says what to change when it doesn’t', () => {
    expect(checkIngress(rules, 'spettro.example.com', 8123).warning).toBe(
      'In Cloudflare, spettro.example.com sends traffic to http://localhost:7879. Set its service type to HTTP and the URL to localhost:8123.'
    )
    expect(checkIngress([{ hostname: 'spettro.example.com', service: 'https://localhost:7879' }], 'spettro.example.com', 7879).warning).toMatch(
      /uses HTTPS/
    )
    expect(checkIngress(rules, 'other.example.com', 7879).warning).toBe(
      'other.example.com isn’t a public hostname of this tunnel. In Cloudflare, add it and set its service type to HTTP and the URL to localhost:7879.'
    )
  })

  it('fills in the hostname when exactly one reaches the relay', () => {
    expect(checkIngress(rules, '', 7879)).toEqual({ warning: null, suggestedHostname: 'spettro.example.com' })
    expect(checkIngress(rules, '', 8123).suggestedHostname).toBeNull()
    const two = [...rules, { hostname: 'two.example.com', service: 'http://127.0.0.1:7879' }]
    expect(checkIngress(two, '', 7879)).toMatchObject({ suggestedHostname: null, warning: expect.stringMatching(/More than one/) })
  })
})

describe('backoff', () => {
  it('waits 1, 2, 5, 10, 30, then 60 seconds, and stays at 60', () => {
    expect(RESTART_BACKOFF_S).toEqual([1, 2, 5, 10, 30, 60])
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(backoffDelayMs)).toEqual([1000, 2000, 5000, 10000, 30000, 60000, 60000, 60000])
  })
})

describe('the command', () => {
  it('runs a remotely managed tunnel, isolated from the user’s own config', () => {
    const args = tunnelArgs('/data/cloudflared/config.yml')
    expect(args[0]).toBe('tunnel')
    expect(args.at(-1)).toBe('run')
    expect(args).toEqual(
      expect.arrayContaining(['--no-autoupdate', '--config', '/data/cloudflared/config.yml', '--metrics', '127.0.0.1:0', '--output', 'json'])
    )
    expect(args).not.toContain('--url')
    expect(args.join(' ')).not.toMatch(/token/)
  })

  it('passes the token in the environment, and nothing else the shell set for cloudflared', () => {
    const env = tunnelEnv('eyJtoken', { PATH: '/usr/bin', TUNNEL_URL: 'http://x', TUNNEL_ORIGIN_CERT: '/c', HOME: '/h' })
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/h', TUNNEL_TOKEN: 'eyJtoken', NO_AUTOUPDATE: 'true' })
  })
})

/** A child process that is told what to say. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly signals: string[] = []
  pid = 4242
  exited = false

  kill(signal: string = 'SIGTERM'): boolean {
    this.signals.push(signal)
    return true
  }

  say(...lines: string[]): void {
    for (const line of lines) this.stderr.emit('data', Buffer.from(`${line}\n`))
  }

  /** Exits, its output drained: 'exit', then 'close'. */
  exit(code: number | null): void {
    this.exited = true
    this.emit('exit', code)
    this.emit('close', code)
  }
}

describe('TunnelProcess', () => {
  let children: FakeChild[]
  let spawned: { command: string; args: string[]; env: NodeJS.ProcessEnv }[]
  let snapshots: TunnelProcessSnapshot[]
  let ready: ReadyReport | null

  beforeEach(() => {
    vi.useFakeTimers()
    children = []
    spawned = []
    snapshots = []
    ready = null
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function supervisor(): TunnelProcess {
    return new TunnelProcess(
      {
        binaryPath: '/usr/bin/cloudflared',
        token: 'eyJtoken',
        configPath: '/data/cloudflared/config.yml',
        platform: 'linux',
        env: { PATH: '/usr/bin' },
        now: () => Date.now(),
        probeReady: async () => ready,
        spawn: (command, args, options) => {
          const child = new FakeChild()
          children.push(child)
          spawned.push({ command, args, env: options.env as NodeJS.ProcessEnv })
          return child as unknown as ChildProcess
        }
      },
      (s) => snapshots.push(s)
    )
  }

  const last = (): TunnelProcessSnapshot => snapshots[snapshots.length - 1]

  it('is connected once cloudflared registers, and says where', () => {
    const p = supervisor()
    p.start()
    expect(last().phase).toBe('starting')
    expect(spawned[0].env.TUNNEL_TOKEN).toBe('eyJtoken')
    children[0].say(LINES.connector, LINES.registered(0, 'fra08'), LINES.registered(1, 'ams02', 'quic'))
    expect(last()).toMatchObject({ phase: 'connected', connections: 2, locations: ['fra08', 'ams02'], protocol: 'quic', connectorId: CONNECTOR })
    children[0].say(LINES.terminated(0))
    expect(last()).toMatchObject({ phase: 'connected', connections: 1, locations: ['ams02'] })
    children[0].say(LINES.unregistered(1))
    expect(last()).toMatchObject({ phase: 'reconnecting', connections: 0 })
  })

  it('reads the dashboard’s routes and a blocked UDP', () => {
    const p = supervisor()
    p.start()
    children[0].say(LINES.config, LINES.udp)
    expect(last().ingress).toEqual(parseIngress(CONFIG))
    expect(last().udpBlocked).toBe(true)
  })

  it('restarts after an unexpected exit on the backoff schedule', async () => {
    const p = supervisor()
    p.start()
    for (let i = 0; i < 3; i++) {
      children[i].exit(1)
      expect(last()).toMatchObject({ phase: 'reconnecting', retryAt: Date.now() + RESTART_BACKOFF_S[i] * 1000 })
      expect(last().error?.kind).toBe('exited')
      await vi.advanceTimersByTimeAsync(RESTART_BACKOFF_S[i] * 1000 - 1)
      expect(children).toHaveLength(i + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(children).toHaveLength(i + 2)
    }
  })

  it('forgets the last run’s connector id when it starts again', async () => {
    const p = supervisor()
    p.start()
    children[0].say(LINES.connector)
    expect(last().connectorId).toBe(CONNECTOR)
    children[0].exit(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(children).toHaveLength(2)
    expect(last().connectorId).toBeNull()
  })

  it('starts the backoff over after two minutes connected', async () => {
    const p = supervisor()
    p.start()
    children[0].exit(1)
    await vi.advanceTimersByTimeAsync(1000)
    children[1].exit(1)
    await vi.advanceTimersByTimeAsync(2000)
    children[2].say(LINES.registered(0, 'fra08'))
    await vi.advanceTimersByTimeAsync(STABLE_RESET_MS)
    children[2].exit(1)
    expect(last().retryAt).toBe(Date.now() + 1000)
  })

  it('calls a failure to reach the edge a network problem', () => {
    const p = supervisor()
    p.start()
    children[0].say(LINES.dialFailed)
    expect(last().error).toEqual({ kind: 'network', message: 'Can’t reach Cloudflare. Check your connection.' })
    children[0].exit(1)
    expect(last()).toMatchObject({ phase: 'reconnecting', error: { kind: 'network' } })
  })

  it('doesn’t restart a refused token', async () => {
    const p = supervisor()
    p.start()
    children[0].say(LINES.badToken)
    children[0].exit(255)
    expect(last()).toMatchObject({
      phase: 'failed',
      retryAt: null,
      error: { kind: 'bad-token', message: 'That tunnel token wasn’t accepted. Copy it again from the Cloudflare dashboard.' }
    })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(children).toHaveLength(1)
  })

  it('reads why it stopped even when that arrives after the exit', async () => {
    const p = supervisor()
    p.start()
    children[0].emit('exit', 255)
    children[0].say(LINES.badToken)
    children[0].emit('close', 255)
    expect(last()).toMatchObject({ phase: 'failed', error: { kind: 'bad-token' } })
  })

  it('acts on an exit whose output never finishes draining', async () => {
    const p = supervisor()
    p.start()
    children[0].emit('exit', 1)
    expect(last().phase).toBe('starting')
    await vi.advanceTimersByTimeAsync(EXIT_DRAIN_MS)
    expect(last()).toMatchObject({ phase: 'reconnecting', error: { kind: 'exited' } })
  })

  it('doesn’t restart on any usage error', async () => {
    const p = supervisor()
    p.start()
    children[0].say('Incorrect Usage: flag provided but not defined: -grace-period')
    children[0].exit(255)
    expect(last()).toMatchObject({ phase: 'failed', error: { kind: 'launch' } })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(children).toHaveLength(1)
  })

  it('stops a tunnel the edge rejected, and leaves it stopped', async () => {
    const p = supervisor()
    p.start()
    children[0].say(LINES.serverRefused)
    expect(children[0].signals).toEqual(['SIGTERM'])
    children[0].exit(0)
    expect(last()).toMatchObject({ phase: 'failed', error: { kind: 'unauthorized' } })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(children).toHaveLength(1)
  })

  it('stops with SIGTERM, again to skip the grace period, then SIGKILL', async () => {
    const p = supervisor()
    p.start()
    const stopped = p.stop()
    expect(children[0].signals).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(200)
    expect(children[0].signals).toEqual(['SIGTERM', 'SIGTERM'])
    await vi.advanceTimersByTimeAsync(3000)
    expect(children[0].signals).toEqual(['SIGTERM', 'SIGTERM', 'SIGKILL'])
    children[0].exit(null)
    await stopped
    expect(last().phase).toBe('stopped')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(children).toHaveLength(1)
  })

  it('quits with one signal and no restart', async () => {
    const p = supervisor()
    p.start()
    p.stopNow()
    expect(children[0].signals).toEqual(['SIGTERM'])
    children[0].exit(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(children).toHaveLength(1)
  })

  it('learns its connector id from /ready, and restarts a process stuck without connections', async () => {
    const p = supervisor()
    p.start()
    ready = { readyConnections: 0, connectorId: CONNECTOR }
    children[0].say(LINES.metrics)
    await vi.advanceTimersByTimeAsync(0)
    expect(last().connectorId).toBe(CONNECTOR)
    await vi.advanceTimersByTimeAsync(STUCK_RESTART_MS)
    expect(children[0].signals).toContain('SIGTERM')
    children[0].exit(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(children).toHaveLength(2)
  })

  it('says so when cloudflared is gone', () => {
    const p = supervisor()
    p.start()
    children[0].emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    expect(last()).toMatchObject({ phase: 'failed', error: { kind: 'binary-missing' } })
  })

  it('tries again at once when asked', async () => {
    const p = supervisor()
    p.start()
    children[0].exit(1)
    children.length = 1
    p.retryNow()
    expect(children).toHaveLength(2)
    expect(last().retryAt).toBeNull()
  })
})

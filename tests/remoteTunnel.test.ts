// The tunnel inside the remote host: the switch, the settings, the port it
// pins, what phones are told, and who gets in through it. cloudflared is a
// fake process the test drives, the listener a fake that reports the port it
// was asked for, and connections are handed to acceptSocket the way the
// listener would hand them over — so nothing here reaches a network.

import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WebSocket, WebSocketServer } from 'ws'
import type { RemoteBridge } from '@main/remote/bridge'
import type { ConnectionOrigin } from '@main/remote/connectionGuard'
import { RemoteHost } from '@main/remote/host'
import { base64urlDecode, computeProof } from '@main/remote/pairing'
import type { TunnelProcessLike } from '@main/remote/tunnel/remoteTunnel'
import type { TunnelProcessOptions, TunnelProcessSnapshot } from '@main/remote/tunnel/tunnelProcess'
import type { JSONValue } from '@shared/acp'
import { RemoteFeature, RemoteMethod, REMOTE_HOST_FEATURES } from '@shared/remote'

type Frame = { [key: string]: JSONValue }

const CONNECTOR = '6f0c9a52-6f43-4bd4-9a7e-3b55e2d3c1aa'
const TUNNEL_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const TOKEN = Buffer.from(
  JSON.stringify({ a: '0123456789abcdef0123456789abcdef', t: TUNNEL_ID, s: Buffer.alloc(32, 7).toString('base64') })
).toString('base64')

class FakeSocket extends EventEmitter {
  readonly sent: Frame[] = []
  closed = false
  closeCode: number | undefined
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Frame)
  }
  close(code?: number): void {
    if (this.closed) return
    this.closed = true
    this.closeCode = code
    this.emit('close')
  }
  receive(frame: Frame): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)))
  }
  notifications(method: string): Frame[] {
    return this.sent.filter((f) => f.method === method)
  }
  reply(id: number): Frame | undefined {
    return this.sent.find((f) => f.id === id && f.method === undefined)
  }
}

/** A cloudflared the test speaks for. */
class FakeProcess implements TunnelProcessLike {
  isRunning = false
  stopped = 0
  stoppedNow = 0
  retried = 0
  state: TunnelProcessSnapshot = {
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
  constructor(
    readonly options: TunnelProcessOptions,
    private readonly onChange: (s: TunnelProcessSnapshot) => void
  ) {}
  start(): void {
    this.isRunning = true
    this.emit({ phase: 'starting' })
  }
  async stop(): Promise<void> {
    this.stopped++
    this.isRunning = false
    this.emit({ phase: 'stopped' })
  }
  stopNow(): void {
    this.stoppedNow++
    this.isRunning = false
  }
  retryNow(): void {
    this.retried++
  }
  resetBackoff(): void {}
  emit(patch: Partial<TunnelProcessSnapshot>): void {
    this.state = { ...this.state, ...patch }
    this.onChange(this.state)
  }
  connect(): void {
    this.emit({ phase: 'connected', connections: 4, locations: ['fra08', 'ams02'], protocol: 'quic', connectorId: CONNECTOR })
  }
}

/** What the host's listener needs from a WebSocketServer. */
class FakeServer extends EventEmitter {
  readonly clients = new Set<WebSocket>()
  constructor(readonly port: number) {
    super()
  }
  address(): { port: number } {
    return { port: this.port }
  }
  close(): void {}
}

function fakeBridge(): RemoteBridge {
  return {
    listChats: () => [],
    openChat: () => null,
    closeChat: () => undefined,
    newChat: () => {
      throw new Error('no')
    },
    deleteChat: () => undefined,
    flagChat: () => undefined,
    renameChat: () => false,
    listProjects: () => [],
    projectFiles: async () => null,
    prompt: async () => undefined,
    cancelChat: () => undefined,
    setConfig: async () => undefined,
    agentCall: async () => null,
    resolvePermission: () => undefined,
    answerQuestion: () => undefined,
    agentReady: () => true,
    pendingPrompts: () => [],
    events: new EventEmitter()
  } as unknown as RemoteBridge
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
async function settleAll(): Promise<void> {
  for (let i = 0; i < 5; i++) await settle()
}

let dir: string
let host: RemoteHost
let processes: FakeProcess[]
let located: { path: string; version: string; source: 'system' | 'downloaded' } | null
let installs: number
let takenPorts: Set<number>
let sharing: boolean[]
let nextId: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spettro-tunnel-'))
  processes = []
  located = { path: '/usr/bin/cloudflared', version: '2026.8.2', source: 'system' }
  installs = 0
  takenPorts = new Set()
  sharing = []
  nextId = 1
})

afterEach(() => {
  host?.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

function makeHost(): RemoteHost {
  host = new RemoteHost(fakeBridge(), {
    dataDir: dir,
    onStateChanged: () => undefined,
    onSharingChanged: (on) => sharing.push(on),
    tunnel: {
      locate: async () => located,
      installer: {
        isRunning: false,
        cancel: () => undefined,
        install: async () => {
          installs++
          throw Object.assign(new Error('Couldn’t reach GitHub to get cloudflared.'), { kind: 'download-failed' })
        }
      },
      createProcess: (options, onChange) => {
        const p = new FakeProcess(options, onChange)
        processes.push(p)
        return p
      },
      openSocket: (url) => openSocket(url)
    }
  })
  const internals = host as unknown as {
    advertiser: { start(): void; stop(): void }
    listen(port: number): Promise<WebSocketServer>
  }
  internals.advertiser = { start: () => undefined, stop: () => undefined }
  internals.listen = async (port) => {
    if (takenPorts.has(port)) throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
    return new FakeServer(port === 0 ? 50123 : port) as unknown as WebSocketServer
  }
  return host
}

let openSocket: (url: string) => WebSocket = () => {
  throw new Error('no network in tests')
}

const tunneled: ConnectionOrigin = { via: 'tunnel', peerIp: '203.0.113.9', connectorTag: CONNECTOR }

/** A configured tunnel, switched on and connected. */
async function connectedTunnel(): Promise<FakeProcess> {
  makeHost()
  expect(await host.configureTunnel({ token: `sudo cloudflared service install ${TOKEN}`, hostname: 'spettro.example.com' })).toEqual({ ok: true })
  await host.setTunnelEnabled(true)
  await settleAll()
  const p = processes.at(-1) as FakeProcess
  p.connect()
  return p
}

function connect(origin?: ConnectionOrigin): { socket: FakeSocket; accepted: boolean } {
  const socket = new FakeSocket()
  const session = host.acceptSocket(socket as unknown as WebSocket, origin)
  return { socket, accepted: session !== null }
}

function hello(socket: FakeSocket): Frame {
  return socket.notifications(RemoteMethod.hello)[0].params as Frame
}

function auth(socket: FakeSocket, params: Frame): number {
  const id = nextId++
  socket.receive({ jsonrpc: '2.0', id, method: RemoteMethod.auth, params })
  return id
}

function resume(socket: FakeSocket, deviceId: string, key: Buffer): number {
  const challenge = base64urlDecode(hello(socket).challenge as string) as Buffer
  return auth(socket, {
    mode: 'resume',
    deviceID: deviceId,
    deviceName: 'Pixel',
    platform: 'android',
    proof: computeProof(key, challenge, host.hostId),
    protocolVersion: 1
  })
}

describe('tunnel settings', () => {
  it('start off, with nothing configured', () => {
    makeHost()
    expect(host.getState().tunnel).toMatchObject({
      enabled: false,
      hostname: '',
      hasToken: false,
      tunnelId: null,
      port: 7879,
      allowInternetPairing: false,
      status: 'off'
    })
    expect(host.getState().tunneledDeviceIds).toEqual([])
  })

  it('take the token out of the dashboard’s command, and never give it back', async () => {
    makeHost()
    expect(await host.configureTunnel({ token: `cloudflared.exe service install ${TOKEN}` })).toEqual({ ok: true })
    const state = host.getState()
    expect(state.tunnel).toMatchObject({ hasToken: true, tunnelId: TUNNEL_ID })
    expect(JSON.stringify(state)).not.toContain(TOKEN)
  })

  it('refuse what isn’t right, naming the field, and save nothing', async () => {
    makeHost()
    expect(await host.configureTunnel({ token: 'not a token', hostname: 'spettro.example.com' })).toMatchObject({ ok: false, field: 'token' })
    expect(await host.configureTunnel({ hostname: 'x.trycloudflare.com' })).toMatchObject({ ok: false, field: 'hostname' })
    expect(await host.configureTunnel({ port: 80 })).toEqual({ ok: false, field: 'port', message: 'Choose a port from 1024 to 65535.' })
    expect(host.getState().tunnel).toMatchObject({ hasToken: false, hostname: '', port: 7879 })
  })

  it('wait for a token before anything runs', async () => {
    makeHost()
    await host.setTunnelEnabled(true)
    await settleAll()
    expect(host.getState().tunnel.status).toBe('needs-setup')
    expect(processes).toHaveLength(0)
  })

  it('forget the token on request', async () => {
    const p = await connectedTunnel()
    host.forgetTunnelToken()
    await settleAll()
    expect(p.stopped).toBe(1)
    expect(host.getState().tunnel).toMatchObject({ hasToken: false, status: 'needs-setup' })
  })
})

describe('the tunnel switch', () => {
  it('turns remote access on, and runs cloudflared with the token', async () => {
    const p = await connectedTunnel()
    expect(sharing).toEqual([true])
    expect(host.getState().enabled).toBe(true)
    expect(p.options).toMatchObject({ binaryPath: '/usr/bin/cloudflared', token: TOKEN })
    expect(host.getState().tunnel).toMatchObject({
      enabled: true,
      status: 'connected',
      connections: 4,
      locations: ['fra08', 'ams02'],
      protocol: 'quic',
      binary: { path: '/usr/bin/cloudflared', version: '2026.8.2', source: 'system' }
    })
  })

  it('is remembered, and comes back with remote access at launch', async () => {
    await connectedTunnel()
    host.shutdown()
    processes = []
    makeHost()
    expect(host.getState().tunnel.enabled).toBe(true)
    await host.restoreSharing(true)
    await settleAll()
    expect(processes).toHaveLength(1)
    expect(processes[0].isRunning).toBe(true)
  })

  it('stops cloudflared with remote access, and starts it again with it', async () => {
    const p = await connectedTunnel()
    await host.setEnabled(false)
    await settleAll()
    expect(p.stopped).toBe(1)
    expect(host.getState().tunnel).toMatchObject({ enabled: true, status: 'off' })
    await host.setEnabled(true)
    await settleAll()
    expect(processes).toHaveLength(2)
  })

  it('signals cloudflared synchronously when the app quits', async () => {
    const p = await connectedTunnel()
    host.shutdown()
    expect(p.stoppedNow).toBe(1)
  })

  it('gets Spettro its own cloudflared when there is none, and says why it couldn’t', async () => {
    located = null
    makeHost()
    await host.configureTunnel({ token: TOKEN })
    await host.setTunnelEnabled(true)
    await settleAll()
    expect(installs).toBe(1)
    expect(processes).toHaveLength(0)
    expect(host.getState().tunnel).toMatchObject({
      status: 'error',
      error: { kind: 'download-failed', message: 'Couldn’t reach GitHub to get cloudflared.' }
    })
  })
})

describe('the pinned port', () => {
  it('listens on the tunnel’s port', async () => {
    makeHost()
    await host.configureTunnel({ port: 8123 })
    await host.setEnabled(true)
    expect(host.getState().port).toBe(8123)
  })

  it('falls back for the LAN when it’s taken, and doesn’t start cloudflared', async () => {
    takenPorts.add(7879)
    makeHost()
    await host.configureTunnel({ token: TOKEN, hostname: 'spettro.example.com' })
    await host.setTunnelEnabled(true)
    await settleAll()
    expect(host.getState().port).toBe(50123)
    expect(processes).toHaveLength(0)
    expect(host.getState().tunnel).toMatchObject({
      status: 'error',
      error: {
        kind: 'port-in-use',
        message:
          'Port 7879 is in use by another program, so the tunnel can’t reach Spettro. Close it, or choose another port and update the service URL in Cloudflare.'
      }
    })
    // Freed: trying again listens there and starts the tunnel.
    takenPorts.clear()
    await host.retryTunnel()
    await settleAll()
    expect(host.getState().port).toBe(7879)
    expect(processes).toHaveLength(1)
  })

  it('moves the listener when the user picks another port', async () => {
    await connectedTunnel()
    await host.configureTunnel({ port: 9000 })
    await settleAll()
    expect(host.getState().port).toBe(9000)
    expect(host.getState().tunnel.error).toBeNull()
  })
})

describe('what phones are told', () => {
  it('announces remoteHost among the features', () => {
    expect(REMOTE_HOST_FEATURES).toContain(RemoteFeature.remoteHost)
  })

  it('puts the hostname in the auth result and the QR while the tunnel is on', async () => {
    await connectedTunnel()
    const key = host.pairDevice('phone-1', 'Pixel', 'android')
    const { socket } = connect()
    const id = resume(socket, 'phone-1', key)
    expect((socket.reply(id)?.result as Frame).remoteHost).toBe('spettro.example.com')
    await host.openPairing()
    expect(host.getState().pairingURL).toMatch(/&r=spettro\.example\.com$/)
  })

  it('leaves it out of the QR while the tunnel is off', async () => {
    makeHost()
    await host.configureTunnel({ hostname: 'spettro.example.com' })
    await host.openPairing()
    expect(host.getState().pairingURL).not.toMatch(/[?&]r=/)
  })

  it('tells attached phones when the tunnel goes on and off', async () => {
    makeHost()
    await host.configureTunnel({ token: TOKEN, hostname: 'spettro.example.com' })
    await host.setEnabled(true)
    const key = host.pairDevice('phone-1', 'Pixel', 'android')
    const { socket } = connect()
    resume(socket, 'phone-1', key)
    await settle()
    const states = (): JSONValue[] => socket.notifications(RemoteMethod.hostState).map((f) => (f.params as Frame).remoteHost)
    expect(states()).toEqual([''])
    await host.setTunnelEnabled(true)
    expect(states()).toEqual(['', 'spettro.example.com'])
    await host.configureTunnel({ hostname: 'other.example.com' })
    expect(states()).toEqual(['', 'spettro.example.com', 'other.example.com'])
    await host.setTunnelEnabled(false)
    expect(states()).toEqual(['', 'spettro.example.com', 'other.example.com', ''])
  })

  it('fills in the hostname from the dashboard’s route, and tells the phones', async () => {
    makeHost()
    await host.configureTunnel({ token: TOKEN })
    await host.setTunnelEnabled(true)
    await settleAll()
    const key = host.pairDevice('phone-1', 'Pixel', 'android')
    const { socket } = connect()
    resume(socket, 'phone-1', key)
    await settle()
    processes[0].emit({ ingress: [{ hostname: 'spettro.example.com', service: 'http://localhost:7879' }, { service: 'http_status:404' }] })
    expect(host.getState().tunnel).toMatchObject({ hostname: 'spettro.example.com', warning: null })
    expect((socket.notifications(RemoteMethod.hostState).at(-1)?.params as Frame).remoteHost).toBe('spettro.example.com')
  })

  it('warns when the dashboard routes the hostname elsewhere', async () => {
    const p = await connectedTunnel()
    p.emit({ ingress: [{ hostname: 'spettro.example.com', service: 'http://localhost:8080' }] })
    expect(host.getState().tunnel.warning).toBe(
      'In Cloudflare, spettro.example.com sends traffic to http://localhost:8080. Set its service type to HTTP and the URL to localhost:7879.'
    )
  })
})

describe('connections through the tunnel', () => {
  it('are let in from this computer’s connector, and counted', async () => {
    await connectedTunnel()
    const key = host.pairDevice('phone-1', 'Pixel', 'android')
    const { socket, accepted } = connect(tunneled)
    expect(accepted).toBe(true)
    resume(socket, 'phone-1', key)
    await settle()
    expect(host.getState().tunneledDeviceIds).toEqual(['phone-1'])
    expect(host.getState().connectedDeviceIds).toEqual(['phone-1'])
  })

  it('are turned away from another connector, the same tunnel run elsewhere', async () => {
    await connectedTunnel()
    const { socket, accepted } = connect({ ...tunneled, connectorTag: '00000000-0000-4000-8000-000000000000' })
    expect(accepted).toBe(false)
    expect(socket.closeCode).toBe(1008)
  })

  it('are dropped when the tunnel is switched off, and refused after', async () => {
    await connectedTunnel()
    const key = host.pairDevice('phone-1', 'Pixel', 'android')
    const internet = connect(tunneled).socket
    resume(internet, 'phone-1', key)
    const lan = connect().socket
    resume(lan, 'phone-1', host.pairDevice('phone-2', 'Tab', 'android'))
    await settle()
    await host.setTunnelEnabled(false)
    await settleAll()
    expect(internet.closeCode).toBe(1008)
    expect(lan.closed).toBe(false)
    expect(connect(tunneled).accepted).toBe(false)
    expect(host.getState().tunneledDeviceIds).toEqual([])
  })

  it('can’t pair while internet pairing is off, even with a code up', async () => {
    await connectedTunnel()
    await host.openPairing()
    const { socket } = connect(tunneled)
    expect(hello(socket)).toMatchObject({ pairingOpen: false, hostName: 'Spettro', hostID: host.hostId })
    const id = auth(socket, { mode: 'pair', deviceID: 'phone-9', deviceName: 'Pixel', platform: 'android', proof: 'x', protocolVersion: 1 })
    expect(socket.reply(id)?.error).toEqual({ code: -33003, message: 'Pair on the same network as this computer first.' })
    // The LAN is told the truth.
    const lan = connect().socket
    expect(hello(lan)).toMatchObject({ pairingOpen: true, hostName: host.hostName })
  })

  it('can pair once the user allows it', async () => {
    await connectedTunnel()
    await host.configureTunnel({ allowInternetPairing: true })
    await host.openPairing()
    const { socket } = connect(tunneled)
    expect(hello(socket).pairingOpen).toBe(true)
  })

  it('take at most 8 unauthenticated at once', async () => {
    await connectedTunnel()
    for (let i = 0; i < 8; i++) expect(connect({ ...tunneled, peerIp: `203.0.113.${i}` }).accepted).toBe(true)
    const extra = connect({ ...tunneled, peerIp: '203.0.113.99' })
    expect(extra.accepted).toBe(false)
    expect(extra.socket.closeCode).toBe(1013)
    expect(connect().accepted).toBe(true)
  })

  it('are rate limited by the address Cloudflare saw', async () => {
    await connectedTunnel()
    host.pairDevice('phone-1', 'Pixel', 'android')
    for (let i = 0; i < 5; i++) {
      const { socket } = connect(tunneled)
      resume(socket, 'phone-1', Buffer.alloc(32, 9))
    }
    expect(connect(tunneled).accepted).toBe(false)
    expect(connect({ ...tunneled, peerIp: '198.51.100.7' }).accepted).toBe(true)
  })
})

describe('checking from the internet', () => {
  class FakeClient extends EventEmitter {
    terminated = false
    terminate(): void {
      this.terminated = true
    }
  }

  it('succeeds when this host says hello at the hostname', async () => {
    await connectedTunnel()
    const urls: string[] = []
    const client = new FakeClient()
    openSocket = (url) => {
      urls.push(url)
      setImmediate(() => client.emit('message', Buffer.from(JSON.stringify({ method: RemoteMethod.hello, params: { hostID: host.hostId } }))))
      return client as unknown as WebSocket
    }
    expect(await host.checkTunnel()).toEqual({ ok: true, message: 'This computer answers at spettro.example.com.' })
    expect(urls).toEqual(['wss://spettro.example.com/'])
    expect(client.terminated).toBe(true)
  })

  it('says what a failure means', async () => {
    await connectedTunnel()
    openSocket = () => {
      const client = new FakeClient()
      setImmediate(() => client.emit('unexpected-response', {}, { statusCode: 502 }))
      return client as unknown as WebSocket
    }
    expect(await host.checkTunnel()).toEqual({
      ok: false,
      message: 'Cloudflare reached the tunnel but not Spettro. In Cloudflare, set spettro.example.com’s service to HTTP, localhost:7879.'
    })
  })
})

describe('the real listener', () => {
  /** A port nothing listens on right now. */
  async function freePort(): Promise<number> {
    const { createServer } = await import('node:net')
    return new Promise((resolve) => {
      const server = createServer()
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as { port: number }).port
        server.close(() => resolve(port))
      })
    })
  }

  function realHost(): RemoteHost {
    host = new RemoteHost(fakeBridge(), { dataDir: dir, onStateChanged: () => undefined })
    ;(host as unknown as { advertiser: { start(): void; stop(): void } }).advertiser = {
      start: () => undefined,
      stop: () => undefined
    }
    return host
  }

  it('settles for another port when the pinned one is taken', async () => {
    const { createServer } = await import('node:net')
    const port = await freePort()
    const squatter = createServer()
    await new Promise<void>((resolve) => squatter.listen(port, resolve))
    try {
      realHost()
      await host.configureTunnel({ port })
      await host.setEnabled(true)
      expect(host.getState().port).not.toBe(port)
      expect(host.getState().port).toBeGreaterThan(0)
    } finally {
      squatter.close()
    }
  })

  it('turns a tunneled upgrade away while the tunnel is off, and serves the LAN', async () => {
    const { WebSocket: Client } = await import('ws')
    realHost()
    await host.configureTunnel({ port: await freePort() })
    await host.setEnabled(true)
    const url = `ws://127.0.0.1:${host.getState().port}/`
    const closeCode = await new Promise<number>((resolve) => {
      const client = new Client(url, { headers: { 'cf-warp-tag-id': CONNECTOR, 'cf-connecting-ip': '203.0.113.9' } })
      client.on('close', (code) => resolve(code))
    })
    expect(closeCode).toBe(1008)
    const first = await new Promise<Frame>((resolve) => {
      const client = new Client(url)
      client.on('message', (data) => {
        resolve(JSON.parse(data.toString()) as Frame)
        client.close()
      })
    })
    expect(first.method).toBe(RemoteMethod.hello)
  })
})

describe('a failed download', () => {
  it('is tried again when remote access comes back on', async () => {
    located = null
    makeHost()
    await host.configureTunnel({ token: TOKEN })
    await host.setTunnelEnabled(true)
    await settleAll()
    expect(installs).toBe(1)
    await host.setEnabled(false)
    await host.setEnabled(true)
    await settleAll()
    expect(installs).toBe(2)
  })
})

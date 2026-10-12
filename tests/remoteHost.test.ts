// The remote host, driven the way a phone drives it: a socket that gets
// `hello`, answers it with a proof, and then lives on what the host sends.
//
// No server is started. RemoteHost.acceptSocket is what the listener calls
// for every connection, so a fake socket handed to it goes through exactly
// the code a real one would; the bridge behind the host is a fake too, so
// each test says what the app holds and reads what the phone would see.

import { EventEmitter } from 'events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { AcpAgent, type AcpConnection, parseAgentCapabilities } from '@main/acp'
import { AppModel } from '@main/model/appModel'
import type { ChatSession } from '@main/model/chatSession'
import { buildRemoteBridge } from '@main/model/remoteBridge'
import type { RemoteBridge } from '@main/remote/bridge'
import { Prefs } from '@main/model/prefs'
import type { ConnectionOrigin } from '@main/remote/connectionGuard'
import { RemoteHost } from '@main/remote/host'
import { RemoteHostSession } from '@main/remote/hostSession'
import { PairedDeviceStore } from '@main/remote/pairedDevices'
import { base64urlDecode, computeProof } from '@main/remote/pairing'
import type { JSONValue } from '@shared/acp'
import type { ChatSummary, RemoteHostState, StoredSession, TranscriptItem } from '@shared/model'
import { REMOTE_HOST_FEATURES, RemoteFeature, RemoteMethod } from '@shared/remote'
import { FakeAgent, type Handler, Reply, deferred, settle as settleAll } from './fakeAgent'
import {
  agentChunk,
  configOptionUpdate,
  configOptions,
  initializeResult,
  permissionAttached,
  rpcError,
  userChunk
} from './wire'

type Frame = { [key: string]: JSONValue }

/** What `ws` gives the host: frames out through send(), frames in as
 *  'message' events. */
class FakeSocket extends EventEmitter {
  readonly sent: Frame[] = []
  closed = false
  closeCode: number | undefined
  /** How many frames had gone out when the socket was closed. */
  sentAtClose: number | undefined

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Frame)
  }

  close(code?: number): void {
    if (this.closed) return
    this.closed = true
    this.closeCode = code
    this.sentAtClose = this.sent.length
    this.emit('close')
  }

  /** A frame from the phone. */
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

function summary(id: string, extra: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id,
    title: 'A chat',
    projectPath: '/project',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    isPinned: false,
    isArchived: false,
    isBusy: false,
    messageCount: 0,
    preview: '',
    ...extra
  } as ChatSummary
}

/** A bridge with nothing in it; tests override what they need. */
function fakeBridge(overrides: Partial<RemoteBridge> = {}): RemoteBridge {
  return {
    listChats: () => [],
    openChat: () => null,
    closeChat: () => undefined,
    newChat: (projectPath) => summary('00000000-0000-4000-8000-000000000001', { projectPath }),
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
    events: new EventEmitter(),
    ...overrides
  } as RemoteBridge
}

/** Lets the host's deferred sends (setImmediate) run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

let dir: string
let host: RemoteHost
let bridge: RemoteBridge
let nextId = 1

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spettro-remote-'))
  nextId = 1
})

afterEach(() => {
  host?.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

function makeHost(overrides: Partial<RemoteBridge> = {}): RemoteHost {
  bridge = fakeBridge(overrides)
  host = new RemoteHost(bridge, { dataDir: dir, onStateChanged: () => undefined })
  return host
}

let fake: FakeAgent
let model: AppModel

/** The real thing behind the host: an AppModel whose live agent is `fake`
 *  (wired the way connect() wires a real one), seen through the same
 *  bridge the app builds. */
function liveHost(): RemoteHost {
  fake = new FakeAgent()
  model = new AppModel({ userDataDir: dir, appVersion: '0.0.0-test' })
  const internals = model as unknown as {
    connection: AcpConnection
    agent: AcpAgent
    liveConnectionToken: number
    phase: { kind: string }
    wire(connection: AcpConnection, token: number): void
  }
  const agent = new AcpAgent(fake.conn)
  agent.capabilities = parseAgentCapabilities(initializeResult())
  internals.connection = fake.conn
  internals.agent = agent
  internals.liveConnectionToken = 1
  internals.phase = { kind: 'ready' }
  internals.wire(fake.conn, 1)
  bridge = buildRemoteBridge(model)
  host = new RemoteHost(bridge, { dataDir: dir, onStateChanged: () => undefined })
  return host
}

/** A chat with a live ACP session `sessionId`, showing `configOptions()`. */
async function liveChat(sessionId = 's1', projectPath = dir): Promise<ChatSession> {
  fake.handlers['session/new'] = () => ({ sessionId, configOptions: configOptions({}) })
  const session = model.newChat(projectPath)
  await settleAll()
  expect(session.acpSessionId).toBe(sessionId)
  return session
}

/** The config_option_updates a socket was sent for `chatId`. */
function configUpdates(socket: FakeSocket, chatId: string): Frame[] {
  return socket
    .notifications(RemoteMethod.chatUpdate)
    .map((f) => f.params as Frame)
    .filter((p) => p.chatID === chatId && (p.update as Frame).sessionUpdate === 'config_option_update')
    .map((p) => p.update as Frame)
}

/** One option's current value in an ACP-shaped option list. */
function acpValue(update: Frame, id: string): JSONValue | undefined {
  return (update.configOptions as Frame[]).find((o) => o.id === id)?.currentValue
}

/** A socket that has been through hello and a successful resume. Resolves
 *  once the host's post-auth sends have gone out. */
async function attached(deviceId = 'phone-1'): Promise<FakeSocket> {
  const { socket, authId } = authenticating(deviceId)
  await settle()
  expect(socket.reply(authId)?.result).toBeDefined()
  return socket
}

/** A socket whose resume has just been answered, before anything the host
 *  defers past the reply has run. */
function authenticating(deviceId = 'phone-1'): { socket: FakeSocket; authId: number } {
  return resuming(deviceId, host.pairDevice(deviceId, 'Pixel', 'android'))
}

/** A socket that has sent a resume signed with `key`. */
function resuming(deviceId: string, key: Buffer): { socket: FakeSocket; authId: number } {
  const socket = new FakeSocket()
  host.acceptSocket(socket as unknown as WebSocket)
  const hello = socket.notifications(RemoteMethod.hello)[0].params as Frame
  const challenge = base64urlDecode(hello.challenge as string) as Buffer
  const id = nextId++
  socket.receive({
    jsonrpc: '2.0',
    id,
    method: RemoteMethod.auth,
    params: {
      mode: 'resume',
      deviceID: deviceId,
      deviceName: 'Pixel',
      platform: 'android',
      proof: computeProof(key, challenge, host.hostId),
      protocolVersion: 1
    }
  })
  return { socket, authId: id }
}

/** Sends a request and waits for its reply. */
async function call(socket: FakeSocket, method: string, params: JSONValue): Promise<Frame> {
  const id = nextId++
  socket.receive({ jsonrpc: '2.0', id, method, params })
  // Some answers wait on a child process (projects/files asks git), so
  // this waits on the clock rather than on a number of turns.
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const reply = socket.reply(id)
    if (reply) return reply
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`no reply to ${method}`)
}

describe('the handshake', () => {
  it('announces what this host speaks in hello and again in the auth result', async () => {
    makeHost()
    const socket = await attached()
    const hello = socket.notifications(RemoteMethod.hello)[0].params as Frame
    expect(hello.features).toEqual([...REMOTE_HOST_FEATURES])
    const auth = socket.sent.find((f) => f.id === 1)?.result as Frame
    expect(auth.features).toEqual([...REMOTE_HOST_FEATURES])
  })

  it('puts no internet address in hello, the auth result or the pairing code', async () => {
    makeHost()
    const socket = await attached()
    const hello = socket.notifications(RemoteMethod.hello)[0].params as Frame
    const auth = socket.sent.find((f) => f.id === 1)?.result as Frame
    expect('remoteHost' in auth).toBe(false)
    expect(auth.features).not.toContain('remoteHost')
    expect(hello.features).not.toContain('remoteHost')
    ;(host as unknown as { advertiser: { start(): void; stop(): void } }).advertiser = {
      start: () => undefined,
      stop: () => undefined
    }
    ;(host as unknown as { listen(port: number): Promise<WebSocketServer> }).listen = () =>
      new Promise((resolve) => {
        const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
        wss.once('listening', () => resolve(wss))
      })
    await host.openPairing()
    const url = new URL(host.getState().pairingURL as string)
    expect(url.searchParams.has('r')).toBe(false)
    expect(url.searchParams.get('h')).toBe(host.hostId)
  })

  it('sends the first host/state after the auth reply, not before it', async () => {
    // A phone that installs its notification handler once it has the
    // answer would drop a host/state that overtook it.
    makeHost()
    const socket = await attached()
    const replyAt = socket.sent.findIndex((f) => f.id === 1)
    const stateAt = socket.sent.findIndex((f) => f.method === RemoteMethod.hostState)
    expect(replyAt).toBeGreaterThan(0)
    expect(stateAt).toBeGreaterThan(replyAt)
    expect(socket.sent[stateAt].params).toEqual({ agentReady: true, shuttingDown: false })
  })

  it('serves nothing but auth before the device has proved itself', async () => {
    makeHost({ listChats: () => [summary('00000000-0000-4000-8000-0000000000aa')] })
    const socket = new FakeSocket()
    host.acceptSocket(socket as unknown as WebSocket)
    const reply = await call(socket, RemoteMethod.chatsList, {})
    expect((reply.error as Frame).code).toBe(-33001)
    expect(socket.notifications(RemoteMethod.hostState)).toHaveLength(0)
  })

  it('says goodbye with the agent down, and says why', async () => {
    makeHost()
    const socket = await attached()
    bridge.events.emit('host-state', { agentReady: false, shuttingDown: true })
    const goodbye = socket.notifications(RemoteMethod.hostState).at(-1)?.params as Frame
    expect(goodbye).toEqual({ agentReady: false, shuttingDown: true, reason: 'quit' })
  })
})

describe('goodbye', () => {
  /** A host listening on a loopback port of the OS's choosing, advertising
   *  nothing. */
  async function listeningHost(): Promise<RemoteHost> {
    bridge = fakeBridge()
    host = new RemoteHost(bridge, { dataDir: dir, onStateChanged: () => undefined })
    const internals = host as unknown as {
      advertiser: { start(): void; stop(): void }
      listen(port: number): Promise<WebSocketServer>
    }
    internals.advertiser = { start: () => undefined, stop: () => undefined }
    internals.listen = () =>
      new Promise((resolve) => {
        const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
        wss.once('listening', () => resolve(wss))
      })
    await host.setEnabled(true)
    return host
  }

  const goodbyes = (socket: FakeSocket): Frame[] =>
    socket
      .notifications(RemoteMethod.hostState)
      .map((f) => f.params as Frame)
      .filter((p) => p.shuttingDown === true)

  it('is announced as goodbyeReason in hello and the auth result', async () => {
    makeHost()
    const socket = await attached()
    expect((socket.notifications(RemoteMethod.hello)[0].params as Frame).features).toContain(
      RemoteFeature.goodbyeReason
    )
    expect((socket.reply(1)?.result as Frame).features).toContain(RemoteFeature.goodbyeReason)
  })

  it('is said once when the app quits, with no message', async () => {
    await listeningHost()
    const socket = await attached()
    // What quitting does: the model's last emission, then the host's own.
    bridge.events.emit('host-state', { agentReady: false, shuttingDown: true })
    host.shutdown()
    expect(goodbyes(socket)).toEqual([{ agentReady: false, shuttingDown: true, reason: 'quit' }])
    expect(socket.closed).toBe(true)
  })

  it('says restarting when the app quits to install an update', async () => {
    await listeningHost()
    const socket = await attached()
    // index.ts's order: the host first, then the model, then the host again.
    host.sayGoodbye('restart')
    bridge.events.emit('host-state', { agentReady: false, shuttingDown: true })
    host.shutdown('restart')
    expect(goodbyes(socket)).toEqual([{ agentReady: false, shuttingDown: true, reason: 'restart' }])
  })

  it('says sharing was turned off, with the words an older phone goes by', async () => {
    await listeningHost()
    const socket = await attached()
    await host.setEnabled(false)
    expect(goodbyes(socket)).toEqual([
      { agentReady: false, shuttingDown: true, reason: 'sharing-off', message: 'Remote access was turned off.' }
    ])
  })

  it('is said again after sharing comes back on', async () => {
    await listeningHost()
    const first = await attached('phone-1')
    await host.setEnabled(false)
    await host.setEnabled(true)
    const second = await attached('phone-2')
    host.shutdown()
    expect(goodbyes(first)).toHaveLength(1)
    expect(goodbyes(second)).toEqual([{ agentReady: false, shuttingDown: true, reason: 'quit' }])
  })

  it('reaches a phone on a host that isn’t listening', async () => {
    makeHost()
    const socket = await attached()
    host.shutdown()
    expect(goodbyes(socket)).toEqual([{ agentReady: false, shuttingDown: true, reason: 'quit' }])
  })

  it('is the last host/state: the agent going down after it isn’t sent', async () => {
    makeHost()
    const socket = await attached()
    const before = socket.notifications(RemoteMethod.hostState).length
    host.sayGoodbye('quit')
    bridge.events.emit('host-state', { agentReady: false, shuttingDown: false })
    expect(socket.notifications(RemoteMethod.hostState)).toHaveLength(before + 1)
  })
})

describe('devices/unpair', () => {
  let states: RemoteHostState[]

  /** makeHost, keeping every state the host publishes. */
  function unpairHost(): RemoteHost {
    states = []
    bridge = fakeBridge()
    host = new RemoteHost(bridge, { dataDir: dir, onStateChanged: (s) => states.push(s) })
    return host
  }

  const deviceIds = (): string[] => host.getState().devices.map((d) => d.deviceId)

  it('is announced in hello and the auth result', async () => {
    unpairHost()
    const socket = await attached()
    expect((socket.notifications(RemoteMethod.hello)[0].params as Frame).features).toContain(RemoteFeature.unpair)
    expect((socket.reply(1)?.result as Frame).features).toContain(RemoteFeature.unpair)
  })

  it('answers null, then forgets the phone and closes its socket normally', async () => {
    unpairHost()
    const socket = await attached()
    expect(host.getState().connectedDeviceIds).toEqual(['phone-1'])
    const reply = await call(socket, RemoteMethod.devicesUnpair, {})
    expect(reply).toEqual({ jsonrpc: '2.0', id: reply.id, result: null })
    // The answer went out before the close did.
    const replyAt = socket.sent.indexOf(reply)
    expect(socket.closed).toBe(true)
    expect(socket.closeCode).toBe(1000)
    expect(replyAt).toBeLessThan(socket.sentAtClose as number)
    expect(deviceIds()).not.toContain('phone-1')
    expect(host.getState().connectedDeviceIds).toEqual([])
    // Settings › Remote heard it: the last state has no row and no one attached.
    const last = states.at(-1) as RemoteHostState
    expect(last.devices.map((d) => d.deviceId)).not.toContain('phone-1')
    expect(last.connectedDeviceIds).toEqual([])
  })

  it('takes the record off disk, so the old key no longer signs in', async () => {
    unpairHost()
    const key = host.pairDevice('phone-1', 'Pixel', 'android')
    const first = resuming('phone-1', key)
    await settle()
    await call(first.socket, RemoteMethod.devicesUnpair, {})
    expect(new PairedDeviceStore(dir).device('phone-1')).toBeUndefined()
    const again = resuming('phone-1', key)
    await settle()
    expect((again.socket.reply(again.authId)?.error as Frame).code).toBe(-33001)
  })

  it('removes only the device that asked', async () => {
    unpairHost()
    const other = await attached('phone-2')
    const socket = await attached('phone-1')
    await call(socket, RemoteMethod.devicesUnpair, { deviceID: 'phone-2' })
    expect(deviceIds()).toEqual(['phone-2'])
    expect(other.closed).toBe(false)
    expect(host.getState().connectedDeviceIds).toEqual(['phone-2'])
    // phone-2 is still served.
    expect((await call(other, RemoteMethod.chatsList, {})).result).toBeDefined()
  })

  it('refuses a socket that hasn’t signed in, and removes nothing', async () => {
    unpairHost()
    host.pairDevice('phone-1', 'Pixel', 'android')
    const socket = new FakeSocket()
    host.acceptSocket(socket as unknown as WebSocket)
    const reply = await call(socket, RemoteMethod.devicesUnpair, {})
    expect((reply.error as Frame).code).toBe(-33001)
    expect(deviceIds()).toEqual(['phone-1'])
  })

  it('serves nothing that arrives behind it on the closing socket', async () => {
    states = []
    const cancelChat = vi.fn()
    bridge = fakeBridge({ cancelChat })
    host = new RemoteHost(bridge, { dataDir: dir, onStateChanged: (s) => states.push(s) })
    const socket = await attached()
    const unpairId = nextId++
    const cancelId = nextId++
    // Two frames back to back, as ws may still deliver them while closing.
    socket.receive({ jsonrpc: '2.0', id: unpairId, method: RemoteMethod.devicesUnpair, params: {} })
    socket.receive({
      jsonrpc: '2.0',
      id: cancelId,
      method: RemoteMethod.chatCancel,
      params: { chatID: '00000000-0000-4000-8000-000000000001' }
    })
    await settle()
    expect(socket.reply(unpairId)?.result).toBeNull()
    expect(socket.reply(cancelId)).toBeUndefined()
    expect(cancelChat).not.toHaveBeenCalled()
  })

  it('answers null when the record is already gone, and again after pairing anew', async () => {
    unpairHost()
    const socket = await attached()
    ;(host as unknown as { devices: PairedDeviceStore }).devices.remove('phone-1')
    expect((await call(socket, RemoteMethod.devicesUnpair, {})).result).toBeNull()
    expect(socket.closeCode).toBe(1000)
    // Paired again from a fresh QR: a fresh row, removable the same way.
    const again = await attached()
    expect(deviceIds()).toEqual(['phone-1'])
    expect((await call(again, RemoteMethod.devicesUnpair, {})).result).toBeNull()
    expect(deviceIds()).toEqual([])
  })
})

describe('removing a device from Settings', () => {
  it('closes that phone’s open socket, and its resume is then refused', async () => {
    makeHost()
    const key = host.pairDevice('phone-1', 'Pixel', 'android')
    const first = resuming('phone-1', key)
    await settle()
    expect(host.getState().connectedDeviceIds).toEqual(['phone-1'])
    host.revokeDevice('phone-1')
    expect(first.socket.closed).toBe(true)
    expect(first.socket.closeCode).toBe(1000)
    expect(host.getState().connectedDeviceIds).toEqual([])
    const again = resuming('phone-1', key)
    await settle()
    expect((again.socket.reply(again.authId)?.error as Frame).code).toBe(-33005)
  })

  it('leaves other phones attached', async () => {
    makeHost()
    const other = await attached('phone-2')
    const socket = await attached('phone-1')
    host.revokeDevice('phone-1')
    expect(socket.closed).toBe(true)
    expect(other.closed).toBe(false)
    expect(host.getState().connectedDeviceIds).toEqual(['phone-2'])
    expect((await call(other, RemoteMethod.chatsList, {})).result).toBeDefined()
  })
})

describe('the paired device store', () => {
  it('removes a record for good, and says whether there was one', () => {
    const store = new PairedDeviceStore(dir)
    store.pair('phone-1', 'Pixel', 'android')
    store.pair('phone-2', 'Seeker', 'android')
    expect(store.remove('phone-1')).toBe(true)
    expect(store.remove('phone-1')).toBe(false)
    expect(store.remove('nobody')).toBe(false)
    const reloaded = new PairedDeviceStore(dir)
    expect(reloaded.list().map((d) => d.deviceId)).toEqual(['phone-2'])
    expect(reloaded.deviceKey('phone-1')).toBeNull()
  })
})

describe('chats/config', () => {
  it('answers once the change is in, with the options the chat runs with now', async () => {
    liveHost()
    const chat = await liveChat()
    fake.handlers['session/set_config_option'] = () => ({ configOptions: configOptions({ thinking: 'high' }) })
    const socket = await attached()

    const reply = await call(socket, RemoteMethod.chatConfig, {
      chatID: chat.id.toUpperCase(),
      configID: 'thinking',
      stringValue: 'high'
    })

    // The Swift wire shape chats/open uses, so one decoder reads both.
    const thinking = (reply.result as { configOptions: Frame[] }).configOptions.find((o) => o.id === 'thinking')
    expect((thinking?.kind as Frame).select).toMatchObject({ current: 'high' })
    expect(REMOTE_HOST_FEATURES).toContain(RemoteFeature.configResult)
  })

  it('tells every phone, the one that asked included, as a config_option_update', async () => {
    // The CLI only tells the *other* live sessions about a change; without
    // this the phone that made it would never hear it landed.
    liveHost()
    const chat = await liveChat()
    fake.handlers['session/set_config_option'] = () => ({ configOptions: configOptions({ thinking: 'high' }) })
    const asking = await attached('phone-1')
    const watching = await attached('phone-2')

    await call(asking, RemoteMethod.chatConfig, { chatID: chat.id, configID: 'thinking', stringValue: 'high' })
    await settleAll()

    for (const socket of [asking, watching]) {
      const updates = configUpdates(socket, chat.id)
      // The optimistic value and the agent's answer agree: one update.
      expect(updates).toHaveLength(1)
      expect(acpValue(updates[0], 'thinking')).toBe('high')
      // The shape the CLI sends, so the phone's ACP parser takes it as is.
      expect((updates[0].configOptions as Frame[])[0]).toMatchObject({ id: 'mode', type: 'select' })
    }
  })

  it('refuses with the agent’s code and the notice’s words, and takes the value back', async () => {
    liveHost()
    const chat = await liveChat()
    fake.handlers['session/set_config_option'] = () => {
      throw new Reply(rpcError('that level is not available', -32602))
    }
    const socket = await attached()

    const reply = await call(socket, RemoteMethod.chatConfig, {
      chatID: chat.id,
      configID: 'thinking',
      stringValue: 'max'
    })
    await settleAll()

    const error = reply.error as Frame
    expect(error.code).toBe(-32602)
    expect(error.message).toMatch(/^Couldn't change Thinking\. /)
    // The optimistic value went out, then the rollback.
    const updates = configUpdates(socket, chat.id)
    expect(updates.map((u) => acpValue(u, 'thinking'))).toEqual(['max', 'medium'])
  })

  it('answers a chat with no live session with what it now shows', async () => {
    liveHost()
    const chat = await liveChat()
    // Its session belongs to an agent that has since gone.
    ;(model as unknown as { sessionsByACPID: Map<string, unknown> }).sessionsByACPID.clear()
    const socket = await attached()

    const reply = await call(socket, RemoteMethod.chatConfig, {
      chatID: chat.id,
      configID: 'permission',
      stringValue: 'restricted'
    })

    const permission = (reply.result as { configOptions: Frame[] }).configOptions.find((o) => o.id === 'permission')
    expect((permission?.kind as Frame).select).toMatchObject({ current: 'restricted' })
    expect(chat.pendingConfigChanges['permission']).toBe('restricted')
    expect(fake.calls('session/set_config_option')).toHaveLength(0)
  })

  it('answers an unknown chat with -32001', async () => {
    liveHost()
    const socket = await attached()
    const reply = await call(socket, RemoteMethod.chatConfig, {
      chatID: '00000000-0000-4000-8000-00000000dead',
      configID: 'thinking',
      stringValue: 'high'
    })
    expect((reply.error as Frame).code).toBe(-32001)
  })

  it('relays a change made on this computer', async () => {
    liveHost()
    const chat = await liveChat()
    fake.handlers['session/set_config_option'] = () => ({ configOptions: configOptions({ mode: 'plan' }) })
    const socket = await attached()

    await model.setConfigValue(chat.id, 'mode', 'plan')
    await settleAll()

    const updates = configUpdates(socket, chat.id)
    expect(updates).toHaveLength(1)
    expect(acpValue(updates[0], 'mode')).toBe('plan')
  })

  it('doesn’t repeat an update the CLI sent itself', async () => {
    liveHost()
    const chat = await liveChat()
    const socket = await attached()

    fake.update('s1', configOptionUpdate(configOptions({ permission: 'yolo' })))
    await settleAll()

    // The CLI's own update, relayed as it came, and nothing after it.
    const updates = configUpdates(socket, chat.id)
    expect(updates).toHaveLength(1)
    expect(acpValue(updates[0], 'permission')).toBe('yolo')
  })
})

describe('notices', () => {
  /** The chat/state frames a socket was sent for `chatId`. */
  function chatStates(socket: FakeSocket, chatId: string): Frame[] {
    return socket
      .notifications(RemoteMethod.chatState)
      .map((f) => f.params as Frame)
      .filter((p) => (p.chat as Frame).id === chatId)
  }

  it('mirrors a refused change’s notice as a chat/state that ends nothing', async () => {
    liveHost()
    const chat = await liveChat()
    fake.handlers['session/set_config_option'] = () => {
      throw new Reply(rpcError('that level is not available', -32602))
    }
    const socket = await attached()

    await call(socket, RemoteMethod.chatConfig, { chatID: chat.id, configID: 'thinking', stringValue: 'max' })

    const [state] = chatStates(socket, chat.id)
    expect(state.stopReason).toBeUndefined()
    expect(state.notice).toEqual({
      text: expect.stringMatching(/^Couldn't change Thinking\. /),
      isError: true
    })
    expect(REMOTE_HOST_FEATURES).toContain(RemoteFeature.notices)
  })

  it('says why a prompt went nowhere before the turn ends', async () => {
    // A phone used to see only stopReason "error", with nothing to say why.
    liveHost()
    fake.handlers['session/new'] = () => {
      throw new Reply(rpcError('no provider configured'))
    }
    const chat = model.newChat(dir)
    await settleAll()
    const socket = await attached()

    await call(socket, RemoteMethod.chatPrompt, { chatID: chat.id, blocks: [{ type: 'text', text: 'hi' }] })
    await settleAll()

    const states = chatStates(socket, chat.id)
    const noticeAt = states.findIndex((p) => p.notice !== undefined)
    const endAt = states.findIndex((p) => p.stopReason !== undefined)
    expect(states[noticeAt].notice).toMatchObject({ isError: true })
    expect((states[noticeAt].notice as Frame).text).toMatch(/^Couldn't start this session\. /)
    expect(states[noticeAt].stopReason).toBeUndefined()
    expect(states[endAt]).toMatchObject({ stopReason: 'error' })
    expect(noticeAt).toBeLessThan(endAt)
  })

  it('keeps the notices a session/load replays to the chat it fills', async () => {
    // An imported conversation's failed turns come back as notices; they
    // are history, which the phones get whole once the import is done.
    liveHost()
    fake.handlers['session/load'] = () => {
      fake.update('tui-1', userChunk('hello'))
      fake.update('tui-1', agentChunk('[turn failed: no API endpoint configured]'))
      fake.update('tui-1', userChunk('again'))
      fake.update('tui-1', agentChunk('[turn interrupted]'))
      return { configOptions: configOptions({}) }
    }
    fake.handlers['session/set_config_option'] = () => ({ configOptions: configOptions({}) })
    const socket = await attached()

    const chatId = (await model.importCLISession('tui-1', dir)) as string
    await settleAll()

    const session = model.sessionById(chatId) as ChatSession
    expect(session.items.filter((i) => i.kind === 'message' && i.message.role === 'notice')).toHaveLength(2)
    expect(chatStates(socket, chatId).filter((p) => p.notice !== undefined)).toEqual([])
    expect(chatStates(socket, chatId).length).toBeGreaterThan(0)
  })

  it('keeps a Workflow Studio run’s notices to the studio', async () => {
    liveHost()
    const chat = await liveChat()
    fake.handlers['session/new'] = () => ({ sessionId: 's2', configOptions: configOptions({}) })
    fake.handlers['session/prompt'] = () => new Promise(() => undefined)
    const scratchId = model.runWorkflow(chat.id, 'ship') as string
    await settleAll()
    const socket = await attached()
    const heard: unknown[] = []
    model.on('chat-notice', (...args: unknown[]) => heard.push(args))

    model.sessionById(scratchId)?.appendNotice("Couldn't change Model.", true)

    expect(heard).toEqual([])
    expect(chatStates(socket, scratchId)).toEqual([])
  })

  it('leaves the notice a turn ends on to the turn’s last chat/state', async () => {
    liveHost()
    const chat = await liveChat()
    fake.handlers['session/prompt'] = () => ({ stopReason: 'max_tokens' })
    const socket = await attached()

    await call(socket, RemoteMethod.chatPrompt, { chatID: chat.id, blocks: [{ type: 'text', text: 'hi' }] })
    await settleAll()

    const withNotice = chatStates(socket, chat.id).filter((p) => p.notice !== undefined)
    expect(withNotice).toEqual([
      expect.objectContaining({ stopReason: 'max_tokens', notice: { text: 'The reply hit the length limit.', isError: false } })
    ])
  })
})

describe('prompts waiting when a phone attaches', () => {
  const permission = {
    kind: 'permission' as const,
    promptId: 'perm-req-1',
    chatId: '00000000-0000-4000-8000-0000000000c1',
    raw: { sessionId: 's1', toolCall: { toolCallId: 'call-1', status: 'pending' }, options: [] }
  }
  const question = {
    kind: 'question' as const,
    promptId: 'question-req-1',
    chatId: null,
    raw: { sessionId: 's1', questions: [{ id: 'q1', question: 'Which?' }] }
  }

  it('are asked again right after the auth reply and host/state', async () => {
    makeHost({ pendingPrompts: () => [permission, question] })
    const socket = await attached()

    const methods = socket.sent.map((f) => f.method ?? 'reply')
    expect(methods.slice(-4)).toEqual([
      'reply',
      RemoteMethod.hostState,
      RemoteMethod.permissionAsk,
      RemoteMethod.questionAsk
    ])
    expect(socket.notifications(RemoteMethod.permissionAsk)[0].params).toEqual({
      promptID: 'perm-req-1',
      chatID: permission.chatId,
      request: permission.raw
    })
    // No chat: the key is left out, as on the original ask.
    expect(socket.notifications(RemoteMethod.questionAsk)[0].params).toEqual({
      promptID: 'question-req-1',
      request: question.raw
    })
    expect(REMOTE_HOST_FEATURES).toContain(RemoteFeature.pendingReplay)
  })

  it('aren’t asked again once answered in the meantime', async () => {
    let waiting = [permission, question]
    makeHost({ pendingPrompts: () => waiting })
    const { socket } = authenticating()
    waiting = [question]
    await settle()

    expect(socket.notifications(RemoteMethod.permissionAsk)).toHaveLength(0)
    expect(socket.notifications(RemoteMethod.questionAsk)).toHaveLength(1)
  })

  it('reach a phone exactly as the one already attached was asked', async () => {
    liveHost()
    const chat = await liveChat()
    fake.update('s1', { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Run ls', kind: 'execute', status: 'in_progress' })
    const early = await attached('phone-1')
    fake.ask(7, 'session/request_permission', permissionAttached({ sessionId: 's1', toolCallId: 'call-1', command: 'ls' }))
    await settleAll()
    const late = await attached('phone-2')

    const asked = early.notifications(RemoteMethod.permissionAsk)
    const replayed = late.notifications(RemoteMethod.permissionAsk)
    expect(asked).toHaveLength(1)
    expect(replayed).toEqual(asked)
    expect((replayed[0].params as Frame).chatID).toBe(chat.id)
    // Attaching phone-2 tells phone-1 nothing new.
    expect(early.notifications(RemoteMethod.permissionAsk)).toHaveLength(1)
  })
})

describe('chats/open', () => {
  const CHAT = '00000000-0000-4000-8000-0000000000e1'
  const T = 1_700_000_000_000

  function snapshot(items: TranscriptItem[]): StoredSession {
    return {
      id: CHAT,
      acpSessionId: 's1',
      projectPath: '/project',
      title: 'A chat',
      createdAt: T,
      updatedAt: T,
      isPinned: false,
      isArchived: false,
      items,
      configOptions: [],
      pendingConfigChanges: {}
    } as StoredSession
  }

  async function opened(items: TranscriptItem[]): Promise<Frame[]> {
    makeHost({
      openChat: () => ({ chat: snapshot(items), configOptions: [], commands: [], plan: [], usage: null, isBusy: true })
    })
    const socket = await attached()
    const reply = await call(socket, RemoteMethod.chatOpen, { chatID: CHAT })
    return ((reply.result as Frame).chat as Frame).items as Frame[]
  }

  const message = (extra: object): TranscriptItem =>
    ({
      kind: 'message',
      message: { id: 'm1', role: 'user', text: 'hi', attachments: [], isStreaming: false, timestamp: T, ...extra }
    }) as TranscriptItem

  const tool = (extra: object): TranscriptItem =>
    ({
      kind: 'tool',
      tool: { id: 'call-1~2', title: 'Run ls', status: 'completed', output: '', diffs: [], locations: [], timestamp: T, ...extra }
    }) as TranscriptItem

  it('keeps what the Swift store never had on messages', async () => {
    const [steer, thinking, notice] = await opened([
      message({ steering: 'queued', mentions: ['src/a.ts'] }),
      message({ id: 'm2', role: 'reasoning', isStreaming: true, startedAt: T, endedAt: T + 12_400 }),
      message({ id: 'm3', role: 'notice', noticeIsError: true, endsTurn: true, contextCleared: true, plain: true })
    ])
    expect((steer.message as Frame)._0).toMatchObject({ steering: 'queued', mentions: ['src/a.ts'] })
    expect((thinking.message as Frame)._0).toMatchObject({
      isStreaming: true,
      // To the millisecond: the phone times the thought from these.
      startedAt: '2023-11-14T22:13:20.000Z',
      endedAt: '2023-11-14T22:13:32.400Z'
    })
    // The fields the Swift store has keep its second-precision dates.
    expect((thinking.message as Frame)._0).toMatchObject({ timestamp: '2023-11-14T22:13:20Z' })
    expect((notice.message as Frame)._0).toMatchObject({ endsTurn: true, contextCleared: true, plain: true })
    expect(REMOTE_HOST_FEATURES).toContain(RemoteFeature.snapshotV2)
  })

  it('keeps a tool’s workflow, raw output, denial and images', async () => {
    const workflow = { version: 1, runId: 'r1', name: 'ship', status: 'running' }
    const images = [1, 2, 3, 4, 5].map((n) => ({ data: `img${n}`, mimeType: 'image/png' }))
    const [item] = await opened([tool({ workflow, rawOutput: 'full output', denied: true, images })])
    const stored = (item.tool as Frame)._0 as Frame
    expect(stored).toMatchObject({ id: 'call-1~2', workflow, rawOutput: 'full output', denied: true })
    expect(stored.images).toEqual(images.slice(0, 4))
  })

  it('adds nothing to an item that has none of it', async () => {
    const [plain, card] = await opened([message({}), tool({})])
    expect(Object.keys((plain.message as Frame)._0 as Frame).sort()).toEqual(
      ['id', 'noticeIsError', 'role', 'text', 'timestamp'].sort()
    )
    expect(Object.keys((card.tool as Frame)._0 as Frame).sort()).toEqual(
      ['diffs', 'id', 'locations', 'output', 'status', 'timestamp', 'title'].sort()
    )
  })
})

describe('chats/prompt mentions', () => {
  it('sends each mention still in the text as the file it names', async () => {
    liveHost()
    const chat = await liveChat()
    let prompt: JSONValue = null
    fake.handlers['session/prompt'] = (params) => {
      prompt = params
      return { stopReason: 'end_turn' }
    }
    const socket = await attached()

    const reply = await call(socket, RemoteMethod.chatPrompt, {
      chatID: chat.id,
      blocks: [{ type: 'text', text: 'look at @src/a.ts and @../secret' }],
      mentions: ['src/a.ts', '../secret']
    })
    await settleAll()

    expect(reply.result).toBeNull()
    const blocks = (prompt as unknown as { prompt: Frame[] }).prompt
    expect(blocks.filter((b) => b.type === 'resource_link')).toEqual([
      expect.objectContaining({ name: 'src/a.ts' })
    ])
    // Outside the project: never a link, left as typed.
    expect(blocks.at(-1)).toEqual({ type: 'text', text: ' and @../secret' })
    expect(chat.items.find((i) => i.kind === 'message' && i.message.role === 'user')).toMatchObject({
      message: { mentions: ['src/a.ts'] }
    })
    expect(REMOTE_HOST_FEATURES).toContain(RemoteFeature.mentions)
  })

  it('refuses mentions that aren’t a list of paths', async () => {
    liveHost()
    const chat = await liveChat()
    const socket = await attached()
    const reply = await call(socket, RemoteMethod.chatPrompt, {
      chatID: chat.id,
      blocks: [{ type: 'text', text: 'hi' }],
      mentions: [42]
    })
    expect((reply.error as Frame).code).toBe(-32602)
  })
})

describe('chats/rename', () => {
  it('renames the chat and tells every screen', async () => {
    liveHost()
    const chat = await liveChat()
    const renaming = await attached('phone-1')
    const watching = await attached('phone-2')

    const reply = await call(renaming, RemoteMethod.chatRename, { chatID: chat.id.toUpperCase(), title: '  Ship   it ' })

    expect(reply.result).toBeNull()
    expect(chat.title).toBe('Ship it')
    for (const socket of [renaming, watching]) {
      const titles = socket.notifications(RemoteMethod.chatState).map((f) => ((f.params as Frame).chat as Frame).title)
      expect(titles).toContain('Ship it')
    }
    expect(REMOTE_HOST_FEATURES).toContain(RemoteFeature.rename)
  })

  it('tells every screen the title kept when it was already the chat’s', async () => {
    liveHost()
    const chat = await liveChat()
    model.renameChat(chat.id, 'Fix bug')
    const renaming = await attached('phone-1')
    const watching = await attached('phone-2')

    const reply = await call(renaming, RemoteMethod.chatRename, { chatID: chat.id, title: 'Fix  bug ' })

    expect(reply.result).toBeNull()
    expect(chat.title).toBe('Fix bug')
    for (const socket of [renaming, watching]) {
      const states = socket.notifications(RemoteMethod.chatState).map((f) => (f.params as Frame).chat as Frame)
      expect(states).toEqual([expect.objectContaining({ id: chat.id, title: 'Fix bug' })])
    }
  })

  it('refuses a blank title and an unknown chat', async () => {
    liveHost()
    const chat = await liveChat()
    const socket = await attached()
    const blank = await call(socket, RemoteMethod.chatRename, { chatID: chat.id, title: '   ' })
    expect((blank.error as Frame).code).toBe(-32602)
    const unknown = await call(socket, RemoteMethod.chatRename, {
      chatID: '00000000-0000-4000-8000-00000000dead',
      title: 'Nope'
    })
    expect((unknown.error as Frame).code).toBe(-32001)
  })
})

describe('projects/files', () => {
  it('lists a project’s files as the mention menu does', async () => {
    liveHost()
    const project = join(dir, 'acme')
    mkdirSync(join(project, 'src'), { recursive: true })
    mkdirSync(join(project, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(project, 'src', 'a.ts'), '')
    writeFileSync(join(project, 'README.md'), '')
    writeFileSync(join(project, 'node_modules', 'dep', 'index.js'), '')
    await liveChat('s1', project)
    const socket = await attached()

    const reply = await call(socket, RemoteMethod.projectFiles, { projectPath: project })

    expect(((reply.result as Frame).files as string[]).sort()).toEqual(['README.md', 'src/a.ts'])
    expect(REMOTE_HOST_FEATURES).toContain(RemoteFeature.projectFiles)
  })

  it('lists nothing outside the projects a phone is offered', async () => {
    liveHost()
    await liveChat()
    const socket = await attached()
    const reply = await call(socket, RemoteMethod.projectFiles, { projectPath: '/etc' })
    expect((reply.error as Frame).code).toBe(-32001)
  })

  it('stops at 5000 files', async () => {
    const many = Array.from({ length: 6000 }, (_, i) => `f${i}.txt`)
    makeHost({ projectFiles: async () => many })
    const socket = await attached()
    const reply = await call(socket, RemoteMethod.projectFiles, { projectPath: '/project' })
    expect((reply.result as Frame).files).toHaveLength(5000)
  })
})

describe('Workflow Studio scratch chats', () => {
  /** A live chat, and a studio run of `ship` from it on ACP session s2,
   *  its turn left running (on `prompt`, by default for good). */
  async function studioRun(
    prompt: Handler = () => new Promise(() => undefined)
  ): Promise<{ chat: ChatSession; scratchId: string }> {
    const chat = await liveChat()
    fake.handlers['session/new'] = () => ({ sessionId: 's2', configOptions: configOptions({}) })
    fake.handlers['session/prompt'] = prompt
    const scratchId = model.runWorkflow(chat.id, 'ship') as string
    await settleAll()
    expect(model.sessionById(scratchId)?.acpSessionId).toBe('s2')
    return { chat, scratchId }
  }

  /** Every frame that names `chatId` anywhere. */
  const mentioning = (socket: FakeSocket, chatId: string): Frame[] =>
    socket.sent.filter((f) => JSON.stringify(f).includes(chatId))

  it('are never listed, opened or emitted to a phone', async () => {
    liveHost()
    const socket = await attached()
    const { chat, scratchId } = await studioRun()
    fake.update('s2', { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Run tests', kind: 'execute', status: 'in_progress' })
    fake.ask(9, 'session/request_permission', permissionAttached({ sessionId: 's2', toolCallId: 'call-1', command: 'npm test' }))
    await settleAll()

    const list = await call(socket, RemoteMethod.chatsList, {})
    expect(((list.result as Frame).chats as Frame[]).map((c) => c.id)).toEqual([chat.id])
    const open = await call(socket, RemoteMethod.chatOpen, { chatID: scratchId })
    expect((open.error as Frame).code).toBe(-32001)
    const projects = await call(socket, RemoteMethod.projectsList, {})
    expect((projects.result as Frame).projects).toEqual([expect.objectContaining({ path: dir, chatCount: 1 })])
    // Not its chat/user, chat/state, chat/update or permission/ask.
    expect(mentioning(socket, scratchId)).toEqual([])
    expect(socket.notifications(RemoteMethod.permissionAsk)).toHaveLength(0)

    // Nor replayed to a phone attaching while the run waits on it.
    const late = await attached('phone-2')
    expect(late.notifications(RemoteMethod.permissionAsk)).toHaveLength(0)
  })

  it('are taken off the phones when the studio discards one', async () => {
    liveHost()
    const socket = await attached()
    const { scratchId } = await studioRun()

    model.discardScratchChat(scratchId)

    expect(mentioning(socket, scratchId)).toEqual([
      expect.objectContaining({ method: RemoteMethod.chatRemoved, params: { chatID: scratchId } })
    ])
  })

  it('stay off once discarded, when the run they cancelled winds down', async () => {
    // The studio discards a run still going when its editor closes: the
    // cancelled turn ends after the chat/removed, and its last chat/state
    // would put a "Workflow · ship" row back on the phone for good.
    liveHost()
    const socket = await attached()
    const turn = deferred<JSONValue>()
    const { scratchId } = await studioRun(() => turn.promise)
    expect(model.sessionById(scratchId)?.isBusy).toBe(true)

    model.discardScratchChat(scratchId)
    expect(fake.calls('session/cancel')).toHaveLength(1)
    turn.resolve({ stopReason: 'cancelled' })
    await settleAll()

    expect(mentioning(socket, scratchId)).toEqual([
      expect.objectContaining({ method: RemoteMethod.chatRemoved, params: { chatID: scratchId } })
    ])
  })

  it('can’t be driven, changed or deleted by a phone that knows the id', async () => {
    liveHost()
    const socket = await attached()
    const { scratchId } = await studioRun()
    const scratch = model.sessionById(scratchId) as ChatSession
    const prompts = fake.calls('session/prompt').length
    const configs = fake.calls('session/set_config_option').length

    await call(socket, RemoteMethod.chatPrompt, { chatID: scratchId, blocks: [{ type: 'text', text: 'hi' }] })
    const config = await call(socket, RemoteMethod.chatConfig, { chatID: scratchId, configID: 'thinking', stringValue: 'max' })
    const rename = await call(socket, RemoteMethod.chatRename, { chatID: scratchId, title: 'Mine now' })
    await call(socket, RemoteMethod.chatFlag, { chatID: scratchId, isPinned: true, isArchived: true })
    await call(socket, RemoteMethod.chatCancel, { chatID: scratchId })
    await call(socket, RemoteMethod.chatDelete, { chatID: scratchId })
    await settleAll()

    expect((config.error as Frame).code).toBe(-32001)
    expect((rename.error as Frame).code).toBe(-32001)
    expect(model.sessionById(scratchId)).toBe(scratch)
    expect(scratch).toMatchObject({ title: 'Workflow · ship', isPinned: false, isArchived: false, isBusy: true })
    expect(fake.calls('session/prompt')).toHaveLength(prompts)
    expect(fake.calls('session/set_config_option')).toHaveLength(configs)
    expect(fake.calls('session/cancel')).toHaveLength(0)
    expect(fake.calls('session/close')).toHaveLength(0)
    expect(mentioning(socket, scratchId).filter((f) => f.method !== undefined)).toEqual([])
  })
})

describe('chats/delete', () => {
  it('leaves a deleted chat gone when the turn it cancelled winds down', async () => {
    liveHost()
    const chat = await liveChat()
    const turn = deferred<JSONValue>()
    fake.handlers['session/prompt'] = () => turn.promise
    const socket = await attached()
    await call(socket, RemoteMethod.chatPrompt, { chatID: chat.id, blocks: [{ type: 'text', text: 'hi' }] })
    await settleAll()
    expect(chat.isBusy).toBe(true)

    await call(socket, RemoteMethod.chatDelete, { chatID: chat.id })
    turn.resolve({ stopReason: 'cancelled' })
    await settleAll()

    const methods = socket.sent
      .filter((f) => f.method !== undefined && JSON.stringify(f).includes(chat.id))
      .map((f) => f.method)
    expect(methods.at(-1)).toBe(RemoteMethod.chatRemoved)
    expect(methods.filter((m) => m === RemoteMethod.chatRemoved)).toHaveLength(1)
  })
})

describe('remote sharing across launches', () => {
  /** A host that listens on a loopback port of the OS's choosing and
   *  advertises nothing, reporting each sharing change to `changes`. */
  function sharingHost(changes: boolean[]): RemoteHost {
    bridge = fakeBridge()
    host = new RemoteHost(bridge, {
      dataDir: dir,
      onStateChanged: () => undefined,
      onSharingChanged: (enabled) => changes.push(enabled)
    })
    const internals = host as unknown as {
      advertiser: { start(): void; stop(): void }
      listen(port: number): Promise<WebSocketServer>
    }
    internals.advertiser = { start: () => undefined, stop: () => undefined }
    internals.listen = () =>
      new Promise((resolve) => {
        const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
        wss.once('listening', () => resolve(wss))
      })
    return host
  }

  it('reports the user turning it on and off, and opening a code turning it on', async () => {
    const changes: boolean[] = []
    sharingHost(changes)
    await host.setEnabled(true)
    await host.setEnabled(false)
    await host.openPairing()
    expect(changes).toEqual([true, false, true])
    expect(host.getState().enabled).toBe(true)
  })

  it('doesn’t count quitting as turning it off', async () => {
    const changes: boolean[] = []
    sharingHost(changes)
    await host.setEnabled(true)
    host.shutdown()
    expect(changes).toEqual([true])
  })

  it('comes back on at launch only when it was on', async () => {
    const changes: boolean[] = []
    sharingHost(changes)
    await host.restoreSharing(false)
    expect(host.getState().enabled).toBe(false)
    await host.restoreSharing(true)
    expect(host.getState().enabled).toBe(true)
    expect(changes).toEqual([true])
  })

  it('is remembered on disk', () => {
    const prefs = new Prefs(dir)
    expect(prefs.remoteSharing).toBe(false)
    prefs.remoteSharing = true
    expect(new Prefs(dir).remoteSharing).toBe(true)
    const app = new AppModel({ userDataDir: dir, appVersion: '0.0.0-test' })
    expect(app.remoteSharing).toBe(true)
    app.remoteSharing = false
    expect(new Prefs(dir).remoteSharing).toBe(false)
  })
})

describe('connections the host turns away', () => {
  /** A hello-only socket, accepted as if from `origin`. */
  function connect(origin?: ConnectionOrigin): { socket: FakeSocket; session: unknown } {
    const socket = new FakeSocket()
    const session = host.acceptSocket(socket as unknown as WebSocket, origin)
    return { socket, session }
  }

  function resume(socket: FakeSocket, deviceId: string, key: Buffer): number {
    const hello = socket.notifications(RemoteMethod.hello)[0].params as Frame
    const challenge = base64urlDecode(hello.challenge as string) as Buffer
    const id = nextId++
    socket.receive({
      jsonrpc: '2.0',
      id,
      method: RemoteMethod.auth,
      params: { mode: 'resume', deviceID: deviceId, deviceName: 'Pixel', platform: 'android', proof: computeProof(key, challenge, host.hostId), protocolVersion: 1 }
    })
    return id
  }

  const lan = (peerIp: string): ConnectionOrigin => ({ peerIp })

  it('closes a socket that hasn’t signed in within 15 seconds', () => {
    vi.useFakeTimers()
    try {
      makeHost()
      const { socket } = connect()
      vi.advanceTimersByTime(14_999)
      expect(socket.closed).toBe(false)
      vi.advanceTimersByTime(1)
      expect(socket.closeCode).toBe(1008)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a socket that signed in past the deadline', async () => {
    makeHost()
    const key = host.pairDevice('phone-1', 'Pixel', 'android')
    vi.useFakeTimers()
    try {
      const { socket } = connect()
      resume(socket, 'phone-1', key)
      vi.advanceTimersByTime(60_000)
      expect(socket.closed).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('doesn’t count a phone idling past the deadline against its address', () => {
    vi.useFakeTimers()
    try {
      makeHost()
      for (let i = 0; i < 6; i++) connect(lan('192.168.1.40'))
      vi.advanceTimersByTime(15_000)
      expect(connect(lan('192.168.1.40')).session).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes a socket that sends too much before signing in', () => {
    makeHost()
    const big = connect().socket
    big.receive({ jsonrpc: '2.0', id: 1, method: RemoteMethod.auth, params: { pad: 'x'.repeat(70 * 1024) } })
    expect(big.closeCode).toBe(1008)
    const chatty = connect().socket
    for (let i = 0; i < 10; i++) chatty.receive({ jsonrpc: '2.0', id: i, method: RemoteMethod.chatsList, params: {} })
    expect(chatty.closed).toBe(false)
    chatty.receive({ jsonrpc: '2.0', id: 11, method: RemoteMethod.chatsList, params: {} })
    expect(chatty.closeCode).toBe(1008)
  })

  it('blocks an address after five failed sign-ins, but lets it pair while a code is up', async () => {
    makeHost()
    host.pairDevice('phone-1', 'Pixel', 'android')
    const wrong = Buffer.alloc(32, 9)
    for (let i = 0; i < 5; i++) {
      const { socket } = connect(lan('192.168.1.40'))
      const id = resume(socket, 'phone-1', wrong)
      expect((socket.reply(id)?.error as Frame).code).toBe(-33002)
    }
    expect(connect(lan('192.168.1.40')).session).toBeNull()
    expect(connect(lan('192.168.1.41')).session).not.toBeNull()
    const internals = host as unknown as { pairingWindow: unknown }
    internals.pairingWindow = { secret: Buffer.alloc(32, 1), openedAt: Date.now() }
    expect(connect(lan('192.168.1.40')).session).not.toBeNull()
  })

  it('doesn’t count a stale code or an old protocol against the phone', () => {
    makeHost()
    for (let i = 0; i < 6; i++) {
      const { socket } = connect(lan('192.168.1.40'))
      socket.receive({
        jsonrpc: '2.0',
        id: 1,
        method: RemoteMethod.auth,
        params: { mode: 'pair', deviceID: 'phone-9', proof: 'x', protocolVersion: 1 }
      })
      expect((socket.reply(1)?.error as Frame).code).toBe(-33003)
    }
    expect(connect(lan('192.168.1.40')).session).not.toBeNull()
  })

  it('takes no more than 32 sockets at once', () => {
    makeHost()
    const sockets = Array.from({ length: 32 }, (_, i) => connect(lan(`192.168.1.${i}`)))
    expect(sockets.every((s) => s.session !== null)).toBe(true)
    const extra = connect(lan('192.168.1.200'))
    expect(extra.session).toBeNull()
    expect(extra.socket.closeCode).toBe(1013)
    // One the host closed itself gives its place back at once.
    sockets[0].socket.receive({ jsonrpc: '2.0', id: 1, method: RemoteMethod.auth, params: { pad: 'x'.repeat(70 * 1024) } })
    expect(connect(lan('192.168.1.201')).session).not.toBeNull()
  })
})

describe('the listener', () => {
  /** What the host needs from a WebSocketServer. */
  class FakeServer extends EventEmitter {
    readonly clients = new Set<WebSocket>()
    closed = false
    constructor(readonly port: number) {
      super()
    }
    address(): { port: number } {
      return { port: this.port }
    }
    close(): void {
      this.closed = true
    }
  }

  let sharing: boolean[]

  /** A host whose listen() the test speaks for, advertising nothing. */
  function fakeListenHost(listen: (port: number) => Promise<WebSocketServer>): RemoteHost {
    sharing = []
    bridge = fakeBridge()
    host = new RemoteHost(bridge, { dataDir: dir, onStateChanged: () => undefined, onSharingChanged: (on) => sharing.push(on) })
    const internals = host as unknown as {
      advertiser: { start(): void; stop(): void }
      listen(port: number): Promise<WebSocketServer>
    }
    internals.advertiser = { start: () => undefined, stop: () => undefined }
    internals.listen = listen
    return host
  }

  it('listens on 7879, and falls back when it’s taken or the OS reserves it', async () => {
    for (const code of [null, 'EADDRINUSE', 'EACCES', 'EPERM']) {
      fakeListenHost(async (port) => {
        if (code && port === 7879) throw Object.assign(new Error(`listen ${code}`), { code })
        return new FakeServer(port === 0 ? 50123 : port) as unknown as WebSocketServer
      })
      await host.setEnabled(true)
      expect(host.getState().enabled).toBe(true)
      expect(host.getState().port).toBe(code ? 50123 : 7879)
      host.shutdown()
    }
  })

  it('doesn’t fall back over a listen error that isn’t about the port', async () => {
    fakeListenHost(async () => {
      throw Object.assign(new Error('listen EMFILE'), { code: 'EMFILE' })
    })
    await expect(host.setEnabled(true)).rejects.toThrow('EMFILE')
    expect(host.getState().enabled).toBe(false)
  })

  it('stays off when turned off while the listener was opening', async () => {
    const opened: FakeServer[] = []
    let release!: () => void
    fakeListenHost(
      (port) =>
        new Promise((resolve) => {
          release = () => {
            const server = new FakeServer(port)
            opened.push(server)
            resolve(server as unknown as WebSocketServer)
          }
        })
    )
    const on = host.setEnabled(true)
    await settle()
    await host.setEnabled(false)
    release()
    await on
    for (let i = 0; i < 5; i++) await settle()
    expect(host.getState().enabled).toBe(false)
    expect(opened[0].closed).toBe(true)
    expect(sharing).toEqual([false])
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

  async function realHost(preferredPort?: number): Promise<RemoteHost> {
    bridge = fakeBridge()
    host = new RemoteHost(bridge, {
      dataDir: dir,
      onStateChanged: () => undefined,
      preferredPort: preferredPort ?? (await freePort())
    })
    ;(host as unknown as { advertiser: { start(): void; stop(): void } }).advertiser = {
      start: () => undefined,
      stop: () => undefined
    }
    return host
  }

  it('settles for another port when the preferred one is taken', async () => {
    const { createServer } = await import('node:net')
    const port = await freePort()
    const squatter = createServer()
    await new Promise<void>((resolve) => squatter.listen(port, resolve))
    try {
      await realHost(port)
      await host.setEnabled(true)
      expect(host.getState().port).not.toBe(port)
      expect(host.getState().port).toBeGreaterThan(0)
    } finally {
      squatter.close()
    }
  })

  it('cuts off a frame too big before sign-in while it arrives, without reading it', async () => {
    const { WebSocket: Client } = await import('ws')
    const handled = vi.spyOn(RemoteHostSession.prototype as unknown as { handleMessage(data: unknown): void }, 'handleMessage')
    try {
      await realHost()
      await host.setEnabled(true)
      const client = new Client(`ws://127.0.0.1:${host.getState().port}/`)
      const closed = new Promise<void>((resolve) => client.on('close', () => resolve()))
      client.on('error', () => undefined)
      client.once('message', () => client.send('x'.repeat(4 * 1024 * 1024)))
      await closed
      expect(handled).not.toHaveBeenCalled()
    } finally {
      handled.mockRestore()
    }
  })

  it('takes big frames once signed in', async () => {
    const { WebSocket: Client } = await import('ws')
    await realHost()
    await host.setEnabled(true)
    const key = host.pairDevice('phone-1', 'Pixel', 'android')
    const client = new Client(`ws://127.0.0.1:${host.getState().port}/`)
    const reply = await new Promise<Frame>((resolve) => {
      client.on('message', (data) => {
        const frame = JSON.parse(data.toString()) as Frame
        if (frame.method === RemoteMethod.hello) {
          const challenge = base64urlDecode((frame.params as Frame).challenge as string) as Buffer
          client.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: RemoteMethod.auth,
              params: { mode: 'resume', deviceID: 'phone-1', proof: computeProof(key, challenge, host.hostId), protocolVersion: 1 }
            })
          )
        } else if (frame.id === 1) {
          client.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: RemoteMethod.chatsList, params: { pad: 'x'.repeat(2 * 1024 * 1024) } }))
        } else if (frame.id === 2) {
          resolve(frame)
          client.close()
        }
      })
    })
    expect(reply.result).toEqual({ chats: [] })
  })

  it('turns an upgrade a Cloudflare tunnel relayed away before hello, and serves the LAN', async () => {
    // A cloudflared left running, or pointed at this port by hand, must not
    // put the relay on the internet.
    const { WebSocket: Client } = await import('ws')
    await realHost()
    await host.setEnabled(true)
    const url = `ws://127.0.0.1:${host.getState().port}/`
    for (const headers of [
      { 'cf-warp-tag-id': '6f0c9a52-6f43-4bd4-9a7e-3b55e2d3c1aa' },
      { 'cf-connecting-ip': '203.0.113.9' }
    ]) {
      const { code, frames } = await new Promise<{ code: number; frames: number }>((resolve) => {
        let frames = 0
        const client = new Client(url, { headers })
        client.on('message', () => frames++)
        client.on('close', (code) => resolve({ code, frames }))
      })
      expect(code).toBe(1008)
      expect(frames).toBe(0)
    }
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

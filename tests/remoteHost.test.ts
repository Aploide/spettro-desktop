// The remote host, driven the way a phone drives it: a socket that gets
// `hello`, answers it with a proof, and then lives on what the host sends.
//
// No server is started. RemoteHost.acceptSocket is what the listener calls
// for every connection, so a fake socket handed to it goes through exactly
// the code a real one would; the bridge behind the host is a fake too, so
// each test says what the app holds and reads what the phone would see.

import { EventEmitter } from 'events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import type { JSONValue } from '@shared/acp'
import type { ChatSummary, StoredSession } from '@shared/model'
import { REMOTE_HOST_FEATURES, RemoteMethod } from '@shared/remote'
import type { RemoteBridge } from '@main/remote/bridge'
import { RemoteHost } from '@main/remote/host'
import { base64urlDecode, computeProof } from '@main/remote/pairing'

type Frame = { [key: string]: JSONValue }

/** What `ws` gives the host: frames out through send(), frames in as
 *  'message' events. */
class FakeSocket extends EventEmitter {
  readonly sent: Frame[] = []
  closed = false

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Frame)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
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
    listProjects: () => [],
    prompt: async () => undefined,
    cancelChat: () => undefined,
    setConfig: async () => undefined,
    agentCall: async () => null,
    resolvePermission: () => undefined,
    answerQuestion: () => undefined,
    agentReady: () => true,
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

/** A socket that has been through hello and a successful resume. Resolves
 *  once the host's post-auth sends have gone out. */
async function attached(deviceId = 'phone-1'): Promise<FakeSocket> {
  const key = host.pairDevice(deviceId, 'Pixel', 'android')
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
  await settle()
  expect(socket.reply(id)?.result).toBeDefined()
  return socket
}

/** Sends a request and waits for its reply. */
async function call(socket: FakeSocket, method: string, params: JSONValue): Promise<Frame> {
  const id = nextId++
  socket.receive({ jsonrpc: '2.0', id, method, params })
  for (let i = 0; i < 20; i++) {
    const reply = socket.reply(id)
    if (reply) return reply
    await settle()
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

  it('leaves remoteHost out of the auth result while there is no tunnel', async () => {
    makeHost()
    const socket = await attached()
    const auth = socket.sent.find((f) => f.id === 1)?.result as Frame
    expect('remoteHost' in auth).toBe(false)
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
    expect(socket.sent[stateAt].params).toEqual({ agentReady: true, shuttingDown: false, remoteHost: '' })
  })

  it('serves nothing but auth before the device has proved itself', async () => {
    makeHost({ listChats: () => [summary('00000000-0000-4000-8000-0000000000aa')] })
    const socket = new FakeSocket()
    host.acceptSocket(socket as unknown as WebSocket)
    const reply = await call(socket, RemoteMethod.chatsList, {})
    expect((reply.error as Frame).code).toBe(-33001)
    expect(socket.notifications(RemoteMethod.hostState)).toHaveLength(0)
  })

  it('says nothing about the public hostname in a goodbye', async () => {
    // A goodbye is about this launch; a phone that cleared its hostname
    // here could not find the host over the internet after the next one.
    makeHost()
    const socket = await attached()
    bridge.events.emit('host-state', { agentReady: false, shuttingDown: true })
    const goodbye = socket.notifications(RemoteMethod.hostState).at(-1)?.params as Frame
    expect(goodbye).toEqual({ agentReady: false, shuttingDown: true })
  })
})

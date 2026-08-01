// One attached phone: the handshake that lets it in, and the dispatch table
// for everything it can ask for afterwards — port of RemoteHostSession.swift
// (plus the server half of JSONRPCPeer.swift over `ws`).
//
// The ordering rule that matters: NOTHING but `auth` is served until the
// device has proved itself. A connection on the LAN is not evidence of
// anything — the listener accepts anyone who can reach the port, and this is
// the file that decides whether they get to see a transcript.
//
// Framing: JSON-RPC 2.0, one message per WebSocket text frame.

import type { WebSocket } from 'ws'
import type { ACPContentBlock, JSONValue } from '../../shared/acp'
import {
  REMOTE_PROTOCOL_VERSION,
  RemoteAuthError,
  RemoteMethod,
  chatSummaryToWire,
  normalizeCommands,
  normalizeConfigOptions,
  normalizePlan,
  normalizeUsage,
  storedSessionToWire,
  type RemoteAuthResultPayload,
  type RemoteHelloParams,
  type RemoteHostStateParams,
  type RemoteProjectWire
} from '../../shared/remote'
import type { RemoteBridge } from './bridge'
import { base64urlEncode, randomKey, verifyProof } from './pairing'

/** What a session needs from its RemoteHost. Kept as an interface so the two
 *  files depend on each other by type only. */
export interface RemoteHostSessionDelegate {
  readonly hostId: string
  readonly hostName: string
  readonly hostVersion: string
  readonly bridge: RemoteBridge
  /** The live pairing secret, or null when the window is shut or expired. */
  openPairingSecret(): Buffer | null
  /** Close the pairing window — called on the FIRST successful pair. */
  completePairing(): void
  /** Mint + persist a device record (re-pairing replaces the key). Returns the
   *  fresh 32-byte key, which travels exactly once, on this connection. */
  pairDevice(id: string, name: string, platform: string): Buffer
  /** Stored (possibly revoked) device lookup for `resume`. */
  resumeDevice(id: string): { key: Buffer; revoked: boolean } | null
  sessionAuthenticated(session: RemoteHostSession): void
  sessionClosed(session: RemoteHostSession): void
}

/** A JSON-RPC error to return from a request handler. */
class RPCFault extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
  }
}

const invalidParams = (): RPCFault => new RPCFault(-32602, 'invalid params')

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** The iOS client round-trips chat ids through `UUID`, which re-encodes them
 *  UPPERCASE; our model mints lowercase ones. Normalize for lookups. */
function normalizeChatId(id: string): string {
  return UUID_RE.test(id) ? id.toLowerCase() : id
}

function asObject(value: JSONValue | undefined): { [key: string]: JSONValue } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidParams()
  return value
}

function reqString(obj: { [key: string]: JSONValue }, key: string): string {
  const value = obj[key]
  if (typeof value !== 'string') throw invalidParams()
  return value
}

function optString(obj: { [key: string]: JSONValue }, key: string): string | undefined {
  const value = obj[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw invalidParams()
  return value
}

function optBool(obj: { [key: string]: JSONValue }, key: string): boolean | undefined {
  const value = obj[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw invalidParams()
  return value
}

export class RemoteHostSession {
  /** Set once `auth` succeeds. Also the gate every other handler checks. */
  private authedDeviceId: string | null = null
  /** This connection's nonce. Regenerated per connection, so a proof captured
   *  from an earlier one cannot be replayed onto this. */
  private readonly challenge = randomKey()
  private closed = false

  constructor(
    private readonly ws: WebSocket,
    private readonly delegate: RemoteHostSessionDelegate
  ) {
    ws.on('message', (data) => {
      this.handleFrame(data.toString())
    })
    ws.on('close', () => this.didClose())
    ws.on('error', () => this.didClose())
    // The host speaks first: the client cannot build an auth proof until it
    // has the challenge, so `hello` goes out the moment the socket is open —
    // which, for a server-accepted `ws` connection, is right now.
    this.sendHello()
  }

  get deviceId(): string | null {
    return this.authedDeviceId
  }

  get isAuthenticated(): boolean {
    return this.authedDeviceId !== null
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }

  private didClose(): void {
    if (this.closed) return
    this.closed = true
    this.delegate.sessionClosed(this)
  }

  /** Sends a JSON-RPC notification (one message per text frame). */
  notify(method: string, params: JSONValue): void {
    if (this.closed) return
    this.sendFrame({ jsonrpc: '2.0', method, params })
  }

  private sendFrame(frame: JSONValue): void {
    try {
      this.ws.send(JSON.stringify(frame))
    } catch {
      /* connection is going away; close event will follow */
    }
  }

  private sendHello(): void {
    const hello: RemoteHelloParams = {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      hostID: this.delegate.hostId,
      hostName: this.delegate.hostName,
      hostKind: 'app',
      hostVersion: this.delegate.hostVersion,
      challenge: base64urlEncode(this.challenge),
      pairingOpen: this.delegate.openPairingSecret() !== null
    }
    this.notify(RemoteMethod.hello, hello as unknown as JSONValue)
  }

  // MARK: Inbound frames

  private handleFrame(text: string): void {
    let root: JSONValue
    try {
      root = JSON.parse(text) as JSONValue
    } catch {
      return // dropping unparseable frame
    }
    if (typeof root !== 'object' || root === null || Array.isArray(root)) return
    const method = root.method
    if (typeof method !== 'string') return // a response to one of ours — the host sends none
    const id = root.id
    if (typeof id !== 'number' && typeof id !== 'string') return // client notification — none defined
    void this.dispatch(method, root.params, id)
  }

  private async dispatch(method: string, params: JSONValue | undefined, id: number | string): Promise<void> {
    // The reply is one-shot: a handler that answered twice would put a second
    // frame with the same id on the wire.
    let answered = false
    const succeed = (result: JSONValue): void => {
      if (answered || this.closed) return
      answered = true
      this.sendFrame({ jsonrpc: '2.0', id, result })
    }
    const fail = (code: number, message: string): void => {
      if (answered || this.closed) return
      answered = true
      this.sendFrame({ jsonrpc: '2.0', id, error: { code, message } })
    }

    try {
      if (method === RemoteMethod.auth) {
        succeed(this.authenticate(params))
        return
      }
      if (!this.isAuthenticated) {
        fail(RemoteAuthError.notPaired, 'not authenticated')
        return
      }
      succeed(await this.handleAuthenticated(method, params))
    } catch (error) {
      if (error instanceof RPCFault) fail(error.code, error.message)
      else fail(-32000, error instanceof Error ? error.message : String(error))
    }
  }

  // MARK: Authenticated dispatch (doc 34 §5-8)

  private async handleAuthenticated(method: string, params: JSONValue | undefined): Promise<JSONValue> {
    const bridge = this.delegate.bridge

    switch (method) {
      case RemoteMethod.chatsList:
        return { chats: bridge.listChats().map(chatSummaryToWire) as unknown as JSONValue[] }

      case RemoteMethod.chatOpen: {
        const obj = asObject(params)
        const chatId = normalizeChatId(reqString(obj, 'chatID'))
        const result = bridge.openChat(chatId)
        if (!result) throw new RPCFault(-32001, 'no such chat')
        const wire: { [key: string]: JSONValue } = {
          chat: storedSessionToWire(result.chat),
          configOptions: normalizeConfigOptions(result.configOptions),
          commands: normalizeCommands(result.commands),
          plan: normalizePlan(result.plan),
          isBusy: result.isBusy
        }
        const usage = normalizeUsage(result.usage)
        if (usage !== null) wire.usage = usage
        return wire
      }

      case RemoteMethod.chatClose: {
        const obj = asObject(params)
        bridge.closeChat(normalizeChatId(reqString(obj, 'chatID')))
        return null
      }

      case RemoteMethod.chatNew: {
        const obj = asObject(params)
        try {
          const summary = bridge.newChat(reqString(obj, 'projectPath'))
          return chatSummaryToWire(summary) as unknown as JSONValue
        } catch (error) {
          if (error instanceof RPCFault) throw error
          throw new RPCFault(-32001, "couldn't start a chat there")
        }
      }

      case RemoteMethod.chatDelete: {
        const obj = asObject(params)
        bridge.deleteChat(normalizeChatId(reqString(obj, 'chatID')))
        return null
      }

      case RemoteMethod.chatFlag: {
        const obj = asObject(params)
        const chatId = normalizeChatId(reqString(obj, 'chatID'))
        const flags: { isPinned?: boolean; isArchived?: boolean } = {}
        const isPinned = optBool(obj, 'isPinned')
        const isArchived = optBool(obj, 'isArchived')
        if (isPinned !== undefined) flags.isPinned = isPinned
        if (isArchived !== undefined) flags.isArchived = isArchived
        bridge.flagChat(chatId, flags)
        return null
      }

      case RemoteMethod.chatPrompt: {
        const obj = asObject(params)
        const chatId = normalizeChatId(reqString(obj, 'chatID'))
        const rawBlocks = obj.blocks
        if (!Array.isArray(rawBlocks)) throw invalidParams()
        const blocks = rawBlocks.map(parseContentBlock)
        // Fire-and-forget, like the Swift host: progress comes back as
        // broadcasts, the same ones the local UI renders from.
        void bridge.prompt(chatId, blocks, this.authedDeviceId as string).catch((error) => {
          console.error('[remote] prompt failed', error)
        })
        return null
      }

      case RemoteMethod.chatCancel: {
        const obj = asObject(params)
        bridge.cancelChat(normalizeChatId(reqString(obj, 'chatID')))
        return null
      }

      case RemoteMethod.chatConfig: {
        const obj = asObject(params)
        const chatId = normalizeChatId(reqString(obj, 'chatID'))
        const configId = reqString(obj, 'configID')
        const stringValue = optString(obj, 'stringValue')
        const boolValue = optBool(obj, 'boolValue')
        if (stringValue === undefined && boolValue === undefined) throw invalidParams()
        const value = stringValue !== undefined ? { stringValue } : { boolValue }
        void bridge.setConfig(chatId, configId, value).catch((error) => {
          console.error('[remote] setConfig failed', error)
        })
        return null
      }

      // Both of these take the prompt down everywhere, including the local
      // window: the resolved broadcast is emitted by the model as it resolves,
      // so there is one source of truth no matter which screen answered.
      case RemoteMethod.permissionReply: {
        const obj = asObject(params)
        bridge.resolvePermission(
          reqString(obj, 'promptID'),
          optString(obj, 'selectedOptionID') ?? null,
          this.authedDeviceId as string
        )
        return null
      }

      case RemoteMethod.questionReply: {
        const obj = asObject(params)
        const answers = obj.answers
        if (answers !== undefined && answers !== null && !Array.isArray(answers)) throw invalidParams()
        bridge.answerQuestion(
          reqString(obj, 'promptID'),
          answers ?? null,
          this.authedDeviceId as string
        )
        return null
      }

      case RemoteMethod.agentCall: {
        const obj = asObject(params)
        const target = reqString(obj, 'method')
        // Only the extension namespace, and never our own surface. A remote
        // client issuing raw `session/*` (or `_spettro/remote/*`) behind the
        // host's back is exactly the drift this protocol exists to prevent.
        if (!target.startsWith('_spettro/') || target.startsWith('_spettro/remote/')) {
          throw new RPCFault(-32601, `method not forwardable: ${target}`)
        }
        return await bridge.agentCall(target, obj.params ?? null)
      }

      case RemoteMethod.projectsList:
        return { projects: this.projects() as unknown as JSONValue[] }

      default:
        throw new RPCFault(-32601, `method not supported: ${method}`)
    }
  }

  /** `chatCount` is non-optional on the client, so it is computed here from
   *  the chat list rather than left to the bridge. Ordered by what the user
   *  actually works on: chat count desc, then name. */
  private projects(): RemoteProjectWire[] {
    const counts = new Map<string, number>()
    for (const chat of this.delegate.bridge.listChats()) {
      counts.set(chat.projectPath, (counts.get(chat.projectPath) ?? 0) + 1)
    }
    return this.delegate.bridge
      .listProjects()
      .map((p) => ({ path: p.path, name: p.name, chatCount: counts.get(p.path) ?? 0 }))
      .sort((a, b) => b.chatCount - a.chatCount || a.name.localeCompare(b.name))
  }

  // MARK: Auth

  private authenticate(params: JSONValue | undefined): JSONValue {
    let obj: { [key: string]: JSONValue }
    let mode: string
    let deviceID: string
    let proof: string
    let protocolVersion: number
    try {
      obj = asObject(params)
      mode = reqString(obj, 'mode')
      deviceID = reqString(obj, 'deviceID')
      proof = reqString(obj, 'proof')
      const rawVersion = obj.protocolVersion
      protocolVersion = typeof rawVersion === 'number' ? rawVersion : REMOTE_PROTOCOL_VERSION
      if (mode !== 'pair' && mode !== 'resume') throw invalidParams()
    } catch {
      throw invalidParams()
    }

    if (protocolVersion !== REMOTE_PROTOCOL_VERSION) {
      throw new RPCFault(
        RemoteAuthError.versionMismatch,
        `this host speaks Spettro Remote v${REMOTE_PROTOCOL_VERSION}`
      )
    }

    let mintedKey: Buffer | null = null
    if (mode === 'pair') {
      const secret = this.delegate.openPairingSecret()
      if (!secret) {
        throw new RPCFault(
          RemoteAuthError.pairingExpired,
          'the pairing code expired — show a new one on the host'
        )
      }
      if (!verifyProof(proof, secret, this.challenge, this.delegate.hostId)) {
        throw new RPCFault(RemoteAuthError.badProof, "that code didn't match")
      }
      mintedKey = this.delegate.pairDevice(
        deviceID,
        optString(obj, 'deviceName') ?? 'Device',
        optString(obj, 'platform') ?? 'unknown'
      )
      // One code, one device. Leaving the window open after a successful scan
      // would let a second phone that photographed the screen pair itself
      // minutes later.
      this.delegate.completePairing()
    } else {
      const known = this.delegate.resumeDevice(deviceID)
      if (!known) {
        throw new RPCFault(
          RemoteAuthError.notPaired,
          `this device isn't paired with ${this.delegate.hostName}`
        )
      }
      if (known.revoked) {
        throw new RPCFault(RemoteAuthError.revoked, 'access for this device was removed')
      }
      if (!verifyProof(proof, known.key, this.challenge, this.delegate.hostId)) {
        throw new RPCFault(RemoteAuthError.badProof, "couldn't verify this device")
      }
    }

    this.authedDeviceId = deviceID
    this.delegate.sessionAuthenticated(this)

    const result: RemoteAuthResultPayload = {
      hostID: this.delegate.hostId,
      hostName: this.delegate.hostName,
      hostKind: 'app',
      agentReady: this.delegate.bridge.agentReady()
    }
    // The durable key travels exactly once, on the connection that minted it.
    // A resume proves the key the device already has.
    if (mintedKey) result.deviceKey = base64urlEncode(mintedKey)
    return result as unknown as JSONValue
  }

  /** Host state pushed to a freshly authenticated session, so it shows the
   *  truth immediately rather than assuming. */
  sendHostState(state: RemoteHostStateParams): void {
    this.notify(RemoteMethod.hostState, state as unknown as JSONValue)
  }
}

function parseContentBlock(value: JSONValue): ACPContentBlock {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidParams()
  const type = value.type
  if (type === 'text' && typeof value.text === 'string') {
    return { type: 'text', text: value.text }
  }
  if (type === 'image' && typeof value.data === 'string' && typeof value.mimeType === 'string') {
    return { type: 'image', data: value.data, mimeType: value.mimeType }
  }
  throw new RPCFault(-32602, `unsupported content block type: ${String(type)}`)
}

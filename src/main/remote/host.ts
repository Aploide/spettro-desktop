// The server half: listens for paired phones, advertises itself on the local
// network, and fans host events out to every attached screen — port of
// RemoteHost.swift.
//
// Lifetime: the listener runs for as long as remote access is switched on,
// independent of whether any phone is connected — the phone is the thing that
// comes and goes. Sharing is off by default and opt-in, matching /remote in
// the TUI; once on, it stays on across launches (onSharingChanged persists
// it, restoreSharing brings it back) until the user turns it off.

import { networkInterfaces } from 'os'
import { WebSocketServer, type WebSocket } from 'ws'
import QRCodeLib from 'qrcode'
import type { JSONValue } from '../../shared/acp'
import type { ChatSummary, RemoteHostState } from '../../shared/model'
import {
  PAIRING_WINDOW_MS,
  REMOTE_PREFERRED_PORT,
  REMOTE_PROTOCOL_VERSION,
  RemoteMethod,
  chatSummaryToWire,
  rfc3339,
  type RemoteHostStateParams
} from '../../shared/remote'
import type { RemoteBridge } from './bridge'
import {
  CLOSE_POLICY,
  CLOSE_TRY_AGAIN_LATER,
  FailedAuthLimiter,
  HEARTBEAT_MS,
  LAN_ORIGIN,
  MAX_PAYLOAD_BYTES,
  MAX_SESSIONS,
  MAX_UNAUTHENTICATED_TUNNELED,
  admitsTunneled,
  classifyConnection,
  type ConnectionOrigin
} from './connectionGuard'
import { RemoteAdvertiser } from './discovery'
import { RemoteHostSession, type RemoteHostSessionDelegate } from './hostSession'
import { HostIdentityStore, PairedDeviceStore } from './pairedDevices'
import {
  buildPairingURL,
  createPairingWindow,
  isPairingWindowExpired,
  type PairingWindow
} from './pairing'

function appVersion(): string {
  try {
    // Available in the Electron main process; guarded so tests can run
    // outside it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron')
    return app.getVersion()
  } catch {
    return '0.0.0'
  }
}

/** First non-internal IPv4 for the QR's fallback address hint (`a=`/`p=`).
 *  Bonjour is the real discovery path; this matters on networks that filter
 *  mDNS. Wireless interfaces are preferred — that is where the phone lives. */
function primaryLANAddress(): string | undefined {
  const interfaces = networkInterfaces()
  let best: string | undefined
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      // `family` is 'IPv4' in current Node typings but was the number 4 in
      // older runtimes; compare loosely.
      if (String(address.family) !== 'IPv4' && String(address.family) !== '4') continue
      if (address.internal) continue
      if (/^(wl|wifi|wlan|en0)/i.test(name)) return address.address
      if (!best) best = address.address
    }
  }
  return best
}

/** permission/ask and question/ask params: the host's prompt id, the chat
 *  when there is one, and the agent's request verbatim. */
function askParams(promptId: string, chatId: string | null, raw: JSONValue): JSONValue {
  const params: { [key: string]: JSONValue } = { promptID: promptId, request: raw }
  if (chatId) params.chatID = chatId
  return params
}

export class RemoteHost implements RemoteHostSessionDelegate {
  readonly bridge: RemoteBridge
  private readonly onStateChanged: (s: RemoteHostState) => void
  private readonly onSharingChanged: (enabled: boolean) => void
  private readonly devices: PairedDeviceStore
  private readonly identity: HostIdentityStore
  private readonly advertiser = new RemoteAdvertiser()
  private readonly version = appVersion()

  private wss: WebSocketServer | null = null
  private port: number | null = null
  private enabled = false
  private starting: Promise<void> | null = null
  private sessions: RemoteHostSession[] = []
  private connectedDeviceIds = new Set<string>()
  private readonly authLimiter = new FailedAuthLimiter()
  private heartbeat: NodeJS.Timeout | null = null

  private pairingWindow: PairingWindow | null = null
  private pairingTimer: NodeJS.Timeout | null = null
  private pairingURL: string | null = null
  private pairingQR: string | null = null
  /** When the open pairing code stops working (ms since epoch). */
  private pairingExpiresAt: number | null = null
  /** The last code ran out rather than being closed — the pane offers a new
   *  one instead of quietly disappearing. */
  private pairingExpired = false

  /** Listeners registered on bridge.events, kept for shutdown(). */
  private readonly bridgeListeners: [string, (...args: never[]) => void][] = []

  constructor(
    bridge: RemoteBridge,
    opts: {
      dataDir: string
      onStateChanged: (s: RemoteHostState) => void
      /** The user turned sharing on or off — persisted so a launch can
       *  restore it. Not called when the app quits with sharing on. */
      onSharingChanged?: (enabled: boolean) => void
    }
  ) {
    this.bridge = bridge
    this.onStateChanged = opts.onStateChanged
    this.onSharingChanged = opts.onSharingChanged ?? ((): void => undefined)
    this.devices = new PairedDeviceStore(opts.dataDir)
    this.identity = new HostIdentityStore(opts.dataDir)
    this.wireBridgeEvents()
  }

  // MARK: RemoteHostSessionDelegate

  get hostId(): string {
    return this.identity.hostId
  }

  get hostName(): string {
    return this.identity.hostName
  }

  get hostVersion(): string {
    return this.version
  }

  /** The public hostname a tunnel puts this host at. None yet: this is the
   *  one place the tunnel fills in, and the auth result and every host/state
   *  pick it up from here. */
  get remoteHost(): string | undefined {
    return undefined
  }

  /** Pairing through the tunnel: off unless the user allowed it, and off
   *  again while someone is hammering auth over the internet. */
  get internetPairingAllowed(): boolean {
    return false
  }

  /** What the kill switch checks a tunneled connection against. */
  private tunnelGate(): { running: boolean; connectorId: string | null } {
    return { running: false, connectorId: null }
  }

  authFailed(session: RemoteHostSession): void {
    if (this.authLimiter.recordFailure(session.origin)) {
      // A wave of failures over the internet: whatever pairing code is up
      // stops working, and pairing through the tunnel stays off until the
      // user opens a new code.
      console.error('[remote] repeated failed sign-ins over the internet; pairing through the tunnel is off')
      this.closePairing()
    }
  }

  openPairingSecret(): Buffer | null {
    if (!this.pairingWindow || isPairingWindowExpired(this.pairingWindow)) return null
    return this.pairingWindow.secret
  }

  completePairing(): void {
    this.closePairing()
  }

  pairDevice(id: string, name: string, platform: string): Buffer {
    const { key } = this.devices.pair(id, name, platform)
    return key
  }

  resumeDevice(id: string): { key: Buffer; revoked: boolean } | null {
    const record = this.devices.device(id)
    if (!record) return null
    const key = this.devices.deviceKey(id)
    if (!key) return null
    return { key, revoked: record.revoked }
  }

  /** Called by a session once its auth reply has gone out. */
  sessionAuthenticated(session: RemoteHostSession): void {
    const deviceId = session.deviceId
    if (!deviceId) return
    this.devices.markSeen(deviceId)
    this.connectedDeviceIds.add(deviceId)
    // One device, one connection. A phone that backgrounded and came back may
    // have left a half-open socket the OS hasn't reaped; the new socket is
    // the real screen, and keeping both would double every broadcast.
    for (const other of this.sessions) {
      if (other !== session && other.deviceId === deviceId) other.close()
    }
    this.sessions = this.sessions.filter((s) => s === session || s.deviceId !== deviceId)
    // The prompts this session was never told about: everything from here
    // on reaches it as a broadcast.
    const waiting = this.bridge.pendingPrompts()
    // A phone that just attached is shown the live agent state rather than
    // being left to assume — a turn later rather than right behind the
    // reply, so the phone has had its answer in hand for a moment before
    // the first notification arrives. Then whatever is still waiting on an
    // answer, asked again exactly as it was asked: a phone that attaches
    // mid-prompt (or comes back from the background) would otherwise never
    // see the approval the turn is blocked on.
    setImmediate(() => {
      if (!this.sessions.includes(session)) return
      session.sendHostState(this.hostStateParams(this.bridge.agentReady(), false))
      const still = new Set(this.bridge.pendingPrompts().map((p) => p.promptId))
      for (const prompt of waiting) {
        if (!still.has(prompt.promptId)) continue
        const method = prompt.kind === 'permission' ? RemoteMethod.permissionAsk : RemoteMethod.questionAsk
        session.notify(method, askParams(prompt.promptId, prompt.chatId, prompt.raw))
      }
    })
    this.publishState()
  }

  /** A host/state as this host sends it: the public hostname rides along
   *  while the host is up (see RemoteHostStateParams.remoteHost). */
  private hostStateParams(agentReady: boolean, shuttingDown: boolean, message?: string): RemoteHostStateParams {
    const params: RemoteHostStateParams = { agentReady, shuttingDown }
    if (message !== undefined && message !== null) params.message = message
    if (!shuttingDown) params.remoteHost = this.remoteHost ?? ''
    return params
  }

  sessionClosed(session: RemoteHostSession): void {
    this.sessions = this.sessions.filter((s) => s !== session)
    const deviceId = session.deviceId
    if (deviceId && !this.sessions.some((s) => s.deviceId === deviceId)) {
      this.connectedDeviceIds.delete(deviceId)
      this.publishState()
    }
  }

  // MARK: Lifecycle

  async setEnabled(v: boolean): Promise<void> {
    if (v) await this.start()
    else this.stop()
    this.onSharingChanged(v)
  }

  /** At launch: sharing left on when the app last quit is on again, since a
   *  phone away from this computer has no way to turn it back on itself.
   *  `wasOn` is the persisted preference (onSharingChanged keeps it). */
  async restoreSharing(wasOn: boolean): Promise<void> {
    if (wasOn) await this.setEnabled(true)
  }

  private async start(): Promise<void> {
    if (this.enabled) return
    if (this.starting) return this.starting
    this.starting = (async () => {
      // Preferred port first; if it's taken (another Spettro, or anything
      // else) let the OS pick — clients find us by Bonjour, not port number.
      let wss: WebSocketServer
      try {
        wss = await this.listen(REMOTE_PREFERRED_PORT)
      } catch {
        wss = await this.listen(0)
      }
      this.wss = wss
      const address = wss.address()
      this.port = typeof address === 'object' && address !== null ? address.port : null
      wss.on('connection', (socket, req) => {
        if (!this.enabled) {
          socket.close()
          return
        }
        this.watchHeartbeat(socket)
        this.acceptSocket(socket, classifyConnection(req.socket.remoteAddress, req.headers))
      })
      this.startHeartbeat(wss)
      wss.on('error', (error) => {
        console.error('[remote] listener error', error)
      })
      this.enabled = true
      this.advertise()
      this.publishState()
    })()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  /** Takes on a connection the listener accepted: it is sent `hello` at
   *  once, and nothing else until it authenticates. Null when it was turned
   *  away instead: a tunneled connection the kill switch stops, an address
   *  blocked for failing auth, or one socket too many. */
  acceptSocket(socket: WebSocket, origin: ConnectionOrigin = LAN_ORIGIN): RemoteHostSession | null {
    const reject = (code: number): null => {
      try {
        socket.close(code)
      } catch {
        /* already gone */
      }
      return null
    }
    if (!admitsTunneled(origin, this.tunnelGate())) return reject(CLOSE_POLICY)
    // A phone on the LAN that failed its way into a block can still pair
    // while a code is up: that is how it gets a working key again.
    if (this.authLimiter.isBlocked(origin.peerIp) && !(origin.via === 'lan' && this.openPairingSecret())) {
      return reject(CLOSE_POLICY)
    }
    if (this.sessions.length >= MAX_SESSIONS) return reject(CLOSE_TRY_AGAIN_LATER)
    if (
      origin.via === 'tunnel' &&
      this.sessions.filter((s) => s.via === 'tunnel' && !s.isAuthenticated).length >= MAX_UNAUTHENTICATED_TUNNELED
    ) {
      return reject(CLOSE_TRY_AGAIN_LATER)
    }
    const session = new RemoteHostSession(socket, this, origin)
    this.sessions.push(session)
    return session
  }

  // MARK: Heartbeat

  private readonly alive = new WeakMap<WebSocket, boolean>()

  private watchHeartbeat(socket: WebSocket): void {
    this.alive.set(socket, true)
    socket.on('pong', () => this.alive.set(socket, true))
  }

  /** Pings every socket each HEARTBEAT_MS and ends any that didn't answer
   *  the last one: a phone that vanished behind the tunnel (or a NAT that
   *  forgot it) otherwise holds its socket open forever. */
  private startHeartbeat(wss: WebSocketServer): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      for (const socket of wss.clients) {
        if (this.alive.get(socket) === false) {
          socket.terminate()
          continue
        }
        this.alive.set(socket, false)
        try {
          socket.ping()
        } catch {
          /* closing anyway */
        }
      }
    }, HEARTBEAT_MS)
    this.heartbeat.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  private listen(port: number): Promise<WebSocketServer> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port, maxPayload: MAX_PAYLOAD_BYTES })
      const onError = (error: Error): void => {
        wss.close()
        reject(error)
      }
      wss.once('error', onError)
      wss.once('listening', () => {
        wss.off('error', onError)
        resolve(wss)
      })
    })
  }

  private stop(): void {
    if (!this.enabled && !this.wss) {
      this.closePairing()
      return
    }
    // Tell attached phones this is deliberate before dropping them, so they
    // show "sharing was turned off" instead of retrying against what looks
    // like a flaky network.
    this.broadcast(
      RemoteMethod.hostState,
      this.hostStateParams(false, true, 'Remote access was turned off.') as unknown as JSONValue
    )
    for (const session of this.sessions) session.close()
    this.sessions = []
    this.connectedDeviceIds.clear()
    this.closePairingInternal()
    this.advertiser.stop()
    this.stopHeartbeat()
    this.wss?.close()
    this.wss = null
    this.port = null
    this.enabled = false
    this.publishState()
  }

  private advertise(): void {
    if (!this.enabled || this.port === null) return
    this.advertiser.start({
      hostId: this.identity.hostId,
      hostName: this.identity.hostName,
      serviceName: this.identity.serviceName,
      port: this.port,
      kind: 'app'
    })
  }

  // MARK: Pairing

  /** Opens a pairing window and exposes the QR via getState(). Sharing has to
   *  be on for a scan to reach anything, so turning it on is part of "show me
   *  the code" rather than a separate step. */
  async openPairing(): Promise<void> {
    // The user is back at the screen: a breaker tripped by failed sign-ins
    // over the internet is theirs to reset.
    this.authLimiter.resetBreaker()
    if (!this.enabled) {
      await this.start()
      this.onSharingChanged(true)
    }
    if (this.pairingTimer) clearTimeout(this.pairingTimer)
    const window = createPairingWindow()
    this.pairingWindow = window
    this.pairingURL = buildPairingURL({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      hostID: this.identity.hostId,
      hostName: this.identity.hostName,
      hostKind: 'app',
      secret: window.secret,
      address: primaryLANAddress(),
      port: this.port ?? undefined
    })
    try {
      // Medium error correction, like the Mac host: the payload is ~150
      // characters and a denser code is harder to scan.
      this.pairingQR = await QRCodeLib.toDataURL(this.pairingURL, {
        errorCorrectionLevel: 'M',
        margin: 2,
        scale: 6
      })
    } catch (error) {
      console.error('[remote] could not render pairing QR', error)
      this.pairingQR = null
    }
    this.pairingExpired = false
    this.pairingExpiresAt = Date.now() + PAIRING_WINDOW_MS
    this.pairingTimer = setTimeout(() => {
      this.closePairingInternal()
      this.pairingExpired = true
      this.publishState()
    }, PAIRING_WINDOW_MS)
    this.publishState()
  }

  closePairing(): void {
    this.closePairingInternal()
    this.pairingExpired = false
    this.publishState()
  }

  private closePairingInternal(): void {
    if (this.pairingTimer) {
      clearTimeout(this.pairingTimer)
      this.pairingTimer = null
    }
    this.pairingWindow = null
    this.pairingURL = null
    this.pairingQR = null
    this.pairingExpiresAt = null
  }

  // MARK: Devices / identity

  revokeDevice(id: string): void {
    this.devices.revoke(id)
    this.publishState()
  }

  renameHost(name: string): void {
    this.identity.rename(name)
    // The advertisement and any open pairing payload carry the name; refresh
    // both so what the phone sees matches what the user typed.
    if (this.enabled) this.advertise()
    if (this.pairingWindow && !isPairingWindowExpired(this.pairingWindow)) {
      this.pairingURL = buildPairingURL({
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        hostID: this.identity.hostId,
        hostName: this.identity.hostName,
        hostKind: 'app',
        secret: this.pairingWindow.secret,
        address: primaryLANAddress(),
        port: this.port ?? undefined
      })
      const url = this.pairingURL
      void QRCodeLib.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, scale: 6 })
        .then((qr) => {
          if (this.pairingURL === url) {
            this.pairingQR = qr
            this.publishState()
          }
        })
        .catch(() => undefined)
    }
    this.publishState()
  }

  // MARK: State

  getState(): RemoteHostState {
    return {
      enabled: this.enabled,
      port: this.port,
      hostId: this.identity.hostId,
      hostName: this.identity.hostName,
      pairingOpen: this.openPairingSecret() !== null,
      pairingURL: this.pairingURL,
      pairingQR: this.pairingQR,
      pairingExpiresAt: this.pairingExpiresAt,
      pairingExpired: this.pairingExpired,
      devices: this.devices.toDTOs(),
      connectedDeviceIds: [...this.connectedDeviceIds]
    }
  }

  shutdown(): void {
    this.stop()
    for (const [event, listener] of this.bridgeListeners) {
      this.bridge.events.off(event, listener as (...args: unknown[]) => void)
    }
    this.bridgeListeners.length = 0
  }

  private publishState(): void {
    this.onStateChanged(this.getState())
  }

  // MARK: Broadcasting (doc 34 §6-8)

  /** Sends a notification to every authenticated client, optionally excluding
   *  one device. A null/undefined exclusion means the event originated on
   *  this machine, so everyone hears it. */
  private broadcast(method: string, params: JSONValue, excludeDeviceId?: string | null): void {
    for (const session of this.sessions) {
      if (!session.isAuthenticated) continue
      if (excludeDeviceId && session.deviceId === excludeDeviceId) continue
      session.notify(method, params)
    }
  }

  /** resolvedBy on the wire is a display name ("answered on Mac"). The bridge
   *  hands device ids for remote answers and null for local ones. */
  private resolvedByName(resolvedBy: string | null): string {
    if (!resolvedBy) return this.identity.hostName
    return this.devices.device(resolvedBy)?.name ?? resolvedBy
  }

  private wireBridgeEvents(): void {
    const on = (event: string, listener: (...args: never[]) => void): void => {
      this.bridge.events.on(event, listener as (...args: unknown[]) => void)
      this.bridgeListeners.push([event, listener])
    }

    // A streamed agent update, re-keyed from ACP session id to chat id.
    // Carries the raw ACP `update` object verbatim — a field this host does
    // not model still reaches a client that does.
    on('chat-update', (chatId: string, rawUpdate: JSONValue) => {
      this.broadcast(RemoteMethod.chatUpdate, { chatID: chatId, update: rawUpdate })
    })

    // A submitted prompt, echoed to every screen EXCEPT the submitter — the
    // sender already drew it optimistically, and echoing double-posts.
    on(
      'chat-user',
      (
        chatId: string,
        text: string,
        attachments: { data?: string; base64?: string; mimeType: string }[],
        timestamp: number,
        sourceDeviceId: string | null
      ) => {
        this.broadcast(
          RemoteMethod.chatUserMessage,
          {
            chatID: chatId,
            text,
            attachments: (attachments ?? []).map((a) => ({
              base64: a.base64 ?? a.data ?? '',
              mimeType: a.mimeType
            })),
            timestamp: rfc3339(timestamp)
          },
          sourceDeviceId
        )
      }
    )

    on('chat-state', (summary: ChatSummary, extra?: { stopReason?: string; notice?: { text: string; isError: boolean } }) => {
      const params: { [key: string]: JSONValue } = {
        chat: chatSummaryToWire(summary) as unknown as JSONValue
      }
      if (extra?.stopReason !== undefined) params.stopReason = extra.stopReason
      if (extra?.notice !== undefined) params.notice = { text: extra.notice.text, isError: extra.notice.isError }
      this.broadcast(RemoteMethod.chatState, params)
    })

    on('chat-removed', (chatId: string) => {
      this.broadcast(RemoteMethod.chatRemoved, { chatID: chatId })
    })

    on('host-state', (state: { agentReady: boolean; shuttingDown: boolean; message?: string }) => {
      const params = this.hostStateParams(state.agentReady, state.shuttingDown, state.message)
      this.broadcast(RemoteMethod.hostState, params as unknown as JSONValue)
    })

    // Blocking prompts fan out to every attached screen with the
    // host-assigned promptID; the request payload is the ACP one, verbatim.
    on('permission-ask', (promptId: string, chatId: string | null, raw: JSONValue) => {
      this.broadcast(RemoteMethod.permissionAsk, askParams(promptId, chatId, raw))
    })

    on('permission-resolved', (promptId: string, resolvedBy: string | null) => {
      this.broadcast(RemoteMethod.permissionResolved, {
        promptID: promptId,
        resolvedBy: this.resolvedByName(resolvedBy)
      })
    })

    on('question-ask', (promptId: string, chatId: string | null, raw: JSONValue) => {
      this.broadcast(RemoteMethod.questionAsk, askParams(promptId, chatId, raw))
    })

    on('question-resolved', (promptId: string, resolvedBy: string | null) => {
      this.broadcast(RemoteMethod.questionResolved, {
        promptID: promptId,
        resolvedBy: this.resolvedByName(resolvedBy)
      })
    })

    // Agent-originated `_spettro/*` notifications (notably
    // `_spettro/account/update` as a device-flow login completes).
    on('agent-notification', (method: string, params: JSONValue) => {
      this.broadcast(RemoteMethod.agentNotification, { method, params: params ?? null })
    })
  }
}

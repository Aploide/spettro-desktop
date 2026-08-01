// The app's single source of truth — the port of
// Platforms/macOS/Model/AppModel.swift (docs/05, /06). Locates (or installs)
// the CLI, owns the shared AcpConnection/AcpAgent pair, hosts every
// ChatSession, routes streamed updates and permission prompts, and persists
// everything worth keeping.
//
// It extends EventEmitter and is the one event source in the main process:
//   emit('event', e: MainEvent)          — everything the renderer mirrors
// plus the remote-host-facing events (re-emitted by buildRemoteBridge):
//   'chat-update-raw' (chatId, rawUpdate)
//   'chat-user'       (chatId, text, attachments, timestamp, sourceDeviceId)
//   'chat-state'      (summary, extra?)
//   'chat-removed-remote' (chatId)
//   'host-state'      ({ agentReady, shuttingDown, message? })
//   'permission-ask' / 'permission-resolved'
//   'question-ask'   / 'question-resolved'

import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { statSync } from 'fs'
import { homedir } from 'os'
import type {
  ACPConfigOption,
  ACPContentBlock,
  ACPPermissionRequest,
  ACPQuestionAnswer,
  ACPQuestionRequest,
  ACPSessionUpdate,
  JSONValue,
  RPCID
} from '../../shared/acp'
import type { MainEvent } from '../../shared/ipc'
import type {
  AppStateDTO,
  ChatDetail,
  CLIInfo,
  ImageAttachmentDTO,
  Phase,
  RemoteHostState,
  SubscriptionState
} from '../../shared/model'
import { AcpAgent, AcpConnection } from '../acp'
import { ChatSession, type ConfigValue } from './chatSession'
import { CLIInstaller } from './cliInstaller'
import { locateCLI } from './cliLocator'
import { Prefs } from './prefs'
import { SessionStore } from './sessionStore'
import { SubscriptionStore } from './subscriptionStore'

interface PendingPermission {
  request: ACPPermissionRequest
  rpcId: RPCID
  raw: JSONValue
}

interface PendingQuestion {
  request: ACPQuestionRequest
  rpcId: RPCID
  raw: JSONValue
  transport: 'ask' | 'permission'
}

export interface PromptAttachment {
  data: string
  mimeType: string
}

/** How long the agent gets to answer `initialize` before we give up on it. */
const HANDSHAKE_TIMEOUT_MS = 20_000

/** Crash-loop guard window: a second death within this many ms of the last
 *  restart surfaces a failure instead of restarting again. */
const CRASH_LOOP_WINDOW_MS = 10_000

export class AppModel extends EventEmitter {
  // -- Published state ------------------------------------------------------

  phase: Phase = { kind: 'locating' }
  cli: CLIInfo | null = null
  agentVersion: string | null = null
  sessions: ChatSession[] = []
  selectedSessionId: string | null = null
  banner: string | null = null
  installLog: string[] = []
  /** Last ≤50 stderr lines from the CLI process. */
  agentLog: string[] = []
  subscription: SubscriptionState
  remote: RemoteHostState | null = null

  private pendingPermissions: PendingPermission[] = []
  /** Ask-user forms waiting on the user. The agent's turn is blocked on each
   *  one, so they queue rather than replacing one another. */
  private pendingQuestions: PendingQuestion[] = []

  // -- Private wiring -------------------------------------------------------

  private connection: AcpConnection | null = null
  private agent: AcpAgent | null = null
  /** A connect that hasn't finished its handshake yet, held separately so a
   *  teardown can also kill a process that is still starting up. */
  private pendingConnection: AcpConnection | null = null
  /** Bumped when a connect starts and when the agent is torn down, so an
   *  attempt still in flight can tell it has been superseded. */
  private connectionToken = 0
  /** Token of the connection currently installed as the live agent (0 when
   *  none) — lets a termination callback tell "the agent died" from "a
   *  process we already replaced finally exited". */
  private liveConnectionToken = 0
  private handshakeTimedOut = false
  private lastAgentRestart: number | null = null

  private sessionsByACPID = new Map<string, ChatSession>()
  private readonly installer = new CLIInstaller()
  private readonly store: SessionStore
  private readonly prefs: Prefs
  private readonly subscriptionStore: SubscriptionStore
  private readonly appVersion: string
  private shuttingDown = false

  constructor(opts: { userDataDir: string; appVersion: string }) {
    super()
    this.setMaxListeners(100)
    this.appVersion = opts.appVersion
    this.prefs = new Prefs(opts.userDataDir)
    this.store = new SessionStore(opts.userDataDir)
    this.subscriptionStore = new SubscriptionStore((state) => {
      this.subscription = state
      this.emitAppState()
    })
    this.subscription = this.subscriptionStore.current
  }

  // -------------------------------------------------------------------------
  // Event plumbing
  // -------------------------------------------------------------------------

  private pushEvent(event: MainEvent): void {
    this.emit('event', event)
  }

  private emitAppState(): void {
    this.pushEvent({ type: 'app-state', state: this.getState() })
  }

  private setPhase(phase: Phase): void {
    this.phase = phase
    this.emitAppState()
  }

  private emitHostState(shuttingDown = false): void {
    const state: { agentReady: boolean; shuttingDown: boolean; message?: string } = {
      agentReady: this.agentReady(),
      shuttingDown
    }
    if (this.banner) state.message = this.banner
    this.emit('host-state', state)
  }

  private emitPermissions(): void {
    this.pushEvent({ type: 'permissions', requests: this.pendingPermissions.map((p) => p.request) })
  }

  private emitQuestions(): void {
    this.pushEvent({ type: 'questions', requests: this.pendingQuestions.map((q) => q.request) })
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  getState(): AppStateDTO {
    return {
      phase: this.phase,
      cli: this.cli,
      agentVersion: this.agentVersion,
      selectedSessionId: this.selectedSessionId,
      sessions: this.sessions.map((s) => s.summary()),
      banner: this.banner,
      installLog: [...this.installLog],
      agentLog: [...this.agentLog],
      subscription: this.subscription,
      remote: this.remote,
      lastProjectPath: this.prefs.lastProjectPath || null,
      recentProjects: this.prefs.recentProjects
    }
  }

  getChatDetail(chatId: string): ChatDetail | null {
    return this.sessionById(chatId)?.detail() ?? null
  }

  sessionById(chatId: string): ChatSession | null {
    return this.sessions.find((s) => s.id === chatId) ?? null
  }

  /** Maps an ACP session id back to the chat that owns it. */
  chatIdForACPSession(acpId: string): string | null {
    return this.sessionsByACPID.get(acpId)?.id ?? null
  }

  agentReady(): boolean {
    return this.phase.kind === 'ready'
  }

  /** The folder new chats open in by default: the selected chat's own folder,
   *  else the persisted last project path (if still a directory), else home. */
  get defaultProjectPath(): string {
    const selected = this.selectedSessionId ? this.sessionById(this.selectedSessionId) : null
    if (selected) return selected.projectPath
    const last = this.prefs.lastProjectPath
    if (last !== '' && isDirectory(last)) return last
    return homedir()
  }

  /** The project folder the memory editor should target. */
  memoryProjectPath(): string {
    return this.defaultProjectPath
  }

  setRemoteState(state: RemoteHostState): void {
    this.remote = state
    this.emitAppState()
  }

  // -------------------------------------------------------------------------
  // Bootstrap / lifecycle
  // -------------------------------------------------------------------------

  async bootstrap(): Promise<void> {
    this.subscriptionStore.start()
    // Show any saved conversations immediately, before the CLI is located or
    // connected, so the sidebar is never empty on a cold launch.
    this.loadPersistedSessions()
    // Idempotent: bootstrapping over an agent that is already up (or coming
    // up) must not drop the UI back onto the loading screen.
    if (this.agent || this.phase.kind === 'connecting') return
    this.setPhase({ kind: 'locating' })
    const found = locateCLI(this.prefs.explicitCLIPath || null)
    if (found) {
      this.cli = { path: found.path, version: found.version, isDev: found.isDev }
      // Land on the home screen (no chat selected) but start the agent
      // immediately in the background, so opening any chat or folder is
      // instant — sessions each pass their own cwd when created.
      this.selectedSessionId = null
      this.emitAppState()
      await this.connect(this.defaultProjectPath)
    } else {
      this.setPhase({ kind: 'needsSetup' })
    }
  }

  async retryBootstrap(): Promise<void> {
    if (this.agent) {
      await this.reconnect()
    } else {
      await this.bootstrap()
    }
  }

  private loadPersistedSessions(): void {
    if (this.sessions.length > 0) return
    this.sessions = this.store.load().map((stored) => {
      const session = ChatSession.restore(stored)
      this.attachSessionCallbacks(session)
      return session
    })
    this.selectedSessionId = this.sessions[0]?.id ?? null
  }

  private attachSessionCallbacks(session: ChatSession): void {
    session.onItem = (s, item) => this.pushEvent({ type: 'chat-item', chatId: s.id, item })
    session.onMeta = (s, meta) => this.pushEvent({ type: 'chat-meta', chatId: s.id, meta })
  }

  private persist(): void {
    // Sessions that have never received a prompt (and never failed to
    // connect) are not conversations — don't store them.
    this.store.save(this.sessions.filter((s) => !s.isPristine).map((s) => s.snapshot()))
    this.emitAppState()
  }

  // -------------------------------------------------------------------------
  // Connect / handshake / teardown
  // -------------------------------------------------------------------------

  /** Establishes the shared ACP connection and performs the handshake.
   *  `rootedAt` is the folder the agent process itself starts in; each
   *  session still passes its own cwd when it is created. */
  private async connect(rootedAt?: string): Promise<void> {
    // A connect is already in flight (or the agent is live): don't spawn a
    // second CLI process.
    if (this.agent || this.phase.kind === 'connecting') return
    // Never cache a stale locator result: if the CLI path changed (or the
    // binary moved) since `cli` was set, a reconnect must re-resolve, or
    // we'd happily "connect" to the wrong binary.
    const found = locateCLI(this.prefs.explicitCLIPath || null)
    if (!found) {
      this.cli = null
      this.setPhase({ kind: 'needsSetup' })
      return
    }
    this.cli = { path: found.path, version: found.version, isDev: found.isDev }
    this.setPhase({ kind: 'connecting' })

    this.connectionToken += 1
    const token = this.connectionToken
    const connection = new AcpConnection({
      executablePath: found.path,
      workingDirectory: rootedAt ?? this.defaultProjectPath
    })
    this.wire(connection, token)
    const agent = new AcpAgent(connection)
    this.pendingConnection = connection

    try {
      await connection.start()
      const info = await this.handshake(agent, connection)
      // A teardown landed while we were waiting: this process is no longer
      // the one the app wants. Kill it and leave the phase to whoever
      // superseded us.
      if (token !== this.connectionToken) {
        connection.stop()
        return
      }
      this.agentVersion = info.agentVersion
      this.connection = connection
      this.agent = agent
      this.liveConnectionToken = token
      this.setPhase({ kind: 'ready' })
      this.emitHostState()
      await this.resumePersistedSessions()
    } catch (err) {
      // Never leave a half-started process behind: it would hold the CLI's
      // session lock and keep answering nothing.
      connection.stop()
      if (token !== this.connectionToken) return
      this.setPhase({ kind: 'failed', message: errMessage(err) })
    } finally {
      if (this.pendingConnection === connection) this.pendingConnection = null
    }
  }

  /** Runs the handshake under a watchdog: a binary that launches but never
   *  replies would otherwise park the app on the connecting spinner forever. */
  private async handshake(
    agent: AcpAgent,
    connection: AcpConnection
  ): Promise<{ agentVersion: string | null; agentName: string | null }> {
    this.handshakeTimedOut = false
    const watchdog = setTimeout(() => {
      this.handshakeTimedOut = true
      connection.stop()
    }, HANDSHAKE_TIMEOUT_MS)
    try {
      return await agent.initialize('Spettro Desktop', this.appVersion)
    } catch (err) {
      if (this.handshakeTimedOut) {
        throw new Error('The Spettro agent did not answer the handshake in time.')
      }
      throw err
    } finally {
      clearTimeout(watchdog)
    }
  }

  /** Replaces whatever agent is running with a fresh one — what a Retry and
   *  a CLI path change want, since connect() refuses to displace a live agent. */
  async reconnect(): Promise<void> {
    this.teardownAgent()
    this.setPhase({ kind: 'locating' })
    const selected = this.selectedSessionId ? this.sessionById(this.selectedSessionId) : null
    await this.connect(selected?.projectPath ?? this.defaultProjectPath)
  }

  /** Stops the current agent and drops every reference to it, without going
   *  through the crash-restart path — the live token is cleared before
   *  anything is stopped, so the termination callbacks that follow recognise
   *  these processes as ones we retired on purpose. */
  private teardownAgent(): void {
    this.connectionToken += 1
    this.liveConnectionToken = 0
    const live = this.connection
    const starting = this.pendingConnection
    this.connection = null
    this.pendingConnection = null
    this.agent = null
    live?.stop()
    starting?.stop()
    // Nothing is left waiting on these answers: the turn that asked them died
    // with the process.
    if (this.pendingQuestions.length > 0) {
      this.pendingQuestions = []
      this.emitQuestions()
    }
    for (const session of this.sessions) {
      session.setBusy(false)
    }
    // The process is gone and its ACP sessions with it. Keep each session's
    // id (it's what session/resume needs) but drop the routing entries, so
    // nothing is prompted into the void before it's re-attached.
    this.sessionsByACPID.clear()
  }

  private handleTermination(code: number): void {
    // Also bumps the connection token, so a connect still in flight for this
    // dead process can't finish and claim to be live.
    this.teardownAgent()
    // Attached phones stay connected and go read-only rather than being
    // dropped: the host is still there, it's the agent that isn't.
    this.emitHostState()
    if (this.phase.kind !== 'ready' && this.phase.kind !== 'connecting') {
      this.emitAppState()
      return
    }

    // Restart the agent in the background so chats keep working, but if it
    // died again within seconds of the last restart, stop and surface the
    // failure rather than crash-looping.
    const now = Date.now()
    if (this.lastAgentRestart !== null && now - this.lastAgentRestart < CRASH_LOOP_WINDOW_MS) {
      let message = `The Spettro agent keeps stopping (exit ${code}).`
      const tail = this.agentLog.slice(-6).join('\n')
      if (tail !== '') message += `\n\nAgent output:\n${tail}`
      this.setPhase({ kind: 'failed', message })
      return
    }
    this.lastAgentRestart = now
    this.banner = `The Spettro agent stopped (exit ${code}) — restarting…`
    this.setPhase({ kind: 'locating' })
    // Because every session kept its acpSessionId and transcript, the
    // reconnect transparently re-resumes them all.
    void this.connect()
  }

  /** Wires the connection's callbacks into the model. */
  private wire(connection: AcpConnection, token: number): void {
    connection.onSessionUpdate = (sessionId, update, raw) => {
      this.handleUpdate(sessionId, update, raw)
    }
    connection.onPermissionRequest = ({ rpcId, request, raw }) => {
      this.pendingPermissions.push({ request, rpcId, raw })
      this.emitPermissions()
      this.emit('permission-ask', request.id, this.chatIdForACPSession(request.sessionId), raw)
    }
    connection.onQuestionRequest = ({ rpcId, request, raw, transport }) => {
      this.pendingQuestions.push({ request, rpcId, raw, transport })
      this.emitQuestions()
      const chatId = request.sessionId ? this.chatIdForACPSession(request.sessionId) : null
      this.emit('question-ask', request.id, chatId, raw)
    }
    connection.onTerminate = (code) => {
      // Only the connection the app is actually using gets to drive the
      // restart; a process killed on purpose (teardown, superseded connect,
      // handshake watchdog) is no longer the live one. A death mid-handshake
      // is left to the connect that is already awaiting it.
      if (this.liveConnectionToken === token && !this.shuttingDown) {
        this.handleTermination(code)
      }
    }
    connection.onLog = (line) => {
      this.agentLog.push(line)
      if (this.agentLog.length > 50) {
        this.agentLog.splice(0, this.agentLog.length - 50)
      }
      this.emitAppState()
    }
  }

  // -------------------------------------------------------------------------
  // Cold → live: resume vs. new session
  // -------------------------------------------------------------------------

  /** Reconnects each restored session to the live agent. Uses session/resume
   *  so the agent restores its memory of the conversation WITHOUT replaying
   *  the transcript (we already display our persisted copy — session/load
   *  would duplicate every message on each relaunch). */
  private async resumePersistedSessions(): Promise<void> {
    const agent = this.agent
    if (!agent) return
    for (const session of [...this.sessions]) {
      const acpId = session.acpSessionId
      if (!acpId) {
        await this.startFreshSession(session)
        continue
      }
      try {
        const displayed = session.displayedConfigValues()
        const result = await agent.resumeSession(acpId, session.projectPath)
        // Register only after a successful resume: updates emitted before
        // this point belong to no session the UI should show.
        this.sessionsByACPID.set(acpId, session)
        if (result.configOptions.length > 0) session.setConfigOptions(result.configOptions)
        await this.syncDisplayedConfig(session, displayed, acpId)
      } catch {
        session.appendNotice(
          "Couldn't restore this chat's earlier context — starting fresh.",
          false
        )
        await this.startFreshSession(session)
      }
    }
    this.persist()
  }

  /** Attaches a new live ACP session to an existing (cold or degraded) chat. */
  private async startFreshSession(session: ChatSession): Promise<void> {
    const agent = this.agent
    if (!agent) return
    const oldId = session.acpSessionId
    if (oldId) this.sessionsByACPID.delete(oldId)
    try {
      const displayed = session.displayedConfigValues()
      const result = await agent.newSession(session.projectPath)
      session.setAcpSessionId(result.sessionId)
      session.setConfigOptions(result.configOptions)
      this.sessionsByACPID.set(result.sessionId, session)
      await this.syncDisplayedConfig(session, displayed, result.sessionId)
    } catch (err) {
      session.setAcpSessionId(null)
      session.appendNotice(`Couldn't start a session: ${errMessage(err)}`, true)
    }
  }

  /** Pushes the config the user was shown (plus any changes queued while the
   *  chat was cold) onto a freshly attached live session, so the displayed
   *  model/mode/permission is exactly what the agent runs with. Values that
   *  no longer exist in the live option set are skipped, and the agent's
   *  refreshed options become the new display state after each push. */
  private async syncDisplayedConfig(
    session: ChatSession,
    previouslyDisplayed: Record<string, ConfigValue>,
    acpId: string
  ): Promise<void> {
    const agent = this.agent
    if (!agent) return
    const desired: Record<string, ConfigValue> = {
      ...previouslyDisplayed,
      ...session.pendingConfigChanges
    }
    session.pendingConfigChanges = {}

    // The CLI's own default for "mode" is Plan mode, but the coding agent is
    // what's actually used most, so steer fresh sessions (no prior mode
    // preference) toward the first non-plan option instead.
    if (desired['mode'] === undefined) {
      const modeOption = session.configOptions.find((o) => o.id === 'mode')
      if (modeOption && modeOption.kind.type === 'select') {
        const choices = [
          ...modeOption.kind.flat,
          ...modeOption.kind.groups.flatMap((g) => g.options)
        ]
        const coding = choices.find(
          (c) =>
            !c.value.toLowerCase().includes('plan') && !c.name.toLowerCase().includes('plan')
        )
        if (coding) desired['mode'] = coding.value
      }
    }

    if (Object.keys(desired).length === 0) {
      this.rememberConfig(session.configOptions)
      return
    }

    for (const live of [...session.configOptions]) {
      const want = desired[live.id]
      if (want === undefined) continue
      try {
        if (live.kind.type === 'select' && typeof want === 'string') {
          const choices = [...live.kind.flat, ...live.kind.groups.flatMap((g) => g.options)]
          if (want === live.kind.currentValue || !choices.some((c) => c.value === want)) continue
          session.setConfigOptions(await agent.setConfigOption(acpId, live.id, want))
        } else if (live.kind.type === 'boolean' && typeof want === 'boolean') {
          if (want === live.kind.currentValue) continue
          session.setConfigOptions(await agent.setConfigOption(acpId, live.id, want))
        }
      } catch (err) {
        session.appendNotice(`Couldn't restore ${live.name}: ${errMessage(err)}`, false)
      }
    }
    this.rememberConfig(session.configOptions)
    this.persist()
  }

  private rememberConfig(options: ACPConfigOption[]): void {
    if (options.length === 0) return
    this.prefs.lastConfigOptions = options
  }

  // -------------------------------------------------------------------------
  // Installation / explicit path
  // -------------------------------------------------------------------------

  installCLI(): void {
    this.phase = { kind: 'installing' }
    this.installLog = ['Downloading and running the Spettro installer…']
    this.emitAppState()
    this.installer.install((event) => {
      if (event.type === 'output') {
        this.installLog.push(event.line)
        this.emitAppState()
        return
      }
      const found = event.success ? locateCLI(null) : null
      if (event.success && found) {
        this.cli = { path: found.path, version: found.version, isDev: found.isDev }
        this.installLog.push(`Installed at ${found.path}`)
        this.setPhase({ kind: 'locating' })
        void this.connect()
      } else {
        this.installLog.push('Installation did not complete.')
        this.setPhase({ kind: 'needsSetup' })
      }
    })
  }

  async useExplicitPath(path: string): Promise<void> {
    const found = locateCLI(path)
    if (!found) {
      this.banner = 'No executable Spettro CLI at that path.'
      this.emitAppState()
      return
    }
    this.prefs.explicitCLIPath = path
    this.cli = { path: found.path, version: found.version, isDev: found.isDev }
    // Pointing at a different binary means the running one has to go: a
    // plain connect() would decline to displace it and strand the UI.
    await this.reconnect()
  }

  // -------------------------------------------------------------------------
  // Sessions: creation, switching, closing, pinning
  // -------------------------------------------------------------------------

  /** The user picked a project folder: remember it, and open a fresh chat
   *  rooted there (which also starts the agent if it isn't running). */
  async chooseProject(path: string): Promise<void> {
    this.prefs.lastProjectPath = path
    this.prefs.addRecentProject(path)
    this.newChat(path)
  }

  /** Creates a chat locally only: no ACP session is requested yet. The
   *  conversation becomes real (on the agent and on disk) when the first
   *  prompt is sent, so untouched empty chats are never persisted. */
  newChat(projectPath: string): ChatSession {
    // Don't touch lastProjectPath here: starting a chat in a different folder
    // shouldn't redirect the app's default away from the folder the user
    // originally picked.
    const session = new ChatSession(projectPath)
    // Inherit the last-used config so the ConfigBar is populated (and the
    // attach-time sync makes the agent match it) from the very first turn.
    session.configOptions = this.prefs.lastConfigOptions
    session.commands = this.prefs.cachedCommands
    this.attachSessionCallbacks(session)
    this.sessions.unshift(session)
    this.selectedSessionId = session.id
    this.pushEvent({ type: 'chat-reset', chat: session.detail() })
    this.emitAppState()
    // If the agent isn't running (first launch, or it died), boot it rooted
    // in this chat's folder.
    if (!this.agent && this.phase.kind !== 'connecting') {
      void this.connect(projectPath)
    }
    return session
  }

  /** Opens a chat from the sidebar. From the home screen this also starts
   *  the agent, so picking a saved conversation is enough to get going. */
  openChat(chatId: string): void {
    const session = this.sessionById(chatId)
    if (!session) return
    this.selectedSessionId = chatId
    this.pushEvent({ type: 'chat-reset', chat: session.detail() })
    this.emitAppState()
    if (!this.agent && this.phase.kind !== 'connecting') {
      void this.connect(session.projectPath)
    }
  }

  selectSession(chatId: string | null): void {
    this.selectedSessionId = chatId
    this.emitAppState()
  }

  closeChat(chatId: string): void {
    const session = this.sessionById(chatId)
    if (!session) return
    if (session.acpSessionId) this.sessionsByACPID.delete(session.acpSessionId)
    this.sessions = this.sessions.filter((s) => s.id !== chatId)
    if (this.selectedSessionId === chatId) {
      this.selectedSessionId = this.sessions[0]?.id ?? null
    }
    this.pushEvent({ type: 'chat-removed', chatId })
    this.emit('chat-removed-remote', chatId)
    this.persist()
  }

  /** Pinned chats float to the top of their folder (or the Archived list). */
  togglePin(chatId: string): void {
    const session = this.sessionById(chatId)
    if (!session) return
    session.setPinned(!session.isPinned)
    this.persist()
    this.emit('chat-state', session.summary())
  }

  /** Archived chats move into the Archived section but stay fully live —
   *  selecting one still resumes the same ACP session. */
  toggleArchive(chatId: string): void {
    const session = this.sessionById(chatId)
    if (!session) return
    session.setArchived(!session.isArchived)
    this.persist()
    this.emit('chat-state', session.summary())
  }

  /** Remote flagChat: applies absolute flag values through the toggles. */
  flagChat(chatId: string, flags: { isPinned?: boolean; isArchived?: boolean }): void {
    const session = this.sessionById(chatId)
    if (!session) return
    if (flags.isPinned !== undefined && flags.isPinned !== session.isPinned) {
      this.togglePin(chatId)
    }
    if (flags.isArchived !== undefined && flags.isArchived !== session.isArchived) {
      this.toggleArchive(chatId)
    }
    this.emit('chat-state', session.summary())
  }

  // -------------------------------------------------------------------------
  // Prompting
  // -------------------------------------------------------------------------

  /** The only prompt entry point, local and remote alike. `sourceDeviceId`
   *  is set when the prompt arrived from a paired device, so the echo of the
   *  user's own message skips the screen that already drew it. */
  send(
    chatId: string,
    text: string,
    attachments: PromptAttachment[],
    sourceDeviceId: string | null = null
  ): void {
    const session = this.sessionById(chatId)
    if (!session) return
    const trimmed = text.trim()
    if ((trimmed === '' && attachments.length === 0) || session.isBusy) return

    const dtos: ImageAttachmentDTO[] = attachments.map((a) => ({
      id: randomUUID(),
      data: a.data,
      mimeType: a.mimeType,
      width: 0,
      height: 0
    }))
    session.appendUserMessage(trimmed, dtos)
    session.setBusy(true)
    this.persist()
    // The user's own message is not an agent update, so it never comes back
    // over the stream — a phone that didn't send it would otherwise see the
    // answer appear with nothing above it.
    const wireAttachments: JSONValue[] = attachments.map((a) => ({
      data: a.data,
      mimeType: a.mimeType
    }))
    this.emit('chat-user', session.id, trimmed, wireAttachments, Date.now(), sourceDeviceId)
    this.emit('chat-state', session.summary())

    const blocks: ACPContentBlock[] = []
    if (trimmed !== '') blocks.push({ type: 'text', text: trimmed })
    for (const a of attachments) {
      blocks.push({ type: 'image', data: a.data, mimeType: a.mimeType })
    }
    void this.runTurn(session, blocks)
  }

  private async runTurn(session: ChatSession, blocks: ACPContentBlock[]): Promise<void> {
    const acpId = await this.ensureLiveSession(session)
    if (!acpId) {
      session.setBusy(false)
      this.persist()
      this.emit('chat-state', session.summary(), { stopReason: 'error' })
      return
    }
    let stopReason = 'end_turn'
    // Mirrors whatever inline notice the local transcript gets, so a remote
    // screen ends the turn in the same visible state.
    let notice: { text: string; isError: boolean } | null = null
    try {
      const reason = this.agent ? await this.agent.prompt(acpId, blocks) : 'end_turn'
      session.endStreaming()
      stopReason = reason
      switch (reason) {
        case 'refusal':
          notice = { text: 'The agent declined to continue.', isError: true }
          break
        case 'max_tokens':
        case 'max_turn_requests':
          notice = { text: 'The turn hit a limit before finishing.', isError: false }
          break
        case 'cancelled':
          notice = { text: 'Turn cancelled.', isError: false }
          break
        default:
          // end_turn / unknown are silent.
          break
      }
      if (notice) session.appendNotice(notice.text, notice.isError)
    } catch (err) {
      session.endStreaming()
      stopReason = 'error'
      const message = errMessage(err)
      notice = { text: message, isError: true }
      session.appendNotice(message, true)
    }
    session.setBusy(false)
    this.persist()
    this.emit(
      'chat-state',
      session.summary(),
      notice ? { stopReason, notice: notice.text } : { stopReason }
    )
  }

  /** Lazily attaches a live ACP session the first time a chat is prompted,
   *  bringing the agent back up first if it died. */
  private async ensureLiveSession(session: ChatSession): Promise<string | null> {
    // The stored id only counts if it still routes to a live ACP session:
    // after the agent restarts it survives on disk but means nothing to the
    // new process until it has been resumed.
    const liveId = this.liveACPSessionId(session)
    if (liveId) return liveId
    if (!this.agent) {
      await this.connect(session.projectPath)
      // Connecting resumes the persisted chats; if this one came back, keep
      // its context instead of starting over.
      const resumed = this.liveACPSessionId(session)
      if (resumed) return resumed
    }
    const agent = this.agent
    if (!agent) {
      session.appendNotice("The agent isn't running yet — try again in a moment.", true)
      return null
    }
    try {
      const displayed = session.displayedConfigValues()
      const result = await agent.newSession(session.projectPath)
      session.setAcpSessionId(result.sessionId)
      session.setConfigOptions(result.configOptions)
      this.sessionsByACPID.set(result.sessionId, session)
      // Push the config the user was shown before prompting, so the first
      // message already runs with the displayed settings.
      await this.syncDisplayedConfig(session, displayed, result.sessionId)
      return result.sessionId
    } catch (err) {
      session.appendNotice(`Couldn't start a session: ${errMessage(err)}`, true)
      return null
    }
  }

  /** The chat's ACP session id, but only while it's attached to the running
   *  agent — null once the process that owned it is gone. */
  private liveACPSessionId(session: ChatSession): string | null {
    if (!this.agent || !session.acpSessionId) return null
    return this.sessionsByACPID.get(session.acpSessionId) === session ? session.acpSessionId : null
  }

  /** Fire-and-forget session/cancel; the in-flight prompt resolves with
   *  'cancelled' and unwinds through the normal turn cleanup. */
  cancel(chatId: string): void {
    const session = this.sessionById(chatId)
    if (!session || !this.agent || !session.acpSessionId) return
    this.agent.cancel(session.acpSessionId)
  }

  // -------------------------------------------------------------------------
  // Config options
  // -------------------------------------------------------------------------

  async setConfigValue(chatId: string, configId: string, value: ConfigValue): Promise<void> {
    const session = this.sessionById(chatId)
    if (!session) return
    // Reflect the choice in the UI immediately; the agent is synced below,
    // or when a live session attaches if there isn't one yet.
    session.applyLocalConfigValue(configId, value)
    const acpId = this.liveACPSessionId(session)
    const agent = this.agent
    if (!agent || !acpId) {
      // Queue the change for the attach-time sync — this is what makes a
      // cold chat's ConfigBar changes stick.
      session.pendingConfigChanges[configId] = value
      this.persist()
      return
    }
    try {
      const options = await agent.setConfigOption(acpId, configId, value)
      session.setConfigOptions(options)
      this.rememberConfig(options)
      this.persist()
    } catch (err) {
      session.appendNotice(`Couldn't change ${configId}: ${errMessage(err)}`, true)
    }
  }

  // -------------------------------------------------------------------------
  // Permissions / questions
  // -------------------------------------------------------------------------

  resolvePermission(requestId: string, optionId: string, resolvedBy: string | null = null): void {
    const index = this.pendingPermissions.findIndex((p) => p.request.id === requestId)
    if (index < 0) return
    const entry = this.pendingPermissions[index]
    this.agent?.replyPermission(entry.rpcId, optionId)
    this.pendingPermissions.splice(index, 1)
    this.emitPermissions()
    this.emit('permission-resolved', requestId, resolvedBy)
  }

  dismissPermission(requestId: string, resolvedBy: string | null = null): void {
    const index = this.pendingPermissions.findIndex((p) => p.request.id === requestId)
    if (index < 0) return
    const entry = this.pendingPermissions[index]
    this.agent?.cancelPermission(entry.rpcId)
    this.pendingPermissions.splice(index, 1)
    this.emitPermissions()
    this.emit('permission-resolved', requestId, resolvedBy)
  }

  /** answers === null declines the whole form. */
  answerQuestion(
    requestId: string,
    answers: ACPQuestionAnswer[] | null,
    resolvedBy: string | null = null
  ): void {
    const index = this.pendingQuestions.findIndex((q) => q.request.id === requestId)
    if (index < 0) return
    const entry = this.pendingQuestions[index]
    this.agent?.replyQuestion(
      { rpcId: entry.rpcId, request: entry.request, transport: entry.transport },
      answers
    )
    this.pendingQuestions.splice(index, 1)
    this.emitQuestions()
    this.emit('question-resolved', requestId, resolvedBy)
  }

  // -------------------------------------------------------------------------
  // Agent passthrough (remote host's _spettro/* calls)
  // -------------------------------------------------------------------------

  async agentRaw(method: string, params: JSONValue): Promise<JSONValue> {
    const agent = this.agent
    if (!agent) throw new Error('The Spettro agent is not running.')
    return agent.raw(method, params)
  }

  // -------------------------------------------------------------------------
  // Update routing
  // -------------------------------------------------------------------------

  private handleUpdate(sessionId: string, update: ACPSessionUpdate, raw: JSONValue): void {
    const session = this.sessionsByACPID.get(sessionId)
    // Unknown ids are dropped — updates emitted before a successful resume
    // belong to no session the UI shows.
    if (!session) return
    // Relay before applying: a remote screen rendering the same stream should
    // not wait on the local view work, and the payload is identical either
    // way. Re-keyed by the app's own chat id.
    this.emit('chat-update-raw', session.id, raw)
    switch (update.kind) {
      case 'agent_message_chunk':
        session.appendAssistant(update.text)
        break
      case 'agent_thought_chunk':
        session.appendReasoning(update.text)
        break
      case 'tool_call':
        session.applyToolEvent(update.event, true)
        break
      case 'tool_call_update':
        session.applyToolEvent(update.event, false)
        break
      case 'available_commands_update':
        session.setCommands(update.commands)
        this.prefs.cachedCommands = update.commands
        break
      case 'config_option_update':
        if (update.options.length > 0) {
          session.setConfigOptions(update.options)
          this.rememberConfig(update.options)
          this.persist()
        }
        break
      case 'plan':
        session.setPlan(update.entries)
        break
      case 'usage_update':
        session.setUsage(update.usage)
        break
      case 'other':
        break
    }
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  /** App quit: tell attached devices the disconnect is deliberate (doc 34),
   *  stop the agent, stop the watchers, and write a final snapshot. */
  shutdown(): void {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.emitHostState(true)
    this.teardownAgent()
    this.subscriptionStore.stop()
    this.store.save(this.sessions.filter((s) => !s.isPristine).map((s) => s.snapshot()))
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

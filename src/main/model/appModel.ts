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
import { mkdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import type {
  ACPConfigOption,
  ACPContentBlock,
  ACPPermissionRequest,
  ACPPromptResult,
  ACPQuestionAnswer,
  ACPQuestionRequest,
  ACPSessionUpdate,
  ACPToolCallEvent,
  ACPToolStatus,
  JSONValue,
  RPCID
} from '../../shared/acp'
import type { MainEvent } from '../../shared/ipc'
import type {
  Appearance,
  AppStateDTO,
  ChatDetail,
  CLIInfo,
  CLISessionEntry,
  ImageAttachmentDTO,
  InstallState,
  Phase,
  RemoteHostState,
  SubscriptionState,
  TurnSummary
} from '../../shared/model'
import { isAppearance, PROJECTS_FOLDER } from '../../shared/model'
import type {
  ConnectResult,
  LocalProbeResult,
  LoginStatus,
  WorkflowInfo,
  WorkflowList,
  WorkflowRunInfo,
  WorkflowScope,
  WorkflowSource,
  WorkflowValidation
} from '../../shared/extensions'
import { EMPTY_WORKFLOW_LIST } from '../../shared/extensions'
import type { UpdateState } from '../../shared/update'
import { ExtensionMethod } from '../../shared/extensions'
import { humanSentence } from '../../shared/humanize'
import { AcpAgent, AcpConnection, AcpError } from '../acp'
import type { WorkflowTarget } from '../acp/extensions'
import { ChatSession, type ConfigValue } from './chatSession'
import { CLIInstaller, type InstallFailure } from './cliInstaller'
import { checkExplicitCLI, EXPLICIT_CLI_PROBLEM, locateCLI } from './cliLocator'
import { ExtensionStores } from './extensionStores'
import { Prefs } from './prefs'
import { newProjectPath } from './projectFolder'
import { cleanMention, promptBlocks, type PromptAttachment } from './promptBlocks'
import { SessionStore } from './sessionStore'
import { SubscriptionStore } from './subscriptionStore'
import { UpdateManager } from './updater'

interface PendingPermission {
  request: ACPPermissionRequest
  rpcId: RPCID
  raw: JSONValue
  /** What the request's card showed before the request turned it "pending",
   *  put back if the request goes away unanswered. Null when the request
   *  itself created the card (a `perm-N` with nothing open to attach to). */
  priorToolStatus: ACPToolStatus | null
}

interface PendingQuestion {
  request: ACPQuestionRequest
  rpcId: RPCID
  raw: JSONValue
  transport: 'ask' | 'permission'
}

export type { PromptAttachment }

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
  /** Bumped per banner, so the same text twice is shown twice. */
  private bannerNonce = 0
  install: InstallState = { stage: 'idle', failure: null }
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
  /** 'reconnecting' while the engine restarts under a shell already on
   *  screen — see AppStateDTO.connection. */
  private connectionState: 'ok' | 'reconnecting' = 'ok'
  /** Set once the sidebar-and-chat shell (or the provider step) has been
   *  shown. From then on a restart keeps it on screen instead of falling
   *  back to the loading screen, which would unmount every draft. */
  private shellShown = false

  private sessionsByACPID = new Map<string, ChatSession>()
  /** In-flight ACP attaches, keyed by chat id — see ensureLiveSession. */
  private ensureInFlight = new Map<string, Promise<string | null>>()
  /** The connect under way, so a second caller waits for it instead of
   *  giving up on an agent that is seconds from ready. */
  private connectInFlight: Promise<void> | null = null
  /** Prompts out per chat — the turn plus any steers sent into it — each
   *  holding its own token, so a prompt of a torn-down agent unwinding late
   *  can't count out one sent since. The chat stays busy until the last one
   *  settles. */
  private promptsInFlight = new Map<string, Set<symbol>>()
  /** Per chat, settles once the running turn's own prompt is on the wire. A
   *  steer waits for it — sent first, the steer would start a turn of its
   *  own and the turn's prompt would become the steer. */
  private turnLaunched = new Map<string, Promise<void>>()
  /** How the latest real turn of a chat ended, held until its last prompt
   *  settles, which is when paired phones hear that the chat went idle. */
  private turnOutcome = new Map<string, { stopReason: string; notice: TurnNotice | null }>()
  private readonly installer = new CLIInstaller()
  private readonly store: SessionStore
  private readonly prefs: Prefs
  private readonly subscriptionStore: SubscriptionStore
  private readonly appVersion: string
  /** Hands an appearance change to the window layer (nativeTheme lives in
   *  Electron, which this class deliberately doesn't import). */
  private readonly applyAppearance: (mode: Appearance) => void
  private shuttingDown = false

  /** Account, providers, and models, all driven over the CLI's `_spettro/*`
   *  extension methods. Owned here so there is one place that attaches them to
   *  (and detaches them from) the live agent. */
  readonly extensions: ExtensionStores
  /** App + CLI release checks. Owned here because updating the CLI means
   *  restarting the agent, which only this class can do. */
  readonly updates: UpdateManager
  constructor(opts: {
    userDataDir: string
    appVersion: string
    /** False under `electron-vite dev`, where the app can't replace itself. */
    isPackaged?: boolean
    /** Quits the app once an update installer has been handed off. */
    quit?: () => void
    /** Applies a changed appearance (main sets nativeTheme.themeSource). */
    applyAppearance?: (mode: Appearance) => void
  }) {
    super()
    this.setMaxListeners(100)
    this.appVersion = opts.appVersion
    this.applyAppearance = opts.applyAppearance ?? ((): void => undefined)
    // Built before the stores: getState() reads it, and a store that emitted
    // during its own construction would otherwise find it undefined.
    this.updates = new UpdateManager({
      appVersion: opts.appVersion,
      isPackaged: opts.isPackaged ?? false,
      // The handshake's version is authoritative; before the agent is up the
      // locator's `--version` reading is the best we have.
      cliVersion: () => this.agentVersion ?? this.cli?.version ?? null,
      installCLI: (onEvent) => this.installer.install(onEvent),
      // Whatever was running is the old binary — restart onto the new one.
      onCLIInstalled: () => this.reconnect(),
      onChange: () => this.emitAppState(),
      quit: opts.quit ?? ((): void => undefined),
      waitForIdle: () => this.waitForIdle()
    })
    this.prefs = new Prefs(opts.userDataDir)
    this.store = new SessionStore(opts.userDataDir)
    this.subscriptionStore = new SubscriptionStore((state) => {
      this.subscription = state
      this.emitAppState()
    })
    this.subscription = this.subscriptionStore.current
    this.extensions = new ExtensionStores(() => this.emitAppState())
    // A completed sign-in is usually what unblocks a CLI with nothing
    // configured, so re-evaluate the setup gate once the plan has loaded.
    this.extensions.onLoginComplete = () => {
      this.updateProviderGate()
    }
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
    if (phase.kind === 'ready' || phase.kind === 'needsProvider') this.shellShown = true
    this.emitAppState()
  }

  private emitHostState(shuttingDown = false, message?: string): void {
    const state: { agentReady: boolean; shuttingDown: boolean; message?: string } = {
      agentReady: this.agentReady(),
      shuttingDown
    }
    if (message) state.message = message
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
      connection: this.connectionState,
      cli: this.cli,
      agentVersion: this.agentVersion,
      selectedSessionId: this.selectedSessionId,
      // Scratch runs are the studio's business, not the sidebar's.
      sessions: this.sessions.filter((s) => !s.isScratch).map((s) => s.summary()),
      banner: this.banner,
      bannerNonce: this.bannerNonce,
      install: this.install,
      installLog: [...this.installLog],
      agentLog: [...this.agentLog],
      subscription: this.subscription,
      extensions: this.extensions.snapshot(),
      update: this.updates.state(),
      remote: this.remote,
      lastProjectPath: this.prefs.lastProjectPath || null,
      defaultProjectPath: this.defaultProjectPath,
      recentProjects: this.prefs.recentProjects,
      missingProjects: this.missingProjects(),
      homePath: homedir(),
      appearance: this.prefs.appearance,
      noModel: this.noModel,
      providerSetupSkipped: this.prefs.providerSetupSkipped,
      notifyWhenDone: this.prefs.notifyWhenDone,
      approvedBroadFolders: this.prefs.approvedBroadFolders,
      defaultConfigOptions: this.prefs.lastConfigOptions,
      busyTasks: this.busyCount()
    }
  }

  /** Chats with a turn running (studio test runs included): what quitting,
   *  updating or restarting the engine would stop. */
  busyCount(): number {
    return this.sessions.filter((s) => s.isBusy).length
  }

  /** Resolves once no chat is working — Update When Finished, Quit When
   *  Finished. */
  waitForIdle(): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.busyCount() === 0 || this.shuttingDown) resolve()
        else setTimeout(check, 500)
      }
      check()
    })
  }

  get notifyWhenDone(): boolean {
    return this.prefs.notifyWhenDone
  }

  setNotifyWhenDone(on: boolean): void {
    this.prefs.notifyWhenDone = on === true
    this.emitAppState()
  }

  /** A one-off message from outside the model (the quit guard). */
  notify(text: string): void {
    this.showBanner(text)
  }

  /** A message for the user, shown once (see AppStateDTO.bannerNonce). It is
   *  cleared as soon as it has been sent, so later snapshots — and paired
   *  phones, which get it once in their host state — never repeat a stale
   *  one. */
  private showBanner(text: string): void {
    this.banner = text
    this.bannerNonce += 1
    this.emitAppState()
    this.banner = null
  }

  /** Recent and session folders that no longer exist. Sessions count too: a
   *  project's "+" (or New session from one of its chats) points the
   *  new-session view at that chat's folder, which may be long gone. */
  private missingProjects(): string[] {
    const paths = new Set(this.prefs.recentProjects)
    for (const s of this.sessions) if (!s.isScratch) paths.add(s.projectPath)
    return [...paths].filter((p) => !isDirectory(p))
  }

  /** The persisted colour scheme. Read by main before the window exists, so
   *  the first paint is already in the right scheme. */
  get appearance(): Appearance {
    return this.prefs.appearance
  }

  setAppearance(mode: Appearance): void {
    if (!isAppearance(mode)) return
    this.prefs.appearance = mode
    this.applyAppearance(mode)
    this.emitAppState()
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

  /** The agent is up and usable by an attached phone. `needsProvider` counts:
   *  the process is running and answering, the local user is just parked on
   *  the setup screen (remoteAgentReady in AppModel+RemoteHost.swift). */
  agentReady(): boolean {
    return (
      (this.phase.kind === 'ready' || this.phase.kind === 'needsProvider') &&
      this.connectionState === 'ok'
    )
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
    // Starts the periodic GitHub check for the app and the CLI; the first one
    // lands a few seconds in, so it never competes with the handshake.
    this.updates.start()
    // Show any saved conversations immediately, before the CLI is located or
    // connected, so the sidebar is never empty on a cold launch.
    this.loadPersistedSessions()
    // Idempotent: bootstrapping over an agent that is already up (or coming
    // up) must not drop the UI back onto the loading screen.
    if (this.agent || this.phase.kind === 'connecting') return
    this.setPhase({ kind: 'locating' })
    const found = await locateCLI(this.prefs.explicitCLIPath || null)
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
      // The palette shows the folder's last known commands until the agent
      // announces its own on resume.
      const session = ChatSession.restore(stored, this.prefs.cachedCommands(stored.projectPath))
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
    this.store.save(
      this.sessions.filter((s) => !s.isPristine && !s.isScratch).map((s) => s.snapshot())
    )
    this.emitAppState()
  }

  // -------------------------------------------------------------------------
  // Connect / handshake / teardown
  // -------------------------------------------------------------------------

  /** Establishes the shared ACP connection and performs the handshake.
   *  `rootedAt` is the folder the agent process itself starts in; each
   *  session still passes its own cwd when it is created. A call while a
   *  connect is under way waits for that one rather than spawning a second
   *  CLI process. */
  private connect(rootedAt?: string): Promise<void> {
    if (this.agent) return Promise.resolve()
    if (this.connectInFlight) return this.connectInFlight
    const attempt = this.runConnect(rootedAt).finally(() => {
      if (this.connectInFlight === attempt) this.connectInFlight = null
    })
    this.connectInFlight = attempt
    return attempt
  }

  private async runConnect(rootedAt?: string): Promise<void> {
    // Never cache a stale locator result: if the CLI path changed (or the
    // binary moved) since `cli` was set, a reconnect must re-resolve, or
    // we'd happily "connect" to the wrong binary.
    const found = await locateCLI(this.prefs.explicitCLIPath || null)
    if (!found) {
      this.cli = null
      this.connectionState = 'ok'
      this.setPhase({ kind: 'needsSetup' })
      return
    }
    this.cli = { path: found.path, version: found.version, isDev: found.isDev }
    // With the shell already up, the restart happens underneath it: only the
    // header's "Reconnecting…" and a waiting Send say so.
    if (this.shellShown && this.phase.kind !== 'failed') {
      this.connectionState = 'reconnecting'
      this.emitAppState()
    } else {
      this.setPhase({ kind: 'connecting' })
    }

    this.connectionToken += 1
    const token = this.connectionToken
    const connection = new AcpConnection({
      executablePath: found.path,
      workingDirectory: rootedAt ?? this.defaultProjectPath
    })
    this.wire(connection, token)
    const agent = new AcpAgent(connection)
    this.pendingConnection = connection

    let answered = false
    try {
      await connection.start()
      const info = await this.handshake(agent, connection)
      answered = true
      // A teardown landed while we were waiting: this process is no longer
      // the one the app wants. Kill it and leave the phase to whoever
      // superseded us.
      if (token !== this.connectionToken) {
        connection.stop()
        return
      }
      this.agentVersion = info.agentVersion
      // The handshake is the authoritative CLI version — re-decide whether the
      // release we already know about is newer than what is now running.
      this.updates.refreshCLIVersion()
      this.connection = connection
      this.agent = agent
      this.liveConnectionToken = token
      this.extensions.attach(agent)

      // Load providers before deciding the phase: a CLI with nothing
      // configured can't answer a prompt, and dropping the user into a chat
      // there is a dead end. This is awaited (and the account refresh below is
      // not) so startup isn't held up by a network round trip to the
      // subscription backend.
      await this.extensions.refreshProviders()
      if (token !== this.connectionToken) return
      this.connectionState = 'ok'
      this.setPhase(this.isProviderSetupNeeded ? { kind: 'needsProvider' } : { kind: 'ready' })
      void this.extensions.refreshAccount()
      this.emitHostState()
      // Chats re-attach lazily, each as it is opened or sent to — at most the
      // one on screen now. Resuming every saved chat here held startup on one
      // round trip per chat, archived ones included.
      this.warmSelected()
    } catch (err) {
      // Never leave a half-started process behind: it would hold the CLI's
      // session lock and keep answering nothing.
      connection.stop()
      if (token !== this.connectionToken) return
      this.connectionState = 'ok'
      // Gone before it said a word: not a crash worth one more try — the file
      // is not Spettro (any executable can be chosen), or a damaged copy.
      const quitEarly = !answered && err instanceof AcpError && (err.kind === 'terminated' || err.kind === 'transport')
      this.setPhase({
        kind: 'failed',
        message: quitEarly
          ? `${errMessage(err)} It quit before answering — it may not be Spettro.`
          : errMessage(err)
      })
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
    this.enterReconnecting()
    const selected = this.selectedSessionId ? this.sessionById(this.selectedSessionId) : null
    await this.connect(selected?.projectPath ?? this.defaultProjectPath)
  }

  /** The "engine is restarting" state: under a shell already on screen it
   *  is a flag the header shows; before that, the loading screen. */
  private enterReconnecting(): void {
    if (this.shellShown && this.phase.kind !== 'failed') {
      this.connectionState = 'reconnecting'
      this.emitAppState()
    } else {
      this.setPhase({ kind: 'locating' })
    }
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
    this.connectInFlight = null
    this.agent = null
    // Stops the login poller and forgets whether providers ever loaded: an
    // agent that isn't there tells us nothing about what's configured.
    this.extensions.attach(null)
    live?.stop()
    starting?.stop()
    // Nothing is left waiting on these answers: the turn that asked them died
    // with the process. Answering them would reach a new process under ids
    // it never issued.
    this.withdrawPrompts(() => true, false)
    for (const session of this.sessions) {
      session.setBusy(false)
    }
    // The prompts those turns were waiting on died with the process too; their
    // runTurn calls unwind through the rejected requests and find nothing to
    // count down.
    this.promptsInFlight.clear()
    this.turnLaunched.clear()
    this.turnOutcome.clear()
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
    if (
      this.phase.kind !== 'ready' &&
      this.phase.kind !== 'needsProvider' &&
      this.phase.kind !== 'connecting'
    ) {
      this.emitAppState()
      return
    }

    // Restart the agent in the background so chats keep working, but if it
    // died again within seconds of the last restart, stop and surface the
    // failure rather than crash-looping.
    const now = Date.now()
    if (this.lastAgentRestart !== null && now - this.lastAgentRestart < CRASH_LOOP_WINDOW_MS) {
      // The failure screen shows the agent's own output behind "Show
      // details"; the message only says what happened.
      this.connectionState = 'ok'
      this.setPhase({ kind: 'failed', message: `The Spettro agent keeps stopping (exit ${code}).` })
      return
    }
    this.lastAgentRestart = now
    const notice = 'Spettro’s engine stopped unexpectedly. Restarting it…'
    this.emitHostState(false, notice)
    this.showBanner(notice)
    this.enterReconnecting()
    // Every session kept its acpSessionId and transcript, so each is
    // transparently resumed the next time it is opened or sent to.
    void this.connect()
  }

  /** Wires the connection's callbacks into the model. */
  private wire(connection: AcpConnection, token: number): void {
    connection.onSessionUpdate = (sessionId, update, raw) => {
      this.handleUpdate(sessionId, update, raw)
    }
    connection.onPermissionRequest = ({ rpcId, request, raw }) => {
      const priorToolStatus = this.adoptPermission(request)
      this.pendingPermissions.push({ request, rpcId, raw, priorToolStatus })
      this.emitPermissions()
      this.emit('permission-ask', request.id, request.chatId, raw)
    }
    connection.onQuestionRequest = ({ rpcId, request, raw, transport }) => {
      request.chatId = request.sessionId ? this.chatIdForACPSession(request.sessionId) : null
      this.pendingQuestions.push({ request, rpcId, raw, transport })
      this.emitQuestions()
      this.emit('question-ask', request.id, request.chatId, raw)
    }
    connection.onCancelRequest = (rpcId) => {
      // The agent stopped waiting (the tool's timeout passed, or its turn was
      // cancelled): the prompt on screen would answer nothing.
      this.withdrawPrompts((p) => p.rpcId === rpcId, false)
    }
    connection.onExtensionNotification = (method, params) => {
      // Attached phones run the same account and provider screens, so they get
      // the same push — a login completing on this machine should update the
      // phone's Settings without it polling.
      this.emit('agent-notification', method, params)
      if (method === ExtensionMethod.accountUpdate) {
        this.extensions.applyAccountUpdate(params)
        // Signing in is usually what unblocks a CLI that had no provider at
        // all, so re-evaluate the setup gate.
        void this.refreshProviderGate()
      }
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

  /** Brings the chat on screen live, so its chips and slash palette are the
   *  session's own. Every other chat waits until it is opened or sent to. */
  private warmSelected(): void {
    const selected = this.selectedSessionId ? this.sessionById(this.selectedSessionId) : null
    if (selected) this.warmSession(selected)
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
        session.appendNotice(`Couldn't restore ${live.name}. ${humanSentence(err)}`, false)
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
    this.install = { stage: 'checking', failure: null }
    this.installLog = ['Downloading and running the Spettro installer…']
    this.emitAppState()
    this.installer.install((event) => {
      if (event.type === 'output') {
        this.installLog.push(event.line)
        this.emitAppState()
        return
      }
      if (event.type === 'phase') {
        this.install = { stage: event.phase, failure: null }
        this.emitAppState()
        return
      }
      if (event.success) {
        void this.finishInstall()
        return
      }
      this.installLog.push('Installation did not complete.')
      this.install = installFailureState(event.failure)
      this.setPhase({ kind: 'needsSetup' })
    })
  }

  /** The script exited cleanly: find what it installed and start it. */
  private async finishInstall(): Promise<void> {
    const found = await locateCLI(null)
    if (!found) {
      this.installLog.push('The installer finished, but Spettro wasn’t found where it installs to.')
      this.install = { stage: 'failed', failure: { kind: 'failed' } }
      this.setPhase({ kind: 'needsSetup' })
      return
    }
    // Installing means "use the copy Spettro installs": a file chosen earlier
    // (perhaps the wrong one) must not keep winning at launch.
    this.prefs.explicitCLIPath = ''
    this.cli = { path: found.path, version: found.version, isDev: found.isDev }
    this.installLog.push(`Installed at ${found.path}`)
    this.install = { stage: 'done', failure: null }
    this.setPhase({ kind: 'locating' })
    void this.connect()
  }

  /** Setup's Cancel: the install stops and setup is back where it began. */
  cancelInstall(): void {
    this.installer.cancel()
  }

  // -------------------------------------------------------------------------
  // Updates
  // -------------------------------------------------------------------------

  /** Checks both the desktop app and the CLI against their latest releases. */
  checkForUpdates(): Promise<void> {
    return this.updates.check()
  }

  /** Downloads this platform's installer and hands the app over to it. */
  installAppUpdate(whenIdle = false): Promise<void> {
    return this.updates.installApp(whenIdle === true)
  }

  /** Re-runs the CLI install script, then restarts the agent on the new
   *  binary. Chats keep their transcripts; their ACP sessions are re-attached
   *  by the reconnect, exactly as they are after a crash-restart. */
  installCLIUpdate(whenIdle = false): Promise<void> {
    return this.updates.installCLI(whenIdle === true)
  }

  async useExplicitPath(path: string): Promise<void> {
    // Checked here, and never swapped for another copy: an invalid choice is
    // said in words and nothing changes. (Any executable used to pass, and a
    // path with nothing at it fell through to whichever spettro the search
    // found, saved as the choice while another binary ran.)
    const checked = await checkExplicitCLI(path)
    if (!checked.ok) {
      this.showBanner(EXPLICIT_CLI_PROBLEM[checked.problem])
      return
    }
    const found = checked.cli
    this.prefs.explicitCLIPath = found.path
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

  /** The new-session view's folder menu: the user chose where the next
   *  session will work, without starting one yet. Remembered exactly like
   *  chooseProject (default folder + recents), so the choice survives a
   *  relaunch. */
  rememberProject(path: string): void {
    if (path === '') return
    this.prefs.lastProjectPath = path
    this.prefs.addRecentProject(path)
    this.emitAppState()
  }

  /** "Continue" on the new-session warning about working in the home folder
   *  (or /): remembered for that folder, so it is asked once, not on every
   *  new session and every launch. */
  approveBroadFolder(path: string): void {
    this.prefs.approveBroadFolder(path)
    this.emitAppState()
  }

  /** "New project folder…": someone with nothing to open yet ("a website for
   *  my bakery") gets a folder of its own, ~/Spettro Projects/<name>, chosen
   *  for the next session like any other. A name already taken gets a
   *  number rather than mixing two projects in one folder. */
  createProjectFolder(name: string): string {
    const path = newProjectPath(join(homedir(), PROJECTS_FOLDER), name)
    mkdirSync(path, { recursive: true })
    this.rememberProject(path)
    return path
  }

  /** "Remove from recents". Only the shortcut goes: chats in that folder and
   *  the folder itself are untouched. */
  removeRecentProject(path: string): void {
    this.prefs.removeRecentProject(path)
    if (this.prefs.lastProjectPath === path) this.prefs.lastProjectPath = ''
    this.emitAppState()
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
    session.commands = this.prefs.cachedCommands(projectPath)
    this.attachSessionCallbacks(session)
    this.sessions.unshift(session)
    this.selectedSessionId = session.id
    this.pushEvent({ type: 'chat-reset', chat: session.detail() })
    this.emitAppState()
    // If the agent isn't running (first launch, or it died), boot it rooted
    // in this chat's folder — or wait for the boot already under way. Either
    // way the chat is warmed as soon as there is an agent, so its config
    // chips are the session's own.
    if (!this.agent) {
      void this.connect(projectPath).then(() => this.warmSession(session))
    } else {
      this.warmSession(session)
    }
    return session
  }

  /** Opens a chat from the sidebar. From the home screen this also starts
   *  the agent, so picking a saved conversation is enough to get going. */
  openChat(chatId: string): void {
    const session = this.sessionById(chatId)
    if (!session) return
    this.selectedSessionId = chatId
    session.unread = false
    this.pushEvent({ type: 'chat-reset', chat: session.detail() })
    this.emitAppState()
    if (!this.agent) {
      void this.connect(session.projectPath).then(() => this.warmSession(session))
    } else {
      this.warmSession(session)
    }
  }

  selectSession(chatId: string | null): void {
    this.selectedSessionId = chatId
    const session = chatId ? this.sessionById(chatId) : null
    if (session) session.unread = false
    this.emitAppState()
  }

  /** Sidebar / header rename. Persisted with the rest of the snapshot; an
   *  untouched chat isn't on disk yet, and takes the new title with it when
   *  its first prompt makes it real. */
  renameChat(chatId: string, title: string): void {
    const session = this.sessionById(chatId)
    if (!session || !session.rename(title)) return
    this.persist()
    this.emit('chat-state', session.summary())
  }

  /** Deletes a chat. Its ACP session is closed too — a turn still running
   *  would otherwise keep going (and asking for permissions nobody can see),
   *  and a paused workflow would sit there until the CLI's idle reaper. The
   *  CLI keeps the conversation on its own disk. Archiving doesn't close. */
  closeChat(chatId: string): void {
    const session = this.sessionById(chatId)
    if (!session) return
    this.releaseSession(session)
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
   *  user's own message skips the screen that already drew it.
   *
   *  A message sent while the chat is busy steers the running turn instead of
   *  waiting for it: the CLI queues it for the agent's next step and answers
   *  that prompt at once (bridge.go steerRunningTurn). The message carries
   *  its steering state, and the chat stays busy for the turn it steers.
   *
   *  `mentions` are the project-relative files the user @-mentioned; each
   *  one still in the text goes to the agent as a resource link in its
   *  place (promptBlocks). */
  send(
    chatId: string,
    text: string,
    attachments: PromptAttachment[],
    sourceDeviceId: string | null = null,
    mentions: string[] = []
  ): void {
    const session = this.sessionById(chatId)
    if (!session) return
    const trimmed = text.trim()
    if (trimmed === '' && attachments.length === 0) return
    const steering = session.isBusy

    const dtos: ImageAttachmentDTO[] = attachments.map((a) => ({
      id: randomUUID(),
      data: a.data,
      mimeType: a.mimeType,
      width: 0,
      height: 0
    }))
    // Only real project files are kept (and sent): see cleanMention.
    const kept = [
      ...new Set(
        mentions
          .map((m) => cleanMention(session.projectPath, m))
          .filter((m): m is string => m !== null)
      )
    ]
    const message = session.appendUserMessage(
      trimmed,
      dtos,
      steering ? 'sending' : undefined,
      kept
    )
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

    const blocks = promptBlocks(trimmed, attachments, kept, session.projectPath)
    void this.runTurn(session, blocks, steering ? message.id : null)
  }

  /** Nothing can run a prompt: no provider, no local model, not signed in. */
  private get noModel(): boolean {
    return this.extensions.needsProviderSetup && !this.extensions.isSignedIn
  }

  /** "Try again" on a turn that failed: sends the newest prompt again,
   *  images and @-mentioned files and all, as a new message — the failed attempt stays above it,
   *  so the transcript still says what happened. Does nothing while a turn
   *  is running: that would steer it, which is not what the button says. */
  retryLast(chatId: string): void {
    const session = this.sessionById(chatId)
    if (!session || session.isBusy) return
    // With no model connected the retry can only fail the same way, adding
    // another copy of the message and the error under it each time.
    if (this.noModel) return
    const last = session.items.findLast(
      (item) => item.kind === 'message' && item.message.role === 'user'
    )
    if (last?.kind !== 'message') return
    const { text, attachments, mentions } = last.message
    this.send(
      chatId,
      text,
      attachments.map((a) => ({ data: a.data, mimeType: a.mimeType })),
      null,
      mentions ?? []
    )
  }

  /**
   * One `session/prompt`, start to finish: a turn, or with `steerId` (the
   * id of the message it carries) a steer into the turn already running.
   *
   * Every prompt counts itself in and out of `promptsInFlight`, and the chat
   * goes idle — unread mark, final persist, the phone's "chat-state" — only
   * when the last one settles. A steer the agent queued answers with an
   * immediate end_turn that ends nothing, so it neither clears busy nor
   * leaves a stop notice. One that arrived after the turn it meant to steer
   * had already finished ran as a turn of its own, and is treated as one.
   */
  private async runTurn(
    session: ChatSession,
    blocks: ACPContentBlock[],
    steerId: string | null = null
  ): Promise<void> {
    const chatId = session.id
    const token = Symbol('prompt')
    const inFlight = this.promptsInFlight.get(chatId) ?? new Set<symbol>()
    inFlight.add(token)
    this.promptsInFlight.set(chatId, inFlight)
    let launched = (): void => undefined
    if (steerId !== null) {
      await this.turnLaunched.get(chatId)
    } else {
      this.turnLaunched.set(chatId, new Promise<void>((resolve) => (launched = resolve)))
    }

    let result: ACPPromptResult | null = null
    let failure: string | null = null
    let reachedAgent = false
    let startedAt = Date.now()
    try {
      const acpId = await this.ensureLiveSession(session)
      // What the user is looking at must be what the turn runs. A fresh
      // attach already synced (and cleared) its queue; anything still pending
      // here was queued while the agent was down or was rejected mid-session,
      // so it is replayed before the prompt goes out rather than after.
      if (acpId && Object.keys(session.pendingConfigChanges).length > 0) {
        await this.syncDisplayedConfig(session, session.displayedConfigValues(), acpId)
      }
      const agent = this.agent
      if (acpId && agent) {
        startedAt = Date.now()
        reachedAgent = true
        const prompt = agent.prompt(acpId, blocks)
        launched()
        result = await prompt
      }
    } catch (err) {
      failure = errMessage(err)
    } finally {
      launched()
    }

    inFlight.delete(token)
    const current = this.promptsInFlight.get(chatId)
    if (current === inFlight && inFlight.size === 0) this.promptsInFlight.delete(chatId)
    // A teardown since this prompt went out may have made way for prompts of
    // a new agent; while they run, this one has no business idling the chat.
    const left = current !== undefined && current !== inFlight ? current.size : inFlight.size

    const steerState = steerId !== null ? session.messageById(steerId)?.steering : undefined
    const steered = steerState === 'queued' || steerState === 'delivered'
    if (steerId !== null && !steered) session.setSteering(steerId, undefined)

    if (!reachedAgent && failure === null) {
      // Nothing was sent: ensureLiveSession has already said why in the chat.
      this.turnOutcome.set(chatId, { stopReason: 'error', notice: null })
    } else if (steerId !== null && !steered && left > 0) {
      // Answered beside the turn it meant to steer, which is still running:
      // a slash command the CLI handles at once (bridge.go Prompt answers
      // those before it ever tries to steer), or a steer that failed. Ending
      // the stream, filing a turn or withdrawing prompts here would all hit
      // the running turn instead, so only a failure is worth a line.
      if (failure !== null) session.appendNotice(humanSentence(failure), true, false, failure)
    } else if (!(steered && result?.stopReason === 'end_turn')) {
      this.finishTurn(session, result, failure, Date.now() - startedAt)
    }

    if (left > 0) {
      this.persist()
      return
    }
    // A steer the agent never got to read (the turn was interrupted first)
    // is just a message now; leaving it "queued" would wait forever.
    session.clearPendingSteering()
    this.turnLaunched.delete(chatId)
    const outcome = this.turnOutcome.get(chatId) ?? { stopReason: 'end_turn', notice: null }
    this.turnOutcome.delete(chatId)
    session.setBusy(false)
    // Finished out of sight: mark it so the sidebar can say so. The selected
    // chat is on screen, and the user has already seen it end.
    if (this.selectedSessionId !== chatId) session.unread = true
    this.persist()
    const { stopReason, notice } = outcome
    this.emit('chat-state', session.summary(), notice ? { stopReason, notice } : { stopReason })
  }

  /** The end of a real turn in the transcript: streaming stops, a stop
   *  reason worth mentioning becomes a notice, and the turn's tokens are
   *  filed. A failed turn's prompts go with it. */
  private finishTurn(
    session: ChatSession,
    result: ACPPromptResult | null,
    failure: string | null,
    durationMs: number
  ): void {
    session.endStreaming()
    const stopReason: TurnSummary['stopReason'] =
      failure !== null ? 'error' : (result?.stopReason ?? 'end_turn')
    // Mirrors whatever inline notice the local transcript gets, so a remote
    // screen ends the turn in the same visible state.
    // A failure is said in words (shared/humanize.ts), with the error as it
    // arrived kept behind the notice's "Show details".
    const notice: TurnNotice | null =
      failure !== null ? { text: humanSentence(failure), isError: true } : stopNotice(stopReason)
    if (notice) session.appendNotice(notice.text, notice.isError, failure !== null, failure ?? undefined)
    if (failure !== null) {
      // The turn is gone; whatever it was asking can't be answered usefully.
      const acpId = session.acpSessionId
      this.withdrawPrompts((p) => p.sessionId === acpId, true)
    }
    const usage = result?.usage
    session.recordTurn({
      stopReason,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cachedReadTokens: usage?.cachedReadTokens ?? 0,
      totalTokens: usage?.totalTokens ?? result?.tokensUsed ?? 0,
      durationMs
    })
    this.turnOutcome.set(session.id, { stopReason, notice })
  }

  /** Lazily attaches a live ACP session when a chat is opened or prompted,
   *  bringing the agent back up first if it died. */
  private ensureLiveSession(session: ChatSession, silent = false): Promise<string | null> {
    // The stored id only counts if it still routes to a live ACP session:
    // after the agent restarts it survives on disk but means nothing to the
    // new process until it has been resumed.
    const liveId = this.liveACPSessionId(session)
    if (liveId) return Promise.resolve(liveId)
    // One attach at a time per chat: warming (below) and the first prompt
    // race, and the prompt must wait for the resume rather than start a
    // session/new of its own — that would strand the conversation's context,
    // and two session/new calls would strand the first ACP session, its
    // streamed updates routed to a chat that no longer claims it.
    const inFlight = this.ensureInFlight.get(session.id)
    if (inFlight) return inFlight
    const attach = this.attachLiveSession(session, silent).finally(() => {
      this.ensureInFlight.delete(session.id)
    })
    this.ensureInFlight.set(session.id, attach)
    return attach
  }

  /** Warms a chat the moment it is on screen: attaching the ACP session is
   *  what produces the real config options and slash commands, so the chips
   *  and the palette show what the session will actually run instead of the
   *  last chat's cached set until the first prompt. */
  private warmSession(session: ChatSession): void {
    if (!this.agent) return
    if (this.liveACPSessionId(session)) return
    void this.ensureLiveSession(session, true)
  }

  /** Resumes the chat's stored ACP session — the agent restores its memory
   *  of the conversation without replaying it (session/load would duplicate
   *  every message we already show) — or, for a chat that never had one or
   *  whose session is gone, starts a new one. */
  private async attachLiveSession(session: ChatSession, silent: boolean): Promise<string | null> {
    if (!this.agent) await this.connect(session.projectPath)
    const agent = this.agent
    if (!agent) {
      if (!silent) {
        session.appendNotice("Spettro's engine isn't running yet. Try again in a moment.", true, true)
      }
      return null
    }
    const storedId = session.acpSessionId
    if (storedId) {
      try {
        const result = await agent.resumeSession(storedId, session.projectPath)
        // The agent this resumed on was replaced meanwhile: the id routes to
        // nothing live.
        if (agent !== this.agent) return null
        // What the chat shows now, not when the resume was asked for: a
        // default changed while it was in flight (Settings, the new-session
        // chips) is already on screen, and pushing the older values would
        // put the old level back for every session.
        const displayed = session.displayedConfigValues()
        // Register only after a successful resume: updates emitted before
        // this point belong to no session the UI should show.
        this.sessionsByACPID.set(storedId, session)
        if (result.configOptions.length > 0) session.setConfigOptions(result.configOptions)
        await this.syncDisplayedConfig(session, displayed, storedId)
        return storedId
      } catch {
        if (agent !== this.agent) return null
        // A chat that only ever ran the CLI's own slash commands (/help…)
        // has no session the CLI saved, and no context to lose either.
        if (session.hasModelTurns()) {
          session.appendNotice("Couldn't restore this chat's earlier context — starting fresh.", false)
        }
      }
    }
    try {
      const result = await agent.newSession(session.projectPath)
      if (agent !== this.agent) return null
      const displayed = session.displayedConfigValues()
      session.setAcpSessionId(result.sessionId)
      session.setConfigOptions(result.configOptions)
      this.sessionsByACPID.set(result.sessionId, session)
      // Push the config the user was shown before prompting, so the first
      // message already runs with the displayed settings.
      await this.syncDisplayedConfig(session, displayed, result.sessionId)
      return result.sessionId
    } catch (err) {
      if (storedId) session.setAcpSessionId(null)
      // A background warm must not spray notices into an empty chat; the
      // prompt path reports the same failure when the user actually sends.
      if (!silent) {
        session.appendNotice(
          `Couldn't start this session. ${humanSentence(err)}`,
          true,
          true,
          errMessage(err)
        )
      }
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
   *  'cancelled' and unwinds through the normal turn cleanup. Anything the
   *  turn was waiting on the user for goes with it, answered "cancelled". */
  cancel(chatId: string): void {
    const session = this.sessionById(chatId)
    if (!session || !session.acpSessionId) return
    const acpId = session.acpSessionId
    if (this.agent && this.liveACPSessionId(session)) this.agent.cancel(acpId)
    this.withdrawPrompts((p) => p.sessionId === acpId, true)
  }

  /** Lets go of a chat's live ACP session before the chat itself goes: a
   *  running turn is cancelled, then the session is closed on the agent,
   *  which also stops any workflow paused in it. */
  private releaseSession(session: ChatSession): void {
    const acpId = this.liveACPSessionId(session)
    if (session.isBusy) this.cancel(session.id)
    const agent = this.agent
    if (!acpId || !agent) return
    agent.closeSession(acpId).catch((err) => {
      this.agentLog.push(`session/close failed: ${errMessage(err)}`)
    })
  }

  // -------------------------------------------------------------------------
  // Sessions the CLI has that no chat is linked to
  // -------------------------------------------------------------------------

  /** Conversations the CLI keeps for `projectPath` that no chat here is
   *  linked to — started in the terminal, say — newest first. Empty when the
   *  agent isn't running or can't list. */
  async listCLISessions(projectPath: string): Promise<CLISessionEntry[]> {
    const agent = this.agent
    if (!agent || !agent.capabilities.listSessions) return []
    const linked = new Set(this.sessions.map((s) => s.acpSessionId).filter((id) => id !== null))
    const entries = await agent.listSessions(projectPath)
    return entries
      .filter((e) => !linked.has(e.sessionId))
      .map(({ sessionId, title, updatedAt }) => ({ sessionId, title, updatedAt }))
  }

  /** Opens one of those as a chat: `session/load` replays its conversation,
   *  which streams in as ordinary updates — user messages included, the one
   *  time the agent sends those. Resolves to the new chat's id (or the
   *  existing one's, when it is already linked), or null when the agent can't
   *  load sessions; rejects with the agent's reason when the load fails. */
  async importCLISession(sessionId: string, projectPath: string): Promise<string | null> {
    const existing = this.sessions.find((s) => s.acpSessionId === sessionId && !s.isScratch)
    if (existing) {
      this.openChat(existing.id)
      return existing.id
    }
    if (!this.agent) await this.connect(projectPath)
    const agent = this.agent
    if (!agent || !agent.capabilities.loadSession) return null

    const session = new ChatSession(projectPath)
    session.configOptions = this.prefs.lastConfigOptions
    session.commands = this.prefs.cachedCommands(projectPath)
    session.acpSessionId = sessionId
    this.attachSessionCallbacks(session)
    // Routed before the call: the replay arrives before session/load answers.
    this.sessionsByACPID.set(sessionId, session)
    session.isReplaying = true
    let configOptions: ACPConfigOption[]
    try {
      configOptions = (await agent.loadSession(sessionId, projectPath)).configOptions
    } catch (err) {
      if (this.sessionsByACPID.get(sessionId) === session) this.sessionsByACPID.delete(sessionId)
      throw err
    } finally {
      session.isReplaying = false
      session.endStreaming()
    }
    if (agent !== this.agent) return null
    if (configOptions.length > 0) session.setConfigOptions(configOptions)
    // A loaded session comes back in the CLI's default mode (Plan); steer it
    // like any fresh session.
    await this.syncDisplayedConfig(session, {}, sessionId)
    session.isEmpty = false
    this.sessions.unshift(session)
    this.selectedSessionId = session.id
    this.pushEvent({ type: 'chat-reset', chat: session.detail() })
    this.persist()
    this.emit('chat-state', session.summary())
    return session.id
  }

  // -------------------------------------------------------------------------
  // Workflows (`_spettro/workflow/*`)
  //
  // Scoped by chat rather than globally: a workflow lives in the repo it
  // automates, so "which workflows exist" is a question about a project, and
  // the chat is what knows which project. A live chat names its ACP session
  // and lets the CLI derive the folder from it, so a script cannot land in
  // the wrong repo because the two sides disagreed about the working
  // directory. A cold chat names its own folder (the CLI takes an absolute
  // `cwd` just as well) rather than showing the studio an empty project.
  //
  // Unlike the account calls these return their result instead of folding it
  // into app-state. The studio is one screen reading files it is about to
  // edit; a cached copy in the global snapshot would go stale the moment the
  // TUI, or the agent itself, wrote one.
  // -------------------------------------------------------------------------

  /** Where a chat's workflows live: its live ACP session, else its folder. */
  private workflowTarget(chatId: string): WorkflowTarget | null {
    const session = this.sessionById(chatId)
    if (!session) return null
    const acpId = this.liveACPSessionId(session)
    return acpId ? { sessionId: acpId } : { cwd: session.projectPath }
  }

  async listWorkflows(chatId: string): Promise<WorkflowList> {
    const client = this.extensions.client
    const target = this.workflowTarget(chatId)
    if (!client || !target) return EMPTY_WORKFLOW_LIST
    return client.listWorkflows(target)
  }

  async readWorkflow(chatId: string, name: string): Promise<WorkflowSource | null> {
    const client = this.extensions.client
    const target = this.workflowTarget(chatId)
    if (!client || !target) return null
    return client.readWorkflow(target, name)
  }

  async writeWorkflow(
    chatId: string,
    name: string,
    scope: WorkflowScope,
    script: string
  ): Promise<WorkflowInfo | null> {
    const client = this.extensions.client
    const target = this.workflowTarget(chatId)
    if (!client || !target) return null
    return client.writeWorkflow(target, name, scope, script)
  }

  async deleteWorkflow(chatId: string, name: string, scope: WorkflowScope): Promise<boolean> {
    const client = this.extensions.client
    const target = this.workflowTarget(chatId)
    if (!client || !target) return false
    return client.deleteWorkflow(target, name, scope)
  }

  async validateWorkflow(chatId: string, script: string): Promise<WorkflowValidation | null> {
    const client = this.extensions.client
    const target = this.workflowTarget(chatId)
    if (!client || !target) return null
    return client.validateWorkflow(target, script)
  }

  /**
   * Runs a saved workflow in a throwaway chat and returns its id.
   *
   * The run goes through an ordinary prompt turn rather than some private
   * channel, because that is what a workflow run actually is: the CLI rewrites
   * "/workflows run <name>" into a turn that calls the workflow tool
   * (internal/acp/bridge.go), and everything downstream — the tool calls, the
   * phase tree, the sub-agents — is machinery the app already renders. A second
   * path would be a second thing to keep correct.
   *
   * What it does not do is run in the user's conversation. Iterating on a
   * script means running it over and over and throwing most of the results
   * away, so each run gets a scratch session: same project, same config, no
   * sidebar entry, never written to disk.
   */
  runWorkflow(chatId: string, name: string): string | null {
    const origin = this.sessionById(chatId)
    if (!origin) return null
    const scratch = new ChatSession(origin.projectPath, `Workflow · ${name}`)
    scratch.isScratch = true
    // Inherit the originating chat's config so a test run uses the model and
    // permission level the user is actually working with — a workflow that
    // only passes under different settings has not been tested.
    scratch.configOptions = origin.configOptions
    scratch.commands = origin.commands
    this.attachSessionCallbacks(scratch)
    this.sessions.unshift(scratch)
    this.pushEvent({ type: 'chat-reset', chat: scratch.detail() })
    // Deliberately not emitAppState(): a scratch chat must not disturb the
    // sidebar or steal the selection out from under the studio. send() takes
    // care of attaching a live ACP session on its way through runTurn.
    this.send(scratch.id, `/workflows run ${name}`, [])
    return scratch.id
  }

  /** Drops a scratch chat once the studio is done with it. Anything still
   *  running is cancelled and the session closed first, so closing the
   *  editor cannot leave a fan-out burning tokens against a session nobody
   *  is watching. */
  discardScratchChat(chatId: string): void {
    const session = this.sessionById(chatId)
    if (!session || !session.isScratch) return
    this.releaseSession(session)
    this.sessions = this.sessions.filter((s) => s.id !== chatId)
    const acpId = session.acpSessionId
    if (acpId) this.sessionsByACPID.delete(acpId)
    this.pushEvent({ type: 'chat-removed', chatId })
  }

  async listWorkflowRuns(chatId: string): Promise<WorkflowRunInfo[]> {
    const client = this.extensions.client
    const target = this.workflowTarget(chatId)
    if (!client || !target) return []
    return client.listWorkflowRuns(target)
  }

  // -------------------------------------------------------------------------
  // Config options
  // -------------------------------------------------------------------------

  async setConfigValue(chatId: string, configId: string, value: ConfigValue): Promise<void> {
    // No chat yet: the new-session composer, whose chips show the seed.
    if (chatId === '') return this.setDraftOption(configId, value)
    const session = this.sessionById(chatId)
    if (!session) return
    // What the agent last told us this option was — the value to fall back to
    // if it turns out the agent won't take the new one.
    const previous = session.displayedConfigValues()[configId]
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
      // Named as the user knows it ("Model"), not by its wire id.
      const label = session.configOptions.find((o) => o.id === configId)?.name ?? configId
      session.appendNotice(`Couldn't change ${label}. ${humanSentence(err)}`, true, false, errMessage(err))
      // Two very different failures arrive here, and they want opposite
      // treatment.
      //
      // A *refusal* — the agent answered, and the answer was no (a JSON-RPC
      // error; kind 'rpc'). A value the CLI does not offer (a model a provider
      // has since dropped, say) is the canonical case: it will be rejected
      // every single time. (Ultra under "Ask first" is not one: the CLI saves
      // it and only suspends it, saying so in the option's description.)
      // Retrying that before the next turn achieves
      // nothing except another notice, forever, and leaving the optimistic
      // value on screen is a lie about what the agent is running with — so we
      // roll the chip back to the value the agent actually reports and drop
      // the change on the floor.
      //
      // A *transport* failure — the agent never answered at all (the process
      // died, the pipe broke, the reply didn't decode). We have no idea what
      // its config is now, and the queue is exactly right: the change gets
      // pushed onto whichever session attaches next, which is what makes a
      // ConfigBar change survive an agent restart.
      const refused = err instanceof AcpError && err.kind === 'rpc'
      if (refused) {
        if (previous !== undefined) session.applyLocalConfigValue(configId, previous)
        delete session.pendingConfigChanges[configId]
      } else {
        session.pendingConfigChanges[configId] = value
      }
      this.persist()
    }
  }

  /** Settings' defaults (the permission level). The CLI keeps these for
   *  every session, so changing one through a live session changes it
   *  everywhere — the selected chat's if it is live, else any live one. The
   *  seed new chats start with is updated either way, and a chat attached
   *  later pushes it like any shown value. */
  async setDefaultOption(configId: string, value: ConfigValue): Promise<void> {
    this.setSeedValue(configId, value)

    const selected = this.selectedSessionId ? this.sessionById(this.selectedSessionId) : null
    const target =
      (selected && this.liveACPSessionId(selected) ? selected : null) ??
      this.sessions.find((s) => !s.isScratch && this.liveACPSessionId(s) !== null) ??
      null
    // Every other chat shows the new value too. A cold chat pushes what it
    // shows when it attaches, so one still showing the old level would put
    // it back for every session the moment it was opened.
    for (const session of this.sessions) {
      if (session === target || session.isScratch) continue
      if (!session.configOptions.some((o) => o.id === configId)) continue
      session.applyLocalConfigValue(configId, value)
      delete session.pendingConfigChanges[configId]
    }
    if (target) await this.setConfigValue(target.id, configId, value)
    else this.persist()
  }

  /** A choice made in the new-session composer, before its chat exists. It
   *  changes the seed that chat starts from (prefs.lastConfigOptions), and
   *  the chat pushes what it shows onto its session when it attaches — so the
   *  first message runs with what the user saw. The mode is the session's
   *  own; the rest the CLI shares across sessions, so those go through as a
   *  default, like Settings' permission. */
  private async setDraftOption(configId: string, value: ConfigValue): Promise<void> {
    if (configId === 'mode') {
      this.setSeedValue(configId, value)
      this.emitAppState()
      return
    }
    // Applying a default through a live chat makes that chat's options the
    // seed (rememberConfig), its own mode included; the draft keeps its own.
    const mode = this.prefs.lastConfigOptions.find((o) => o.id === 'mode')
    await this.setDefaultOption(configId, value)
    if (mode?.kind.type === 'select' && mode.kind.currentValue !== null) {
      this.setSeedValue('mode', mode.kind.currentValue)
    }
    this.emitAppState()
  }

  /** Sets one value in the seed new chats start from; unknown ids are left
   *  alone (the seed only ever holds options a session reported). */
  private setSeedValue(configId: string, value: ConfigValue): void {
    const seed = this.prefs.lastConfigOptions
    const option = seed.find((o) => o.id === configId)
    if (option?.kind.type === 'select' && typeof value === 'string') option.kind.currentValue = value
    else if (option?.kind.type === 'boolean' && typeof value === 'boolean') option.kind.currentValue = value
    else return
    this.prefs.lastConfigOptions = seed
  }

  // -------------------------------------------------------------------------
  // Permissions / questions
  // -------------------------------------------------------------------------

  resolvePermission(requestId: string, optionId: string, resolvedBy: string | null = null): void {
    const index = this.pendingPermissions.findIndex((p) => p.request.id === requestId)
    if (index < 0) return
    const entry = this.pendingPermissions[index]
    this.agent?.replyPermission(entry.rpcId, optionId)
    const kind = entry.request.options.find((o) => o.optionId === optionId)?.kind ?? ''
    if (kind.startsWith('reject') && entry.request.chatId && entry.request.toolCallId) {
      this.sessionById(entry.request.chatId)?.markDenied(entry.request.toolCallId)
    }
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

  /**
   * Fills in what an incoming permission request leaves to the app, and
   * marks its card. Returns the card's status before the request turned it
   * "pending" (null when the request made the card).
   *
   * spettro attaches a request to the card it is already drawing and then
   * sends only the card's id, the pending status and the content — no title,
   * no kind (permission.go requestApproval) — so the chat, the title and the
   * kind come from that card here. A request with nothing open to attach to
   * names a fresh `perm-N` card and describes it in full; that card is put in
   * the transcript now, as the spec says to treat the request's toolCall, so
   * the settle update that follows the answer lands on a titled card instead
   * of creating an untitled one. The compaction prompt approves no tool and
   * gets no settle update, so it gets no card.
   */
  private adoptPermission(request: ACPPermissionRequest): ACPToolStatus | null {
    const session = this.sessionsByACPID.get(request.sessionId) ?? null
    request.chatId = session?.id ?? null
    const toolCallId = request.toolCallId
    const card = session && toolCallId ? session.toolById(toolCallId) : null
    if (request.toolKind === undefined && card?.kind !== undefined) request.toolKind = card.kind
    if (request.title === '') request.title = card?.title || permissionSentence(request)
    if (!session || !toolCallId || request.variant === 'compact') return null
    if (card) {
      // From here on the request names the card by the id it is filed
      // under, which differs from the wire id once an earlier turn used it
      // (ChatSession.turnStart) — the renderer marks the card by it.
      request.toolCallId = card.id
      return session.setToolStatus(card.id, 'pending')
    }
    const event: ACPToolCallEvent = {
      toolCallId,
      title: request.title,
      status: 'pending',
      texts: [],
      diffs: [],
      images: [],
      locations: request.locations
    }
    if (request.toolKind !== undefined) event.kind = request.toolKind
    if (request.rawInput !== undefined) event.rawInput = request.rawInput
    session.applyToolEvent(event, true)
    request.toolCallId = session.toolById(toolCallId)?.id ?? toolCallId
    return null
  }

  /**
   * Takes every queued permission and question that `match`es off screen —
   * because the agent withdrew it, its turn was cancelled or failed, or the
   * agent itself is gone — and tells paired phones it is resolved. With
   * `answer`, each is also answered "cancelled", so a CLI still waiting on
   * it stops waiting. A card a permission marked "pending" goes back to what
   * it was, or to failed when the request made it: the CLI counts an
   * unanswered request as a denial.
   */
  private withdrawPrompts(
    match: (prompt: { rpcId: RPCID; sessionId: string | undefined }) => boolean,
    answer: boolean
  ): void {
    const agent = answer ? this.agent : null
    const permissions = this.pendingPermissions.filter((p) =>
      match({ rpcId: p.rpcId, sessionId: p.request.sessionId })
    )
    const questions = this.pendingQuestions.filter((q) =>
      match({ rpcId: q.rpcId, sessionId: q.request.sessionId })
    )
    if (permissions.length > 0) {
      this.pendingPermissions = this.pendingPermissions.filter((p) => !permissions.includes(p))
      for (const entry of permissions) {
        agent?.cancelPermission(entry.rpcId)
        this.releasePromptCard(entry)
      }
      this.emitPermissions()
      for (const entry of permissions) this.emit('permission-resolved', entry.request.id, null)
    }
    if (questions.length > 0) {
      this.pendingQuestions = this.pendingQuestions.filter((q) => !questions.includes(q))
      for (const entry of questions) agent?.cancelQuestion(entry)
      this.emitQuestions()
      for (const entry of questions) this.emit('question-resolved', entry.request.id, null)
    }
  }

  /** Undoes the "pending" a withdrawn permission put on its card, unless an
   *  update has moved the card on since. */
  private releasePromptCard(entry: PendingPermission): void {
    const { chatId, toolCallId } = entry.request
    const session = chatId ? this.sessionById(chatId) : null
    if (!session || !toolCallId) return
    if (session.toolById(toolCallId)?.status !== 'pending') return
    session.setToolStatus(toolCallId, entry.priorToolStatus ?? 'failed')
  }

  // -------------------------------------------------------------------------
  // Provider gate (needsProvider)
  // -------------------------------------------------------------------------

  /** Whether to route the user into provider setup.
   *
   *  This gate fails open on purpose. It only closes when the provider list
   *  loaded successfully *and* came back empty *and* no subscription is signed
   *  in — anything else (a failed load, an old CLI, a transient error) means
   *  "we don't know", and an unknown answer must never cost someone access to
   *  the rest of the app. */
  private get isProviderSetupNeeded(): boolean {
    if (this.prefs.providerSetupSkipped) return false
    if (!this.extensions.needsProviderSetup) return false
    // Being signed in is itself proof there's a way to run a model, even when
    // the plan details haven't loaded yet.
    return !this.extensions.isSignedIn
  }

  /** Recomputes the gate from what the stores already know, without a fetch.
   *  Only ever moves between the two connected phases, so it can't disturb
   *  setup, install, or failure. */
  private updateProviderGate(): void {
    if (this.phase.kind !== 'ready' && this.phase.kind !== 'needsProvider') return
    const next: Phase = this.isProviderSetupNeeded ? { kind: 'needsProvider' } : { kind: 'ready' }
    if (next.kind === this.phase.kind) return
    this.setPhase(next)
    this.emitHostState()
  }

  /** Re-checks whether a provider is configured, moving the app out of (or
   *  into) the `needsProvider` phase. */
  async refreshProviderGate(): Promise<void> {
    if (this.phase.kind !== 'ready' && this.phase.kind !== 'needsProvider') return
    await this.extensions.refreshProviders()
    this.updateProviderGate()
  }

  /** Called once provider setup completes, to leave the `needsProvider` phase
   *  without a full reconnect. */
  async providerSetupCompleted(): Promise<void> {
    await this.extensions.refreshProviders()
    if (this.isProviderSetupNeeded) return
    if (this.phase.kind === 'needsProvider') {
      this.setPhase({ kind: 'ready' })
      this.emitHostState()
      this.warmSelected()
    }
  }

  /** Leaves provider setup without configuring anything. The chat will fail on
   *  its first prompt if nothing is connected, which is the user's call to
   *  make — being unable to reach settings, sessions, or the sidebar is not a
   *  reasonable price for an unfinished setup step. */
  skipProviderSetup(): void {
    // Remembered: the setup screen doesn't come back on the next launch. The
    // composer's "Connect a model" bar keeps the way back in view.
    this.prefs.providerSetupSkipped = true
    if (this.phase.kind === 'needsProvider') {
      this.setPhase({ kind: 'ready' })
      this.emitHostState()
    }
  }

  // -------------------------------------------------------------------------
  // Account / providers / models (the `_spettro/*` surface)
  //
  // Every mutating call refreshes the affected store, so the renderer reads
  // results from AppStateDTO.extensions rather than from return values. API
  // keys are passed straight through to the CLI: never logged, never stored.
  // -------------------------------------------------------------------------

  async refreshExtensions(): Promise<void> {
    await this.extensions.refresh()
    this.updateProviderGate()
  }

  /** Starts a device-flow sign-in. The returned status carries the URL the
   *  renderer opens; the main process then polls the flow to completion. */
  accountLoginStart(): Promise<LoginStatus> {
    return this.extensions.startLogin()
  }

  /** One synchronous read of the in-flight login — for a screen that
   *  reappeared and may have missed a push. */
  accountLoginPoll(): Promise<LoginStatus> {
    return this.extensions.pollLogin()
  }

  accountLoginCancel(): Promise<void> {
    return this.extensions.cancelLogin()
  }

  async accountLogout(): Promise<void> {
    await this.extensions.logout()
    this.updateProviderGate()
  }

  async providerConnect(id: string, apiKey: string, activate: boolean): Promise<ConnectResult> {
    const result = await this.extensions.connect(id, apiKey, activate)
    // The store already refreshed; releasing the user out of `needsProvider`
    // is what makes a successful connect the end of setup.
    this.updateProviderGate()
    return result
  }

  async providerDisconnect(id: string): Promise<void> {
    await this.extensions.disconnect(id)
    this.updateProviderGate()
  }

  localEndpointProbe(endpoint: string, apiKey: string | null): Promise<LocalProbeResult> {
    return this.extensions.probeLocal(endpoint, apiKey)
  }

  async localEndpointAdd(endpoint: string, apiKey: string | null): Promise<void> {
    await this.extensions.addLocal(endpoint, apiKey)
    this.updateProviderGate()
  }

  async localEndpointRemove(endpoint: string): Promise<void> {
    await this.extensions.removeLocal(endpoint)
    this.updateProviderGate()
  }

  modelSetFavorite(provider: string, model: string, favorite: boolean): Promise<void> {
    return this.extensions.setFavorite(provider, model, favorite)
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
    // way. Re-keyed by the app's own chat id. A load replay isn't relayed:
    // the chat it fills isn't anyone's yet, and phones get it whole once the
    // import finishes.
    if (!session.isReplaying) this.emit('chat-update-raw', session.id, raw)
    switch (update.kind) {
      case 'agent_message_chunk':
        session.appendAssistant(update.text)
        break
      case 'user_message_chunk':
        // Only ever legitimate inside session/load; anywhere else it would be
        // the agent putting words in the user's mouth.
        if (session.isReplaying) session.appendReplayedUserMessage(update.text)
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
        this.prefs.setCachedCommands(session.projectPath, update.commands)
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
    this.installer.cancel()
    this.teardownAgent()
    this.extensions.dispose()
    this.subscriptionStore.stop()
    this.updates.shutdown()
    this.store.save(
      this.sessions.filter((s) => !s.isPristine && !s.isScratch).map((s) => s.snapshot())
    )
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

/** An inline notice the transcript gets at a turn's end, mirrored to phones. */
interface TurnNotice {
  text: string
  isError: boolean
}

/** The muted line a turn's stop reason earns, if any. end_turn (and a reason
 *  this build doesn't know) end silently. */
function stopNotice(reason: TurnSummary['stopReason']): TurnNotice | null {
  switch (reason) {
    case 'max_tokens':
      return { text: 'The reply hit the length limit.', isError: false }
    case 'refusal':
      return { text: 'The model declined this request.', isError: false }
    case 'max_turn_requests':
      return { text: 'The turn reached its step limit.', isError: false }
    case 'cancelled':
      return { text: 'Interrupted', isError: false }
    default:
      return null
  }
}

/** A title for a permission request that came with none and whose card we
 *  don't have — written from the tool kind, naming the file when there is
 *  one. */
function permissionSentence(request: ACPPermissionRequest): string {
  const path = request.content.diffs[0]?.path ?? request.locations[0]?.path
  const file = path ? basename(path) : null
  switch (request.variant ?? request.toolKind) {
    case 'compact':
      return 'Compact the conversation'
    case 'execute':
      return 'Run a command'
    case 'edit':
      return file ? `Edit ${file}` : 'Edit a file'
    case 'delete':
      return file ? `Delete ${file}` : 'Delete a file'
    case 'move':
      return file ? `Move ${file}` : 'Move a file'
    case 'read':
      return file ? `Read ${file}` : 'Read a file'
    case 'search':
      return 'Search the project'
    case 'fetch':
      return 'Open a web page'
    default:
      return 'Allow this action'
  }
}

/** What setup shows for an install that ended without a CLI. A cancelled
 *  one is no failure: setup just goes back to its first screen. */
function installFailureState(failure: InstallFailure): InstallState {
  switch (failure.kind) {
    case 'cancelled':
      return { stage: 'idle', failure: null }
    case 'missing-tool':
      return { stage: 'failed', failure: { kind: 'missing-tool', tool: failure.tool } }
    case 'timeout':
      return { stage: 'failed', failure: { kind: 'timeout' } }
    case 'launch':
      return { stage: 'failed', failure: { kind: 'launch' } }
    case 'failed':
      return { stage: 'failed', failure: { kind: 'failed' } }
  }
}

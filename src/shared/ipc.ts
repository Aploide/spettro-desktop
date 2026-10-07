// The IPC contract between the main-process model layer and the renderer.
//
// Design: the model (AppModel port) lives in the MAIN process; the renderer is
// a pure view that mirrors state. Main pushes granular events on the channels
// below; the renderer calls methods via `window.spettro.call(method, params)`
// which is routed over a single `invoke` channel.

import type {
  ACPConfigOption,
  ACPPermissionRequest,
  ACPQuestionAnswer,
  ACPQuestionRequest
} from './acp'
import type {
  Accent,
  Appearance,
  AppStateDTO,
  ChatDetail,
  CLISessionEntry,
  GitStat,
  TranscriptItem
} from './model'
import type { MenuCommand } from './shortcuts'
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
} from './extensions'

// ---------------------------------------------------------------------------
// Main → renderer push events
// ---------------------------------------------------------------------------

export const EVENT_CHANNEL = 'spettro:event'

/** The launch argument main gives the window's renderer process
 *  (`--spettro-accent=lilac`), read by preload before the page paints. */
export const ACCENT_ARG = '--spettro-accent='

export type MainEvent =
  /** App-level state changed (phase, sessions list, banner, selection, …).
   *  Sent as a whole — it is small. */
  | { type: 'app-state'; state: AppStateDTO }
  /** Full transcript + config for one chat (sent on open/reset/restore). */
  | { type: 'chat-reset'; chat: ChatDetail }
  /** One transcript item was appended or mutated. Renderer upserts by
   *  transcriptItemId: replace in place if present, else append. */
  | { type: 'chat-item'; chatId: string; item: TranscriptItem }
  /** Chat-scoped metadata changed (any subset of the fields). */
  | {
      type: 'chat-meta'
      chatId: string
      meta: Partial<
        Pick<
          ChatDetail,
          | 'title'
          | 'isBusy'
          | 'configOptions'
          | 'commands'
          | 'plan'
          | 'usage'
          | 'acpSessionId'
          | 'isPinned'
          | 'isArchived'
          | 'lastTurn'
          | 'sessionTokens'
        >
      >
    }
  /** One config option's shown value changed (a chip moved, a shared
   *  setting spread from another chat). The rest of the option set — the
   *  model catalog in it runs to tens of KB — is what the renderer has. */
  | { type: 'chat-config-value'; chatId: string; configId: string; value: string | boolean }
  /** A chat was removed. */
  | { type: 'chat-removed'; chatId: string }
  /** Permission queue changed; renderer shows the first element. */
  | { type: 'permissions'; requests: ACPPermissionRequest[] }
  /** Ask-user question queue changed; renderer shows the first element. */
  | { type: 'questions'; requests: ACPQuestionRequest[] }
  /** Terminal output for a pty tab. */
  | { type: 'terminal-data'; termId: string; data: string }
  /** A pty exited. */
  | { type: 'terminal-exit'; termId: string; exitCode: number }
  /** An application-menu item was chosen (shared/shortcuts.ts). The menu
   *  only shows the shortcuts; the keys themselves are the renderer's, so
   *  a shell in the terminal keeps its Ctrl+N. */
  | { type: 'menu'; command: MenuCommand }

// ---------------------------------------------------------------------------
// Renderer → main calls (all routed over one invoke channel)
// ---------------------------------------------------------------------------

export const INVOKE_CHANNEL = 'spettro:invoke'

export interface RendererApi {
  // Bootstrap / state
  getState(): Promise<AppStateDTO>
  getChat(chatId: string): Promise<ChatDetail | null>

  // Lifecycle
  retryBootstrap(): Promise<void>
  installCLI(): Promise<void>
  /** Stops an install in flight; setup goes back to its first screen. */
  cancelInstall(): Promise<void>
  useExplicitCLIPath(path: string): Promise<void>
  chooseProject(path: string): Promise<void>
  /** Sets the folder the next new session works in (and adds it to the
   *  recents) without creating a chat. */
  rememberProject(path: string): Promise<void>
  removeRecentProject(path: string): Promise<void>
  /** "Continue" in the home folder: don't warn about this folder again. */
  approveBroadFolder(path: string): Promise<void>
  /** "New project folder…": makes ~/Spettro Projects/<name> (numbered if
   *  taken), remembers it like a chosen folder, and resolves to its path. */
  createProjectFolder(name: string): Promise<string>
  /** Opens a native folder picker; resolves to the chosen path or null. */
  pickFolder(): Promise<string | null>
  /** Opens a native file picker for the CLI binary (NSOpenPanel port);
   *  resolves to the chosen path or null. */
  pickExecutable(): Promise<string | null>
  /** System / Light / Dark. Persisted, and applied to the whole window
   *  (and the terminal) live; the new value comes back in app-state. */
  setAppearance(mode: Appearance): Promise<void>
  /** Lilac or Monochrome. Persisted, and applied live (data-accent on <html>);
   *  the new value comes back in app-state. */
  setAccent(accent: Accent): Promise<void>
  /** Settings › General: a notification when a turn ends in the background. */
  setNotifyWhenDone(on: boolean): Promise<void>
  /** Settings' defaults (the permission level): applied to the selected
   *  chat's live session when there is one — the CLI keeps these settings
   *  for every session — and to what new chats start with either way. */
  setDefaultOption(configId: string, value: string | boolean): Promise<void>

  // Sessions
  newChat(projectPath?: string): Promise<string>
  openChat(chatId: string): Promise<void>
  closeChat(chatId: string): Promise<void>
  togglePin(chatId: string): Promise<void>
  toggleArchive(chatId: string): Promise<void>
  /** Blank titles are ignored. */
  renameChat(chatId: string, title: string): Promise<void>
  selectSession(chatId: string | null): Promise<void>
  /** Conversations the CLI keeps for this folder that no chat is linked to
   *  (started in the terminal, say). Empty when the agent can't list. */
  listCLISessions(projectPath: string): Promise<CLISessionEntry[]>
  /** Opens one of those as a new chat, replaying its transcript; resolves to
   *  the chat's id, or null when it couldn't be loaded. */
  importCLISession(sessionId: string, projectPath: string): Promise<string | null>

  // Prompting
  /** While the chat is busy this steers the running turn rather than
   *  starting another (the message's `steering` field tracks it).
   *  `mentions` are project-relative paths the user @-mentioned; each one
   *  still written in the text as `@<path>` goes to the agent as a file. */
  send(
    chatId: string,
    text: string,
    attachments: { data: string; mimeType: string }[],
    mentions?: string[]
  ): Promise<void>
  cancel(chatId: string): Promise<void>
  /** Sends the chat's newest prompt again (Try again after a failed turn);
   *  ignored while the chat is busy. */
  retryLast(chatId: string): Promise<void>

  // Config
  setSelectOption(chatId: string, configId: string, value: string): Promise<void>
  setBoolOption(chatId: string, configId: string, value: boolean): Promise<void>

  // Permissions / questions
  resolvePermission(requestId: string, optionId: string): Promise<void>
  dismissPermission(requestId: string): Promise<void>
  answerQuestion(requestId: string, answers: ACPQuestionAnswer[] | null): Promise<void>

  // Memory
  loadMemory(scope: 'user' | 'project', projectPath?: string): Promise<string>
  saveMemory(scope: 'user' | 'project', content: string, projectPath?: string): Promise<void>

  // Terminal drawer
  terminalCreate(projectPath: string): Promise<string>
  terminalWrite(termId: string, data: string): Promise<void>
  terminalResize(termId: string, cols: number, rows: number): Promise<void>
  terminalDispose(termId: string): Promise<void>
  terminalList(projectPath: string): Promise<string[]>
  /** True while something other than the shell itself runs in the tab
   *  (closing it would kill that). */
  terminalHasProcess(termId: string): Promise<boolean>

  // Remote host
  remoteSetEnabled(enabled: boolean): Promise<void>
  remoteOpenPairing(): Promise<void>
  remoteClosePairing(): Promise<void>
  remoteRevokeDevice(deviceId: string): Promise<void>
  remoteRenameHost(name: string): Promise<void>

  // Account / providers / models (the `_spettro/*` extension surface).
  // Every one of these refreshes AppStateDTO.extensions and pushes app-state,
  // so the renderer reads results from the store rather than return values.
  refreshExtensions(): Promise<void>
  /** "Continue without setting up a provider" — releases the needsProvider
   *  gate until the next launch. */
  skipProviderSetup(): Promise<void>
  accountLoginStart(): Promise<LoginStatus>
  accountLoginPoll(): Promise<LoginStatus>
  accountLoginCancel(): Promise<void>
  accountLogout(): Promise<void>
  providerConnect(id: string, apiKey: string, activate: boolean): Promise<ConnectResult>
  providerDisconnect(id: string): Promise<void>
  localEndpointProbe(endpoint: string, apiKey: string | null): Promise<LocalProbeResult>
  localEndpointAdd(endpoint: string, apiKey: string | null): Promise<void>
  localEndpointRemove(endpoint: string): Promise<void>
  modelSetFavorite(provider: string, model: string, favorite: boolean): Promise<void>

  // Workflows (`_spettro/workflow/*`, CLI extensions v4). Scoped by chat
  // because a workflow lives in the repo it automates and the chat is what
  // knows which repo. These return their result rather than pushing app-state:
  // the studio edits the files it reads, and a cached copy would go stale the
  // moment the TUI or the agent wrote one.
  workflowList(chatId: string): Promise<WorkflowList>
  workflowRead(chatId: string, name: string): Promise<WorkflowSource | null>
  workflowWrite(
    chatId: string,
    name: string,
    scope: WorkflowScope,
    script: string
  ): Promise<WorkflowInfo | null>
  workflowDelete(chatId: string, name: string, scope: WorkflowScope): Promise<boolean>
  workflowValidate(chatId: string, script: string): Promise<WorkflowValidation | null>
  workflowRuns(chatId: string): Promise<WorkflowRunInfo[]>
  /** Runs a saved workflow in a throwaway chat and returns that chat's id, so
   *  the studio can mirror its transcript without touching the sidebar. */
  workflowRun(chatId: string, name: string): Promise<string | null>
  /** Drops a scratch chat (cancelling anything still running in it). */
  workflowDiscardRun(scratchChatId: string): Promise<void>

  // Updates. The main process checks GitHub on a timer and pushes results in
  // AppStateDTO.update; these are the user-initiated versions.
  /** Re-checks both components now, ignoring the cached result. */
  checkForUpdates(): Promise<void>
  /** Downloads the release installer for this platform and hands off to it —
   *  the app quits once the installer is running. `whenIdle` holds the
   *  hand-off until no chat is working (Update when finished). */
  installAppUpdate(whenIdle?: boolean): Promise<void>
  /** Re-runs the official CLI install script, then reconnects the agent —
   *  after the running turns finish, with `whenIdle`. */
  installCLIUpdate(whenIdle?: boolean): Promise<void>

  // Misc
  openExternal(url: string): Promise<void>
  showItemInFolder(path: string): Promise<void>
  /** Uncommitted-change stats for the header's git chip (GitStatModel port). */
  gitStat(projectPath: string): Promise<GitStat>
  /** The folder's files, project-relative, for the composer's @-mentions:
   *  what git tracks or would track, else a capped walk. */
  listProjectFiles(projectPath: string): Promise<string[]>
}

export type RendererApiMethod = keyof RendererApi

/** The shape preload exposes on window.spettro. */
export interface SpettroBridge {
  call<M extends RendererApiMethod>(
    method: M,
    ...args: Parameters<RendererApi[M]>
  ): ReturnType<RendererApi[M]>
  /** Subscribes to main's events — only those of `types`, when given. Each
   *  event a listener receives is its own copy across the context bridge,
   *  so a listener that wants a few kinds should say which. */
  onEvent(listener: (event: MainEvent) => void, types?: readonly MainEvent['type'][]): () => void
  platform: NodeJS.Platform
  /** The accent this window was opened with, known before the first paint
   *  (main hands it over as a launch argument; app-state follows later). */
  accent: Accent
}

/** Reads a session-scoped config option snapshot value by id (helper). */
export function configValue(options: ACPConfigOption[], id: string): string | boolean | null {
  const opt = options.find((o) => o.id === id)
  if (!opt) return null
  return opt.kind.currentValue
}

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
import type { AppStateDTO, ChatDetail, TranscriptItem } from './model'

// ---------------------------------------------------------------------------
// Main → renderer push events
// ---------------------------------------------------------------------------

export const EVENT_CHANNEL = 'spettro:event'

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
      meta: Partial<Pick<ChatDetail, 'title' | 'isBusy' | 'configOptions' | 'commands' | 'plan' | 'usage' | 'acpSessionId' | 'isPinned' | 'isArchived'>>
    }
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
  useExplicitCLIPath(path: string): Promise<void>
  chooseProject(path: string): Promise<void>
  /** Opens a native folder picker; resolves to the chosen path or null. */
  pickFolder(): Promise<string | null>

  // Sessions
  newChat(projectPath?: string): Promise<string>
  openChat(chatId: string): Promise<void>
  closeChat(chatId: string): Promise<void>
  togglePin(chatId: string): Promise<void>
  toggleArchive(chatId: string): Promise<void>
  selectSession(chatId: string | null): Promise<void>

  // Prompting
  send(chatId: string, text: string, attachments: { data: string; mimeType: string }[]): Promise<void>
  cancel(chatId: string): Promise<void>

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

  // Remote host
  remoteSetEnabled(enabled: boolean): Promise<void>
  remoteOpenPairing(): Promise<void>
  remoteClosePairing(): Promise<void>
  remoteRevokeDevice(deviceId: string): Promise<void>
  remoteRenameHost(name: string): Promise<void>

  // Misc
  openExternal(url: string): Promise<void>
  showItemInFolder(path: string): Promise<void>
}

export type RendererApiMethod = keyof RendererApi

/** The shape preload exposes on window.spettro. */
export interface SpettroBridge {
  call<M extends RendererApiMethod>(
    method: M,
    ...args: Parameters<RendererApi[M]>
  ): ReturnType<RendererApi[M]>
  onEvent(listener: (event: MainEvent) => void): () => void
  platform: NodeJS.Platform
}

/** Reads a session-scoped config option snapshot value by id (helper). */
export function configValue(options: ACPConfigOption[], id: string): string | boolean | null {
  const opt = options.find((o) => o.id === id)
  if (!opt) return null
  return opt.kind.currentValue
}

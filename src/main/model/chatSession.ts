// One conversation with the agent — the port of Spettro/Model/ChatSession.swift
// (docs/11). Owns the transcript, the live ACP session id, the displayed
// config state, and the streaming flags.
//
// Unlike the SwiftUI original (an ObservableObject), every mutation here
// reports itself through two callbacks the AppModel installs:
//   onItem — a transcript item was appended or mutated (→ 'chat-item' upsert)
//   onMeta — chat-scoped metadata changed (→ 'chat-meta' patch)
// Nothing is batched or throttled: one mutation, one emission.

import { randomUUID } from 'crypto'
import { basename } from 'path'
import type {
  ACPCommand,
  ACPConfigOption,
  ACPPlanEntry,
  ACPToolCallEvent,
  ACPToolLocation,
  ACPToolStatus,
  ACPUsage,
  JSONValue
} from '../../shared/acp'
import type {
  ChatDetail,
  ChatMessage,
  ChatSummary,
  ImageAttachmentDTO,
  SteeringState,
  StoredSession,
  ToolCallItem,
  TranscriptItem,
  TurnSummary
} from '../../shared/model'
import { sameJSON } from './sameJSON'

/** The CLI's acknowledgement that a message sent mid-turn was queued for the
 *  running agent (bridge.go steerRunningTurn), and its report that the agent
 *  has read it (content.go, from llm_runtime.go's "steering delivered"
 *  comment). Both arrive as ordinary agent_message_chunks; the app turns them
 *  into state on the user's message instead of printing them. */
const STEERING_QUEUED = '→ steering queued'
const STEERING_DELIVERED = '✔ steering delivered'

/** The slash commands the CLI answers itself, without the model, in plain
 *  column-aligned text (internal/acp commands.go, commands_ext.go). `/plan
 *  <task>`, `/goal`, `/loop`, `/compact` and skills run the model and answer
 *  in markdown like any turn. */
const LOCAL_COMMANDS = new Set([
  'help',
  'mode',
  'next',
  'models',
  'model',
  'permission',
  'permissions',
  'budget',
  'thinking',
  'think',
  'memory',
  'stats',
  'tasks',
  'jobs',
  'hooks',
  'diff',
  'ultra',
  'ultracode',
  'workflows',
  'workflow',
  'workflow-size',
  'skills',
  'clear',
  'init',
  'approve'
])

/** The CLI's whole reply to `/clear` (internal/acp commands.go). */
const CLEARED_REPLY = 'conversation history cleared'

/** What the transcript says in its place. */
export const CONTEXT_CLEARED_TEXT = 'Context cleared. Spettro won’t remember the messages above.'

/** Whether `text` is one of those commands. The CLI matches the name in any
 *  case; `/workflows run …` (or `start`, or the singular) and `/plan <task>`
 *  are turns, bare `/plan` only switches the mode. */
export function isLocalCommand(text: string): boolean {
  const fields = text.trim().split(/\s+/)
  const name = /^\/(\S+)$/.exec(fields[0] ?? '')?.[1]?.toLowerCase()
  if (name === undefined) return false
  if (name === 'plan') return fields.length === 1
  if ((name === 'workflows' || name === 'workflow') && /^(?:run|start)$/i.test(fields[1] ?? '')) {
    return false
  }
  return LOCAL_COMMANDS.has(name)
}

/** The longest title a first prompt is made into (derivedTitle): about what
 *  the sidebar row and the header show before they ellipsize. */
const TITLE_MAX = 48

/** A single select or boolean config value, used for the local display state
 *  and for queuing changes made before a live session exists. */
export type ConfigValue = string | boolean

export type ChatMetaPatch = Partial<
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

/** Tool-call ids spettro numbers per turn (internal/acp/content.go
 *  nextToolCallID); see ChatSession.turnStart. */
const PER_TURN_TOOL_ID = /^(call|perm|compact)-(\d+)$/

const COMMA = Buffer.from(',')
const ITEMS_END = Buffer.from(']}')

export class ChatSession {
  readonly id: string
  readonly projectPath: string
  readonly createdAt: number

  /** The ACP session id, assigned once `session/new` succeeds. */
  acpSessionId: string | null = null
  title: string
  items: TranscriptItem[] = []
  configOptions: ACPConfigOption[] = []
  /** The running turn is one of the CLI's own slash commands: its reply is
   *  plain text (see isLocalCommand). */
  private commandTurn = false
  commands: ACPCommand[] = []
  isBusy = false
  /** True until the first prompt is sent. */
  isEmpty = true
  isPinned = false
  isArchived = false
  /** Live context-window occupancy, streamed by the agent during a turn. */
  usage: ACPUsage | null = null
  /** The agent's current plan (task list), when it publishes one. */
  plan: ACPPlanEntry[] = []
  /** A turn finished while the user was looking at another chat. Drives the
   *  sidebar's "finished while you were away" dot; cleared the moment the
   *  chat is opened. Live-only: a relaunch starts with nothing unread. */
  unread = false
  /** How the latest turn ended and what it cost; live-only. */
  lastTurn: TurnSummary | null = null
  /** Every turn's tokens added up. Persisted, so it survives a relaunch the
   *  way the conversation does. */
  sessionTokens = 0
  /** True while `session/load` replays this conversation into it — the only
   *  time a user_message_chunk is the agent's to send. */
  isReplaying = false

  /** Changes the user made while this chat had no live ACP session yet;
   *  AppModel replays them onto the session as soon as one attaches. */
  pendingConfigChanges: Record<string, ConfigValue> = {}

  /** Chunks of a re-delivered previous answer already suppressed (see
   *  appendAssistant); reset whenever a genuinely new message starts. */
  private replayTail = ''

  /**
   * spettro numbers a turn's tool calls from 1 again every prompt (`call-1`,
   * `perm-1`, `compact-1` — internal/acp/content.go nextToolCallID keeps the
   * counter on the turn), so those ids are only unique within their turn.
   * Matched across the whole chat, the second turn's `call-1` would land on
   * the first turn's card: overwriting it in the transcript, and taking an
   * approval to the wrong card. So they are matched only within the current
   * turn (from `turnStart`), and a new call whose id an earlier turn already
   * used is filed under a fresh one (`call-1~2`); `turnIds` maps this turn's
   * wire ids to the ids they were filed under. Workflow cards keep their ids
   * across turns on purpose (a run updates its card after the turn ends) and
   * are matched chat-wide as before.
   */
  private turnStart = 0
  private turnIds = new Map<string, string>()
  /** The highest number a per-turn id has started with since turnStart:
   *  one turn's counter only goes up (see noteTurnSeq). */
  private turnSeq = 0

  onItem: ((session: ChatSession, item: TranscriptItem) => void) | null = null
  onMeta: ((session: ChatSession, meta: ChatMetaPatch) => void) | null = null
  /** One option's value changed in place (applyLocalConfigValue). Without a
   *  listener here the change goes out as the whole set, through onMeta. */
  onConfigValue: ((session: ChatSession, configId: string, value: ConfigValue) => void) | null = null

  /**
   * A throwaway chat the studio runs a workflow in.
   *
   * It is a full ChatSession — it gets an ACP session, streams items, and
   * renders through the same transcript fold — but it is kept out of the
   * sidebar and off disk. Testing a script you are still editing means running
   * it repeatedly and mostly discarding the result; that belongs beside the
   * editor, not filed among the user's conversations.
   */
  isScratch = false

  constructor(projectPath: string, title?: string, id?: string, createdAt?: number) {
    this.id = id ?? randomUUID()
    this.projectPath = projectPath
    this.createdAt = createdAt ?? Date.now()
    this.title = title ?? basename(projectPath)
  }

  /** True for a chat that has never received a prompt (and never failed to
   *  connect) — not a conversation, so AppModel doesn't persist it. */
  /** An untouched chat, which is never written to disk.
   *
   *  Emptiness alone decides this. The macOS app also required
   *  `acpSessionId == nil`, but there a session was only ever attached by the
   *  first prompt; here chats are warmed on open so their config chips show
   *  the session's real options, which would otherwise make every glanced-at
   *  chat persist itself. */
  get isPristine(): boolean {
    return this.isEmpty
  }

  get projectName(): string {
    return basename(this.projectPath)
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  /** Rebuilds a session from its on-disk snapshot. The result is "cold": it
   *  carries the display transcript but no live ACP session yet. `commands`
   *  seeds the slash palette until the agent announces its own. */
  static restore(stored: StoredSession, commands: ACPCommand[] = []): ChatSession {
    const session = new ChatSession(stored.projectPath, stored.title, stored.id, stored.createdAt)
    session.acpSessionId = stored.acpSessionId ?? null
    session.isPinned = stored.isPinned === true
    session.isArchived = stored.isArchived === true
    // A malformed item is dropped rather than allowed to throw: one bad entry
    // must not cost the user every saved chat at launch.
    session.items = Array.isArray(stored.items)
      ? structuredClone(stored.items).filter(upgradeStoredItem)
      : []
    session.isEmpty = session.items.length === 0
    session.commands = commands
    if (typeof stored.sessionTokens === 'number' && Number.isFinite(stored.sessionTokens)) {
      session.sessionTokens = Math.max(0, stored.sessionTokens)
    }
    session.configOptions = Array.isArray(stored.configOptions)
      ? structuredClone(stored.configOptions)
      : []
    if (stored.pendingConfigChanges && typeof stored.pendingConfigChanges === 'object') {
      for (const [key, value] of Object.entries(stored.pendingConfigChanges)) {
        if (typeof value === 'string' || typeof value === 'boolean') {
          session.pendingConfigChanges[key] = value
        }
      }
    }
    return session
  }

  /** A codable snapshot of this session for persistence. Live-only state
   *  (isBusy, streaming flags, usage, plan, replayTail) is not persisted. */
  snapshot(): StoredSession {
    const pending: Record<string, JSONValue> = { ...this.pendingConfigChanges }
    return {
      id: this.id,
      acpSessionId: this.acpSessionId,
      projectPath: this.projectPath,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      isPinned: this.isPinned,
      isArchived: this.isArchived,
      items: structuredClone(this.items),
      configOptions: structuredClone(this.configOptions),
      pendingConfigChanges: pending,
      sessionTokens: this.sessionTokens
    }
  }

  /** This session as stored JSON (what snapshot() would serialise), in
   *  UTF-8 pieces for SessionStore.saveParts. Each transcript item's JSON is
   *  kept until the item changes — every change goes through emitItem — so
   *  saving a long chat re-encodes only what moved since the last save. */
  persistParts(): Buffer[] {
    const head = JSON.stringify({
      id: this.id,
      acpSessionId: this.acpSessionId,
      projectPath: this.projectPath,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      isPinned: this.isPinned,
      isArchived: this.isArchived,
      configOptions: this.configOptions,
      pendingConfigChanges: this.pendingConfigChanges,
      sessionTokens: this.sessionTokens
    } satisfies Omit<StoredSession, 'items'>)
    const parts: Buffer[] = [Buffer.from(`${head.slice(0, -1)},"items":[`, 'utf8')]
    this.items.forEach((item, i) => {
      let json = this.storedItems.get(item)
      if (!json) {
        json = Buffer.from(JSON.stringify(item), 'utf8')
        this.storedItems.set(item, json)
      }
      if (i > 0) parts.push(COMMA)
      parts.push(json)
    })
    parts.push(ITEMS_END)
    return parts
  }

  /** Gives items with no stored JSON yet theirs, until `deadline`
   *  (performance.now()); true once every item has it. The first save after
   *  launch is every item of every chat: encoded in slices like this, it
   *  never holds the main thread (and with it the window) in one piece. */
  encodeStoredItems(deadline: number): boolean {
    for (const item of this.items) {
      if (this.storedItems.has(item)) continue
      this.storedItems.set(item, Buffer.from(JSON.stringify(item), 'utf8'))
      if (performance.now() >= deadline) return false
    }
    return true
  }

  /** Each item's stored JSON, dropped when the item changes (emitItem). */
  private storedItems = new WeakMap<TranscriptItem, Buffer>()

  /** The bubbles still streaming, oldest first. Only pushStreamingMessage
   *  starts one (a restored item never is), so closing them is a walk over
   *  these instead of the whole transcript on every answer chunk. */
  private streaming = new Set<TranscriptItem>()

  /** When the conversation last moved: the newest message or tool call.
   *  Notices don't count — the app adds those on its own (e.g. "Couldn't
   *  restore this chat's earlier context" when a chat is merely opened), and
   *  the sidebar sorts by this, so counting them would make an old chat jump
   *  to the top, as "now", just for being clicked. */
  get updatedAt(): number {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i]
      if (item.kind === 'tool') return item.tool.timestamp
      if (item.message.role !== 'notice') return item.message.timestamp
    }
    return this.createdAt
  }

  // -------------------------------------------------------------------------
  // Projections
  // -------------------------------------------------------------------------

  summary(): ChatSummary {
    return {
      id: this.id,
      title: this.title,
      projectPath: this.projectPath,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      isPinned: this.isPinned,
      isArchived: this.isArchived,
      isBusy: this.isBusy,
      messageCount: this.items.length,
      preview: this.previewText(),
      unread: this.unread
    }
  }

  detail(): ChatDetail {
    return {
      id: this.id,
      title: this.title,
      projectPath: this.projectPath,
      acpSessionId: this.acpSessionId,
      isPinned: this.isPinned,
      isArchived: this.isArchived,
      isBusy: this.isBusy,
      createdAt: this.createdAt,
      // Not copied: every consumer serialises it on the spot (IPC, the
      // remote wire), and a deep copy of a long transcript costs as much
      // as sending it.
      items: this.items,
      configOptions: this.configOptions,
      commands: this.commands,
      plan: this.plan,
      usage: this.usage,
      lastTurn: this.lastTurn ? { ...this.lastTurn } : null,
      sessionTokens: this.sessionTokens
    }
  }

  /** Walk back to the newest message worth showing — a tool call's title says
   *  far less about a conversation than the message around it. */
  private previewText(): string {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i]
      if (item.kind !== 'message') continue
      const trimmed = item.message.text.trim()
      if (trimmed === '') continue
      const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? trimmed
      return firstLine.slice(0, 120)
    }
    return ''
  }

  // -------------------------------------------------------------------------
  // Emission helpers
  // -------------------------------------------------------------------------

  private emitItem(item: TranscriptItem): void {
    this.storedItems.delete(item)
    this.onItem?.(this, item)
  }

  private emitMeta(meta: ChatMetaPatch): void {
    this.onMeta?.(this, meta)
  }

  // -------------------------------------------------------------------------
  // Metadata setters (each one emits the matching chat-meta patch)
  // -------------------------------------------------------------------------

  setBusy(value: boolean): void {
    // A slash command's reply ends with its turn: anything the agent says
    // after that (a background run finishing) is its own, in markdown.
    if (!value) this.commandTurn = false
    if (this.isBusy === value) return
    this.isBusy = value
    this.emitMeta({ isBusy: value })
  }

  setAcpSessionId(value: string | null): void {
    this.acpSessionId = value
    this.emitMeta({ acpSessionId: value })
  }

  setConfigOptions(options: ACPConfigOption[]): void {
    // The CLI answers every change, and tells every other live session too,
    // with the whole option set — the model catalog included. When that is
    // what this chat already shows (a slider stop applied optimistically,
    // another chat's change already spread here), there is nothing to say.
    const unchanged = sameJSON(this.configOptions, options)
    this.configOptions = options
    if (!unchanged) this.emitMeta({ configOptions: options })
  }

  setCommands(commands: ACPCommand[]): void {
    this.commands = commands
    this.emitMeta({ commands })
  }

  setPlan(entries: ACPPlanEntry[]): void {
    this.plan = entries
    this.emitMeta({ plan: entries })
  }

  setUsage(usage: ACPUsage | null): void {
    this.usage = usage
    this.emitMeta({ usage })
  }

  /** Files a finished turn: what it ended with and what it cost, added to
   *  the session's running total. */
  recordTurn(turn: TurnSummary): void {
    this.lastTurn = turn
    this.sessionTokens += Math.max(0, turn.totalTokens)
    this.emitMeta({ lastTurn: { ...turn }, sessionTokens: this.sessionTokens })
  }

  /** A user-chosen title. Blank input is refused rather than stored, so a
   *  chat can never end up nameless in the sidebar. Returns whether the title
   *  changed. */
  rename(title: string): boolean {
    const next = title.replace(/\s+/g, ' ').trim().slice(0, 120)
    if (next === '' || next === this.title) return false
    this.title = next
    this.emitMeta({ title: next })
    return true
  }

  setPinned(value: boolean): void {
    this.isPinned = value
    this.emitMeta({ isPinned: value })
  }

  setArchived(value: boolean): void {
    this.isArchived = value
    this.emitMeta({ isArchived: value })
  }

  // -------------------------------------------------------------------------
  // Config state
  // -------------------------------------------------------------------------

  /** Updates the displayed value of one option without a round-trip, so the
   *  UI reflects the user's choice instantly (the agent is synced separately). */
  applyLocalConfigValue(id: string, value: ConfigValue): void {
    const option = this.configOptions.find((o) => o.id === id)
    if (!option) return
    if (option.kind.type === 'select' && typeof value === 'string') {
      option.kind.currentValue = value
    } else if (option.kind.type === 'boolean' && typeof value === 'boolean') {
      option.kind.currentValue = value
    } else {
      return
    }
    if (this.onConfigValue) this.onConfigValue(this, id, value)
    else this.emitMeta({ configOptions: this.configOptions })
  }

  /** The current value of every displayed option, used to reconcile a newly
   *  attached live session with what the user was shown. */
  displayedConfigValues(): Record<string, ConfigValue> {
    const values: Record<string, ConfigValue> = {}
    for (const option of this.configOptions) {
      if (option.kind.type === 'select') {
        const current = option.kind.currentValue
        if (current !== null && current !== '') values[option.id] = current
      } else {
        values[option.id] = option.kind.currentValue
      }
    }
    return values
  }

  // -------------------------------------------------------------------------
  // Transcript mutation
  // -------------------------------------------------------------------------

  /** `steering` marks a message sent while a turn was running (see
   *  SteeringState). Returns the message, whose id the caller needs to track
   *  that state. */
  appendUserMessage(
    text: string,
    attachments: ImageAttachmentDTO[] = [],
    steering?: SteeringState,
    mentions: string[] = []
  ): ChatMessage {
    const message: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      text,
      attachments,
      isStreaming: false,
      timestamp: Date.now()
    }
    if (mentions.length > 0) message.mentions = mentions
    if (steering !== undefined) message.steering = steering
    else {
      // A message that isn't steering starts a turn: the agent's tool-call
      // numbering starts over with it (see turnStart).
      this.beginTurn()
      this.commandTurn = isLocalCommand(text)
    }
    const item: TranscriptItem = { kind: 'message', message }
    this.items.push(item)
    this.isEmpty = false
    this.emitItem(item)
    // Derive the chat title from the first prompt (replacing the project-name
    // placeholder), "Image" for an attachment-only prompt.
    if (this.title === this.projectName || this.title === '') {
      const titleSource = text === '' ? 'Image' : text
      this.title = ChatSession.derivedTitle(titleSource)
      this.emitMeta({ title: this.title })
    }
    return message
  }

  /** A user message `session/load` replays. spettro sends each stored
   *  message as one chunk (sessions.go LoadSession), so every chunk is a
   *  message of its own; whatever the agent was saying before it is over. */
  appendReplayedUserMessage(text: string): void {
    if (text.trim() === '') return
    this.endStreaming()
    this.appendUserMessage(text.trim())
  }

  messageById(messageId: string): ChatMessage | null {
    for (const item of this.items) {
      if (item.kind === 'message' && item.message.id === messageId) return item.message
    }
    return null
  }

  /** Moves a mid-turn message along (or, with `undefined`, drops the state,
   *  for a steer that failed to send). */
  setSteering(messageId: string, state: SteeringState | undefined): void {
    for (const item of this.items) {
      if (item.kind !== 'message' || item.message.id !== messageId) continue
      if (item.message.steering === state) return
      if (state === undefined) delete item.message.steering
      else item.message.steering = state
      this.emitItem(item)
      return
    }
  }

  /** Drops the state of every steer still waiting: once no turn is running,
   *  nothing is going to read them, and they are plain messages. */
  clearPendingSteering(): void {
    for (const item of this.items) {
      if (item.kind !== 'message') continue
      const state = item.message.steering
      if (state === 'sending' || state === 'queued') this.setSteering(item.message.id, undefined)
    }
  }

  /** The id of a user message in the given steering state — the newest, or
   *  with `oldest`, the first — or null. */
  steeringMessage(state: SteeringState, oldest = false): string | null {
    const found = (item: TranscriptItem): boolean =>
      item.kind === 'message' && item.message.role === 'user' && item.message.steering === state
    const item = oldest ? this.items.find(found) : this.items.findLast(found)
    return item?.kind === 'message' ? item.message.id : null
  }

  /** `endsTurn` marks the error a turn ended on (see ChatMessage.endsTurn). */
  /** `detail` is the raw error behind an error notice's sentence, for its
   *  "Show details" (left off when it would only repeat the text). */
  appendNotice(text: string, isError: boolean, endsTurn = false, detail?: string): void {
    const message: ChatMessage = {
      id: randomUUID(),
      role: 'notice',
      noticeIsError: isError,
      text,
      attachments: [],
      isStreaming: false,
      timestamp: Date.now()
    }
    if (isError && endsTurn) message.endsTurn = true
    if (isError && detail && detail.trim() !== '' && !text.includes(detail.trim())) {
      message.detail = detail.trim()
    }
    const item: TranscriptItem = { kind: 'message', message }
    this.items.push(item)
    this.emitItem(item)
  }

  /** Appends to (or starts) the current streaming reasoning bubble. */
  appendReasoning(delta: string): void {
    const last = this.items[this.items.length - 1]
    const now = Date.now()
    if (last && last.kind === 'message' && last.message.role === 'reasoning' && last.message.isStreaming) {
      last.message.text += delta
      last.message.endedAt = now
      this.emitItem(last)
      return
    }
    this.pushStreamingMessage('reasoning', delta, now)
  }

  /** Appends to (or starts) the current streaming assistant answer bubble.
   *  Guards against duplicate delivery: the CLI re-sends the turn's final
   *  answer in situations like a degraded resume, and blindly appending
   *  every chunk would duplicate the last message across relaunches. */
  appendAssistant(delta: string): void {
    // The CLI's steering acknowledgements are state, not prose.
    if (this.absorbSteeringNotice(delta)) return
    this.endReasoningStream()
    const last = this.items[this.items.length - 1]
    if (last && last.kind === 'message' && last.message.role === 'assistant') {
      const message = last.message
      if (message.isStreaming) {
        message.text += delta
        this.emitItem(last)
        return
      }
      // A finished bubble with identical text is a re-delivery — drop it.
      if (message.text === delta) return
      // A finished bubble that is a strict prefix of the new chunk is a
      // re-send of a longer final answer — replace instead of duplicating.
      if (delta.startsWith(message.text)) {
        message.text = delta
        this.emitItem(last)
        return
      }
      // A re-delivery of the previous turn's answer split across several
      // chunks: suppress chunks while they keep re-stating the tail of the
      // last finished bubble. `replayTail` accumulates what was suppressed,
      // so the whole replay is dropped chunk by chunk instead of becoming
      // a duplicated bubble.
      const candidate = this.replayTail + delta
      if (message.text.endsWith(candidate)) {
        this.replayTail = candidate
        return
      }
    }
    this.replayTail = ''
    this.pushStreamingMessage('assistant', delta)
  }

  /** Turns a steering acknowledgement into the state of the message it is
   *  about; true when `delta` was one. Both go to the oldest message in the
   *  earlier state: the CLI answers steers in the order they were sent, and
   *  the agent reads them in that order too. An acknowledgement with no
   *  message to apply to is dropped all the same. */
  private absorbSteeringNotice(delta: string): boolean {
    const text = delta.trim()
    if (text.startsWith(STEERING_QUEUED)) {
      const id = this.steeringMessage('sending', true)
      if (id) this.setSteering(id, 'queued')
      return true
    }
    if (text.startsWith(STEERING_DELIVERED)) {
      const id = this.steeringMessage('queued', true) ?? this.steeringMessage('sending', true)
      if (id) this.setSteering(id, 'delivered')
      return true
    }
    return false
  }

  private pushStreamingMessage(
    role: 'assistant' | 'reasoning',
    text: string,
    now = Date.now()
  ): void {
    const message: ChatMessage = {
      id: randomUUID(),
      role,
      text,
      attachments: [],
      isStreaming: true,
      timestamp: now
    }
    // The span a reasoning bubble covers, first chunk to latest: "Thought
    // for Ns" once it closes. Time spent before the first chunk isn't the
    // model's thinking we can see, so it doesn't count.
    if (role === 'reasoning') {
      message.startedAt = now
      message.endedAt = now
    }
    if (role === 'assistant' && this.commandTurn) message.plain = true
    const item: TranscriptItem = { kind: 'message', message }
    this.items.push(item)
    this.streaming.add(item)
    this.emitItem(item)
  }

  /** Upsert keyed on the ACP toolCallId: merge in place when known (each
   *  field applied only if present in this event), append when new. */
  applyToolEvent(event: ACPToolCallEvent, isStart: boolean): void {
    const combinedOutput = event.texts.join('\n')
    const diffs = event.diffs.map((d) => ({
      path: d.path,
      oldText: d.oldText,
      newText: d.newText
    }))
    const argsJSON = encodeArgs(event.rawInput)
    const locations = event.locations.map((l) => ({ ...l }))
    const images = event.images.map((i) => ({ ...i }))

    if (isStart) this.noteTurnSeq(event.toolCallId)
    const existing = this.turnTool(event.toolCallId)
    if (existing) {
      const tool = existing.tool
      if (event.title !== undefined) tool.title = event.title
      if (event.kind !== undefined) tool.kind = event.kind
      if (event.status !== undefined) tool.status = event.status
      // Only when non-empty, so a contentless update doesn't wipe earlier output.
      if (combinedOutput !== '') tool.output = combinedOutput
      if (diffs.length > 0) tool.diffs = diffs
      if (locations.length > 0) tool.locations = locations
      if (images.length > 0) tool.images = images
      if (event.rawOutput !== undefined) tool.rawOutput = event.rawOutput
      if (argsJSON !== undefined) tool.argsJSON = argsJSON
      if (event.workflowMeta !== undefined) tool.workflow = structuredClone(event.workflowMeta)
      this.emitItem(existing)
      return
    }

    const status: ACPToolStatus = event.status ?? (isStart ? 'in_progress' : 'completed')
    const tool: ToolCallItem = {
      id: this.fileToolId(event.toolCallId),
      title: event.title ?? 'Tool call',
      status,
      output: combinedOutput,
      diffs,
      locations,
      timestamp: Date.now()
    }
    if (event.kind !== undefined) tool.kind = event.kind
    if (images.length > 0) tool.images = images
    if (event.rawOutput !== undefined) tool.rawOutput = event.rawOutput
    if (argsJSON !== undefined) tool.argsJSON = argsJSON
    if (event.workflowMeta !== undefined) tool.workflow = structuredClone(event.workflowMeta)
    // A call after some prose means that prose is done: the agent said its
    // piece and moved on. Left streaming, an interim "Let me look at…" kept
    // its typing dots (and no Copy) for the rest of the chat — saved that
    // way, even across relaunches.
    this.endOpenBubbles()
    const item: TranscriptItem = { kind: 'tool', tool }
    this.items.push(item)
    this.emitItem(item)
  }

  /** The card a tool call id names: a wire id of this turn's (see
   *  turnStart), or the id a card was filed under. */
  toolById(toolCallId: string): ToolCallItem | null {
    return this.turnTool(toolCallId)?.tool ?? null
  }

  /** Whether any message here went to the model — not just the CLI's own
   *  slash commands, which leave the agent nothing to remember. */
  hasModelTurns(): boolean {
    return this.items.some(
      (item) =>
        item.kind === 'message' && item.message.role === 'user' && !isLocalCommand(item.message.text)
    )
  }

  /** Marks a card the user turned down in its approval (ToolCallItem.denied). */
  markDenied(toolCallId: string): void {
    const item = this.turnTool(toolCallId)
    if (!item || item.tool.denied) return
    item.tool.denied = true
    this.emitItem(item)
  }

  /** Sets one card's status; returns the status it had, or null when there
   *  is no such card. */
  setToolStatus(toolCallId: string, status: ACPToolStatus): ACPToolStatus | null {
    const item = this.turnTool(toolCallId)
    if (!item) return null
    const previous = item.tool.status
    if (previous !== status) {
      item.tool.status = status
      this.emitItem(item)
    }
    return previous
  }

  private beginTurn(): void {
    // Set again by appendUserMessage when the turn is a slash command; a
    // turn started any other way (a steer running as its own) is the model's.
    this.commandTurn = false
    this.turnStart = this.items.length
    this.turnIds.clear()
    this.turnSeq = 0
  }

  /**
   * Starts a turn where the agent's numbering says one started without a
   * message from here to mark it. Within a turn spettro's counter only goes
   * up, shared by every prefix (call-3 follows perm-2), and each new call
   * takes the next number; so a call starting at or below a number this
   * turn already used belongs to a new turn. That happens when a steer
   * reaches the CLI just after the turn it meant to steer ended: it runs as
   * a turn of its own (AppModel.runTurn), and its call-1 must not land on
   * the finished turn's call-1.
   */
  private noteTurnSeq(toolCallId: string): void {
    const m = PER_TURN_TOOL_ID.exec(toolCallId)
    if (!m) return
    const seq = Number(m[2])
    if (seq <= this.turnSeq) this.beginTurn()
    this.turnSeq = seq
  }

  /** The card for `toolCallId` — this turn's only, for an id the agent
   *  numbers per turn (see turnStart). */
  private turnTool(toolCallId: string): Extract<TranscriptItem, { kind: 'tool' }> | null {
    const filed = this.turnIds.get(toolCallId)
    const perTurn = filed === undefined && PER_TURN_TOOL_ID.test(toolCallId)
    const id = filed ?? toolCallId
    for (let i = this.items.length - 1; i >= (perTurn ? this.turnStart : 0); i--) {
      const item = this.items[i]
      if (item.kind === 'tool' && item.tool.id === id) return item
    }
    return null
  }

  /** The id a new card is filed under: the agent's own, unless an earlier
   *  turn's card already has it. */
  private fileToolId(toolCallId: string): string {
    const taken = (id: string): boolean =>
      this.items.some((item) => item.kind === 'tool' && item.tool.id === id)
    let id = toolCallId
    for (let n = 2; taken(id); n++) id = `${toolCallId}~${n}`
    if (PER_TURN_TOOL_ID.test(toolCallId)) this.turnIds.set(toolCallId, id)
    return id
  }

  /** At the end of a `/clear` turn, the CLI's reply ("conversation history
   *  cleared", in monospace like any of its commands) becomes a divider
   *  saying what it means: everything above is still on screen, but the
   *  agent no longer has it (ChatMessage.contextCleared). */
  markContextCleared(): void {
    const opener = this.items[this.turnStart]
    if (opener?.kind !== 'message' || opener.message.role !== 'user') return
    if (opener.message.text.trim().split(/\s+/)[0]?.toLowerCase() !== '/clear') return
    for (const item of this.items.slice(this.turnStart + 1)) {
      if (item.kind !== 'message' || item.message.role !== 'assistant') continue
      if (item.message.text.trim() !== CLEARED_REPLY) continue
      const message = item.message
      message.role = 'notice'
      message.noticeIsError = false
      message.contextCleared = true
      message.text = CONTEXT_CLEARED_TEXT
      delete message.plain
      this.emitItem(item)
    }
  }

  /** Marks the current streamed bubbles as finished at turn's end. */
  endStreaming(): void {
    this.endOpenBubbles()
  }

  /** Flips every streaming bubble — answer or reasoning — to finished. */
  private endOpenBubbles(): void {
    for (const item of this.streaming) {
      this.streaming.delete(item)
      if (item.kind === 'message' && item.message.isStreaming) {
        item.message.isStreaming = false
        this.emitItem(item)
      }
    }
  }

  /** Flips every streaming reasoning bubble to finished, so a turn's
   *  reasoning phase closes the moment the first answer chunk arrives. */
  private endReasoningStream(): void {
    if (this.streaming.size === 0) return
    for (const item of this.streaming) {
      if (item.kind !== 'message' || item.message.role !== 'reasoning') continue
      this.streaming.delete(item)
      if (item.message.isStreaming) {
        item.message.isStreaming = false
        this.emitItem(item)
      }
    }
  }

  /** A title from the first prompt: its first line, or just its first
   *  sentence when that is long, and otherwise cut at a word with an
   *  ellipsis — never mid-word, as if the cut were the title. Not at a
   *  comma: "Before doing anything, ask me…" would title the chat "Before
   *  doing anything". */
  static derivedTitle(text: string): string {
    const firstLine = (text.trim().split(/\r?\n/, 1)[0] ?? '').replace(/\s+/g, ' ').trim()
    if (firstLine.length <= TITLE_MAX) return firstLine
    const sentence = /^(.{12,}?)[.!?](?:\s|$)/.exec(firstLine)?.[1]
    if (sentence !== undefined && sentence.length <= TITLE_MAX) return sentence
    const cut = firstLine.slice(0, TITLE_MAX)
    const space = cut.lastIndexOf(' ')
    return `${(space >= TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, '')}…`
  }
}

/** Brings an item saved by an older build up to the current shape, in place:
 *  tool locations were bare paths before line numbers were kept, and a
 *  steering state or a stream saved mid-turn means nothing once the turn is
 *  gone. False
 *  for an item too malformed to show. */
function upgradeStoredItem(item: TranscriptItem): boolean {
  if (typeof item !== 'object' || item === null) return false
  if (item.kind === 'tool') {
    if (typeof item.tool !== 'object' || item.tool === null) return false
    const raw = Array.isArray(item.tool.locations) ? (item.tool.locations as unknown[]) : []
    item.tool.locations = raw
      .map((loc): ACPToolLocation | null => {
        if (typeof loc === 'string') return { path: loc }
        const path = (loc as Partial<ACPToolLocation> | null)?.path
        if (typeof path === 'string') return loc as ACPToolLocation
        return null
      })
      .filter((loc): loc is ACPToolLocation => loc !== null)
    return true
  }
  if (item.kind !== 'message' || typeof item.message !== 'object' || item.message === null) {
    return false
  }
  if (item.message.steering !== undefined && item.message.steering !== 'delivered') {
    delete item.message.steering
  }
  // Nothing saved is still arriving: a bubble stored mid-stream (or by a
  // build that never closed interim prose) would otherwise show typing dots,
  // or "Thinking…", forever.
  item.message.isStreaming = false
  return true
}

/** The full ACP rawInput re-encoded as JSON — the reliable argument source
 *  (mirrors JSONValue.encodedJSONString: objects encode, strings pass
 *  through, everything else is dropped). */
function encodeArgs(raw: JSONValue | undefined): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'string') return raw
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    try {
      return JSON.stringify(raw)
    } catch {
      return undefined
    }
  }
  return undefined
}

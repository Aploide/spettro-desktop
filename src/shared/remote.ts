// Spettro Remote wire types — port of RemoteProtocol.swift.
//
// This is the protocol an iPhone/iPad speaks to a host driving the CLI. The
// Swift host (spettro-apple/Platforms/macOS/Core/Remote/*) is the reference
// implementation and the shipped iOS client decodes every payload with Swift's
// synthesized Codable, so the shapes below are byte-for-byte what that decoder
// expects:
//
//   * Dates travel as RFC3339/ISO-8601 strings WITHOUT fractional seconds
//     ("2026-08-01T10:00:00Z") — Swift's `.iso8601` strategy rejects
//     fractional seconds outright, so `rfc3339()` below strips them.
//   * `StoredItem` is a Swift enum with an unlabeled associated value, which
//     synthesizes to `{"message":{"_0":{...}}}` / `{"tool":{"_0":{...}}}` on
//     the wire (SE-0295). Doc 34 §5 spells it `{"message":{...}}` as
//     shorthand; the `_0` level is real and load-bearing.
//   * `ACPConfigOption.Kind` is a Swift enum with labeled associated values:
//     `{"kind":{"select":{"current":…,"groups":[…]}}}` or
//     `{"kind":{"boolean":{"current":…}}}`.
//   * Swift omits `nil` optionals — optional fields below are omitted, never
//     `null`, when absent.
//   * UUID-valued fields (chat ids, message ids) must be UUID strings; the
//     client decodes them as `UUID` and re-encodes them UPPERCASE in its own
//     requests, so hosts must match chat ids case-insensitively.

import type { ACPCommand, ACPConfigOption, ACPPlanEntry, ACPUsage, JSONValue } from './acp'
import type { ChatSummary, StoredSession, TranscriptItem } from './model'

// ---------------------------------------------------------------------------
// Versioning / discovery
// ---------------------------------------------------------------------------

/** Bumped when the wire surface changes incompatibly. */
export const REMOTE_PROTOCOL_VERSION = 1

/** Bonjour service type ("_spettro-remote._tcp" on the wire; bonjour-service
 *  takes it without the underscore/protocol decoration). */
export const REMOTE_BONJOUR_TYPE = 'spettro-remote'
export const REMOTE_BONJOUR_FULL_TYPE = '_spettro-remote._tcp'

/** TXT record keys on the Bonjour advertisement. `hostid` is the one a paired
 *  client matches on, independent of address, name, or port. */
export const RemoteTXTKey = {
  hostID: 'hostid',
  hostName: 'name',
  hostKind: 'kind',
  protocolVersion: 'v'
} as const

/** Preferred listen port. Deliberately not 7878 (the CLI's HTTP /remote). */
export const REMOTE_PREFERRED_PORT = 7879

/** Key length (bytes) for both the pairing secret and the durable device key. */
export const REMOTE_KEY_LENGTH = 32

/** How long a pairing window stays open (5 minutes). */
export const PAIRING_WINDOW_MS = 5 * 60 * 1000

/** URL scheme of the pairing QR payload. */
export const PAIRING_URL_SCHEME = 'spettro-pair'

export type RemoteHostKind = 'app' | 'tui'

// ---------------------------------------------------------------------------
// Method names (RemoteMethod in RemoteProtocol.swift)
// ---------------------------------------------------------------------------

export const RemoteMethod = {
  // Handshake.
  hello: '_spettro/remote/hello',
  auth: '_spettro/remote/auth',

  // Chats.
  chatsList: '_spettro/remote/chats/list',
  chatOpen: '_spettro/remote/chats/open',
  chatClose: '_spettro/remote/chats/close',
  chatNew: '_spettro/remote/chats/new',
  chatDelete: '_spettro/remote/chats/delete',
  chatFlag: '_spettro/remote/chats/flag',

  // Driving a turn.
  chatPrompt: '_spettro/remote/chats/prompt',
  chatCancel: '_spettro/remote/chats/cancel',
  chatConfig: '_spettro/remote/chats/config',

  // Host → client notifications.
  chatUpdate: '_spettro/remote/chat/update',
  chatUserMessage: '_spettro/remote/chat/user',
  chatState: '_spettro/remote/chat/state',
  chatRemoved: '_spettro/remote/chat/removed',
  hostState: '_spettro/remote/host/state',

  // Blocking prompts.
  permissionAsk: '_spettro/remote/permission/ask',
  permissionReply: '_spettro/remote/permission/reply',
  permissionResolved: '_spettro/remote/permission/resolved',
  questionAsk: '_spettro/remote/question/ask',
  questionReply: '_spettro/remote/question/reply',
  questionResolved: '_spettro/remote/question/resolved',

  // Agent passthrough.
  agentCall: '_spettro/remote/agent/call',
  agentNotification: '_spettro/remote/agent/notification',

  // Projects.
  projectsList: '_spettro/remote/projects/list'
} as const

export type RemoteMethodName = (typeof RemoteMethod)[keyof typeof RemoteMethod]

// ---------------------------------------------------------------------------
// Auth error codes (RemoteAuthError)
// ---------------------------------------------------------------------------

export const RemoteAuthError = {
  /** This device is not paired and the host is not showing a QR. */
  notPaired: -33001,
  /** The proof did not verify — wrong key, or a stale QR. */
  badProof: -33002,
  /** The QR's pairing window closed before this arrived. */
  pairingExpired: -33003,
  /** The client speaks a protocol version this host cannot serve. */
  versionMismatch: -33004,
  /** The user revoked this device from the host's paired list. */
  revoked: -33005
} as const

// ---------------------------------------------------------------------------
// Handshake payloads
// ---------------------------------------------------------------------------

/** Host → client, first frame on the socket (notification). */
export interface RemoteHelloParams {
  protocolVersion: number
  hostID: string
  hostName: string
  hostKind: RemoteHostKind
  hostVersion: string
  /** base64url, 32 random bytes, fresh per connection. */
  challenge: string
  pairingOpen: boolean
}

export type RemoteAuthMode = 'pair' | 'resume'

/** Client → host request. */
export interface RemoteAuthRequestParams {
  mode: RemoteAuthMode
  deviceID: string
  deviceName: string
  platform: string
  /** base64url( HMAC-SHA256(key, challenge_bytes || utf8(hostID)) ). */
  proof: string
  protocolVersion: number
}

export interface RemoteAuthResultPayload {
  /** base64url device key — present ONLY on a successful `pair`. */
  deviceKey?: string
  hostID: string
  hostName: string
  hostKind: RemoteHostKind
  agentReady: boolean
}

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

/** One row in the phone's chat list. Dates are RFC3339 strings on the wire. */
export interface RemoteChatSummaryWire {
  id: string
  title: string
  projectPath: string
  createdAt: string
  updatedAt: string
  isPinned: boolean
  isArchived: boolean
  isBusy: boolean
  messageCount: number
  preview: string
}

export interface RemoteChatListResult {
  chats: RemoteChatSummaryWire[]
}

export interface RemoteChatOpenParams {
  chatID: string
}

export interface RemoteChatOpenResultWire {
  /** Swift StoredSession Codable shape — see storedSessionToWire(). */
  chat: JSONValue
  /** Swift `[ACPConfigOption]` Codable shape — see configOptionsToWire(). */
  configOptions: JSONValue
  /** Swift `[ACPCommand]` shape: { name, description, hint? }. */
  commands: JSONValue
  /** Swift `[ACPPlanEntry]` shape: { content, status, priority? }. */
  plan: JSONValue
  /** Swift `ACPUsageUpdate` shape: { used, size, totalTokens? }. Omitted when null. */
  usage?: JSONValue
  isBusy: boolean
}

export interface RemoteChatNewParams {
  projectPath: string
}

export interface RemoteChatIDParams {
  chatID: string
}

export interface RemoteChatFlagParams {
  chatID: string
  isPinned?: boolean
  isArchived?: boolean
}

// ---------------------------------------------------------------------------
// Driving a turn
// ---------------------------------------------------------------------------

export interface RemoteChatPromptParams {
  chatID: string
  /** ACP content blocks: {type:'text',text} | {type:'image',data,mimeType}. */
  blocks: JSONValue[]
}

export interface RemoteChatConfigParams {
  chatID: string
  configID: string
  stringValue?: string
  boolValue?: boolean
}

export interface RemoteChatUpdateParams {
  chatID: string
  /** The ACP session/update `update` object verbatim. */
  update: JSONValue
}

export interface RemoteAttachmentWire {
  base64: string
  mimeType: string
}

export interface RemoteChatUserMessageParams {
  chatID: string
  text: string
  attachments: RemoteAttachmentWire[]
  /** RFC3339. */
  timestamp: string
}

export interface RemoteNoticeWire {
  text: string
  isError: boolean
}

export interface RemoteChatStateParams {
  chat: RemoteChatSummaryWire
  stopReason?: string
  notice?: RemoteNoticeWire
}

export interface RemoteHostStateParams {
  agentReady: boolean
  shuttingDown: boolean
  message?: string
}

// ---------------------------------------------------------------------------
// Blocking prompts
// ---------------------------------------------------------------------------

export interface RemotePermissionAskParams {
  promptID: string
  chatID?: string
  /** The ACP `session/request_permission` params verbatim. */
  request: JSONValue
}

export interface RemotePermissionReplyParams {
  promptID: string
  /** Absent/undefined means the user dismissed it. */
  selectedOptionID?: string
}

export interface RemoteQuestionAskParams {
  promptID: string
  chatID?: string
  /** The `_spettro/question/ask` form verbatim. */
  request: JSONValue
}

export interface RemoteQuestionReplyParams {
  promptID: string
  /** Absent means the user declined the whole form. Elements are the client's
   *  ACPQuestionAnswer encoding: { questionId, optionIds, text?, notes? }. */
  answers?: JSONValue[]
}

export interface RemotePromptResolvedParams {
  promptID: string
  resolvedBy?: string
}

// ---------------------------------------------------------------------------
// Agent passthrough
// ---------------------------------------------------------------------------

export interface RemoteAgentCallParams {
  method: string
  params?: JSONValue
}

export interface RemoteAgentNotificationParams {
  method: string
  params?: JSONValue
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** The client decodes `chatCount` as a non-optional Int — it must be present. */
export interface RemoteProjectWire {
  path: string
  name: string
  chatCount: number
}

export interface RemoteProjectsListResult {
  projects: RemoteProjectWire[]
}

// ---------------------------------------------------------------------------
// Wire encoding helpers (ms epoch / local shapes → Swift Codable shapes)
// ---------------------------------------------------------------------------

/** RFC3339 with second precision — Swift's `.iso8601` date strategy cannot
 *  decode fractional seconds, so they MUST be stripped. */
export function rfc3339(msEpoch: number): string {
  return new Date(msEpoch).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** Local ChatSummary (ms epochs) → RemoteChatSummary wire shape. */
export function chatSummaryToWire(s: ChatSummary): RemoteChatSummaryWire {
  return {
    id: s.id,
    title: s.title,
    projectPath: s.projectPath,
    createdAt: rfc3339(s.createdAt),
    updatedAt: rfc3339(s.updatedAt),
    isPinned: s.isPinned,
    isArchived: s.isArchived,
    isBusy: s.isBusy,
    messageCount: s.messageCount,
    preview: s.preview
  }
}

/** One TranscriptItem → Swift StoredItem synthesized-enum encoding:
 *  `{"message":{"_0":{...}}}` / `{"tool":{"_0":{...}}}`. Field names and
 *  presence mirror SessionStore.swift's StoredMessage/StoredTool exactly. */
export function transcriptItemToWire(item: TranscriptItem): JSONValue {
  if (item.kind === 'message') {
    const m = item.message
    const stored: { [key: string]: JSONValue } = {
      id: m.id,
      role: m.role,
      noticeIsError: m.noticeIsError ?? false,
      text: m.text,
      timestamp: rfc3339(m.timestamp)
    }
    // Swift writes nil (key omitted) when there are no attachments.
    if (m.attachments.length > 0) {
      stored.attachments = m.attachments.map((a) => ({
        id: a.id,
        data: a.data, // base64, matching Swift's Data encoding
        mimeType: a.mimeType
      }))
    }
    return { message: { _0: stored } }
  }
  const t = item.tool
  const stored: { [key: string]: JSONValue } = {
    id: t.id,
    title: t.title,
    status: t.status,
    output: t.output,
    diffs: t.diffs.map((d) => {
      const diff: { [key: string]: JSONValue } = { path: d.path, newText: d.newText }
      if (d.oldText !== null && d.oldText !== undefined) diff.oldText = d.oldText
      return diff
    }),
    locations: [...t.locations],
    timestamp: rfc3339(t.timestamp)
  }
  if (t.kind !== undefined) stored.kind = t.kind
  if (t.argsJSON !== undefined) stored.argsJSON = t.argsJSON
  return { tool: { _0: stored } }
}

/** Local StoredSession (ms epochs, local extras) → the Swift StoredSession
 *  Codable shape from SessionStore.swift. Drops `updatedAt` and
 *  `pendingConfigChanges`, which the Swift snapshot does not carry. */
export function storedSessionToWire(s: StoredSession): JSONValue {
  const wire: { [key: string]: JSONValue } = {
    id: s.id,
    projectPath: s.projectPath,
    title: s.title,
    createdAt: rfc3339(s.createdAt),
    isPinned: s.isPinned,
    isArchived: s.isArchived,
    items: s.items.map(transcriptItemToWire),
    configOptions: s.configOptions.map(configOptionToWire)
  }
  if (s.acpSessionId !== null) wire.acpSessionId = s.acpSessionId
  return wire
}

/** Shared ACPConfigOption → Swift ACPConfigOption Codable shape:
 *  { id, name, description?, category?,
 *    kind: {select:{current,groups:[{name?,options:[{name,value,description?}]}]}}
 *        | {boolean:{current}} }. */
export function configOptionToWire(opt: ACPConfigOption): JSONValue {
  const wire: { [key: string]: JSONValue } = { id: opt.id, name: opt.name }
  if (opt.description !== undefined) wire.description = opt.description
  if (opt.category !== undefined) wire.category = opt.category
  if (opt.kind.type === 'boolean') {
    wire.kind = { boolean: { current: opt.kind.currentValue } }
    return wire
  }
  const groups: JSONValue[] =
    opt.kind.groups.length > 0
      ? opt.kind.groups.map((g) => ({
          name: g.name,
          options: g.options.map(configChoiceToWire)
        }))
      : [{ options: opt.kind.flat.map(configChoiceToWire) }] // ungrouped: name omitted (nil)
  wire.kind = { select: { current: opt.kind.currentValue ?? '', groups } }
  return wire
}

function configChoiceToWire(c: { name: string; value: string; description?: string }): JSONValue {
  const wire: { [key: string]: JSONValue } = { name: c.name, value: c.value }
  if (c.description !== undefined) wire.description = c.description
  return wire
}

/** Shared ACPCommand → Swift ACPCommand shape { name, description, hint? }.
 *  `description` is non-optional in Swift, so it defaults to "". */
export function commandToWire(c: ACPCommand): JSONValue {
  const wire: { [key: string]: JSONValue } = { name: c.name, description: c.description ?? '' }
  if (c.inputHint !== undefined) wire.hint = c.inputHint
  return wire
}

/** Shared ACPPlanEntry → Swift ACPPlanEntry shape { content, status, priority? }. */
export function planEntryToWire(e: ACPPlanEntry): JSONValue {
  const wire: { [key: string]: JSONValue } = { content: e.content, status: e.status }
  if (e.priority !== undefined) wire.priority = e.priority
  return wire
}

/** Shared ACPUsage → Swift ACPUsageUpdate shape { used, size, totalTokens? }.
 *  Note the rename: local `tokensUsed` → wire `totalTokens`. */
export function usageToWire(u: ACPUsage): JSONValue {
  const wire: { [key: string]: JSONValue } = { used: u.used, size: u.size }
  if (u.tokensUsed !== undefined) wire.totalTokens = u.tokensUsed
  return wire
}

// ---------------------------------------------------------------------------
// Defensive normalizers — accept either the already-wire-shaped value or the
// shared parsed shape and return the Swift Codable wire shape. Lets the model
// bridge hand over whichever representation it holds.
// ---------------------------------------------------------------------------

function isObject(v: JSONValue | undefined): v is { [key: string]: JSONValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Normalizes a configOptions JSONValue to the Swift wire shape. */
export function normalizeConfigOptions(value: JSONValue): JSONValue {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    if (!isObject(item)) return item
    const kind = item.kind
    if (isObject(kind) && typeof kind.type === 'string') {
      // Shared/parsed shape — convert.
      return configOptionToWire(item as unknown as ACPConfigOption)
    }
    return item // already wire-shaped (or raw enough to pass through)
  })
}

/** Normalizes a commands JSONValue to { name, description, hint? } elements. */
export function normalizeCommands(value: JSONValue): JSONValue {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    if (!isObject(item) || typeof item.name !== 'string') return item
    const wire: { [key: string]: JSONValue } = {
      name: item.name,
      description: typeof item.description === 'string' ? item.description : ''
    }
    const hint =
      typeof item.hint === 'string'
        ? item.hint
        : typeof item.inputHint === 'string'
          ? item.inputHint
          : isObject(item.input) && typeof item.input.hint === 'string'
            ? item.input.hint
            : undefined
    if (hint !== undefined) wire.hint = hint
    return wire
  })
}

/** Normalizes plan entries to { content, status, priority? }. */
export function normalizePlan(value: JSONValue): JSONValue {
  if (!Array.isArray(value)) return []
  const entries: JSONValue[] = []
  for (const item of value) {
    if (!isObject(item) || typeof item.content !== 'string') continue
    const wire: { [key: string]: JSONValue } = {
      content: item.content,
      status: typeof item.status === 'string' ? item.status : 'pending'
    }
    if (typeof item.priority === 'string') wire.priority = item.priority
    entries.push(wire)
  }
  return entries
}

/** Normalizes usage to { used, size, totalTokens? }, or null when unusable. */
export function normalizeUsage(value: JSONValue | null): JSONValue | null {
  if (!isObject(value)) return null
  const used = value.used
  const size = value.size
  if (typeof used !== 'number' || typeof size !== 'number' || size <= 0) return null
  const wire: { [key: string]: JSONValue } = { used, size }
  const total =
    typeof value.totalTokens === 'number'
      ? value.totalTokens
      : typeof value.tokensUsed === 'number'
        ? value.tokensUsed
        : isObject(value._meta) && typeof value._meta['spettro.app/tokensUsed'] === 'number'
          ? value._meta['spettro.app/tokensUsed']
          : undefined
  if (total !== undefined) wire.totalTokens = total
  return wire
}

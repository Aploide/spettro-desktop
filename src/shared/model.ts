// Presentation + persistence models shared between the main process (which
// owns them) and the renderer (which displays a mirrored copy). Port of
// Spettro/Model/TranscriptModels.swift and the state surface of AppModel.

import type {
  ACPCommand,
  ACPConfigOption,
  ACPPlanEntry,
  ACPToolStatus,
  ACPUsage,
  JSONValue
} from './acp'
import type { ExtensionsState } from './extensions'

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export interface ImageAttachmentDTO {
  id: string
  /** base64 JPEG (already downsampled/re-encoded). */
  data: string
  mimeType: string
  width: number
  height: number
}

export type ChatRole = 'user' | 'assistant' | 'reasoning' | 'notice'

export interface ChatMessage {
  id: string
  role: ChatRole
  /** Only meaningful when role === 'notice'. */
  noticeIsError?: boolean
  text: string
  attachments: ImageAttachmentDTO[]
  isStreaming: boolean
  /** ms since epoch */
  timestamp: number
}

export interface ToolDiff {
  path: string
  oldText: string | null
  newText: string
}

export interface ToolCallItem {
  /** The ACP toolCallId. */
  id: string
  title: string
  kind?: string
  status: ACPToolStatus
  output: string
  diffs: ToolDiff[]
  locations: string[]
  /** The full ACP rawInput re-encoded as JSON — the reliable argument source. */
  argsJSON?: string
  timestamp: number
}

export type TranscriptItem =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'tool'; tool: ToolCallItem }

/** Stable ForEach/scroll identity: "msg-<uuid>" | "tool-<toolCallId>". */
export function transcriptItemId(item: TranscriptItem): string {
  return item.kind === 'message' ? `msg-${item.message.id}` : `tool-${item.tool.id}`
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Lightweight sidebar/summary projection of a ChatSession. */
export interface ChatSummary {
  id: string
  title: string
  projectPath: string
  createdAt: number
  updatedAt: number
  isPinned: boolean
  isArchived: boolean
  isBusy: boolean
  messageCount: number
  preview: string
}

/** Full detail the renderer holds for an open chat. */
export interface ChatDetail {
  id: string
  title: string
  projectPath: string
  acpSessionId: string | null
  isPinned: boolean
  isArchived: boolean
  isBusy: boolean
  createdAt: number
  items: TranscriptItem[]
  configOptions: ACPConfigOption[]
  commands: ACPCommand[]
  plan: ACPPlanEntry[]
  usage: ACPUsage | null
}

/** On-disk snapshot (sessions.json). Matches the remote-protocol StoredSession
 *  shape (RFC3339 dates on the remote wire; ms epoch locally). */
export interface StoredSession {
  id: string
  acpSessionId: string | null
  projectPath: string
  title: string
  createdAt: number
  updatedAt: number
  isPinned: boolean
  isArchived: boolean
  items: TranscriptItem[]
  configOptions: ACPConfigOption[]
  pendingConfigChanges: Record<string, JSONValue>
}

// ---------------------------------------------------------------------------
// App-level state
// ---------------------------------------------------------------------------

export type Phase =
  | { kind: 'locating' }
  | { kind: 'needsSetup' }
  | { kind: 'installing' }
  | { kind: 'needsProject' }
  | { kind: 'connecting' }
  /** Agent running, but no provider key, local endpoint, or subscription is
   *  configured — it cannot answer a single prompt yet, so the user is routed
   *  into provider setup instead of a chat that would fail. */
  | { kind: 'needsProvider' }
  | { kind: 'ready' }
  | { kind: 'failed'; message: string }

export interface CLIInfo {
  path: string
  version: string | null
  /** true when resolved from a dev checkout fallback */
  isDev: boolean
}

/** Subscription tier. Port of SubscriptionPlan.swift, which is an open enum:
 *  the five known tiers, `unknown` for "not connected / no plan", and any
 *  other string the service starts returning (rendered verbatim, uppercased,
 *  rather than being flattened to unknown). */
export type Plan = 'free' | 'lite' | 'plus' | 'pro' | 'max' | 'unknown' | (string & {})

export interface SubscriptionState {
  plan: Plan
  email: string | null
}

export interface RemoteHostState {
  enabled: boolean
  port: number | null
  hostId: string
  hostName: string
  pairingOpen: boolean
  /** spettro-pair:// URL while a pairing window is open. */
  pairingURL: string | null
  /** QR code for pairingURL as a data: URL (SVG/PNG). */
  pairingQR: string | null
  devices: PairedDeviceDTO[]
  connectedDeviceIds: string[]
}

export interface PairedDeviceDTO {
  deviceId: string
  name: string
  platform: string
  pairedAt: number
  lastSeenAt: number | null
  revoked: boolean
}

/** Uncommitted working-tree stats for the chat header's git chip. */
export interface GitStat {
  branch: string
  files: { path: string; added: number; removed: number }[]
}

export interface AppStateDTO {
  phase: Phase
  cli: CLIInfo | null
  agentVersion: string | null
  selectedSessionId: string | null
  sessions: ChatSummary[]
  banner: string | null
  installLog: string[]
  agentLog: string[]
  subscription: SubscriptionState
  /** Account / providers / models, mirrored from the `_spettro/*` surface. */
  extensions: ExtensionsState
  remote: RemoteHostState | null
  lastProjectPath: string | null
  /** Where a new chat opens when the user doesn't pick a folder — already
   *  resolved by the main process (selected chat → last project → $HOME), so
   *  the renderer never has to guess at the home directory. */
  defaultProjectPath: string
  recentProjects: string[]
}

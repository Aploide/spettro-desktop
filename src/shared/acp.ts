// ACP wire types — mirrors the subset of the Agent Client Protocol that
// Spettro.app drives (see spettro-apple/docs/09-acp-protocol-types.md and
// appendix-e-cli-app-contract.md). These types are shared between the main
// process (which speaks the protocol) and the renderer (which displays it).

/** Dependency-free dynamic JSON value (port of JSONValue.swift). */
export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue }

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export type ACPContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

// ---------------------------------------------------------------------------
// Config options (the data-driven ConfigBar)
// ---------------------------------------------------------------------------

export interface ACPConfigChoice {
  name: string
  value: string
  description?: string
}

export interface ACPConfigGroup {
  name: string
  options: ACPConfigChoice[]
}

/** A select option's `options` array is either flat choices or named groups. */
export type ACPConfigOptionKind =
  | { type: 'select'; currentValue: string | null; groups: ACPConfigGroup[]; flat: ACPConfigChoice[] }
  | { type: 'boolean'; currentValue: boolean }

export interface ACPConfigOption {
  id: string
  name: string
  description?: string
  category?: string
  kind: ACPConfigOptionKind
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

export type ACPToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'unknown'

export interface ACPToolDiffContent {
  type: 'diff'
  path: string
  oldText: string | null
  newText: string
}

export interface ACPToolCallEvent {
  toolCallId: string
  title?: string
  kind?: string
  status?: ACPToolStatus
  rawInput?: JSONValue
  /** Plain-text output fragments from `content` blocks. */
  texts: string[]
  diffs: ACPToolDiffContent[]
  locations: string[]
}

// ---------------------------------------------------------------------------
// Commands, plan, usage
// ---------------------------------------------------------------------------

export interface ACPCommand {
  name: string
  description?: string
  inputHint?: string
}

export interface ACPPlanEntry {
  content: string
  status: string // "pending" | "in_progress" | "completed" | anything
  priority?: string
}

export interface ACPUsage {
  used: number
  size: number
  /** Spettro extension: cumulative session tokens (`_meta["spettro.app/tokensUsed"]`). */
  tokensUsed?: number
}

// ---------------------------------------------------------------------------
// Session updates (the `session/update` notification payloads)
// ---------------------------------------------------------------------------

export type ACPSessionUpdate =
  | { kind: 'agent_message_chunk'; text: string }
  | { kind: 'agent_thought_chunk'; text: string }
  | { kind: 'tool_call'; event: ACPToolCallEvent }
  | { kind: 'tool_call_update'; event: ACPToolCallEvent }
  | { kind: 'available_commands_update'; commands: ACPCommand[] }
  | { kind: 'config_option_update'; options: ACPConfigOption[] }
  | { kind: 'plan'; entries: ACPPlanEntry[] }
  | { kind: 'usage_update'; usage: ACPUsage }
  | { kind: 'other'; tag: string }

// ---------------------------------------------------------------------------
// Stop reasons
// ---------------------------------------------------------------------------

export type ACPStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'
  | 'unknown'

// ---------------------------------------------------------------------------
// Permission requests (agent → app)
// ---------------------------------------------------------------------------

export interface ACPPermissionOption {
  optionId: string
  name: string
  kind?: string
}

export interface ACPPermissionRequest {
  /** App-generated identity for queueing/dismissal. */
  id: string
  sessionId: string
  title: string
  toolKind?: string
  rawInput?: JSONValue
  options: ACPPermissionOption[]
}

// ---------------------------------------------------------------------------
// Ask-user questions (`_spettro/question/ask`)
// ---------------------------------------------------------------------------

export interface ACPQuestionOption {
  id: string
  label: string
  description?: string
  isRecommended?: boolean
  preview?: string
}

export interface ACPQuestion {
  id: string
  header?: string
  question: string
  options: ACPQuestionOption[]
  multiSelect: boolean
  allowCustomInput: boolean
}

export interface ACPQuestionRequest {
  /** App-generated identity for queueing/dismissal. */
  id: string
  version: number
  sessionId?: string
  context?: string
  questions: ACPQuestion[]
}

export type ACPQuestionAnswer =
  | { questionId: string; kind: 'option'; optionId?: string; optionIds: string[]; notes?: string }
  | { questionId: string; kind: 'custom'; text: string; notes?: string }

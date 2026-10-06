// ACP wire types — mirrors the subset of the Agent Client Protocol that
// Spettro.app drives (see spettro-apple/docs/09-acp-protocol-types.md and
// appendix-e-cli-app-contract.md). These types are shared between the main
// process (which speaks the protocol) and the renderer (which displays it).

/** Dependency-free dynamic JSON value (port of JSONValue.swift). */
export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue }

/** JSON-RPC id — the app's own ids are ints; agent-originated ids may be strings. */
export type RPCID = number | string

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export type ACPContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  /** A file the user @-mentioned. spettro reads it before the turn starts
   *  (a RequiredRead) and writes it into the prompt as `@<path>` where the
   *  link sits among the text blocks (internal/acp/content.go
   *  readPromptContent). */
  | { type: 'resource_link'; uri: string; name: string }

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

/** A file a tool call touches (`locations[]`); `line` when the agent names one. */
export interface ACPToolLocation {
  path: string
  line?: number
}

/** An image a tool returned (a screenshot, a viewed image) — base64 `data`. */
export interface ACPToolImage {
  data: string
  mimeType: string
}

export interface ACPToolCallEvent {
  toolCallId: string
  title?: string
  kind?: string
  status?: ACPToolStatus
  rawInput?: JSONValue
  /** `rawOutput.output` — the tool's own result text, unclipped by the card. */
  rawOutput?: string
  /** `_meta["spettro.app/workflow"]`: a workflow card's whole state as
   *  structure (internal/acp/workflow.go metaView), on every update a workflow
   *  card sends. Absent from older CLIs and from every other tool call. */
  workflowMeta?: JSONValue
  /** Plain-text output fragments from `content` blocks. */
  texts: string[]
  diffs: ACPToolDiffContent[]
  /** Image content blocks, capped (see parse.ts MAX_TOOL_IMAGES). */
  images: ACPToolImage[]
  locations: ACPToolLocation[]
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
  /** Only ever sent while `session/load` replays a stored conversation. */
  | { kind: 'user_message_chunk'; text: string }
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

/** The token accounting a `session/prompt` response carries (ACP `Usage`). */
export interface ACPTurnUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
}

/** What a finished `session/prompt` reports. */
export interface ACPPromptResult {
  stopReason: ACPStopReason
  usage?: ACPTurnUsage
  /** Spettro's own count for the turn (`_meta["spettro.app/tokensUsed"]`),
   *  an estimate when the provider reported no accounting. */
  tokensUsed?: number
}

/** What the agent said it can do at `initialize` — feature detection instead
 *  of trial and error. Every flag is false for an agent that didn't say. */
export interface ACPAgentCapabilities {
  loadSession: boolean
  listSessions: boolean
  resumeSession: boolean
  closeSession: boolean
  promptImage: boolean
  promptEmbeddedContext: boolean
}

/** One entry of `session/list`. */
export interface ACPSessionInfo {
  sessionId: string
  cwd: string
  title: string | null
  /** ms since epoch, when the agent reported one. */
  updatedAt: number | null
}
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
  /** The chat that asked, stamped by the main process; null when the ACP
   *  session belongs to no chat it knows (a closed one, say). */
  chatId: string | null
  /** The transcript card this approval is about. The CLI attaches a request
   *  to the card it is already drawing, or names a fresh `perm-N` one. */
  toolCallId?: string
  /** Always a sentence: the agent's title, else the card's, else one written
   *  from the tool kind. */
  title: string
  toolKind?: string
  rawInput?: JSONValue
  /** What the approval would do, from `toolCall.content`: the command (in a
   *  fenced block), the reason, and any diff. An attached request carries
   *  nothing else — no title, no rawInput (permission.go). */
  content: { texts: string[]; diffs: ACPToolDiffContent[] }
  locations: ACPToolLocation[]
  options: ACPPermissionOption[]
  /** The "context nearly full — compact now?" prompt (compaction.go), which
   *  rides the permission transport but approves no tool. */
  variant?: 'compact'
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
  /** The chat that asked, stamped by the main process (see
   *  ACPPermissionRequest.chatId). */
  chatId: string | null
  context?: string
  questions: ACPQuestion[]
}

export type ACPQuestionAnswer =
  | { questionId: string; kind: 'option'; optionId?: string; optionIds: string[]; notes?: string }
  | { questionId: string; kind: 'custom'; text: string; notes?: string }

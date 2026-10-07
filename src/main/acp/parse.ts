// Wire parsers for the ACP surface Spettro drives — the TypeScript port of the
// hand-rolled `parse(_:)` functions in spettro-apple's ACPProtocol.swift and
// ACPQuestion.swift. Every function consumes a dynamic JSONValue and returns
// the shared typed shape (or null / drops malformed entries), never throwing:
// one bad option, command, or plan entry must not poison the whole update.

import { randomUUID } from 'node:crypto'
import type {
  ACPAgentCapabilities,
  ACPCommand,
  ACPConfigChoice,
  ACPConfigGroup,
  ACPConfigOption,
  ACPPermissionOption,
  ACPPermissionRequest,
  ACPPlanEntry,
  ACPPromptResult,
  ACPQuestion,
  ACPQuestionOption,
  ACPQuestionRequest,
  ACPSessionInfo,
  ACPSessionUpdate,
  ACPStopReason,
  ACPToolCallEvent,
  ACPToolDiffContent,
  ACPToolImage,
  ACPToolLocation,
  ACPToolStatus,
  ACPTurnUsage,
  ACPUsage,
  JSONValue
} from '../../shared/acp'

// ---------------------------------------------------------------------------
// JSONValue accessors (port of JSONValue.swift's optional projections)
// ---------------------------------------------------------------------------

type JSONObject = { [key: string]: JSONValue }

export function objectValue(value: JSONValue | undefined): JSONObject | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
  return null
}

export function arrayValue(value: JSONValue | undefined): JSONValue[] | null {
  return Array.isArray(value) ? value : null
}

export function stringValue(value: JSONValue | undefined): string | null {
  return typeof value === 'string' ? value : null
}

export function boolValue(value: JSONValue | undefined): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/** Like Swift's `intValue`: exact for ints, truncating for doubles. */
export function intValue(value: JSONValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

/** Nil for a string that is blank once trimmed (ACPQuestion.swift `nonEmpty`). */
function nonEmpty(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

// ---------------------------------------------------------------------------
// Config options (ACPConfigOption.parse)
// ---------------------------------------------------------------------------

function parseConfigChoice(value: JSONValue): ACPConfigChoice | null {
  const obj = objectValue(value)
  if (!obj) return null
  const name = stringValue(obj['name'])
  const v = stringValue(obj['value'])
  if (name === null || v === null) return null
  const choice: ACPConfigChoice = { name, value: v }
  const description = stringValue(obj['description'])
  if (description !== null) choice.description = description
  return choice
}

/** Parses one agent-advertised config option; null when malformed. */
export function parseConfigOption(value: JSONValue): ACPConfigOption | null {
  const obj = objectValue(value)
  if (!obj) return null
  const id = stringValue(obj['id'])
  const name = stringValue(obj['name'])
  if (id === null || name === null) return null

  const option: ACPConfigOption = {
    id,
    name,
    kind: { type: 'select', currentValue: null, groups: [], flat: [] }
  }
  const description = stringValue(obj['description'])
  if (description !== null) option.description = description
  const category = stringValue(obj['category'])
  if (category !== null) option.category = category

  if (stringValue(obj['type']) === 'boolean') {
    option.kind = { type: 'boolean', currentValue: boolValue(obj['currentValue']) ?? false }
    return option
  }

  // Default to select. `options` is either a flat choice array or a grouped
  // array — grouped when the first element carries a nested "options" array.
  const currentValue = stringValue(obj['currentValue'])
  const groups: ACPConfigGroup[] = []
  const flat: ACPConfigChoice[] = []
  const optionsArray = arrayValue(obj['options'])
  if (optionsArray && optionsArray.length > 0) {
    const first = objectValue(optionsArray[0])
    if (first && first['options'] !== undefined) {
      for (const g of optionsArray) {
        const gObj = objectValue(g)
        if (!gObj) continue
        const opts = (arrayValue(gObj['options']) ?? [])
          .map(parseConfigChoice)
          .filter((c): c is ACPConfigChoice => c !== null)
        groups.push({ name: stringValue(gObj['name']) ?? '', options: opts })
        flat.push(...opts)
      }
    } else {
      const opts = optionsArray
        .map(parseConfigChoice)
        .filter((c): c is ACPConfigChoice => c !== null)
      groups.push({ name: '', options: opts })
      flat.push(...opts)
    }
  }
  option.kind = { type: 'select', currentValue, groups, flat }
  return option
}

/** Parses a `configOptions` array leniently, dropping malformed entries. */
export function parseConfigOptions(value: JSONValue | undefined): ACPConfigOption[] {
  const array = arrayValue(value)
  if (!array) return []
  return array.map(parseConfigOption).filter((o): o is ACPConfigOption => o !== null)
}

// ---------------------------------------------------------------------------
// Commands (ACPCommand.parse)
// ---------------------------------------------------------------------------

export function parseCommand(value: JSONValue): ACPCommand | null {
  const obj = objectValue(value)
  if (!obj) return null
  const name = stringValue(obj['name'])
  if (name === null) return null
  const command: ACPCommand = { name }
  const description = stringValue(obj['description'])
  if (description !== null) command.description = description
  const hint = stringValue(objectValue(obj['input'])?.['hint'])
  if (hint !== null) command.inputHint = hint
  return command
}

export function parseCommands(value: JSONValue | undefined): ACPCommand[] {
  const array = arrayValue(value)
  if (!array) return []
  return array.map(parseCommand).filter((c): c is ACPCommand => c !== null)
}

// ---------------------------------------------------------------------------
// Plan entries (ACPPlanEntry.parse)
// ---------------------------------------------------------------------------

export function parsePlanEntry(value: JSONValue): ACPPlanEntry | null {
  const obj = objectValue(value)
  if (!obj) return null
  const content = stringValue(obj['content'])
  if (content === null) return null
  const entry: ACPPlanEntry = { content, status: stringValue(obj['status']) ?? 'pending' }
  const priority = stringValue(obj['priority'])
  if (priority !== null) entry.priority = priority
  return entry
}

export function parsePlan(value: JSONValue | undefined): ACPPlanEntry[] {
  const array = arrayValue(value)
  if (!array) return []
  return array.map(parsePlanEntry).filter((e): e is ACPPlanEntry => e !== null)
}

// ---------------------------------------------------------------------------
// Usage (ACPUsageUpdate.parse)
// ---------------------------------------------------------------------------

/** Parses a `usage_update` payload; null when `used`/`size` are missing or
 *  `size <= 0` (a zero window would divide every percentage by zero). */
export function parseUsage(obj: JSONValue): ACPUsage | null {
  const o = objectValue(obj)
  if (!o) return null
  const used = intValue(o['used'])
  const size = intValue(o['size'])
  if (used === null || size === null || size <= 0) return null
  const usage: ACPUsage = { used, size }
  const tokensUsed = intValue(objectValue(o['_meta'])?.['spettro.app/tokensUsed'])
  if (tokensUsed !== null) usage.tokensUsed = tokensUsed
  return usage
}

// ---------------------------------------------------------------------------
// Tool calls (ACPToolCallEvent.parse / ACPToolContent.parse / ACPToolStatus)
// ---------------------------------------------------------------------------

const TOOL_STATUSES: readonly ACPToolStatus[] = ['pending', 'in_progress', 'completed', 'failed']

function parseToolStatus(raw: string | null): ACPToolStatus {
  return raw !== null && (TOOL_STATUSES as readonly string[]).includes(raw)
    ? (raw as ACPToolStatus)
    : 'unknown'
}

/** At most this many images are kept per tool call. A screenshot loop can
 *  return one per step, and every image kept is persisted with the chat. */
export const MAX_TOOL_IMAGES = 4
/** An image whose base64 is longer than this is dropped rather than kept:
 *  one oversized capture would otherwise bloat sessions.json for good. */
const MAX_TOOL_IMAGE_CHARS = 4_000_000

type ToolContent =
  | { kind: 'text'; text: string }
  | { kind: 'diff'; diff: ACPToolDiffContent }
  | { kind: 'image'; image: ACPToolImage }

/** One tool-content item: a diff, a nested content block (text or image), or
 *  bare text. */
function parseToolContent(value: JSONValue): ToolContent | null {
  const obj = objectValue(value)
  if (!obj) return null
  if (stringValue(obj['type']) === 'diff') {
    const path = stringValue(obj['path'])
    const newText = stringValue(obj['newText'])
    if (path === null || newText === null) return null
    return { kind: 'diff', diff: { type: 'diff', path, oldText: stringValue(obj['oldText']), newText } }
  }
  // "content" wrapper holds a nested content block, usually text — an image
  // when the tool returned one (tools.go: screenshots, view-image).
  const inner = objectValue(obj['content'])
  if (inner && stringValue(inner['type']) === 'image') {
    const data = stringValue(inner['data'])
    const mimeType = stringValue(inner['mimeType'])
    if (data === null || data === '' || mimeType === null) return null
    return { kind: 'image', image: { data, mimeType } }
  }
  const innerText = inner ? stringValue(inner['text']) : null
  if (innerText !== null) return { kind: 'text', text: innerText }
  const bare = stringValue(obj['text'])
  if (bare !== null) return { kind: 'text', text: bare }
  return null
}

/** A tool call's `content` array, split by kind. */
function parseToolContents(value: JSONValue | undefined): {
  texts: string[]
  diffs: ACPToolDiffContent[]
  images: ACPToolImage[]
} {
  const texts: string[] = []
  const diffs: ACPToolDiffContent[] = []
  const images: ACPToolImage[] = []
  for (const item of arrayValue(value) ?? []) {
    const parsed = parseToolContent(item)
    if (!parsed) continue
    if (parsed.kind === 'text') texts.push(parsed.text)
    else if (parsed.kind === 'diff') diffs.push(parsed.diff)
    else if (images.length < MAX_TOOL_IMAGES && parsed.image.data.length <= MAX_TOOL_IMAGE_CHARS) {
      images.push(parsed.image)
    }
  }
  return { texts, diffs, images }
}

/** `locations[]`: a path each, plus the line when the agent names one. */
function parseLocations(value: JSONValue | undefined): ACPToolLocation[] {
  const out: ACPToolLocation[] = []
  for (const loc of arrayValue(value) ?? []) {
    const obj = objectValue(loc)
    const path = stringValue(obj?.['path'])
    if (!obj || path === null) continue
    const line = intValue(obj['line'])
    out.push(line !== null && line > 0 ? { path, line } : { path })
  }
  return out
}

/** `rawOutput` is `{output}` from spettro (content.go); a bare string from an
 *  agent that sends one is taken as is. */
function parseRawOutput(value: JSONValue | undefined): string | null {
  if (typeof value === 'string') return value
  return stringValue(objectValue(value)?.['output'])
}

/** Parses a `tool_call` / `tool_call_update` payload. `toolCallId` required. */
export function parseToolCallEvent(value: JSONValue): ACPToolCallEvent | null {
  const obj = objectValue(value)
  if (!obj) return null
  const toolCallId = stringValue(obj['toolCallId'])
  if (toolCallId === null) return null

  const { texts, diffs, images } = parseToolContents(obj['content'])
  const locations = parseLocations(obj['locations'])

  const event: ACPToolCallEvent = { toolCallId, texts, diffs, images, locations }
  const title = stringValue(obj['title'])
  if (title !== null) event.title = title
  const kind = stringValue(obj['kind'])
  if (kind !== null) event.kind = kind
  // Status: absent stays absent; present-but-unrecognized becomes 'unknown'.
  if (obj['status'] !== undefined) event.status = parseToolStatus(stringValue(obj['status']))
  if (obj['rawInput'] !== undefined) event.rawInput = obj['rawInput']
  const rawOutput = parseRawOutput(obj['rawOutput'])
  if (rawOutput !== null) event.rawOutput = rawOutput
  // Kept as it came: the renderer reads it defensively (orchestration.ts),
  // and an object is the only shape spettro sends.
  const workflow = objectValue(objectValue(obj['_meta'])?.['spettro.app/workflow'])
  if (workflow) event.workflowMeta = workflow
  return event
}

// ---------------------------------------------------------------------------
// Session updates (ACPSessionUpdate.parse)
// ---------------------------------------------------------------------------

function chunkText(obj: JSONObject): string {
  const content = objectValue(obj['content'])
  if (!content) return ''
  return stringValue(content['text']) ?? ''
}

/** Parses the inner `update` object of a `session/update` notification.
 *  Unknown tags yield `{ kind: 'other', tag }`; null only when the payload is
 *  not an object or carries no `sessionUpdate` tag. */
export function parseSessionUpdate(update: JSONValue): ACPSessionUpdate | null {
  const obj = objectValue(update)
  if (!obj) return null
  const tag = stringValue(obj['sessionUpdate'])
  if (tag === null) return null
  switch (tag) {
    case 'agent_message_chunk':
      return { kind: 'agent_message_chunk', text: chunkText(obj) }
    case 'agent_thought_chunk':
      return { kind: 'agent_thought_chunk', text: chunkText(obj) }
    case 'user_message_chunk':
      return { kind: 'user_message_chunk', text: chunkText(obj) }
    case 'tool_call': {
      const event = parseToolCallEvent(update)
      return event ? { kind: 'tool_call', event } : null
    }
    case 'tool_call_update': {
      const event = parseToolCallEvent(update)
      return event ? { kind: 'tool_call_update', event } : null
    }
    case 'available_commands_update':
      return { kind: 'available_commands_update', commands: parseCommands(obj['availableCommands']) }
    case 'config_option_update':
      return { kind: 'config_option_update', options: parseConfigOptions(obj['configOptions']) }
    case 'current_mode_update': {
      const modeId = stringValue(obj['currentModeId'])
      return modeId ? { kind: 'current_mode_update', modeId } : null
    }
    case 'plan':
      return { kind: 'plan', entries: parsePlan(obj['entries']) }
    case 'usage_update': {
      const usage = parseUsage(update)
      return usage ? { kind: 'usage_update', usage } : null
    }
    default:
      return { kind: 'other', tag }
  }
}

// ---------------------------------------------------------------------------
// Handshake, prompt results, session list
// ---------------------------------------------------------------------------

/** `initialize` → `agentCapabilities`. An agent that doesn't mention a
 *  capability doesn't have it: ACP capabilities are opt-in. */
export function parseAgentCapabilities(result: JSONValue | undefined): ACPAgentCapabilities {
  const caps = objectValue(objectValue(result)?.['agentCapabilities'])
  const sessions = objectValue(caps?.['sessionCapabilities'])
  const prompt = objectValue(caps?.['promptCapabilities'])
  // Each session capability is an object when present (`{}` today), null or
  // absent when not.
  const has = (key: string): boolean => objectValue(sessions?.[key]) !== null
  return {
    loadSession: boolValue(caps?.['loadSession']) === true,
    listSessions: has('list'),
    resumeSession: has('resume'),
    closeSession: has('close'),
    promptImage: boolValue(prompt?.['image']) === true,
    promptEmbeddedContext: boolValue(prompt?.['embeddedContext']) === true
  }
}

/** The `_spettro/*` methods the agent serves, from the `initialize` result's
 *  `_meta["spettro.app/extensions"].methods` (ext.go). Null when it didn't
 *  say — an older CLI, or another agent — which means "try and see", not
 *  "none". */
export function parseExtensionMethods(result: JSONValue | undefined): string[] | null {
  const ext = objectValue(objectValue(objectValue(result)?.['_meta'])?.['spettro.app/extensions'])
  const methods = arrayValue(ext?.['methods'])
  if (!methods) return null
  return methods.map(stringValue).filter((m): m is string => m !== null)
}

const STOP_REASONS: readonly ACPStopReason[] = [
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled'
]

/** ACP `Usage`; null unless the three required counts are all there. */
function parseTurnUsage(value: JSONValue | undefined): ACPTurnUsage | null {
  const obj = objectValue(value)
  if (!obj) return null
  const inputTokens = intValue(obj['inputTokens'])
  const outputTokens = intValue(obj['outputTokens'])
  const totalTokens = intValue(obj['totalTokens'])
  if (inputTokens === null || outputTokens === null || totalTokens === null) return null
  const usage: ACPTurnUsage = { inputTokens, outputTokens, totalTokens }
  const cachedRead = intValue(obj['cachedReadTokens'])
  if (cachedRead !== null) usage.cachedReadTokens = cachedRead
  const cachedWrite = intValue(obj['cachedWriteTokens'])
  if (cachedWrite !== null) usage.cachedWriteTokens = cachedWrite
  return usage
}

/** A `session/prompt` response (bridge.go Prompt): the stop reason, plus the
 *  turn's usage and Spettro's own token count when reported. Null when there
 *  is no stop reason, which is not a response to a prompt. */
export function parsePromptResult(value: JSONValue | undefined): ACPPromptResult | null {
  const obj = objectValue(value)
  const raw = stringValue(obj?.['stopReason'])
  if (!obj || raw === null) return null
  const result: ACPPromptResult = {
    stopReason: (STOP_REASONS as readonly string[]).includes(raw) ? (raw as ACPStopReason) : 'unknown'
  }
  const usage = parseTurnUsage(obj['usage'])
  if (usage) result.usage = usage
  const tokensUsed = intValue(objectValue(obj['_meta'])?.['spettro.app/tokensUsed'])
  if (tokensUsed !== null) result.tokensUsed = tokensUsed
  return result
}

/** RFC 3339 → ms since epoch; null for anything Date can't read. */
function parseTimestamp(value: JSONValue | undefined): number | null {
  const raw = stringValue(value)
  if (raw === null) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : null
}

/** A `session/list` page (sessions.go ListSessions). Entries without an id
 *  are dropped. */
export function parseSessionList(value: JSONValue | undefined): {
  sessions: ACPSessionInfo[]
  nextCursor: string | null
} {
  const obj = objectValue(value)
  const sessions: ACPSessionInfo[] = []
  for (const entry of arrayValue(obj?.['sessions']) ?? []) {
    const e = objectValue(entry)
    const sessionId = stringValue(e?.['sessionId'])
    if (!e || sessionId === null || sessionId === '') continue
    sessions.push({
      sessionId,
      cwd: stringValue(e['cwd']) ?? '',
      title: nonEmpty(stringValue(e['title'])),
      updatedAt: parseTimestamp(e['updatedAt'])
    })
  }
  return { sessions, nextCursor: nonEmpty(stringValue(obj?.['nextCursor'])) }
}

// ---------------------------------------------------------------------------
// Permission requests (ACPPermissionRequest.parse)
// ---------------------------------------------------------------------------

/** Parses `session/request_permission` params. `sessionId` and a `toolCall`
 *  object are required; malformed requests earn a -32602 from the connection.
 *
 *  `title` is the agent's own when it sent one and blank otherwise: a request
 *  the CLI attaches to a card it is already drawing carries only the id, the
 *  pending status and the content (permission.go requestApproval), and only
 *  the app knows that card's title. AppModel fills the blank. `chatId` is
 *  likewise the app's to stamp. */
export function parsePermissionRequest(params: JSONValue): ACPPermissionRequest | null {
  const obj = objectValue(params)
  if (!obj) return null
  const sessionId = stringValue(obj['sessionId'])
  const toolCall = objectValue(obj['toolCall'])
  if (sessionId === null || !toolCall) return null

  const options: ACPPermissionOption[] = []
  for (const opt of arrayValue(obj['options']) ?? []) {
    const o = objectValue(opt)
    if (!o) continue
    const optionId = stringValue(o['optionId'])
    const name = stringValue(o['name'])
    if (optionId === null || name === null) continue
    const option: ACPPermissionOption = { optionId, name }
    const kind = stringValue(o['kind'])
    if (kind !== null) option.kind = kind
    options.push(option)
  }

  const { texts, diffs } = parseToolContents(toolCall['content'])
  const request: ACPPermissionRequest = {
    id: randomUUID(),
    sessionId,
    chatId: null,
    title: nonEmpty(stringValue(toolCall['title'])) ?? '',
    content: { texts, diffs },
    locations: parseLocations(toolCall['locations']),
    options
  }
  const toolCallId = stringValue(toolCall['toolCallId'])
  if (toolCallId !== null) request.toolCallId = toolCallId
  const toolKind = stringValue(toolCall['kind'])
  if (toolKind !== null) request.toolKind = toolKind
  if (toolCall['rawInput'] !== undefined) request.rawInput = toolCall['rawInput']
  // compaction.go asks "compact now?" over this transport with its own ids
  // (`compact-N`) and options (`compact` / `continue`). Either gives it away.
  if (
    toolCallId?.startsWith('compact-') === true ||
    options.some((o) => o.optionId === 'compact')
  ) {
    request.variant = 'compact'
  }
  return request
}

// ---------------------------------------------------------------------------
// Agent questions (ACPQuestion.swift)
// ---------------------------------------------------------------------------

function parseQuestionOption(value: JSONValue): ACPQuestionOption | null {
  const obj = objectValue(value)
  if (!obj) return null
  const id = stringValue(obj['id'])
  const label = stringValue(obj['label'])
  if (id === null || label === null) return null
  const option: ACPQuestionOption = { id, label }
  const description = nonEmpty(stringValue(obj['description']))
  if (description !== null) option.description = description
  const preview = nonEmpty(stringValue(obj['preview']))
  if (preview !== null) option.preview = preview
  if (boolValue(obj['isRecommended']) === true) option.isRecommended = true
  return option
}

/** One question of a form (ACPQuestionItem.parse). A question with neither
 *  text nor options is nothing anyone can answer — null. */
function parseQuestionItem(value: JSONValue, index: number): ACPQuestion | null {
  const obj = objectValue(value)
  if (!obj) return null
  const question = nonEmpty(stringValue(obj['question']))
  const options = (arrayValue(obj['options']) ?? [])
    .map(parseQuestionOption)
    .filter((o): o is ACPQuestionOption => o !== null)
  if (question === null && options.length === 0) return null
  return {
    id: nonEmpty(stringValue(obj['id'])) ?? `q-${index}`,
    header: nonEmpty(stringValue(obj['header'])) ?? `Question ${index + 1}`,
    question: question ?? '',
    options,
    multiSelect: boolValue(obj['multiSelect']) ?? false,
    // A question with nothing to pick from can only be answered in the
    // user's own words, whatever the flag says.
    allowCustomInput: (boolValue(obj['allowCustomInput']) ?? false) || options.length === 0
  }
}

/** The form's questions, or the single question a version 1 payload spells
 *  out in its flat fields. */
function questionsFrom(payload: JSONObject): ACPQuestion[] {
  const array = arrayValue(payload['questions'])
  if (array && array.length > 0) {
    const parsed = array
      .map((v, i) => parseQuestionItem(v, i))
      .filter((q): q is ACPQuestion => q !== null)
    if (parsed.length > 0) return parsed
  }
  const flat = parseQuestionItem(payload, 0)
  return flat ? [flat] : []
}

/** Parses `_spettro/question/ask` params (v1 flat → one-question form; v2+
 *  carries `questions[]`). Null when there is no answerable question. */
export function parseQuestionRequest(params: JSONValue): ACPQuestionRequest | null {
  const payload = objectValue(params)
  if (!payload) return null
  const questions = questionsFrom(payload)
  if (questions.length === 0) return null
  const request: ACPQuestionRequest = {
    id: randomUUID(),
    version: intValue(payload['version']) ?? 1,
    chatId: null,
    questions
  }
  const sessionId = stringValue(payload['sessionId'])
  if (sessionId !== null) request.sessionId = sessionId
  const context = nonEmpty(stringValue(payload['context']))
  if (context !== null) request.context = context
  return request
}

/** The question a `session/request_permission` is really asking, or null for
 *  an ordinary permission prompt: the payload rides in
 *  `_meta["spettro.app/question"]` when an older CLI walks the form over the
 *  permission transport. Also resolves the synthetic "type my own answer"
 *  option id the reply must select for free-text answers. */
export function parseQuestionFromPermission(
  params: JSONValue
): { request: ACPQuestionRequest; customOptionId: string | null } | null {
  const obj = objectValue(params)
  if (!obj) return null
  const payload = objectValue(objectValue(obj['_meta'])?.['spettro.app/question'])
  if (!payload) return null
  const request = parseQuestionRequest(payload)
  if (!request) return null

  let customOptionId: string | null = null
  for (const opt of arrayValue(obj['options']) ?? []) {
    const o = objectValue(opt)
    if (!o) continue
    if (boolValue(objectValue(o['_meta'])?.['spettro.app/isCustomInput']) === true) {
      customOptionId = stringValue(o['optionId'])
      if (customOptionId !== null) break
    }
  }
  if (customOptionId === null && boolValue(payload['allowCustomInput']) === true) {
    customOptionId = 'custom'
  }
  return { request, customOptionId }
}

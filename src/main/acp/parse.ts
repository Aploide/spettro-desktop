// Wire parsers for the ACP surface Spettro drives — the TypeScript port of the
// hand-rolled `parse(_:)` functions in spettro-apple's ACPProtocol.swift and
// ACPQuestion.swift. Every function consumes a dynamic JSONValue and returns
// the shared typed shape (or null / drops malformed entries), never throwing:
// one bad option, command, or plan entry must not poison the whole update.

import { randomUUID } from 'node:crypto'
import type {
  ACPCommand,
  ACPConfigChoice,
  ACPConfigGroup,
  ACPConfigOption,
  ACPPermissionOption,
  ACPPermissionRequest,
  ACPPlanEntry,
  ACPQuestion,
  ACPQuestionOption,
  ACPQuestionRequest,
  ACPSessionUpdate,
  ACPToolCallEvent,
  ACPToolDiffContent,
  ACPToolStatus,
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

/** One tool-content item: a diff, a nested content block's text, or bare text. */
function parseToolContent(
  value: JSONValue
): { kind: 'text'; text: string } | { kind: 'diff'; diff: ACPToolDiffContent } | null {
  const obj = objectValue(value)
  if (!obj) return null
  if (stringValue(obj['type']) === 'diff') {
    const path = stringValue(obj['path'])
    const newText = stringValue(obj['newText'])
    if (path === null || newText === null) return null
    return { kind: 'diff', diff: { type: 'diff', path, oldText: stringValue(obj['oldText']), newText } }
  }
  // "content" wrapper holds a nested content block, usually text.
  const inner = objectValue(obj['content'])
  const innerText = inner ? stringValue(inner['text']) : null
  if (innerText !== null) return { kind: 'text', text: innerText }
  const bare = stringValue(obj['text'])
  if (bare !== null) return { kind: 'text', text: bare }
  return null
}

/** Parses a `tool_call` / `tool_call_update` payload. `toolCallId` required. */
export function parseToolCallEvent(value: JSONValue): ACPToolCallEvent | null {
  const obj = objectValue(value)
  if (!obj) return null
  const toolCallId = stringValue(obj['toolCallId'])
  if (toolCallId === null) return null

  const texts: string[] = []
  const diffs: ACPToolDiffContent[] = []
  for (const item of arrayValue(obj['content']) ?? []) {
    const parsed = parseToolContent(item)
    if (!parsed) continue
    if (parsed.kind === 'text') texts.push(parsed.text)
    else diffs.push(parsed.diff)
  }
  const locations = (arrayValue(obj['locations']) ?? [])
    .map((loc) => stringValue(objectValue(loc)?.['path']))
    .filter((p): p is string => p !== null)

  const event: ACPToolCallEvent = { toolCallId, texts, diffs, locations }
  const title = stringValue(obj['title'])
  if (title !== null) event.title = title
  const kind = stringValue(obj['kind'])
  if (kind !== null) event.kind = kind
  // Status: absent stays absent; present-but-unrecognized becomes 'unknown'.
  if (obj['status'] !== undefined) event.status = parseToolStatus(stringValue(obj['status']))
  if (obj['rawInput'] !== undefined) event.rawInput = obj['rawInput']
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
// Permission requests (ACPPermissionRequest.parse)
// ---------------------------------------------------------------------------

/** Parses `session/request_permission` params. `sessionId` and a `toolCall`
 *  object are required; malformed requests earn a -32602 from the connection. */
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

  const request: ACPPermissionRequest = {
    id: randomUUID(),
    sessionId,
    title: stringValue(toolCall['title']) ?? 'Permission requested',
    options
  }
  const toolKind = stringValue(toolCall['kind'])
  if (toolKind !== null) request.toolKind = toolKind
  if (toolCall['rawInput'] !== undefined) request.rawInput = toolCall['rawInput']
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

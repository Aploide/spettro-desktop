// Pure presentation derivations for tool calls — a faithful port of the
// computed properties on ToolCallItem in
// spettro-apple/Spettro/Model/TranscriptModels.swift. Everything the tool
// views show is derived here so the components stay free of parsing logic.

import type { JSONValue, ACPToolStatus } from '@shared/acp'
import type { ToolCallItem, ToolDiff } from '@shared/model'

// ---------------------------------------------------------------------------
// JSONValue accessors (port of JSONValue.swift's stringValue/intValue/…)
// ---------------------------------------------------------------------------

function stringValue(v: JSONValue | undefined): string | null {
  return typeof v === 'string' ? v : null
}

function isObject(v: JSONValue | undefined): v is { [key: string]: JSONValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Swift's `stringValue ?? intValue.map(String.init) ?? boolValue.map(String.init)`:
 *  a compact scalar rendering for the unknown-tool `key: value` pairs. */
function scalarString(v: JSONValue): string | null {
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(Math.trunc(v)) // JSONValue.intValue truncates doubles
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return null
}

function decodeObject(text: string | undefined | null): { [key: string]: JSONValue } | null {
  if (text == null) return null
  try {
    const v = JSON.parse(text) as JSONValue
    return isObject(v) ? v : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Title parsing
// ---------------------------------------------------------------------------

export interface ParsedTitle {
  /** The `[agent#n]` prefix content, when present. */
  agent: string | null
  name: string
  args: { [key: string]: JSONValue } | null
}

/**
 * The CLI titles tool calls as `name {json args}` (optionally prefixed with
 * `[agent#n] `). Split that back apart so the UI can show a verb and a
 * readable detail instead of a raw JSON blob. Prefers `argsJSON` (the
 * untruncated ACP rawInput) over the title's inline braces, because the CLI
 * truncates inline args at 120 chars, often leaving invalid JSON.
 */
export function parsedTitle(tool: Pick<ToolCallItem, 'title' | 'argsJSON'>): ParsedTitle {
  let text = tool.title
  let agent: string | null = null
  if (text.startsWith('[')) {
    const close = text.indexOf(']')
    if (close >= 0) {
      agent = text.slice(1, close)
      text = text.slice(close + 1).trim()
    }
  }
  const brace = text.indexOf('{')
  if (brace < 0) {
    const name = text.trim()
    return { agent, name, args: decodeObject(tool.argsJSON) }
  }
  const name = text.slice(0, brace).trim()
  // Prefer the untruncated rawInput; the title's inline args are cut at
  // 120 chars by the CLI and often aren't valid JSON anymore.
  const argsText = tool.argsJSON ?? text.slice(brace)
  const args = decodeObject(argsText)
  return { agent, name: name === '' ? tool.title : name, args }
}

/** First non-empty string value among a list of candidate argument keys. */
function argString(args: { [key: string]: JSONValue } | null, ...keys: string[]): string | null {
  if (!args) return null
  for (const key of keys) {
    const s = stringValue(args[key])
    if (s !== null && s !== '') return s
  }
  return null
}

// ---------------------------------------------------------------------------
// Icon + verb
// ---------------------------------------------------------------------------

export type ToolSymbol =
  | 'doc.text'
  | 'pencil'
  | 'trash'
  | 'arrow.right.doc.on.clipboard'
  | 'magnifyingglass'
  | 'terminal'
  | 'brain'
  | 'globe'
  | 'arrow.triangle.2.circlepath'
  | 'wrench.and.screwdriver'

/** Icon id chosen from the ACP tool kind (SF Symbol names kept as ids). */
export function symbolName(tool: Pick<ToolCallItem, 'kind'>): ToolSymbol {
  switch (tool.kind) {
    case 'read':
      return 'doc.text'
    case 'edit':
      return 'pencil'
    case 'delete':
      return 'trash'
    case 'move':
      return 'arrow.right.doc.on.clipboard'
    case 'search':
      return 'magnifyingglass'
    case 'execute':
      return 'terminal'
    case 'think':
      return 'brain'
    case 'fetch':
      return 'globe'
    case 'switch_mode':
      return 'arrow.triangle.2.circlepath'
    default:
      return 'wrench.and.screwdriver'
  }
}

/** Port of Swift's `String.capitalized`: word-wise Firstcap, rest lowered. */
function capitalized(s: string): string {
  return s
    .split(' ')
    .map((w) => (w === '' ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ')
}

/** A short verb for the row label, e.g. "Terminal" / "Read". */
export function displayName(tool: Pick<ToolCallItem, 'title' | 'argsJSON' | 'kind'>): string {
  const name = parsedTitle(tool).name
  switch (tool.kind) {
    case 'execute':
      return 'Terminal'
    case 'read':
      return 'Read'
    case 'edit':
      return 'Edit'
    case 'delete':
      return 'Delete'
    case 'move':
      return 'Move'
    case 'search':
      return name === 'ls' ? 'List' : 'Search'
    case 'fetch':
      return 'Fetch'
    case 'think':
      return name.startsWith('agent') ? 'Agent' : 'Plan'
    case 'switch_mode':
      return 'Mode'
    default:
      return name === '' ? 'Tool' : capitalized(name)
  }
}

// ---------------------------------------------------------------------------
// Detail line
// ---------------------------------------------------------------------------

/**
 * The one-line human detail: the shell command, the file's short path, the
 * search pattern — never raw JSON. Newlines collapse to " ⏎ " and a parsed
 * `[agent#n]` prefix is re-applied.
 */
export function displayDetail(
  tool: Pick<ToolCallItem, 'title' | 'argsJSON' | 'locations'>
): string {
  const { agent, name, args } = parsedTitle(tool)
  let detail: string
  switch (name) {
    case 'bash':
    case 'shell':
    case 'exec':
      detail = argString(args, 'command', 'cmd') ?? name
      break
    case 'agent': {
      const who = argString(args, 'agent') ?? 'agent'
      const task = argString(args, 'task') ?? ''
      detail = task === '' ? who : `${who}: ${task}`
      break
    }
    default: {
      const path =
        argString(args, 'path', 'file', 'file_path', 'filename') ??
        (tool.locations.length > 0 ? tool.locations[0] : null)
      if (path !== null) {
        detail = shortPath(path)
        const pattern = argString(args, 'pattern', 'query', 'regex')
        if (pattern !== null) detail = `${pattern} in ${detail}`
      } else {
        const fallback = argString(
          args,
          'content',
          'task',
          'description',
          'pattern',
          'query',
          'regex',
          'url',
          'job_id',
          'id',
          'name'
        )
        if (fallback !== null) {
          detail = fallback
        } else if (args && Object.keys(args).length > 0) {
          // Unknown tool: show compact `key: value` pairs, not JSON.
          detail = Object.entries(args)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, value]) => {
              const text = scalarString(value)
              return text === null ? null : `${key}: ${text}`
            })
            .filter((x): x is string => x !== null)
            .join(', ')
          if (detail === '') detail = name
        } else {
          detail = name === tool.title ? '' : name
        }
      }
    }
  }
  detail = detail.split('\n').join(' ⏎ ')
  if (agent !== null) detail = `[${agent}] ${detail}`
  return detail
}

/** Collapses an absolute path to its last few meaningful components:
 *  more than three `/`-separated components → the last three. */
export function shortPath(path: string): string {
  const parts = path.split('/').filter((p) => p !== '')
  if (parts.length <= 3) return path
  return parts.slice(-3).join('/')
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

export interface ChangedLines {
  old: string[]
  new: string[]
}

/**
 * The lines that actually changed: both sides with the common leading and
 * trailing lines stripped. Not a real diff, but tight enough that small
 * edits show only their changed region.
 */
export function changedLines(diff: ToolDiff): ChangedLines {
  const oldText = diff.oldText ?? ''
  const oldLines = oldText === '' ? [] : oldText.split('\n')
  const newLines = diff.newText === '' ? [] : diff.newText.split('\n')
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start += 1
  }
  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1
    newEnd -= 1
  }
  return { old: oldLines.slice(start, oldEnd), new: newLines.slice(start, newEnd) }
}

export interface DiffStat {
  added: number
  removed: number
}

/** Added/removed line counts across this call's diffs; null with no diffs. */
export function diffStat(tool: Pick<ToolCallItem, 'diffs'>): DiffStat | null {
  if (tool.diffs.length === 0) return null
  let added = 0
  let removed = 0
  for (const diff of tool.diffs) {
    const { old, new: nw } = changedLines(diff)
    removed += old.length
    added += nw.length
  }
  return { added, removed }
}

// ---------------------------------------------------------------------------
// Sub-agent calls
// ---------------------------------------------------------------------------

export interface SubAgentCall {
  agent: string
  task: string | null
}

export interface SubAgentResult {
  status: string
  summary: string
}

/**
 * Non-nil when this tool call spins up another agent (the `agent` tool).
 * Extraction fallbacks, in order: parsed args (`agent` / `task` keys), the
 * bare title form `agent <who>: <task>`, then a bare `agent` call.
 */
export function subAgentCall(
  tool: Pick<ToolCallItem, 'title' | 'argsJSON'>
): SubAgentCall | null {
  const { name, args } = parsedTitle(tool)
  if (!(name === 'agent' || name.startsWith('agent '))) return null
  const agent = argString(args, 'agent')
  if (agent !== null) {
    return { agent, task: argString(args, 'task') }
  }
  // Title form "agent explore: task text" without parseable args.
  if (name.startsWith('agent ')) {
    const rest = name.slice('agent '.length)
    const idx = rest.indexOf(':')
    if (idx < 0) return { agent: rest, task: null }
    const before = rest.slice(0, idx)
    const after = rest.slice(idx + 1)
    // Swift split(:maxSplits:1, omittingEmptySubsequences:) semantics.
    if (before === '') return { agent: after, task: null }
    return { agent: before, task: after.trim() }
  }
  return { agent: 'agent', task: null }
}

/**
 * The sub-agent's reported outcome, parsed from its JSON output
 * (`{"agent":…,"status":…,"summary":…}`). When the CLI has truncated the
 * output into invalid JSON, salvages the summary/status fields by hand.
 */
export function subAgentResult(
  tool: Pick<ToolCallItem, 'title' | 'argsJSON' | 'output'>
): SubAgentResult | null {
  if (subAgentCall(tool) === null || tool.output === '') return null
  try {
    const value = JSON.parse(tool.output) as JSONValue
    if (isObject(value)) {
      const summary = stringValue(value['summary']) ?? stringValue(value['output']) ?? ''
      if (summary !== '' || 'status' in value) {
        return { status: stringValue(value['status']) ?? 'ok', summary }
      }
    }
  } catch {
    // fall through to the salvage path
  }
  // The CLI truncates long outputs, leaving invalid JSON. Salvage the
  // summary field by hand so the card still shows the agent's report.
  const summary = extractJSONString('summary', tool.output)
  if (summary !== null) {
    const status = extractJSONString('status', tool.output) ?? 'ok'
    return { status, summary }
  }
  return null
}

/**
 * Pulls `"field":"…"` out of possibly-truncated JSON, unescaping the usual
 * sequences; reads to the closing quote or the end of the text.
 * Faithful port of TranscriptModels.swift's extractJSONString(field:from:).
 */
export function extractJSONString(field: string, text: string): string | null {
  const marker = `"${field}":"`
  const start = text.indexOf(marker)
  if (start < 0) return null
  let result = ''
  let escaped = false
  for (let i = start + marker.length; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      switch (ch) {
        case 'n':
          result += '\n'
          break
        case 't':
          result += '\t'
          break
        case 'r':
          break
        default:
          result += ch
      }
      escaped = false
    } else if (ch === '\\') {
      escaped = true
    } else if (ch === '"') {
      break
    } else {
      result += ch
    }
  }
  return result === '' ? null : result
}

// ---------------------------------------------------------------------------
// Shared conveniences
// ---------------------------------------------------------------------------

/** True for the states after which no further updates are expected. */
export function isTerminal(status: ACPToolStatus): boolean {
  return status === 'completed' || status === 'failed'
}

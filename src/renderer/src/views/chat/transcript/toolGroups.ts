// Folding runs of look-around calls into one line.
//
// An agent getting its bearings reads five files and greps twice before it
// does anything, and as seven rows that preamble pushes the edit it led to
// off the screen. Claude Code says "Read 5 files, searched 2 patterns" and
// lets you open it; this is that. Only *finished* reads and searches fold —
// a call still running stays a row of its own, so the live edge of the turn
// is always visible — and anything between them (a message, an edit, a
// command) ends the run, so the fold never hides the order things happened in.

import type { ToolCallItem } from '@shared/model'
import type { TranscriptRow } from './orchestration'
import { displayName, subAgentCall } from './toolPresentation'

/** A folded run of reads and searches. Its id is the first call's, so the row
 *  keeps its identity (and its open/closed state) as more calls join it. */
export interface ToolGroupRow {
  kind: 'tools'
  id: string
  tools: ToolCallItem[]
}

/** What the transcript draws: the folded rows, plus look-around groups. */
export type DisplayRow = TranscriptRow | ToolGroupRow

/** Calls a group never holds fewer of: one read is just a row. */
const MIN_GROUP = 2

const GROUPED_VERBS = new Set(['Read', 'Search', 'List'])

/** A finished read, search or listing that is nothing else besides. */
export function isGroupable(tool: ToolCallItem): boolean {
  if (tool.status !== 'completed') return false
  if (tool.kind !== 'read' && tool.kind !== 'search') return false
  if ((tool.images?.length ?? 0) > 0) return false
  if (subAgentCall(tool) !== null) return false
  return GROUPED_VERBS.has(displayName(tool))
}

/** Folds consecutive groupable tool rows (two or more) into one group row. */
export function groupToolRuns(rows: TranscriptRow[]): DisplayRow[] {
  const out: DisplayRow[] = []
  let run: Extract<TranscriptRow, { kind: 'item' }>[] = []
  const flush = (): void => {
    if (run.length >= MIN_GROUP) {
      const tools = run.map((row) => (row.item as { kind: 'tool'; tool: ToolCallItem }).tool)
      out.push({ kind: 'tools', id: `tools-${run[0].id}`, tools })
    } else {
      out.push(...run)
    }
    run = []
  }
  for (const row of rows) {
    if (row.kind === 'item' && row.item.kind === 'tool' && isGroupable(row.item.tool)) {
      run.push(row)
      continue
    }
    flush()
    out.push(row)
  }
  flush()
  return out
}

/** "Read 5 files", "Searched 3 patterns", or both: "Read 2 files, searched 1
 *  pattern". Clauses follow the order their first call happened in. */
export function groupSummary(tools: ToolCallItem[]): string {
  const counts = new Map<string, number>()
  for (const tool of tools) {
    const verb = displayName(tool)
    counts.set(verb, (counts.get(verb) ?? 0) + 1)
  }
  const clauses: string[] = []
  for (const [verb, n] of counts) {
    const plural = n === 1 ? '' : 's'
    if (verb === 'Read') clauses.push(`read ${n} file${plural}`)
    else if (verb === 'Search') clauses.push(`searched ${n} pattern${plural}`)
    else clauses.push(`listed ${n} folder${plural}`)
  }
  const text = clauses.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

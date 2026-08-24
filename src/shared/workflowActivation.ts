// Which phrases turn workflows on for a turn.
//
// A direct port of workflowActivationRes and WorkflowActivationSpans in the
// CLI's internal/agent/workflow.go, and it has to stay one: the highlight the
// user sees while typing is only honest if it is driven by the same match that
// decides whether the workflow tool is actually injected. A UI that lit up
// "use a workflow" while the CLI ignored it would be promising a mode the run
// never enters — which is worse than not highlighting at all.
//
// Every pattern is a phrase that only makes sense as a request for this
// feature. "our deploy workflow" and ".github/workflows" must stay quiet.

/** The shorthand. Spelled out rather than interpolated so a search for the
 *  word finds this file. */
export const WORKFLOW_KEYWORD = 'ultracode'

// JavaScript has no `\b` problem here — the Go patterns use \b throughout and
// the semantics match for these inputs, which are ASCII keywords surrounded by
// ordinary prose.
const ACTIVATION_PATTERNS: RegExp[] = [
  /\bultracode\b/gi,
  // "use a workflow", "write a multi-agent workflow", "set up a workflow".
  // An indefinite article only: "run the workflow" almost always means a CI
  // job or an already-named saved script.
  /\b(?:use|using|run|write|author|make|create|build|set ?up|start|launch|kick off|do this as|do it as)\s+(?:a|an|another)\s+(?:new\s+)?(?:multi[- ]?agent\s+|orchestration\s+)?workflow\b/gi,
  // "with workflows", "via workflows"
  /\b(?:use|using|run|with|via)\s+workflows\b/gi,
  // an explicit reference to the tool itself
  /\bworkflow tool\b/gi,
  // "fan this out across sub-agents"
  /\bfan\s+(?:this|that|it|them|the \w+)?\s*out\s+(?:across|over|to|into)\s+(?:\w+\s+){0,2}(?:sub-?)?agents?\b/gi,
  // "orchestrate this with subagents"
  /\borchestrate\s+(?:\w+\s+){0,3}(?:with|using|across|over)\s+(?:\w+\s+){0,2}(?:sub-?)?agents?\b/gi,
  // "multi-agent orchestration"
  /\bmulti[- ]?agent\s+(?:orchestration|workflow|pipeline|run)\b/gi
]

/** A half-open [start, end) range of `text` that activates workflows. */
export interface ActivationSpan {
  start: number
  end: number
}

/**
 * Every activating phrase in `text`, ordered and non-overlapping.
 *
 * The patterns overlap by design — "use a workflow" and "workflow tool" both
 * match inside "use a workflow tool" — so they are merged before being
 * returned. A renderer handed overlapping ranges would style the same
 * characters twice and nest its own markup inside itself.
 */
export function workflowActivationSpans(text: string): ActivationSpan[] {
  if (text === '') return []

  const found: ActivationSpan[] = []
  for (const pattern of ACTIVATION_PATTERNS) {
    // The patterns are module-level and /g, so lastIndex survives between
    // calls and would make the second search of the same string start
    // halfway through it.
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      if (match[0] === '') {
        pattern.lastIndex += 1
        continue
      }
      found.push({ start: match.index, end: match.index + match[0].length })
    }
  }
  if (found.length === 0) return []

  // Earliest first; on a tie the longer span leads, so the merge below absorbs
  // the shorter one instead of the other way round.
  found.sort((a, b) => (a.start !== b.start ? a.start - b.start : b.end - a.end))

  const merged: ActivationSpan[] = [found[0]]
  for (const span of found.slice(1)) {
    const last = merged[merged.length - 1]
    if (span.start <= last.end) {
      if (span.end > last.end) last.end = span.end
      continue
    }
    merged.push(span)
  }
  return merged
}

/** True when this text opts the turn into workflows. */
export function workflowRequested(text: string): boolean {
  return workflowActivationSpans(text).length > 0
}

/** A piece of `text` for rendering: the activating phrases and the prose
 *  between them, in order, covering the whole string exactly once. */
export interface ActivationPiece {
  text: string
  active: boolean
}

export function splitOnActivation(text: string): ActivationPiece[] {
  const spans = workflowActivationSpans(text)
  if (spans.length === 0) return text === '' ? [] : [{ text, active: false }]

  const pieces: ActivationPiece[] = []
  let cursor = 0
  for (const span of spans) {
    if (span.start > cursor) pieces.push({ text: text.slice(cursor, span.start), active: false })
    pieces.push({ text: text.slice(span.start, span.end), active: true })
    cursor = span.end
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), active: false })
  return pieces
}

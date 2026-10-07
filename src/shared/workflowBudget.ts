// Token-budget directives: "+500k", "+1.5m" written into a message.
//
// A direct port of budgetDirectiveRe, ParseBudgetDirective and
// BudgetDirectiveSpans in the CLI's internal/agent/workflow_budget.go, for the
// same reason workflowActivation.ts is one: the composer lights a directive up
// as it is typed, and that is only honest if the match is the one that decides
// the budget. A "+500k" the run would ignore must stay dark.
//
// A directive only does something when workflows are on for the message (the
// keyword, or Ultra), so callers decide whether to look for one at all — see
// budgetDirectivesLive.

import type { ActivationPiece, ActivationSpan } from './workflowActivation'
import { workflowActivationSpans, workflowRequested } from './workflowActivation'

/**
 * The Go pattern is `(?:^|\s)(\+(\d+(?:\.\d+)?)\s?([kKmM]))\b`. Go's `\s` is
 * ASCII whitespace only (`[\t\n\f\r ]`) where JavaScript's also takes a
 * no-break space and the rest of Unicode, so it is spelled out; `\d` and `\b`
 * are ASCII in both. It has to stand on its own — the start of the message or
 * whitespace before it — so "a+500k salary" and "C++" never read as one, and
 * the suffix is mandatory so a bare "+5" in arithmetic stays arithmetic.
 */
const BUDGET_DIRECTIVE = /(?:^|[\t\n\f\r ])(\+(\d+(?:\.\d+)?)[\t\n\f\r ]?([kKmM]))\b/g

/** maxBudgetDirective: a billion tokens. Anything larger is a typo. */
const MAX_BUDGET_DIRECTIVE = 1_000_000_000

interface Directive {
  span: ActivationSpan
  number: string
  suffix: string
}

function directives(text: string): Directive[] {
  const out: Directive[] = []
  if (text === '') return out
  // Module-level and /g, so lastIndex would otherwise survive between calls.
  BUDGET_DIRECTIVE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = BUDGET_DIRECTIVE.exec(text)) !== null) {
    // The directive is the match minus the whitespace before it, and always
    // ends where the match does (the \b after it is zero-width).
    const end = match.index + match[0].length
    out.push({ span: { start: end - match[1].length, end }, number: match[2], suffix: match[3] })
  }
  return out
}

/** Where each directive in `text` is, without the whitespace before it. */
export function budgetDirectiveSpans(text: string): ActivationSpan[] {
  return directives(text).map((directive) => directive.span)
}

/**
 * The token budget a directive in `text` asks for, or null when there is none.
 * When several appear, the last one wins: it is the user's most recent word on
 * the matter.
 */
export function parseBudgetDirective(text: string): number | null {
  const found = directives(text)
  if (found.length === 0) return null
  const last = found[found.length - 1]
  let n = Number.parseFloat(last.number)
  if (!Number.isFinite(n) || n <= 0) return null
  n *= last.suffix.toLowerCase() === 'm' ? 1_000_000 : 1_000
  if (n < 1) return null
  return Math.trunc(Math.min(n, MAX_BUDGET_DIRECTIVE))
}

/**
 * Whether a directive in this message would be honoured: workflows are on for
 * it, through the message's own words or a standing Ultra. The TUI asks the
 * same question (budgetDirectivesLive in internal/tui/timers.go).
 */
export function budgetDirectivesLive(text: string, ultraActive: boolean): boolean {
  if (ultraActive) return true
  return text.includes('+') && workflowRequested(text)
}

/**
 * splitOnActivation plus the budget directives, when `budgets` says they are
 * live: every lit range of `text` and the prose between them, in order,
 * covering the whole string exactly once. The two kinds never overlap in
 * practice ("+" is in no activating phrase), but they are merged rather than
 * trusted not to, since overlapping ranges would nest the markup.
 */
export function splitWorkflowInput(text: string, budgets: boolean): ActivationPiece[] {
  if (text === '') return []
  const spans = [...workflowActivationSpans(text), ...(budgets ? budgetDirectiveSpans(text) : [])]
  if (spans.length === 0) return [{ text, active: false }]
  spans.sort((a, b) => (a.start !== b.start ? a.start - b.start : b.end - a.end))
  const merged: ActivationSpan[] = [{ ...spans[0] }]
  for (const span of spans.slice(1)) {
    const last = merged[merged.length - 1]
    if (span.start <= last.end) {
      if (span.end > last.end) last.end = span.end
      continue
    }
    merged.push({ ...span })
  }
  const pieces: ActivationPiece[] = []
  let cursor = 0
  for (const span of merged) {
    if (span.start > cursor) pieces.push({ text: text.slice(cursor, span.start), active: false })
    pieces.push({ text: text.slice(span.start, span.end), active: true })
    cursor = span.end
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), active: false })
  return pieces
}

/**
 * A token count the way a directive spells it — 500k, 1.5m — as the CLI's
 * compactTokens (internal/acp/workflow.go) prints a run's budget: that is how
 * the user asked for it.
 */
export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${trimDecimals((n / 1_000_000).toFixed(2))}m`
  if (n >= 1_000) return `${trimDecimals((n / 1_000).toFixed(1))}k`
  return String(n)
}

function trimDecimals(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

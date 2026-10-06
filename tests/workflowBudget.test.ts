// The "+500k" budget directive, against the Go implementation.
//
// tests/go-budget-directives.json is a golden file produced by Go's regexp
// engine running the CLI's own pattern: the generator reads
// `budgetDirectiveRe` straight out of internal/agent/workflow_budget.go, then
// runs that file's ParseBudgetDirective and BudgetDirectiveSpans logic over
// each case and dumps the result (`pattern` in the file is what it read). If
// the Go pattern changes and the port does not, this fails — the only way to
// notice, because both sides keep working perfectly on their own while
// disagreeing about what a user asked for.
//
// To regenerate: a small `go run` program that does exactly that (read the
// pattern from the source, apply it to each case, marshal
// {spans, tokens}) — add cases to its list rather than only here, since a case
// the Go side was never asked about proves nothing.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  budgetDirectiveSpans,
  budgetDirectivesLive,
  compactTokens,
  parseBudgetDirective,
  splitWorkflowInput
} from '@shared/workflowBudget'

const GOLDEN: {
  pattern: string
  cases: Record<string, { spans: [number, number][]; tokens: number | null }>
} = JSON.parse(readFileSync(join(__dirname, 'go-budget-directives.json'), 'utf8'))

describe('the port agrees with the Go implementation', () => {
  const cases = Object.entries(GOLDEN.cases)

  it('was generated from the pattern this port was written against', () => {
    expect(GOLDEN.pattern).toBe('(?:^|\\s)(\\+(\\d+(?:\\.\\d+)?)\\s?([kKmM]))\\b')
    expect(cases.length).toBeGreaterThan(20)
  })

  for (const [text, want] of cases) {
    it(`matches on ${JSON.stringify(text)}`, () => {
      // Every case is in the Basic Multilingual Plane, where Go's rune offsets
      // and JavaScript's UTF-16 ones are the same numbers.
      expect(budgetDirectiveSpans(text).map((s) => [s.start, s.end])).toEqual(want.spans)
      expect(parseBudgetDirective(text)).toBe(want.tokens)
    })
  }
})

describe('when a directive counts', () => {
  it('only beside workflows: the message’s own words, or a standing Ultra', () => {
    expect(budgetDirectivesLive('review this +500k', false)).toBe(false)
    expect(budgetDirectivesLive('ultracode: review this +500k', false)).toBe(true)
    expect(budgetDirectivesLive('review this +500k', true)).toBe(true)
  })

  it('lights the directive only when it counts', () => {
    const lit = (text: string, budgets: boolean): string[] =>
      splitWorkflowInput(text, budgets)
        .filter((p) => p.active)
        .map((p) => p.text)
    expect(lit('ultracode +1.5m go', true)).toEqual(['ultracode', '+1.5m'])
    expect(lit('ultracode +1.5m go', false)).toEqual(['ultracode'])
    // Covers the whole string exactly once, whatever is lit.
    const text = 'use a workflow +200k and +300k'
    expect(splitWorkflowInput(text, true).map((p) => p.text).join('')).toBe(text)
  })
})

describe('compactTokens', () => {
  it('spells a budget the way the CLI prints it (workflow.go compactTokens)', () => {
    expect(compactTokens(500_000)).toBe('500k')
    expect(compactTokens(1_500_000)).toBe('1.5m')
    expect(compactTokens(1_000_000)).toBe('1m')
    expect(compactTokens(1_250_000)).toBe('1.25m')
    expect(compactTokens(1_500)).toBe('1.5k')
    expect(compactTokens(950)).toBe('950')
  })
})

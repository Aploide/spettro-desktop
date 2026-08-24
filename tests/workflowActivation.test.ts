// The activation matcher is a port, and the whole value of the highlight rests
// on the port being faithful: the words that light up in the composer are a
// promise that this turn can orchestrate, and the CLI is what decides whether
// it actually can. A pattern that drifts from internal/agent/workflow.go makes
// the input lie in one direction or the other.
//
// The negative cases matter as much as the positive ones. "our deploy
// workflow" and ".github/workflows" appear constantly in this domain, and
// lighting them up would train people to ignore the effect.

import { describe, expect, it } from 'vitest'
import {
  splitOnActivation,
  workflowActivationSpans,
  workflowRequested,
  WORKFLOW_KEYWORD
} from '@shared/workflowActivation'

function lit(text: string): string[] {
  return splitOnActivation(text)
    .filter((p) => p.active)
    .map((p) => p.text)
}

describe('the keyword', () => {
  it('activates on its own and anywhere in a sentence', () => {
    expect(workflowRequested('ultracode')).toBe(true)
    expect(workflowRequested('please ultracode this refactor')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(lit('ULTRACODE and ultracode twice')).toEqual(['ULTRACODE', 'ultracode'])
  })

  it('does not fire inside a longer word', () => {
    // The Go patterns are \b-anchored; "ultracoded" is not the keyword.
    expect(workflowRequested('an ultracoded word must not light up')).toBe(false)
  })

  it('is exported so a search for the word finds the port', () => {
    expect(WORKFLOW_KEYWORD).toBe('ultracode')
  })
})

describe('plain-English requests', () => {
  it.each([
    'use a workflow to modernise these handlers',
    'write a multi-agent workflow for this',
    'set up a workflow',
    'can you create an orchestration workflow',
    'do this with workflows',
    'run it via workflows',
    'reach for the workflow tool here',
    'fan this out across sub-agents',
    'fan it out over agents',
    'orchestrate this with subagents',
    'multi-agent orchestration please',
    'multi agent pipeline'
  ])('activates on %j', (text) => {
    expect(workflowRequested(text)).toBe(true)
  })
})

describe('phrases that must stay quiet', () => {
  it.each([
    'our deploy workflow is broken',
    'check .github/workflows for the CI config',
    'run the workflow again',
    'the workflow failed last night',
    'what does this workflow do',
    'add a workflow_dispatch trigger',
    'agents are useful',
    'this is a normal message'
  ])('ignores %j', (text) => {
    expect(workflowRequested(text)).toBe(false)
  })

  it('wants an indefinite article, because "the workflow" is a CI job', () => {
    expect(workflowRequested('use a workflow')).toBe(true)
    expect(workflowRequested('use the workflow')).toBe(false)
  })
})

describe('overlapping matches', () => {
  it('merges into one span rather than styling the same text twice', () => {
    // "use a workflow" and "workflow tool" both match inside this. Handing a
    // renderer two overlapping ranges would nest its markup inside itself.
    const spans = workflowActivationSpans('use a workflow tool for this')
    expect(spans).toHaveLength(1)
    expect(spans[0]).toEqual({ start: 0, end: 19 })
  })

  it('keeps separate phrases separate', () => {
    expect(lit('ultracode, then use a workflow')).toEqual(['ultracode', 'use a workflow'])
  })

  it('returns spans in order', () => {
    const spans = workflowActivationSpans('use a workflow and then ultracode')
    expect(spans.map((s) => s.start)).toEqual([...spans.map((s) => s.start)].sort((a, b) => a - b))
  })
})

describe('splitOnActivation', () => {
  it('covers the input exactly once, in order', () => {
    // The renderer concatenates these; anything dropped or duplicated is text
    // the user typed appearing wrong on screen.
    const text = 'ultracode: review the changes and use a workflow for the port'
    expect(splitOnActivation(text).map((p) => p.text).join('')).toBe(text)
  })

  it('keeps the punctuation that follows a phrase', () => {
    // A regression: the colon after "ultracode" was being painted over by the
    // highlight's own backing pill, which is a rendering bug — but the split
    // has to put it in a piece of its own for the fix to be possible at all.
    const pieces = splitOnActivation('ultracode: go')
    expect(pieces[0]).toEqual({ text: 'ultracode', active: true })
    expect(pieces[1].text.startsWith(':')).toBe(true)
  })

  it('handles a phrase at the very start and the very end', () => {
    expect(splitOnActivation('ultracode')).toEqual([{ text: 'ultracode', active: true }])
    expect(lit('now ultracode')).toEqual(['ultracode'])
  })

  it('is empty for empty input', () => {
    expect(splitOnActivation('')).toEqual([])
    expect(workflowActivationSpans('')).toEqual([])
  })

  it('returns one inactive piece when nothing matches', () => {
    expect(splitOnActivation('hello')).toEqual([{ text: 'hello', active: false }])
  })
})

describe('repeated calls', () => {
  it('does not let a /g regex carry lastIndex between calls', () => {
    // The patterns are module-level and global. Without an explicit reset the
    // second search of the same string starts halfway through it and the
    // highlight flickers off on every other keystroke.
    const text = 'ultracode now'
    expect(workflowActivationSpans(text)).toEqual(workflowActivationSpans(text))
    expect(workflowActivationSpans(text)).toHaveLength(1)
  })
})

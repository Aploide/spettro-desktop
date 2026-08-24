// The `_spettro/*` decoders sit on the seam between two codebases: whatever
// the Go side puts on the wire, these have to turn into something the UI can
// render, including when the CLI is older or newer than the app. Their
// leniency is the point, so what is worth testing is where the leniency
// deliberately stops.

import { describe, expect, it } from 'vitest'
import {
  decodeWorkflowInfo,
  decodeWorkflowList,
  decodeWorkflowRuns,
  decodeWorkflowSource,
  decodeWorkflowValidation
} from '@main/acp/extensions'

describe('decodeWorkflowValidation', () => {
  it('reads a clean compile', () => {
    const v = decodeWorkflowValidation({
      ok: true,
      name: 'review',
      description: 'd',
      whenToUse: 'w',
      phases: [{ title: 'Review', detail: 'x' }]
    })
    expect(v.ok).toBe(true)
    expect(v.error).toBeNull()
    expect(v.phases).toEqual([{ title: 'Review', detail: 'x' }])
  })

  it('defaults ok to FALSE when the field is missing', () => {
    // The single most load-bearing default in this file. Defaulting to true
    // would let a decoding slip read as a clean compile, and the very next
    // thing the studio does with a clean compile is save the script.
    expect(decodeWorkflowValidation({}).ok).toBe(false)
    expect(decodeWorkflowValidation({ error: 'boom' }).ok).toBe(false)
  })

  it('keeps the compile error verbatim', () => {
    const v = decodeWorkflowValidation({ ok: false, error: "SyntaxError: Unexpected token '}'" })
    expect(v.error).toBe("SyntaxError: Unexpected token '}'")
  })
})

describe('decodeWorkflowInfo', () => {
  it('reads a project workflow', () => {
    const info = decodeWorkflowInfo({
      name: 'review',
      path: '/p/.spettro/workflows/review.js',
      scope: 'project',
      description: 'd',
      phases: [{ title: 'A' }]
    })
    expect(info.scope).toBe('project')
    expect(info.phases).toEqual([{ title: 'A', detail: '' }])
  })

  it('treats any unrecognised scope as project', () => {
    // Guessing "global" would offer to write into the user's home directory
    // for a workflow that belongs to a repo; guessing "project" cannot leave
    // the folder they are already working in.
    expect(decodeWorkflowInfo({ name: 'x', scope: 'nonsense' }).scope).toBe('project')
    expect(decodeWorkflowInfo({ name: 'x' }).scope).toBe('project')
  })

  it('distinguishes "no error" from "an empty error"', () => {
    // null means nobody reported a problem; "" would read as a problem with
    // nothing to say, and the list draws a `broken` pill off this field.
    expect(decodeWorkflowInfo({ name: 'x' }).error).toBeNull()
    expect(decodeWorkflowInfo({ name: 'x', error: 'SyntaxError' }).error).toBe('SyntaxError')
  })

  it('drops a phase with no title rather than rendering a blank row', () => {
    const info = decodeWorkflowInfo({ name: 'x', phases: [{ detail: 'orphan' }, { title: 'Real' }] })
    expect(info.phases).toEqual([{ title: 'Real', detail: '' }])
  })
})

describe('decodeWorkflowList', () => {
  it('reads the list and the folders it would save into', () => {
    const list = decodeWorkflowList({
      workflows: [{ name: 'a', scope: 'project' }],
      searchPaths: ['/p/.spettro/workflows', '/h/.spettro/workflows'],
      cwd: '/p'
    })
    expect(list.workflows).toHaveLength(1)
    expect(list.searchPaths[0]).toBe('/p/.spettro/workflows')
    expect(list.cwd).toBe('/p')
  })

  it('answers an empty project without throwing', () => {
    const list = decodeWorkflowList({})
    expect(list.workflows).toEqual([])
    expect(list.searchPaths).toEqual([])
  })

  it('ignores a non-string search path instead of rendering undefined', () => {
    const list = decodeWorkflowList({ searchPaths: ['/good', 42, null] })
    expect(list.searchPaths).toEqual(['/good'])
  })
})

describe('decodeWorkflowSource', () => {
  it('carries the script alongside the parsed header', () => {
    const source = decodeWorkflowSource({
      name: 'review',
      scope: 'project',
      script: 'export const meta = {}\n',
      phases: [{ title: 'A' }]
    })
    expect(source.script).toBe('export const meta = {}\n')
    expect(source.phases).toHaveLength(1)
  })

  it('gives the editor an empty buffer rather than undefined', () => {
    expect(decodeWorkflowSource({ name: 'x' }).script).toBe('')
  })
})

describe('decodeWorkflowRuns', () => {
  it('reads recent run transcripts', () => {
    const runs = decodeWorkflowRuns({
      runs: [{ runId: 'wf_1', dir: '/d/wf_1', modifiedAt: 1700000000000 }]
    })
    expect(runs).toEqual([{ runId: 'wf_1', dir: '/d/wf_1', modifiedAt: 1700000000000 }])
  })

  it('drops an entry with no run id, since resume is keyed on it', () => {
    const runs = decodeWorkflowRuns({ runs: [{ dir: '/d' }, { runId: 'wf_2' }] })
    expect(runs.map((r) => r.runId)).toEqual(['wf_2'])
  })

  it('answers an absent list with an empty one', () => {
    expect(decodeWorkflowRuns({})).toEqual([])
  })
})

// The tool-call presentation layer turns the CLI's title/args conventions into
// what a row actually says. It is all string surgery against formats defined
// in another language in another repo, which is exactly the kind of code that
// rots quietly: a change to internal/acp/content.go's title format shows up
// here as a row that reads slightly wrong, not as a crash.

import { describe, expect, it } from 'vitest'
import type { ToolCallItem } from '@shared/model'
import {
  changedLines,
  diffStat,
  displayDetail,
  displayName,
  extractJSONString,
  isTerminal,
  parsedTitle,
  shortPath,
  subAgentCall,
  subAgentResult
} from '@renderer/views/chat/transcript/toolPresentation'

const base = { locations: [] as ToolCallItem['locations'], diffs: [], output: '' }

describe('parsedTitle', () => {
  it('splits the CLI’s `name {args}` form', () => {
    const parsed = parsedTitle({ title: 'bash {"command":"ls"}', argsJSON: undefined })
    expect(parsed.name).toBe('bash')
    expect(parsed.args?.['command']).toBe('ls')
  })

  it('prefers argsJSON over the title’s inline args', () => {
    // The CLI truncates inline args at 120 chars, which regularly leaves
    // invalid JSON. rawInput is the untruncated copy and must win.
    const parsed = parsedTitle({
      title: 'bash {"command":"rg -n very long thing that got cut…',
      argsJSON: '{"command":"rg -n complete"}'
    })
    expect(parsed.args?.['command']).toBe('rg -n complete')
  })

  it('lifts the [instance] prefix off the front', () => {
    const parsed = parsedTitle({ title: '[code#3] bash {"command":"ls"}', argsJSON: undefined })
    expect(parsed.agent).toBe('code#3')
    expect(parsed.name).toBe('bash')
  })

  it('survives args that are not JSON at all', () => {
    const parsed = parsedTitle({ title: 'weird {not json', argsJSON: '{also not json' })
    expect(parsed.name).toBe('weird')
    expect(parsed.args).toBeNull()
  })
})

describe('displayName', () => {
  it('names a tool by its ACP kind, not its id', () => {
    expect(displayName({ title: 'bash {}', kind: 'execute', argsJSON: undefined })).toBe('Terminal')
    expect(displayName({ title: 'file-read {}', kind: 'read', argsJSON: undefined })).toBe('Read')
    expect(displayName({ title: 'ls {}', kind: 'search', argsJSON: undefined })).toBe('List')
  })

  it('tells a thinking agent call from a thinking plan call', () => {
    expect(displayName({ title: 'agent code#1: x', kind: 'think', argsJSON: undefined })).toBe('Agent')
    expect(displayName({ title: 'plan {}', kind: 'think', argsJSON: undefined })).toBe('Plan')
  })
})

describe('displayDetail', () => {
  it('shows a command, a path or a pattern — never raw JSON', () => {
    expect(displayDetail({ ...base, title: 'bash {}', argsJSON: '{"command":"npm test"}' })).toBe(
      'npm test'
    )
    expect(
      displayDetail({ ...base, title: 'read {}', argsJSON: '{"file_path":"/a/b/c/d/e.ts"}' })
    ).toBe('c/d/e.ts')
  })

  it('collapses newlines so a row cannot grow a second line', () => {
    const detail = displayDetail({ ...base, title: 'bash {}', argsJSON: '{"command":"a\\nb"}' })
    expect(detail).not.toContain('\n')
    expect(detail).toContain('⏎')
  })

  it('falls back to key: value pairs for a tool it has never seen', () => {
    const detail = displayDetail({ ...base, title: 'mystery {}', argsJSON: '{"b":2,"a":"x"}' })
    expect(detail).toBe('a: x, b: 2')
  })
})

describe('shortPath', () => {
  it('keeps the last three components of a long path', () => {
    expect(shortPath('/one/two/three/four/five.ts')).toBe('three/four/five.ts')
  })

  it('leaves a short path alone', () => {
    expect(shortPath('src/a.ts')).toBe('src/a.ts')
  })
})

describe('subAgentCall', () => {
  it('reads agent and task out of the args', () => {
    const call = subAgentCall({
      title: 'agent code#1: fix the tests',
      argsJSON: '{"agent":"code#1","task":"fix the tests"}'
    })
    expect(call).toEqual({ agent: 'code#1', task: 'fix the tests' })
  })

  it('falls back to the bare title form when args are unusable', () => {
    const call = subAgentCall({ title: 'agent explore: map it', argsJSON: undefined })
    expect(call?.agent).toBe('explore')
    expect(call?.task).toBe('map it')
  })

  it('is null for a tool that is not a delegation', () => {
    expect(subAgentCall({ title: 'bash {}', argsJSON: '{}' })).toBeNull()
  })
})

describe('subAgentResult', () => {
  it('reads the {agent,status,summary} report', () => {
    const result = subAgentResult({
      title: 'agent code#1: t',
      argsJSON: '{"agent":"code#1"}',
      output: '{"agent":"code#1","status":"ok","summary":"all good"}'
    })
    expect(result).toEqual({ status: 'ok', summary: 'all good' })
  })

  it('salvages a summary out of JSON the CLI truncated mid-string', () => {
    // Long outputs are cut to 600 chars, which routinely leaves invalid JSON.
    // Giving up there would blank a card that is holding the agent's answer.
    const result = subAgentResult({
      title: 'agent code#1: t',
      argsJSON: '{"agent":"code#1"}',
      output: '{"agent":"code#1","status":"error","summary":"it broke while doing the thing'
    })
    expect(result?.summary).toContain('it broke')
    expect(result?.status).toBe('error')
  })

  it('is null for a structured result that is not a report', () => {
    // This is the case that made completed members render empty until
    // MemberCall.resultText was added — the parse is *correct* to refuse it.
    expect(
      subAgentResult({
        title: 'agent code#1: t',
        argsJSON: '{"agent":"code#1"}',
        output: '{"content":"beta","file":"b.txt"}'
      })
    ).toBeNull()
  })
})

describe('extractJSONString', () => {
  it('unescapes the sequences the CLI emits', () => {
    expect(extractJSONString('summary', '{"summary":"line\\none\\ttab"}')).toBe('line\none\ttab')
  })

  it('reads to the end when the closing quote never arrives', () => {
    expect(extractJSONString('summary', '{"summary":"cut off here')).toBe('cut off here')
  })

  it('is null when the field is absent', () => {
    expect(extractJSONString('summary', '{"other":"x"}')).toBeNull()
  })
})

describe('diffs', () => {
  it('strips the common head and tail so only the change shows', () => {
    const changed = changedLines({
      path: 'a.ts',
      oldText: 'keep\nold\nkeep',
      newText: 'keep\nnew\nkeep'
    })
    expect(changed.old).toEqual(['old'])
    expect(changed.new).toEqual(['new'])
  })

  it('treats a new file as all additions', () => {
    const changed = changedLines({ path: 'a.ts', oldText: null, newText: 'a\nb' })
    expect(changed.old).toEqual([])
    expect(changed.new).toEqual(['a', 'b'])
  })

  it('sums added and removed across every diff on the call', () => {
    const stat = diffStat({
      diffs: [
        { path: 'a', oldText: 'x', newText: 'y' },
        { path: 'b', oldText: null, newText: 'p\nq' }
      ]
    })
    expect(stat).toEqual({ added: 3, removed: 1 })
  })

  it('is null with no diffs, so a row shows no stat rather than +0 -0', () => {
    expect(diffStat({ diffs: [] })).toBeNull()
  })
})

describe('isTerminal', () => {
  it('is true only for states after which nothing more arrives', () => {
    expect(isTerminal('completed')).toBe(true)
    expect(isTerminal('failed')).toBe(true)
    expect(isTerminal('in_progress')).toBe(false)
    expect(isTerminal('pending')).toBe(false)
  })
})

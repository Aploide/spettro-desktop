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
  exitCode,
  extractJSONString,
  isTerminal,
  middleTruncate,
  parsedTitle,
  ROW_ARGUMENT_MAX,
  rowArgument,
  rowMeta,
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
  const verb = (title: string, kind: string): string =>
    displayName({ title, kind, argsJSON: undefined })

  it('names a tool by its ACP kind, not its id', () => {
    // internal/acp/tools.go builtinToolKinds.
    expect(verb('bash {}', 'execute')).toBe('Bash')
    expect(verb('file-read {}', 'read')).toBe('Read')
    expect(verb('grep {}', 'search')).toBe('Search')
    expect(verb('glob {}', 'search')).toBe('Search')
    expect(verb('web-fetch {}', 'fetch')).toBe('Fetch')
  })

  it('tells the members of a kind apart where they read differently', () => {
    expect(verb('file-write {}', 'edit')).toBe('Write')
    expect(verb('file-edit {}', 'edit')).toBe('Edit')
    expect(verb('ls {}', 'search')).toBe('List')
    expect(verb('web-search {}', 'fetch')).toBe('Web search')
    expect(verb('pty-start {}', 'execute')).toBe('Terminal')
    expect(verb('view-image {}', 'read')).toBe('View')
  })

  it('tells a thinking agent call from other thinking calls', () => {
    expect(verb('agent code#1: x', 'think')).toBe('Agent')
    expect(verb('todo-write {}', 'think')).toBe('Todos')
    expect(verb('goal-complete {}', 'think')).toBe('Think')
  })

  it('capitalises an unknown tool’s own name', () => {
    expect(verb('mcp-github_search {}', 'other')).toBe('Mcp-github_search')
  })
})

describe('middleTruncate', () => {
  it('leaves text that fits alone', () => {
    expect(middleTruncate('npm test', 20)).toBe('npm test')
  })

  it('cuts the middle, keeping both ends, to exactly the limit', () => {
    const cut = middleTruncate('src/components/settings/forms/SaveButton.tsx', 20)
    expect(Array.from(cut)).toHaveLength(20)
    expect(cut.startsWith('src/compo')).toBe(true)
    expect(cut.endsWith('Button.tsx')).toBe(true)
    expect(cut).toContain('…')
  })

  it('counts characters, not UTF-16 units, so it never splits a glyph', () => {
    const cut = middleTruncate('🙂'.repeat(10), 5)
    expect(Array.from(cut)).toHaveLength(5)
    expect(cut).toBe('🙂🙂…🙂🙂')
  })
})

describe('rowArgument', () => {
  const row = (title: string, kind: string, args: object) =>
    rowArgument({ title, kind, argsJSON: JSON.stringify(args), locations: [] })

  it('shows a file by its name, the full path being in the panel', () => {
    expect(row('file-read {}', 'read', { path: '/home/u/app/src/components/SaveButton.tsx' })).toBe(
      'SaveButton.tsx'
    )
  })

  it('shows a command’s first line, marking that there is more', () => {
    expect(row('bash {}', 'execute', { command: 'npm test' })).toBe('npm test')
    expect(row('bash {}', 'execute', { command: 'cd web\nnpm test' })).toBe('cd web …')
  })

  it('shows a search as its pattern and where it looked', () => {
    expect(row('grep {}', 'search', { pattern: 'SaveButton', path: '/home/u/app/src' })).toBe(
      'SaveButton in src'
    )
  })

  it('drops the [agent#n] prefix — the row is already nested under that agent', () => {
    expect(row('[code#3] web-fetch {}', 'fetch', { url: 'https://example.com' })).toBe(
      'https://example.com'
    )
  })

  it('cuts a long argument in the middle', () => {
    const long = `npm run build -- --filter ${'x'.repeat(100)} --verbose`
    const text = row('bash {}', 'execute', { command: long })
    expect(Array.from(text)).toHaveLength(ROW_ARGUMENT_MAX)
    expect(text.endsWith('--verbose')).toBe(true)
  })
})

describe('the ask-user row', () => {
  it('reads "Ask" and the question, not "Ask The User  Ask the user"', () => {
    const tool = {
      title: 'Ask the user',
      kind: 'other',
      locations: [],
      argsJSON: JSON.stringify({ questions: [{ header: 'Filename', question: 'Which filename should I use?' }] })
    }
    expect(displayName(tool)).toBe('Ask')
    expect(rowArgument(tool)).toBe('Which filename should I use?')
  })
})

describe('rowMeta', () => {
  const meta = (title: string, kind: string, status: ToolCallItem['status'], output: string) =>
    rowMeta({ title, kind, status, output, argsJSON: undefined })

  it('says how much a read or a search returned', () => {
    expect(meta('file-read {}', 'read', 'completed', 'a\nb\nc\n')).toBe('3 lines')
    expect(meta('grep {}', 'search', 'completed', 'a.ts:1\nb.ts:2')).toBe('2 results')
    expect(meta('grep {}', 'search', 'completed', 'No matches found')).toBe('no results')
  })

  it('gives a failed command its exit status (llm_runtime_shell.go)', () => {
    expect(meta('bash {}', 'execute', 'failed', 'FAIL src/a.test.ts\n[exit status 1]')).toBe('exit 1')
    expect(meta('bash {}', 'execute', 'failed', 'killed')).toBe('failed')
    expect(meta('bash {}', 'execute', 'completed', 'ok')).toBeNull()
  })

  it('calls a call the user turned down "denied", not failed', () => {
    expect(rowMeta({ title: 'file-write {}', kind: 'edit', status: 'failed', output: '', denied: true })).toBe('denied')
  })

  it('says nothing while the call is still running', () => {
    expect(meta('file-read {}', 'read', 'in_progress', 'a\nb')).toBeNull()
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

  it('names a file in the chat’s folder from there', () => {
    expect(shortPath('/tmp/sd-live/WP10/proj/hello.txt', '/tmp/sd-live/WP10/proj')).toBe('hello.txt')
    expect(shortPath('/w/acme/src/deep/x.ts', '/w/acme/')).toBe('src/deep/x.ts')
    // Outside it, the last three as before.
    expect(shortPath('/etc/a/b/c.conf', '/w/acme')).toBe('a/b/c.conf')
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

  it('counts a real diff: unchanged lines between two edits are not churn', () => {
    // The old head/tail strip counted "keep" as removed and added again.
    const stat = diffStat({
      diffs: [{ path: 'a', oldText: 'one\nkeep\nkeep\nkeep\ntwo\n', newText: 'ONE\nkeep\nkeep\nkeep\nTWO\n' }]
    })
    expect(stat).toEqual({ added: 2, removed: 2 })
  })

  it('reads the exit status off the end of a command’s output', () => {
    expect(exitCode('boom\n[exit status 2]\n')).toBe(2)
    expect(exitCode('all good')).toBeNull()
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

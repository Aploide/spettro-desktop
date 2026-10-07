// @-mentions, end to end without a DOM: finding the "@query" under the
// caret, ranking the project's files, the text a pick leaves behind, which
// mentions are still in the text when it is sent — and, in the main process,
// the content blocks that text becomes (promptBlocks) and the file list the
// menu searches (projectFiles). A menu that inserts the wrong path, or a
// prompt that sends a mention twice, draws perfectly.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  insertMention,
  liveMentions,
  mentionAt,
  projectFiles,
  rankFiles,
  splitMentions
} from '@renderer/views/chat/mentions'
import { cleanMention, promptBlocks } from '@main/model/promptBlocks'
import { walkFiles } from '@main/model/projectFiles'

describe('the "@query" under the caret', () => {
  it('starts at an @ at the start or after whitespace', () => {
    expect(mentionAt('@sav', 4)).toEqual({ start: 0, query: 'sav' })
    expect(mentionAt('look at @src/sa', 15)).toEqual({ start: 8, query: 'src/sa' })
    expect(mentionAt('look at @', 9)).toEqual({ start: 8, query: '' })
  })

  it('is not an e-mail address, and ends at whitespace', () => {
    expect(mentionAt('mail me@host', 12)).toBeNull()
    expect(mentionAt('@src done', 9)).toBeNull()
    expect(mentionAt('no mention', 10)).toBeNull()
  })

  it('reads only up to the caret', () => {
    expect(mentionAt('@savebutton', 4)).toEqual({ start: 0, query: 'sav' })
  })
})

describe('picking a file', () => {
  it('replaces the query with the path and a space, caret after it', () => {
    const out = insertMention('compare @sav', 8, 12, 'src/SaveButton.tsx')
    expect(out.text).toBe('compare @src/SaveButton.tsx ')
    expect(out.caret).toBe(out.text.length)
  })

  it('keeps the text after the caret, without doubling its space', () => {
    const out = insertMention('see @sa and more', 4, 7, 'a.ts')
    expect(out.text).toBe('see @a.ts and more')
    expect(out.text.slice(out.caret)).toBe('and more')
  })
})

describe('ranking files', () => {
  const files = [
    'src/bootstrap/tsconfig.json',
    'src/components/SaveButton.tsx',
    'src/components/SaveButton.test.tsx',
    'src/views/SettingsForm.tsx',
    'README.md'
  ]

  it('puts a name match first', () => {
    expect(rankFiles(files, 'savebutton')[0]).toBe('src/components/SaveButton.tsx')
    expect(rankFiles(files, 'settings')[0]).toBe('src/views/SettingsForm.tsx')
  })

  it('matches scattered letters in order, word starts first', () => {
    const ranked = rankFiles(files, 'sbt')
    expect(ranked[0]).toBe('src/components/SaveButton.tsx')
    expect(rankFiles(files, 'zzz')).toEqual([])
  })

  it('shows the top of the project for a bare "@"', () => {
    expect(rankFiles(files, '', 2)).toEqual(['README.md', 'src/views/SettingsForm.tsx'])
  })
})

describe('mentions in the text', () => {
  it('are live only while "@path" is still written, whole', () => {
    expect(liveMentions('see @a.ts, then @b.ts', ['a.ts', 'b.ts', 'c.ts'])).toEqual(['a.ts', 'b.ts'])
    // Edited into a different path: no longer the file that was picked.
    expect(liveMentions('see @a.tsx', ['a.ts'])).toEqual([])
    expect(liveMentions('see @a.ts.', ['a.ts'])).toEqual(['a.ts'])
  })

  it('split out as chips, longest path first', () => {
    expect(splitMentions('@src/a.ts and @src/a', ['src/a', 'src/a.ts'])).toEqual([
      { text: '@src/a.ts', mention: true },
      { text: ' and ', mention: false },
      { text: '@src/a', mention: true }
    ])
  })
})

describe('the content blocks a message becomes', () => {
  const root = '/home/me/proj'
  const link = (rel: string): object => ({
    type: 'resource_link',
    uri: pathToFileURL(join(root, rel)).href,
    name: rel
  })

  it('puts each link where its mention was typed, and the text around it', () => {
    expect(promptBlocks('fix @src/a.ts please', [], ['src/a.ts'], root)).toEqual([
      { type: 'text', text: 'fix ' },
      link('src/a.ts'),
      { type: 'text', text: ' please' }
    ])
  })

  it('needs no words around a lone mention', () => {
    // content.go writes the link as "@<path>": text enough for spettro.
    expect(promptBlocks('@a.ts', [], ['a.ts'], root)).toEqual([link('a.ts')])
  })

  it('leaves a mention the text no longer has, and one used twice is linked twice', () => {
    expect(promptBlocks('@a.ts vs @a.ts', [], ['a.ts', 'b.ts'], root)).toEqual([
      link('a.ts'),
      { type: 'text', text: ' vs ' },
      link('a.ts')
    ])
  })

  it('never links outside the project, nor an e-mail', () => {
    expect(cleanMention(root, '../secret')).toBeNull()
    expect(cleanMention(root, '/etc/passwd')).toBeNull()
    expect(cleanMention(root, 'a/../../x')).toBeNull()
    expect(cleanMention(root, 'a/./b.ts')).toBe('a/b.ts')
    expect(promptBlocks('mail me@a.ts', [], ['a.ts'], root)).toEqual([{ type: 'text', text: 'mail me@a.ts' }])
  })

  it('gives images alone the text spettro requires, and keeps them after the text', () => {
    const image = { data: 'aGk=', mimeType: 'image/png' }
    expect(promptBlocks('', [image, image])[0]).toEqual({ type: 'text', text: '(see the attached images)' })
    expect(promptBlocks('look', [image])).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', ...image }
    ])
  })
})

describe('the files a folder offers', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('walks a folder git doesn’t know, skipping node_modules and .git', async () => {
    dir = mkdtempSync(join(tmpdir(), 'spettro-files-'))
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, 'README.md'), '')
    writeFileSync(join(dir, 'src', 'a.ts'), '')
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), '')
    writeFileSync(join(dir, '.git', 'HEAD'), '')
    expect((await walkFiles(dir)).sort()).toEqual(['README.md', 'src/a.ts'])
  })

  it('stops at its cap', async () => {
    dir = mkdtempSync(join(tmpdir(), 'spettro-files-'))
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, `f${i}.txt`), '')
    expect(await walkFiles(dir, 5)).toHaveLength(5)
  })

  it('is listed once per folder while fresh, and retried after a failure', async () => {
    let calls = 0
    const fetch = (): Promise<string[]> => {
      calls += 1
      return calls === 1 ? Promise.reject(new Error('gone')) : Promise.resolve(['a.ts'])
    }
    expect(await projectFiles('/cache-test', fetch)).toEqual([])
    expect(await projectFiles('/cache-test', fetch)).toEqual(['a.ts'])
    expect(await projectFiles('/cache-test', fetch)).toEqual(['a.ts'])
    expect(calls).toBe(2)
  })
})

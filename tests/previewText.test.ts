// The chat list's preview line on the phone: the newest message's first
// line, read as words rather than markup.

import { describe, expect, it } from 'vitest'
import { plainLine, previewLine } from '@main/model/previewText'

describe('previewLine', () => {
  it('drops a heading’s hashes', () => {
    expect(previewLine('## Summary\n\nThe store now writes once.')).toBe('Summary')
  })

  it('skips fences, rules and table dashes for the first line that says something', () => {
    expect(previewLine('```ts\nexport const x = 1\n```')).toBe('export const x = 1')
    expect(previewLine('---\n\nDone.')).toBe('Done.')
    expect(previewLine('| File | Lines |\n|---|---:|\n| a.ts | 3 |')).toBe('File · Lines')
    expect(previewLine('```\n```\n\n')).toBe('')
  })

  it('reads links, emphasis and inline code as their words', () => {
    expect(previewLine('See **the store** and [the docs](https://x.y) for `persist()`.')).toBe(
      'See the store and the docs for persist().'
    )
    expect(previewLine('- [ ] _Maybe_ *later*')).toBe('Maybe later')
  })

  it('leaves words that only look like markup alone', () => {
    expect(plainLine('snake_case_name and 2 * 3 * 4')).toBe('snake_case_name and 2 * 3 * 4')
    expect(plainLine('#hashtag')).toBe('#hashtag')
  })

  it('peels nested block markers', () => {
    expect(plainLine('> 1. ## Heading')).toBe('Heading')
  })

  it('keeps to 120 characters', () => {
    expect(previewLine('x'.repeat(300))).toHaveLength(120)
  })
})

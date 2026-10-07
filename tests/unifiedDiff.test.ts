// The edit rows' diff. The CLI sends a whole file before and after
// (internal/acp/tools.go fileChangeContent), so what is checked here is what
// a reader relies on: the right lines marked, the file's own line numbers,
// and hunks cut the way `diff -u` cuts them.

import { describe, expect, it } from 'vitest'
import { unifiedDiff, type DiffLine } from '@renderer/views/chat/transcript/unifiedDiff'

/** Lines as `diff -u` would print them, plus each line's numbers. */
function render(lines: DiffLine[]): string[] {
  return lines.map((l) => {
    const sign = l.kind === 'added' ? '+' : l.kind === 'removed' ? '-' : ' '
    return `${l.oldNo ?? '_'}/${l.newNo ?? '_'} ${sign}${l.text}`
  })
}

const file = (n: number, change?: Record<number, string>): string =>
  Array.from({ length: n }, (_, i) => change?.[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'

describe('unifiedDiff', () => {
  it('marks an inserted line, with three lines of context and both numberings', () => {
    const d = unifiedDiff('a\nb\nc\nd\ne\nf\n', 'a\nb\nc\nNEW\nd\ne\nf\n')
    expect(d.added).toBe(1)
    expect(d.removed).toBe(0)
    expect(d.hunks).toHaveLength(1)
    expect(render(d.hunks[0].lines)).toEqual([
      '1/1  a',
      '2/2  b',
      '3/3  c',
      '_/4 +NEW',
      '4/5  d',
      '5/6  e',
      '6/7  f'
    ])
    expect(d.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 6, newStart: 1, newLines: 7 })
  })

  it('marks a deleted line', () => {
    const d = unifiedDiff(file(10), file(10).replace('line 5\n', ''))
    expect(d.removed).toBe(1)
    expect(d.added).toBe(0)
    expect(render(d.hunks[0].lines)).toEqual([
      '2/2  line 2',
      '3/3  line 3',
      '4/4  line 4',
      '5/_ -line 5',
      '6/5  line 6',
      '7/6  line 7',
      '8/7  line 8'
    ])
    expect(d.hunks[0]).toMatchObject({ oldStart: 2, oldLines: 7, newStart: 2, newLines: 6 })
  })

  it('shows a replaced block as its removals then its additions', () => {
    const d = unifiedDiff('keep\nold 1\nold 2\nkeep\n', 'keep\nnew 1\nnew 2\nnew 3\nkeep\n')
    expect(render(d.hunks[0].lines)).toEqual([
      '1/1  keep',
      '2/_ -old 1',
      '3/_ -old 2',
      '_/2 +new 1',
      '_/3 +new 2',
      '_/4 +new 3',
      '4/5  keep'
    ])
  })

  it('pairs unchanged lines inside a changed region instead of churning them', () => {
    const d = unifiedDiff('x\nshared\ny\n', 'X\nshared\nY\n')
    expect(d.added).toBe(2)
    expect(d.removed).toBe(2)
    expect(render(d.hunks[0].lines)).toContain('2/2  shared')
  })

  it('merges changes whose context overlaps into one hunk', () => {
    // Six unchanged lines between the edits: 3 + 3 of context meet.
    const d = unifiedDiff(file(20), file(20, { 5: 'five', 12: 'twelve' }))
    expect(d.hunks).toHaveLength(1)
    expect(d.hunks[0]).toMatchObject({ oldStart: 2, oldLines: 14, newStart: 2, newLines: 14 })
  })

  it('splits changes far apart into separate hunks with the right line numbers', () => {
    const d = unifiedDiff(file(40), file(40, { 5: 'five', 30: 'thirty' }))
    expect(d.hunks).toHaveLength(2)
    expect(d.hunks[0]).toMatchObject({ oldStart: 2, oldLines: 7, newStart: 2, newLines: 7 })
    expect(d.hunks[1]).toMatchObject({ oldStart: 27, oldLines: 7, newStart: 27, newLines: 7 })
    expect(render(d.hunks[1].lines)).toContain('_/30 +thirty')
  })

  it('treats a missing final newline as a change to the last line, as git does', () => {
    const d = unifiedDiff('a\nb\n', 'a\nb')
    expect(d.removed).toBe(1)
    expect(d.added).toBe(1)
    const added = d.hunks[0].lines.find((l) => l.kind === 'added')
    expect(added).toMatchObject({ text: 'b', noNewline: true })
    const removed = d.hunks[0].lines.find((l) => l.kind === 'removed')
    expect(removed?.noNewline).toBeUndefined()
  })

  it('handles two files that both end without a newline', () => {
    const d = unifiedDiff('a\nb', 'a\nc')
    expect(render(d.hunks[0].lines)).toEqual(['1/1  a', '2/_ -b', '_/2 +c'])
  })

  it('shows a created file as all additions from -0,0', () => {
    const d = unifiedDiff(null, 'one\ntwo\n')
    expect(d.added).toBe(2)
    expect(d.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 })
  })

  it('has no hunks for identical text', () => {
    expect(unifiedDiff('same\n', 'same\n').hunks).toHaveLength(0)
  })

  it('stays quick on a large rewrite, falling back to a wholesale replace', () => {
    const before = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n')
    const after = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n')
    const started = Date.now()
    const d = unifiedDiff(before, after)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(d.removed).toBe(3000)
    expect(d.added).toBe(3000)
  })
})

// A real line diff for the edit rows: what changed, where, with line numbers.
//
// The CLI sends an edit as the whole file before and after the call
// (internal/acp/tools.go fileChangeContent; oldText absent for a created
// file), so the numbers below are the file's own. The rows used to show
// "every old line, then every new line" between the common head and tail,
// which reads fine for a one-line change and turns into noise for anything
// that touches two places: the unchanged lines between them showed as both
// removed and added.
//
// The algorithm is the dull, dependable one. The shared head and tail are
// peeled off first (that alone is the whole diff for nearly every edit an
// agent makes), and the middle goes through an LCS table. A middle too big to
// tabulate cheaply — a rewritten generated file, say — is shown as replaced
// wholesale rather than stalling the transcript; the numbers stay right, only
// the pairing is coarser.

export type DiffLineKind = 'context' | 'added' | 'removed'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  /** 1-based line in the old file; null on an added line. */
  oldNo: number | null
  /** 1-based line in the new file; null on a removed line. */
  newNo: number | null
  /** The file's last line, with no newline after it ("\ No newline at end of
   *  file"). Only set where that is what makes the line differ, or on context. */
  noNewline?: boolean
}

export interface DiffHunk {
  /** `@@ -oldStart,oldLines +newStart,newLines @@`, 1-based as in git. */
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface UnifiedDiff {
  hunks: DiffHunk[]
  added: number
  removed: number
}

/** Cells of LCS table we are willing to fill (~16 MB of Uint32). */
const MAX_TABLE = 4_000_000

interface Line {
  text: string
  noNewline: boolean
}

/** Splits a file into lines. A final line without a trailing newline is
 *  marked, so "a\nb" and "a\nb\n" differ in their last line the way git says. */
function splitLines(text: string | null): Line[] {
  if (text === null || text === '') return []
  const parts = text.split('\n')
  const endsWithNewline = parts[parts.length - 1] === ''
  if (endsWithNewline) parts.pop()
  return parts.map((t, i) => ({
    text: t.endsWith('\r') ? t.slice(0, -1) : t,
    noNewline: !endsWithNewline && i === parts.length - 1
  }))
}

function same(a: Line, b: Line): boolean {
  return a.text === b.text && a.noNewline === b.noNewline
}

type Op = { kind: DiffLineKind; line: Line }

/** The edit script for the region between the shared head and tail. */
function middleOps(a: Line[], b: Line[]): Op[] {
  const n = a.length
  const m = b.length
  const ops: Op[] = []
  if (n === 0 || m === 0 || n * m > MAX_TABLE) {
    for (const line of a) ops.push({ kind: 'removed', line })
    for (const line of b) ops.push({ kind: 'added', line })
    return ops
  }
  // lcs[i * (m + 1) + j] = LCS length of a[i:] and b[j:].
  const w = m + 1
  const lcs = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = same(a[i], b[j])
        ? lcs[(i + 1) * w + j + 1] + 1
        : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (same(a[i], b[j])) {
      ops.push({ kind: 'context', line: b[j] })
      i++
      j++
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
      // On a tie, removals go first: a replaced block reads as "these went,
      // these came", not as an interleaving.
      ops.push({ kind: 'removed', line: a[i++] })
    } else {
      ops.push({ kind: 'added', line: b[j++] })
    }
  }
  while (i < n) ops.push({ kind: 'removed', line: a[i++] })
  while (j < m) ops.push({ kind: 'added', line: b[j++] })
  return ops
}

/**
 * The unified diff of two texts, in hunks with `context` unchanged lines on
 * either side of each change. Changes closer than twice the context share a
 * hunk, as in `diff -u`. Identical texts give no hunks.
 */
export function unifiedDiff(oldText: string | null, newText: string, context = 3): UnifiedDiff {
  const a = splitLines(oldText)
  const b = splitLines(newText)

  let head = 0
  while (head < a.length && head < b.length && same(a[head], b[head])) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    same(a[a.length - 1 - tail], b[b.length - 1 - tail])
  ) {
    tail++
  }

  const ops: Op[] = []
  for (let k = 0; k < head; k++) ops.push({ kind: 'context', line: b[k] })
  ops.push(...middleOps(a.slice(head, a.length - tail), b.slice(head, b.length - tail)))
  for (let k = b.length - tail; k < b.length; k++) ops.push({ kind: 'context', line: b[k] })

  // Number every op once, then cut hunks out of the numbered list.
  const lines: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  let added = 0
  let removed = 0
  for (const op of ops) {
    const line: DiffLine = { kind: op.kind, text: op.line.text, oldNo: null, newNo: null }
    if (op.kind !== 'added') line.oldNo = ++oldNo
    if (op.kind !== 'removed') line.newNo = ++newNo
    if (op.kind === 'added') added++
    if (op.kind === 'removed') removed++
    if (op.line.noNewline) line.noNewline = true
    lines.push(line)
  }

  const hunks: DiffHunk[] = []
  let k = 0
  while (k < lines.length) {
    if (lines[k].kind === 'context') {
      k++
      continue
    }
    const start = Math.max(0, k - context)
    // Extend over changes until a run of unchanged lines long enough to
    // close the hunk (more than both hunks' context put together).
    let end = k
    let scan = k
    while (scan < lines.length) {
      if (lines[scan].kind !== 'context') {
        end = scan
        scan++
        continue
      }
      let run = 0
      while (scan + run < lines.length && lines[scan + run].kind === 'context') run++
      if (scan + run >= lines.length || run > 2 * context) break
      scan += run
    }
    const stop = Math.min(lines.length, end + 1 + context)
    hunks.push(toHunk(lines.slice(start, stop)))
    k = stop
  }
  return { hunks, added, removed }
}

function toHunk(lines: DiffLine[]): DiffHunk {
  let oldLines = 0
  let newLines = 0
  let oldStart = 0
  let newStart = 0
  for (const line of lines) {
    if (line.oldNo !== null) {
      if (oldLines === 0) oldStart = line.oldNo
      oldLines++
    }
    if (line.newNo !== null) {
      if (newLines === 0) newStart = line.newNo
      newLines++
    }
  }
  // A side with no lines at all only happens when that side is an empty
  // file (created, or emptied): git prints it as `-0,0`.
  return { oldStart, oldLines, newStart, newLines, lines }
}

/** Total lines a diff renders, separators not counted. */
export function diffLineCount(diff: UnifiedDiff): number {
  let n = 0
  for (const h of diff.hunks) n += h.lines.length
  return n
}

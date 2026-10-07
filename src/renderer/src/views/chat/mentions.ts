// @-mentions in the composer: finding the "@query" under the caret, ranking
// the project's files against it, and keeping track of which mentions are
// still in the text.
//
// Pure, so the parts that decide *what* gets sent are tested without a DOM:
// a mention menu that looks right but inserts the wrong path is the kind of
// bug a screenshot never shows.

/** The "@query" the caret is in, if any: an @ at the start of the text or
 *  after whitespace, then no whitespace up to the caret. `start` is the @'s
 *  index. An e-mail address ("me@host") is not a mention. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  let i = caret - 1
  while (i >= 0) {
    const ch = text[i]
    if (ch === '@') {
      if (i > 0 && !/\s/.test(text[i - 1])) return null
      return { start: i, query: text.slice(i + 1, caret) }
    }
    if (/\s/.test(ch)) return null
    i -= 1
  }
  return null
}

/** The draft with the "@query" at `start` replaced by the chosen path, and
 *  where the caret goes after it (past the space that closes the mention). */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  path: string
): { text: string; caret: number } {
  const after = text.slice(caret)
  const spacer = after.startsWith(' ') ? '' : ' '
  const inserted = '@' + path + spacer
  return { text: text.slice(0, start) + inserted + after, caret: start + inserted.length + (spacer ? 0 : 1) }
}

/**
 * How well `path` matches `query`, or -1 when it doesn't: every query
 * character must appear in order (case-insensitive). Matches in the file
 * name beat matches spread over folders, a run of adjacent characters beats
 * scattered ones, and a match at the start of a word beats one inside it —
 * so "btn" ranks `SaveButton.tsx` over `src/bootstrap/tsconfig.json`.
 */
export function fuzzyScore(path: string, query: string): number {
  if (query === '') return 0
  const p = path.toLowerCase()
  const q = query.toLowerCase()
  const nameStart = p.lastIndexOf('/') + 1
  // A plain substring of the name is the strongest signal there is.
  const inName = p.indexOf(q, nameStart)
  if (inName >= 0) return 1000 - (inName - nameStart) * 2 - (p.length - nameStart) * 0.1
  const inPath = p.indexOf(q)
  if (inPath >= 0) return 700 - inPath * 0.5 - p.length * 0.05

  let score = 0
  let pi = 0
  let run = 0
  for (const ch of q) {
    const at = p.indexOf(ch, pi)
    if (at < 0) return -1
    const boundary = at === 0 || /[/_\-. ]/.test(p[at - 1]) || (path[at] >= 'A' && path[at] <= 'Z')
    run = at === pi && pi > 0 ? run + 1 : 0
    score += 10 + run * 8 + (boundary ? 12 : 0) + (at >= nameStart ? 6 : 0)
    pi = at + 1
  }
  return score - p.length * 0.05
}

/** The best `limit` files for `query`; with no query, the shortest paths
 *  first (the top of the project). */
export function rankFiles(files: string[], query: string, limit = 8): string[] {
  if (query === '') {
    return [...files].sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, limit)
  }
  const scored: { path: string; score: number }[] = []
  for (const path of files) {
    const score = fuzzyScore(path, query)
    if (score >= 0) scored.push({ path, score })
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return scored.slice(0, limit).map((s) => s.path)
}

/** The mentions still written in `text` as "@path" (each once). A mention
 *  the user deleted or edited away is no longer sent as a file. */
export function liveMentions(text: string, mentions: string[]): string[] {
  return [...new Set(mentions)].filter((m) => {
    const token = '@' + m
    let from = 0
    for (;;) {
      const at = text.indexOf(token, from)
      if (at < 0) return false
      const after = text[at + token.length] ?? ''
      if (after === '' || /[\s,;:!?)\]}'"`]/.test(after) || after === '.') return true
      from = at + 1
    }
  })
}

/** The text split around live mentions, for drawing them as chips. */
export function splitMentions(
  text: string,
  mentions: string[]
): { text: string; mention: boolean }[] {
  const live = liveMentions(text, mentions).sort((a, b) => b.length - a.length)
  if (live.length === 0) return [{ text, mention: false }]
  const pieces: { text: string; mention: boolean }[] = []
  let at = 0
  let plain = ''
  while (at < text.length) {
    const hit =
      text[at] === '@' && (at === 0 || /\s/.test(text[at - 1]))
        ? live.find((m) => {
            const end = at + 1 + m.length
            const after = text[end] ?? ''
            return (
              text.startsWith(m, at + 1) &&
              (after === '' || /[\s,;:!?)\]}'"`]/.test(after) || after === '.')
            )
          })
        : undefined
    if (hit) {
      if (plain) pieces.push({ text: plain, mention: false })
      plain = ''
      pieces.push({ text: '@' + hit, mention: true })
      at += 1 + hit.length
    } else {
      plain += text[at]
      at += 1
    }
  }
  if (plain) pieces.push({ text: plain, mention: false })
  return pieces
}

// ---------------------------------------------------------------------------
// The project's files, fetched once per folder and kept briefly
// ---------------------------------------------------------------------------

const FRESH_MS = 30_000
const cache = new Map<string, { at: number; files: Promise<string[]> }>()

/** The folder's files through `fetch` (the listProjectFiles call), reused for
 *  30 s so typing "@" twice doesn't list the repo twice. A failed listing is
 *  forgotten at once so the next "@" tries again. */
export function projectFiles(
  projectPath: string,
  fetch: (path: string) => Promise<string[] | null>
): Promise<string[]> {
  const hit = cache.get(projectPath)
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.files
  const files = fetch(projectPath)
    .then((list) => list ?? [])
    .catch(() => {
      cache.delete(projectPath)
      return [] as string[]
    })
  cache.set(projectPath, { at: Date.now(), files })
  return files
}

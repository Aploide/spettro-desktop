// A chat's preview line, as the phone's chat list shows it under the title:
// the newest message's first line worth reading, in plain words. Messages
// are markdown, and a reply that opens with "## Summary" or a code fence
// showed exactly that — the markup — in the list.

const FENCE = /^\s*(```|~~~)/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

/** One line of markdown without its markup: block markers at the start
 *  (headings, quotes, list bullets and numbers, task boxes), links and
 *  images down to their text, emphasis and inline code down to the words. */
export function plainLine(line: string): string {
  let s = line.trim()
  // Block markers, in the order they nest: "> - [ ] ## x".
  for (;;) {
    const next = s
      .replace(/^>\s?/, '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d{1,9}[.)]\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
    if (next === s) break
    s = next
  }
  s = s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w_])_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, '$1$2')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
    .replace(/`+([^`]+)`+/g, '$1')
  // A table row reads as its cells.
  if (s.startsWith('|')) {
    s = s
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell) => cell !== '')
      .join(' · ')
  }
  return s.trim()
}

/** The first line of `text` that still says something once its markup is
 *  gone (a fence, a rule or a table's dashes says nothing), at most `max`
 *  characters; '' when there is none. */
export function previewLine(text: string, max = 120): string {
  for (const raw of text.split(/\r?\n/)) {
    if (FENCE.test(raw) || RULE.test(raw) || TABLE_SEPARATOR.test(raw)) continue
    const line = plainLine(raw)
    if (line !== '') return line.slice(0, max)
  }
  return ''
}

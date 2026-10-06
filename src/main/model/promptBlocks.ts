// The content blocks one message becomes on the wire.
//
// An @-mentioned file travels as a `resource_link` in the spot the mention
// was typed, between the text around it — not as the text "@src/x.ts" and
// not appended at the end. spettro rebuilds the typed prompt by joining the
// blocks in order and writing each link as `@<absolute path>`
// (internal/acp/content.go readPromptContent), and makes the file a required
// read for the turn; a link left in its place reads back as the sentence the
// user wrote, with the path made absolute. Sending the mention's text *as
// well* would put it in the prompt twice.

import { isAbsolute, join, normalize } from 'path'
import { pathToFileURL } from 'url'
import type { ACPContentBlock } from '../../shared/acp'

export interface PromptAttachment {
  data: string
  mimeType: string
}

/** What a prompt with images and no words says, so the agent has text to
 *  work from: spettro refuses a prompt with no text content (bridge.go). The
 *  user's bubble keeps showing just the images. */
export const IMAGE_ONLY_TEXT = '(see the attached image)'
export const IMAGES_ONLY_TEXT = '(see the attached images)'

/** Characters a path can continue with. A mention ends at the first other
 *  one, so "@src/a.ts," and "(@src/a.ts)" still match; "@src/a.tsx" does not
 *  match a mention of "src/a.ts". A full stop is the one ambiguous case —
 *  it ends a sentence as often as it starts an extension — and counts as an
 *  end only when nothing path-like follows it. */
const PATH_CHAR = /[A-Za-z0-9_\-/\\~+@]/

/**
 * A renderer-supplied mention, kept only when it names a file inside the
 * project: relative, no `..` climbing out, no NUL. Anything else is dropped
 * — the text still says "@whatever", the agent just isn't handed a file.
 */
export function cleanMention(projectPath: string, mention: unknown): string | null {
  if (typeof mention !== 'string' || mention === '' || mention.includes('\0')) return null
  if (isAbsolute(mention)) return null
  const rel = normalize(mention)
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) return null
  return projectPath === '' ? null : rel
}

/** Where in `text` each mention sits, longest first so "@src/a.tsx" is never
 *  claimed by a mention of "src/a". Overlaps keep the first claim. */
function mentionSpans(text: string, mentions: string[]): { start: number; end: number; rel: string }[] {
  const spans: { start: number; end: number; rel: string }[] = []
  const sorted = [...new Set(mentions)].sort((a, b) => b.length - a.length)
  for (const rel of sorted) {
    const token = '@' + rel
    let from = 0
    for (;;) {
      const at = text.indexOf(token, from)
      if (at < 0) break
      from = at + token.length
      const end = at + token.length
      const before = at === 0 ? '' : text[at - 1]
      const after = text[end] ?? ''
      const next = text[end + 1] ?? ''
      // An @ that is part of a word ("me@host") is not a mention.
      if (before !== '' && !/\s|[([{"'`]/.test(before)) continue
      if (after !== '' && PATH_CHAR.test(after)) continue
      if (after === '.' && next !== '' && PATH_CHAR.test(next)) continue
      if (spans.some((s) => at < s.end && end > s.start)) continue
      spans.push({ start: at, end, rel })
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}

/**
 * The blocks for one message: the text, split around each mention still in
 * it, the mentions as resource links in their places, then the images. A
 * message of images alone gets the stand-in text spettro needs.
 */
export function promptBlocks(
  text: string,
  attachments: PromptAttachment[],
  mentions: string[] = [],
  projectPath = ''
): ACPContentBlock[] {
  const blocks: ACPContentBlock[] = []
  if (text === '') {
    blocks.push({
      type: 'text',
      text: attachments.length > 1 ? IMAGES_ONLY_TEXT : IMAGE_ONLY_TEXT
    })
  } else {
    const rels = mentions
      .map((m) => cleanMention(projectPath, m))
      .filter((m): m is string => m !== null)
    let at = 0
    for (const span of mentionSpans(text, rels)) {
      if (span.start > at) blocks.push({ type: 'text', text: text.slice(at, span.start) })
      blocks.push({
        type: 'resource_link',
        uri: pathToFileURL(join(projectPath, span.rel)).href,
        name: span.rel
      })
      at = span.end
    }
    // A message that is nothing but a mention needs no words added: the link
    // alone reads back as "@<path>", which is text enough for spettro.
    if (at < text.length) blocks.push({ type: 'text', text: text.slice(at) })
  }
  for (const a of attachments) {
    blocks.push({ type: 'image', data: a.data, mimeType: a.mimeType })
  }
  return blocks
}

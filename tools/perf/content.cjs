// Deterministic text for the performance benchmark: the markdown, code,
// diffs and command output a heavy agent turn is made of. Shared by the fake
// agent (fake-spettro.cjs), which streams it, and the session generator
// (gen-sessions.cjs), which stores it, so a turn streamed live and a turn
// loaded from disk are the same kind of thing.
//
// Everything is a pure function of a seed: two runs of the benchmark render
// the same words.

'use strict'

/** mulberry32: small, fast, good enough to vary text. */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = (
  'the session store keeps every chat in one file and the renderer mirrors it over ipc so a change ' +
  'in main reaches the view as an event which the reducer folds into a new snapshot before react ' +
  'renders the transcript again we should check whether the slider sends one config change per stop ' +
  'or per release because each reply is broadcast to every live session and persisted with the whole ' +
  'transcript the parser reads newline delimited json from stdout and hands each update to the model ' +
  'which appends streaming text merges tool events and emits the changed item'
).split(' ')

const FILES = [
  'src/main/model/appModel.ts',
  'src/main/model/chatSession.ts',
  'src/main/acp/connection.ts',
  'src/main/acp/parse.ts',
  'src/renderer/src/state/store.ts',
  'src/renderer/src/views/chat/ChatView.tsx',
  'src/renderer/src/views/chat/Composer.tsx',
  'src/renderer/src/views/chat/ThinkingSlider.tsx',
  'src/renderer/src/views/chat/transcript/MarkdownText.tsx',
  'src/renderer/src/views/chat/transcript/ToolCallView.tsx',
  'src/shared/ipc.ts',
  'src/shared/model.ts',
  'internal/acp/bridge.go',
  'internal/agent/loop.go',
  'internal/workflow/engine.go'
]

const COMMANDS = ['npm test', 'npm run typecheck', 'go test ./...', 'git status --short', 'rg -n "persist\\(" src', 'ls -la src/main/model']

function sentence(r, min = 6, max = 18) {
  const n = min + Math.floor(r() * (max - min))
  const words = []
  for (let i = 0; i < n; i++) words.push(WORDS[Math.floor(r() * WORDS.length)])
  const s = words.join(' ')
  return s[0].toUpperCase() + s.slice(1) + '.'
}

function paragraph(r, sentences = 4) {
  const out = []
  for (let i = 0; i < sentences; i++) out.push(sentence(r))
  return out.join(' ')
}

/** A plausible TypeScript function, `lines` long. */
function codeLines(r, lines, salt = 0) {
  const out = []
  let depth = 0
  for (let i = 0; i < lines; i++) {
    const w = () => WORDS[Math.floor(r() * WORDS.length)]
    let line
    if (i % 17 === 0) {
      line = `export function ${w()}${w()[0].toUpperCase()}${w().slice(1)}${salt}(input: string): number {`
      depth = 1
    } else if (i % 17 === 16) {
      line = '}'
      depth = 0
    } else if (i % 5 === 0) {
      line = `${'  '.repeat(depth)}if (input.includes('${w()}')) return ${i} // ${w()} ${w()}`
    } else if (i % 7 === 0) {
      line = `${'  '.repeat(depth)}const ${w()}${i} = input.split('${w()}').map((s) => s.trim())`
    } else {
      line = `${'  '.repeat(depth)}// ${sentence(r, 4, 10)}`
    }
    out.push(line)
  }
  return out
}

/** ~`tokens` tokens of assistant markdown: headings, lists, paragraphs, code
 *  blocks, a table. A "token" is about four characters, as a provider streams
 *  them. */
function markdown(seed, tokens) {
  const r = rng(seed)
  const parts = []
  let size = 0
  let section = 0
  while (size < tokens * 4.2) {
    section++
    const block = []
    block.push(`## ${sentence(r, 2, 5).replace(/\.$/, '')}`)
    block.push(paragraph(r, 3))
    if (section % 2 === 0) {
      block.push(['- ' + sentence(r), '- ' + sentence(r), '- `' + FILES[section % FILES.length] + '` ' + sentence(r, 3, 7)].join('\n'))
    }
    if (section % 3 === 1) {
      block.push('```ts\n' + codeLines(r, 12 + Math.floor(r() * 14), section).join('\n') + '\n```')
    }
    if (section % 5 === 4) {
      block.push(
        '| file | change | risk |\n| --- | --- | --- |\n' +
          FILES.slice(0, 4)
            .map((f) => `| \`${f}\` | ${sentence(r, 3, 6)} | ${r() > 0.5 ? 'low' : 'medium'} |`)
            .join('\n')
      )
    }
    block.push(paragraph(r, 2))
    const text = block.join('\n\n')
    parts.push(text)
    size += text.length
  }
  return parts.join('\n\n')
}

/** Splits text into stream chunks of about one token each, keeping the
 *  whitespace with the word before it, the way providers stream. */
function tokenize(text) {
  const out = []
  const re = /\S+\s*|\s+/g
  let m
  while ((m = re.exec(text))) {
    let piece = m[0]
    // Long words (code) come in several tokens.
    while (piece.length > 8) {
      out.push(piece.slice(0, 6))
      piece = piece.slice(6)
    }
    out.push(piece)
  }
  return out
}

/** The CLI clips a tool's text to 16 KiB before it goes on the wire
 *  (internal/acp/tools.go maxToolTextBytes). */
const MAX_TOOL_TEXT = 16 << 10
function clip(text) {
  return text.length <= MAX_TOOL_TEXT ? text : text.slice(0, MAX_TOOL_TEXT)
}

function readOutput(seed, path, lines = 140) {
  const r = rng(seed)
  return clip(
    codeLines(r, lines, seed % 97)
      .map((l, i) => `${String(i + 1).padStart(6)}\t${l}`)
      .join('\n')
  )
}

/** An edit: old and new text of `lines` lines, about one line in ten
 *  changed. */
function editTexts(seed, lines = 200) {
  const r = rng(seed)
  const old = codeLines(r, lines, seed % 89)
  const neu = old.map((l, i) => (i % 10 === 3 ? l.replace(/\/\/ .*/, '// ' + sentence(r, 4, 9)) + ' // changed' : l))
  // A few inserted lines, so hunks move.
  neu.splice(40, 0, '  const cached = new Map<string, number>()', '  if (cached.has(input)) return cached.get(input)!')
  return { oldText: old.join('\n') + '\n', newText: neu.join('\n') + '\n' }
}

function bashOutput(seed, command, lines = 300) {
  const r = rng(seed)
  const out = [`$ ${command}`]
  for (let i = 0; i < lines; i++) {
    if (i % 25 === 0) out.push(`> ${FILES[i % FILES.length]} (${Math.floor(r() * 900)} ms)`)
    else if (i % 11 === 0) out.push(`  ✓ ${sentence(r, 3, 8)} (${Math.floor(r() * 40)} ms)`)
    else out.push(`    at ${WORDS[Math.floor(r() * WORDS.length)]} (${FILES[i % FILES.length]}:${i}:${Math.floor(r() * 80)})`)
  }
  out.push(` Test Files  ${12 + (seed % 7)} passed`, `      Tests  ${200 + (seed % 50)} passed`)
  return clip(out.join('\n'))
}

function searchOutput(seed, lines = 60) {
  const r = rng(seed)
  const out = [`${lines} files:`]
  for (let i = 0; i < lines; i++) out.push(`${FILES[Math.floor(r() * FILES.length)].replace(/\.(ts|tsx|go)$/, '')}${i}.ts`)
  return out.join('\n')
}

/** The thinking that precedes a turn. */
function thought(seed, chunks) {
  const r = rng(seed)
  const out = []
  for (let i = 0; i < chunks; i++) out.push((i === 0 ? '' : ' ') + sentence(r, 4, 9))
  return out
}

module.exports = {
  rng,
  sentence,
  paragraph,
  codeLines,
  markdown,
  tokenize,
  readOutput,
  editTexts,
  bashOutput,
  searchOutput,
  thought,
  FILES,
  COMMANDS
}

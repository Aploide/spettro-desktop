// A small JavaScript tokenizer, for colouring workflow scripts.
//
// Workflow scripts are short — fifty lines of `phase()`, `agent()` and
// ordinary control flow — and the app ships no editor component. Pulling in a
// real one (CodeMirror, Monaco, Shiki) to colour that would add megabytes and
// a second text-editing model to maintain, for a screen nobody spends an hour
// in. A single-pass scanner is about eighty lines and gets JavaScript's
// genuinely tricky parts right: template literals with `${}` inside them,
// regex-vs-division, and comments.
//
// It is a *lexer*, not a parser. It will never understand the code. What it
// has to do is never lie about where a string ends, because a mis-terminated
// string paints the rest of the file the wrong colour and that looks far worse
// than no colour at all.

export type TokenKind =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'builtin'
  | 'property'
  | 'punct'

export interface Token {
  text: string
  kind: TokenKind
}

const KEYWORDS = new Set([
  'await', 'async', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for',
  'from', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'of',
  'return', 'static', 'switch', 'this', 'throw', 'try', 'typeof', 'var',
  'void', 'while', 'yield', 'true', 'false', 'null', 'undefined'
])

/** The globals the workflow runtime injects (internal/workflow/prelude.go).
 *  Colouring these apart from ordinary calls is the one piece of *semantic*
 *  help this view can give: it shows at a glance which calls are the
 *  orchestration and which are the script's own plumbing. */
const BUILTINS = new Set([
  'agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget',
  'workflow', 'meta', 'console', 'Math', 'JSON', 'Object', 'Array',
  'Promise', 'String', 'Number', 'Boolean', 'Set', 'Map'
])

const ID_START = /[A-Za-z_$]/
const ID_PART = /[A-Za-z0-9_$]/

/** True when a `/` at this point starts a regex rather than a division. The
 *  test is the usual one: look back at the last meaningful character. */
function regexAllowed(previous: Token | undefined): boolean {
  if (!previous) return true
  if (previous.kind === 'keyword') return previous.text !== 'this'
  if (previous.kind === 'number' || previous.kind === 'string') return false
  if (previous.kind === 'plain' || previous.kind === 'property') return false
  return !/[)\]}]$/.test(previous.text.trim())
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  const push = (text: string, kind: TokenKind): void => {
    if (text === '') return
    const last = tokens[tokens.length - 1]
    if (last && last.kind === kind && kind === 'plain') last.text += text
    else tokens.push({ text, kind })
  }

  /** The last token that is not whitespace-only, for the regex heuristic. */
  const meaningful = (): Token | undefined => {
    for (let k = tokens.length - 1; k >= 0; k--) {
      if (tokens[k].text.trim() !== '') return tokens[k]
    }
    return undefined
  }

  while (i < source.length) {
    const ch = source[i]

    // Comments
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i)
      const stop = end === -1 ? source.length : end
      push(source.slice(i, stop), 'comment')
      i = stop
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      push(source.slice(i, stop), 'comment')
      i = stop
      continue
    }

    // Template literals. Scanned by hand because `${…}` nests arbitrarily and
    // a naive "read to the next backtick" swallows any backtick inside an
    // interpolation.
    if (ch === '`') {
      let j = i + 1
      let depth = 0
      while (j < source.length) {
        const c = source[j]
        if (c === '\\') {
          j += 2
          continue
        }
        if (depth === 0 && c === '`') {
          j += 1
          break
        }
        if (c === '$' && source[j + 1] === '{') {
          depth += 1
          j += 2
          continue
        }
        if (depth > 0 && c === '}') depth -= 1
        j += 1
      }
      push(source.slice(i, j), 'string')
      i = j
      continue
    }

    // Quoted strings. An unterminated one stops at the newline rather than
    // running to the end of the file — the mistake is almost always a missing
    // closing quote on that line, and colouring the rest of the script as a
    // string hides every other thing that is wrong with it.
    if (ch === '"' || ch === "'") {
      let j = i + 1
      while (j < source.length && source[j] !== ch && source[j] !== '\n') {
        j += source[j] === '\\' ? 2 : 1
      }
      if (j < source.length && source[j] === ch) j += 1
      push(source.slice(i, j), 'string')
      i = j
      continue
    }

    // Regex literals
    if (ch === '/' && regexAllowed(meaningful())) {
      let j = i + 1
      let inClass = false
      while (j < source.length && source[j] !== '\n') {
        const c = source[j]
        if (c === '\\') {
          j += 2
          continue
        }
        if (c === '[') inClass = true
        else if (c === ']') inClass = false
        else if (c === '/' && !inClass) {
          j += 1
          break
        }
        j += 1
      }
      while (j < source.length && /[gimsuy]/.test(source[j])) j += 1
      push(source.slice(i, j), 'string')
      i = j
      continue
    }

    // Numbers
    if (/[0-9]/.test(ch)) {
      let j = i
      while (j < source.length && /[0-9a-fA-FxX._on]/.test(source[j])) j += 1
      push(source.slice(i, j), 'number')
      i = j
      continue
    }

    // Identifiers
    if (ID_START.test(ch)) {
      let j = i
      while (j < source.length && ID_PART.test(source[j])) j += 1
      const word = source.slice(i, j)
      // A word after a dot is a property, whatever else it looks like:
      // `.filter` is not the builtin `filter` and `obj.new` is not a keyword.
      const afterDot = /\.\s*$/.test(source.slice(Math.max(0, i - 2), i))
      if (afterDot) push(word, 'property')
      else if (KEYWORDS.has(word)) push(word, 'keyword')
      else if (BUILTINS.has(word)) push(word, 'builtin')
      else push(word, 'plain')
      i = j
      continue
    }

    if (/[{}()[\];,.:]/.test(ch)) {
      push(ch, 'punct')
      i += 1
      continue
    }

    push(ch, 'plain')
    i += 1
  }

  return tokens
}

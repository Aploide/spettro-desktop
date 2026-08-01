// Markdown rendering — port of spettro-apple/Spettro/Views/MarkdownText.swift.
//
// Streaming strategy (same as the Swift MarkdownChunker): the source is split
// into block-level chunks (code-fence and list aware). Each chunk renders
// through a memoized component keyed on its text, so while an answer streams
// only the growing last chunk is re-tokenized and re-rendered; finished
// chunks are never touched again.
//
// Safety: `marked` is used as a *lexer* only — tokens are rendered to React
// elements by hand, never through dangerouslySetInnerHTML, so raw HTML in
// the source is inert (rendered as plain text).

import { Fragment, memo, useMemo, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { Lexer, type Token, type Tokens } from 'marked'
import './transcript.css'

export function MarkdownText({ source }: { source: string }): JSX.Element {
  const chunks = useMemo(() => markdownChunks(source), [source])
  return (
    <div className="md">
      {chunks.map((chunk, i) => (
        <MarkdownChunk key={i} text={chunk} />
      ))}
    </div>
  )
}

/** One markdown chunk. Memoized on its text, so chunks whose text didn't
 *  change this update are neither re-tokenized nor re-rendered. */
const MarkdownChunk = memo(
  function MarkdownChunk({ text }: { text: string }): JSX.Element {
    const tokens = useMemo(() => Lexer.lex(text, { gfm: true, breaks: false }), [text])
    return <>{renderBlocks(tokens)}</>
  },
  (prev, next) => prev.text === next.text
)

// ---------------------------------------------------------------------------
// Chunking (port of MarkdownChunker.chunks)
// ---------------------------------------------------------------------------

/**
 * Splits markdown into independently renderable chunks on blank lines,
 * keeping fenced code blocks (even unterminated ones, mid-stream) and list
 * runs intact so numbering and fences never break across chunks.
 */
export function markdownChunks(source: string): string[] {
  const chunks: string[] = []
  let current: string[] = []
  let inFence = false
  const lines = source.split('\n')

  const flush = (): void => {
    // Preserve interior blank lines but drop pure-whitespace chunks.
    if (current.some((l) => l.trim() !== '')) {
      chunks.push(current.join('\n'))
    }
    current = []
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const trimmed = line.trim()
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence
      current.push(line)
      continue
    }
    if (trimmed === '' && !inFence) {
      // A blank line splits chunks unless it sits inside a list run
      // (loose lists restart numbering if split apart).
      const prevIsItem = current.length > 0 && isListItem(current[current.length - 1])
      let nextIsItem = false
      for (let j = index + 1; j < lines.length; j++) {
        if (lines[j].trim() !== '') {
          nextIsItem = isListItem(lines[j])
          break
        }
      }
      if (prevIsItem && nextIsItem) {
        current.push(line)
      } else {
        flush()
      }
      continue
    }
    current.push(line)
  }
  flush()
  return chunks
}

function isListItem(line: string): boolean {
  const t = line.trim()
  if (t.startsWith('- ') || t.startsWith('* ') || t.startsWith('+ ') || t.startsWith('> ')) {
    return true
  }
  // Ordered markers: 1. / 2) with up to three digits.
  return /^\d{1,3}[.)]/.test(t)
}

// ---------------------------------------------------------------------------
// Token → React rendering
// ---------------------------------------------------------------------------

/** Undo the HTML-entity escaping `marked` applies to some token texts. */
function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function safeHref(href: string): string | null {
  try {
    const url = new URL(href)
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
      return href
    }
    return null
  } catch {
    return null
  }
}

function renderBlocks(tokens: Token[]): ReactNode {
  return tokens.map((t, i) => <Fragment key={i}>{renderBlock(t)}</Fragment>)
}

function renderBlock(t: Token): ReactNode {
  switch (t.type) {
    case 'space':
      return null
    case 'code': {
      const c = t as Tokens.Code
      return <CodeBlock lang={c.lang} code={c.text} />
    }
    case 'heading': {
      const h = t as Tokens.Heading
      const Tag = `h${Math.min(6, Math.max(1, h.depth))}` as keyof JSX.IntrinsicElements
      return <Tag className="md-heading">{renderInline(h.tokens)}</Tag>
    }
    case 'table': {
      const tb = t as Tokens.Table
      return (
        <div className="md-tablewrap">
          <table className="md-table">
            <thead>
              <tr>
                {tb.header.map((cell, i) => (
                  <th key={i} style={cellAlign(tb.align[i])}>
                    {renderInline(cell.tokens)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tb.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci} style={cellAlign(tb.align[ci])}>
                      {renderInline(cell.tokens)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    case 'hr':
      return <hr className="md-hr" />
    case 'blockquote': {
      const b = t as Tokens.Blockquote
      return <blockquote className="md-blockquote">{renderBlocks(b.tokens)}</blockquote>
    }
    case 'list': {
      const l = t as Tokens.List
      const Tag = l.ordered ? 'ol' : 'ul'
      const start = l.ordered && l.start !== '' && l.start !== 1 ? l.start : undefined
      return (
        <Tag className="md-list" start={start}>
          {l.items.map((item, i) => (
            <li key={i} className={item.task ? 'md-task' : undefined}>
              {item.task && (
                <input type="checkbox" checked={item.checked === true} readOnly disabled />
              )}
              {renderBlocks(item.tokens)}
            </li>
          ))}
        </Tag>
      )
    }
    case 'paragraph': {
      const p = t as Tokens.Paragraph
      return <p className="md-p">{renderInline(p.tokens)}</p>
    }
    case 'text': {
      // Block-level text appears inside tight list items; keep it inline.
      const tx = t as Tokens.Text
      return <span>{tx.tokens ? renderInline(tx.tokens) : decodeEntities(tx.text)}</span>
    }
    case 'html':
      // Raw HTML is never injected — show it literally (React escapes it).
      return <p className="md-p md-raw">{t.raw}</p>
    case 'def':
      return null
    default:
      return decodeEntities((t as Tokens.Generic).raw ?? '')
  }
}

function cellAlign(
  align: 'center' | 'left' | 'right' | null
): { textAlign: 'center' | 'left' | 'right' } | undefined {
  return align ? { textAlign: align } : undefined
}

function renderInline(tokens: Token[]): ReactNode {
  return tokens.map((t, i) => <Fragment key={i}>{renderInlineToken(t)}</Fragment>)
}

function renderInlineToken(t: Token): ReactNode {
  switch (t.type) {
    case 'text': {
      const tx = t as Tokens.Text
      return tx.tokens ? renderInline(tx.tokens) : decodeEntities(tx.text)
    }
    case 'escape':
      return decodeEntities((t as Tokens.Escape).text)
    case 'strong':
      return <strong>{renderInline((t as Tokens.Strong).tokens)}</strong>
    case 'em':
      return <em>{renderInline((t as Tokens.Em).tokens)}</em>
    case 'del':
      return <del>{renderInline((t as Tokens.Del).tokens)}</del>
    case 'codespan':
      return <code className="md-inline-code">{decodeEntities((t as Tokens.Codespan).text)}</code>
    case 'br':
      return <br />
    case 'link': {
      const lk = t as Tokens.Link
      const href = safeHref(lk.href)
      const children = renderInline(lk.tokens)
      if (href === null) return <span>{children}</span>
      return (
        <a
          className="md-link"
          href={href}
          title={lk.title ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
        >
          {children}
        </a>
      )
    }
    case 'image': {
      // Remote images are blocked in this environment; show the alt text.
      const im = t as Tokens.Image
      return <span className="md-img-alt">{decodeEntities(im.text)}</span>
    }
    case 'html':
      // Inline HTML is shown literally, never injected.
      return t.raw
    default:
      return decodeEntities((t as Tokens.Generic).raw ?? '')
  }
}

// ---------------------------------------------------------------------------
// Code blocks (port of SpettroCodeBlockStyle + CopyButton)
// ---------------------------------------------------------------------------

function CodeBlock({ lang, code }: { lang?: string; code: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const label = lang && lang.trim() !== '' ? lang.trim().split(/\s+/)[0] : 'code'

  const copy = (): void => {
    void navigator.clipboard.writeText(code)
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="md-codeblock">
      <div className="md-codeblock-head">
        <span className="md-codeblock-lang">{label}</span>
        <button className="md-copy" type="button" title="Copy code" onClick={copy}>
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>
      <pre className="md-codeblock-body">
        <code>{code}</code>
      </pre>
    </div>
  )
}

function CopyIcon(): JSX.Element {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5.5" y="1.5" width="8" height="10" rx="1.5" />
      <path d="M10.5 14.5h-7a1 1 0 0 1-1-1v-9" />
    </svg>
  )
}

function CheckIcon(): JSX.Element {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5l3.2 3.2L13 4.5" />
    </svg>
  )
}

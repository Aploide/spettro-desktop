// A slash command's reply, read for display.
//
// The CLI answers /help, /ultra, /permission… with text laid out for a
// terminal: a "commands:" heading, then `/cmd args   description` rows padded
// with spaces into two columns, long descriptions hard-wrapped onto indented
// continuation lines. Shown verbatim in a monospace block that is forty lines
// of terminal in the middle of a chat. Two shapes are worth reading:
//
//  - a command list (every line a row, a continuation, or the heading) →
//    a two-column list: the command as a chip, the description in prose;
//  - a one-line acknowledgement ("permission set to restricted") → a quiet
//    line, like the app's own notices.
//
// Anything else (/models' roster, /stats, /memory show) stays verbatim: its
// layout is the content.

export interface CommandRow {
  command: string
  description: string
}

export type CommandReply =
  | { kind: 'list'; heading: string | null; rows: CommandRow[] }
  | { kind: 'ack'; text: string }
  | { kind: 'verbatim' }

/** `/cmd [args]` then two or more spaces then the description. */
const ROW = /^\s*(\/\S.*?)\s{2,}(\S.*)$/
/** "commands:" — a lone heading line ending in a colon. */
const HEADING = /^([A-Za-z][\w ]*):\s*$/

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function readCommandReply(text: string): CommandReply {
  const trimmed = text.replace(/\s+$/, '').replace(/^\s*\n/, '')
  if (trimmed.length === 0) return { kind: 'verbatim' }
  const lines = trimmed.split('\n')

  if (lines.length === 1) return { kind: 'ack', text: sentence(lines[0].trim()) }

  // The description column, as most rows have it. A command too long for
  // its column (`/workflow-size [tier] show or set…`) is followed by a single
  // space, so the padding can't find it; the column can.
  const column = descriptionColumn(lines)

  let heading: string | null = null
  const rows: CommandRow[] = []
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '') continue
    const head = i === 0 ? HEADING.exec(line) : null
    if (head) {
      heading = sentence(head[1])
      continue
    }
    const row = ROW.exec(line)
    if (row) {
      rows.push({ command: row[1].trim(), description: row[2].trim() })
      continue
    }
    if (
      column !== null &&
      /^\s*\//.test(line) &&
      line.length > column &&
      line[column - 1] === ' ' &&
      line[column] !== ' '
    ) {
      rows.push({ command: line.slice(0, column).trim(), description: line.slice(column).trim() })
      continue
    }
    // A wrapped description: indented, and not a command of its own.
    const last = rows[rows.length - 1]
    if (last && /^\s{2,}/.test(line) && !line.trim().startsWith('/')) {
      last.description = `${last.description} ${line.trim()}`
      continue
    }
    return { kind: 'verbatim' }
  }
  // Two rows at least: one padded line is as likely a coincidence of spacing
  // in some other reply as it is a list.
  if (rows.length < 2) return { kind: 'verbatim' }
  return {
    kind: 'list',
    heading,
    rows: rows.map((r) => ({ ...r, description: sentence(r.description) }))
  }
}

function descriptionColumn(lines: string[]): number | null {
  const counts = new Map<number, number>()
  for (const line of lines) {
    const row = ROW.exec(line)
    if (!row) continue
    const at = line.length - row[2].length
    counts.set(at, (counts.get(at) ?? 0) + 1)
  }
  let best: number | null = null
  for (const [at, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = at
  return best
}

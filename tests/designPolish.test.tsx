// @vitest-environment jsdom
//
// The design review's small things, each a regression a screenshot caught:
// /help reads as a list and a one-line command reply as a quiet line; a
// terminal tab keeps its folder's name when the shell titles itself
// `user@host:/long/path`; a screen that opens with its main button focused
// doesn't draw the keyboard ring around it; buttons say what they do in
// sentence case; Settings' sidebar glyphs are all outlines.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { ChatMessage } from '@shared/model'
import { readCommandReply } from '@renderer/views/chat/transcript/commandReply'
import { TranscriptItemView } from '@renderer/views/chat/transcript/TranscriptItemView'
import { terminalTabLabel } from '@renderer/views/terminal/tabLabel'
import { ConfirmHost, confirmDialog } from '@renderer/views/common/ConfirmDialog'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// The CLI's /help, abridged but with its awkward lines: a padded row with
// three spaces, a description hard-wrapped onto indented lines, two
// commands on one row.
const HELP = `commands:
  /help                 this message
  /memory add [user|project] <fact>   save one fact to persistent memory
  /jobs [list] | /jobs kill <id>|all  background shell jobs
  /ultra [on|off]       toggle ultra, saved in your config (ultracode:
                        substantive tasks run as dynamic workflows; needs
                        restricted or yolo). Write "ultracode" in a message
                        to get the same for that turn only
  /workflow-size [tier] show or set the workflow size guideline
                        (small | medium | large | unbounded)
  /<skill> [args]       run a skill (or mention it as $skill in a prompt)`

const MODELS = `current model: anthropic:claude-sonnet-4-5
connected models:
  anthropic:claude-sonnet-4-5
usage: /models <provider:model> [api_key]`

function reply(text: string): ChatMessage {
  return { id: 'r1', role: 'assistant', text, attachments: [], isStreaming: false, timestamp: 1, plain: true }
}

describe('slash command replies', () => {
  it('reads /help as rows, wrapped descriptions joined', () => {
    const read = readCommandReply(HELP)
    expect(read.kind).toBe('list')
    if (read.kind !== 'list') return
    expect(read.heading).toBe('Commands')
    expect(read.rows.map((r) => r.command)).toEqual([
      '/help',
      '/memory add [user|project] <fact>',
      '/jobs [list] | /jobs kill <id>|all',
      '/ultra [on|off]',
      '/workflow-size [tier]',
      '/<skill> [args]'
    ])
    expect(read.rows[0].description).toBe('This message')
    expect(read.rows[3].description).toBe(
      'Toggle ultra, saved in your config (ultracode: substantive tasks run as dynamic workflows; needs restricted or yolo). Write "ultracode" in a message to get the same for that turn only'
    )
    expect(read.rows[4].description).toBe('Show or set the workflow size guideline (small | medium | large | unbounded)')
  })

  it('reads a one-line reply as an acknowledgement', () => {
    expect(readCommandReply('permission set to restricted\n')).toEqual({
      kind: 'ack',
      text: 'Permission set to restricted'
    })
  })

  it('leaves a reply whose layout is its content alone', () => {
    expect(readCommandReply(MODELS)).toEqual({ kind: 'verbatim' })
    // One padded line among prose is not a list.
    expect(readCommandReply('usage:\n  /budget <n|0>    set it')).toEqual({ kind: 'verbatim' })
  })

  it('draws /help as a list, not a terminal dump', () => {
    const { container } = render(<TranscriptItemView item={{ kind: 'message', message: reply(HELP) }} />)
    expect(container.querySelector('.tr-plain')).toBeNull()
    const commands = [...container.querySelectorAll('.tr-commands-list dt')].map((dt) => dt.textContent)
    expect(commands).toContain('/ultra [on|off]')
    expect(screen.getByText('This message')).toBeTruthy()
  })

  it('draws a one-line reply as a quiet line, and /models verbatim', () => {
    const { container, rerender } = render(
      <TranscriptItemView item={{ kind: 'message', message: reply('ultra off — workflows run only when asked') }} />
    )
    expect(screen.getByRole('note').textContent).toBe('Ultra off — workflows run only when asked')
    expect(container.querySelector('.tr-plain')).toBeNull()
    rerender(<TranscriptItemView item={{ kind: 'message', message: reply(MODELS) }} />)
    expect(container.querySelector('.tr-plain')?.textContent).toBe(MODELS)
  })

  it('leaves a model’s answer to markdown', () => {
    const { container } = render(
      <TranscriptItemView item={{ kind: 'message', message: { ...reply('done'), plain: undefined } }} />
    )
    expect(container.querySelector('.tr-notice')).toBeNull()
    expect(container.querySelector('.md')).not.toBeNull()
  })
})

describe('terminal tab label', () => {
  it.each([
    ['carlo@endermite:/tmp/sd-live/proj', 'proj'],
    ['carlo@endermite: ~/code/proj', 'proj'],
    ['~/code/proj', 'proj'],
    ['/tmp/sd-live/proj', 'proj'],
    ['-zsh', 'proj'],
    ['/usr/bin/fish', 'proj'],
    ['fish /tmp/sd-live/proj', 'proj'],
    ['C:\\Users\\me\\proj', 'proj'],
    ['C:\\WINDOWS\\system32\\cmd.exe', 'proj'],
    ['Windows PowerShell', 'proj'],
    ['', 'proj'],
    ['npm test', 'npm test'],
    ['vim notes.md', 'vim notes.md']
  ])('%j → %j', (title, label) => {
    expect(terminalTabLabel(title, '/tmp/sd-live/proj')).toBe(label)
  })
})

describe('autofocused default buttons', () => {
  it('focus an alert’s safe button without the keyboard ring', async () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    render(<ConfirmHost />)
    act(() => {
      void confirmDialog({ title: 'Delete it?', confirmLabel: 'Delete', destructive: true })
    })
    await act(async () => undefined)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(document.activeElement).toBe(cancel)
    const call = focus.mock.contexts.findIndex((el) => el === cancel)
    expect(call).toBeGreaterThanOrEqual(0)
    expect(focus.mock.calls[call][0]).toMatchObject({ focusVisible: false })
  })

  it('never use React’s autoFocus on a button (it draws the ring)', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(join(ROOT, 'src/renderer/src'))) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/<button\b[^>]*?\sautoFocus\b/gs)) {
        offenders.push(`${relative(ROOT, file)}: ${m[0].slice(0, 60)}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

const ROOT = join(__dirname, '..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

describe('labels', () => {
  // Names, and words that are names here (Settings is a place in the app,
  // Restricted a permission level).
  const PROPER = new Set(
    'Spettro Spettro’s API CLI Anthropic OpenAI Ollama LM Studio Claude Sonnet Opus Google GitHub Windows Linux macOS Mac iPhone iPad Pro Max Ultra Git MCP URL Ctrl Cmd Shift Alt Esc Enter Tab Settings Finder Explorer I JSON ID Restricted'.split(
      ' '
    )
  )
  const SMALL = new Set('a an the to of in on for and or with as at by from this my your'.split(' '))
  // Titles of windows and panes: names of places, not actions.
  const ALLOWED = new Set(['Remote Access', 'Keyboard Shortcuts', 'Spettro Projects', 'Spettro Desktop'])

  /** "Choose Folder…" — every word capitalized, at least one that isn't a name. */
  function isTitleCase(label: string): boolean {
    const words = label.replace(/…$/, '').split(' ')
    if (words.length < 2 || words.length > 6 || !/^[A-Z]/.test(words[0])) return false
    // A capital after a full stop starts a sentence; ALL CAPS is a badge.
    const rest = words.slice(1).filter((w, i) => !/\.$/.test(words[i]) && !/^[A-Z]{2,}$/.test(w))
    if (!rest.every((w) => /^[A-Z]/.test(w) || SMALL.has(w))) return false
    return rest.some((w) => /^[A-Z]/.test(w) && !PROPER.has(w.replace(/[.,:?!]$/, '')))
  }

  it('are in sentence case, like the rest of the app', () => {
    const offenders: string[] = []
    const files = [...sourceFiles(join(ROOT, 'src/renderer/src')), ...sourceFiles(join(ROOT, 'src/shared'))]
    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*|import )/.test(line)) return
          const texts = [
            ...[...line.matchAll(/'([^'\n]{3,60})'|"([^"\n]{3,60})"|>([^<>{}\n]{3,60})</g)].map(
              (m) => m[1] ?? m[2] ?? m[3]
            ),
            // JSX text on a line of its own
            ...(/^\s*([A-Z][^<>{}=;()'"]{2,60})$/.exec(line)?.slice(1) ?? [])
          ]
          for (const text of texts) {
            const label = text.trim()
            if (isTitleCase(label) && !ALLOWED.has(label)) offenders.push(`${relative(ROOT, file)}:${i + 1} ${label}`)
          }
        })
    }
    expect(offenders).toEqual([])
  })

  it('catches what it is for', () => {
    expect(isTitleCase('Choose Folder…')).toBe(true)
    expect(isTitleCase('Try Again')).toBe(true)
    expect(isTitleCase('Choose folder…')).toBe(false)
    expect(isTitleCase('Open Settings')).toBe(false)
    expect(isTitleCase('Sign in to Spettro')).toBe(false)
    expect(isTitleCase('Installed. Starting Spettro…')).toBe(false)
    expect(isTitleCase('Switch to Restricted?')).toBe(false)
  })
})

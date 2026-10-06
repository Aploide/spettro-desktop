// @vitest-environment jsdom
//
// The transcript as a reader meets it: reads fold into one line and open
// back up, reasoning says how long it took, a failed turn offers Try again
// (only the newest, only once it's over), a steer says where it stands, an
// edit opens to a numbered diff, a command to `$ command` and its output,
// and the run ticker says what the turn is doing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ChatMessage, ToolCallItem, TranscriptItem } from '@shared/model'
import type { MainEvent } from '@shared/ipc'
import { TranscriptRowView, TranscriptItemView } from '@renderer/views/chat/transcript/TranscriptItemView'
import { groupTranscript } from '@renderer/views/chat/transcript/orchestration'
import { groupToolRuns } from '@renderer/views/chat/transcript/toolGroups'
import { TranscriptActionsProvider } from '@renderer/views/chat/transcript/TranscriptActions'
import { runPhase } from '@renderer/views/chat/transcript/RunTicker'
import { initStore } from '@renderer/state/store'

let seq = 0

function tool(partial: Partial<ToolCallItem> & { title: string }): TranscriptItem {
  seq += 1
  return {
    kind: 'tool',
    tool: {
      id: `call_${seq}`,
      status: 'completed',
      output: '',
      diffs: [],
      locations: [],
      timestamp: seq,
      ...partial
    }
  }
}

function say(role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): TranscriptItem {
  seq += 1
  return {
    kind: 'message',
    message: { id: `m${seq}`, role, text, attachments: [], isStreaming: false, timestamp: seq, ...extra }
  }
}

const read = (path: string, status: ToolCallItem['status'] = 'completed'): TranscriptItem =>
  tool({ title: 'file-read {}', kind: 'read', status, argsJSON: JSON.stringify({ path }), output: 'x\ny' })

const grep = (pattern: string): TranscriptItem =>
  tool({ title: 'grep {}', kind: 'search', argsJSON: JSON.stringify({ pattern, path: '/app/src' }), output: 'a:1' })

function rowsOf(items: TranscriptItem[]) {
  return groupToolRuns(groupTranscript(items))
}

function renderRows(items: TranscriptItem[]): void {
  render(
    <>
      {rowsOf(items).map((row) => (
        <TranscriptRowView row={row} key={row.id} />
      ))}
    </>
  )
}

beforeEach(() => {
  seq = 0
  cleanup()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('folding reads and searches', () => {
  it('folds consecutive finished reads and searches into one line that opens to them', () => {
    renderRows([say('user', 'fix it'), read('/app/a.ts'), read('/app/b.ts'), grep('Save')])
    const line = screen.getByRole('button', { name: /Read 2 files, searched 1 pattern/ })
    expect(screen.queryByText('a.ts')).toBeNull()
    fireEvent.click(line)
    expect(screen.getByText('a.ts')).toBeTruthy()
    expect(screen.getByText('b.ts')).toBeTruthy()
    expect(screen.getByText('Save in src')).toBeTruthy()
  })

  it('never folds across a message, nor a call still running, nor a lone read', () => {
    const rows = rowsOf([
      read('/app/a.ts'),
      say('assistant', 'Looking further.'),
      read('/app/b.ts'),
      read('/app/c.ts', 'in_progress')
    ])
    expect(rows.map((r) => r.kind)).toEqual(['item', 'item', 'item', 'item'])
  })

  it('keeps the group’s identity as more calls join it', () => {
    const a = read('/app/a.ts')
    const b = read('/app/b.ts')
    const first = rowsOf([a, b])
    const second = rowsOf([a, b, read('/app/c.ts')])
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(second[0].id).toBe(first[0].id)
  })
})

describe('reasoning', () => {
  it('says how long the model thought, from its first chunk to its last', () => {
    render(<TranscriptItemView item={say('reasoning', 'hmm', { startedAt: 1_000, endedAt: 13_400 })} />)
    expect(screen.getByRole('button', { name: /Thought for 12s/ })).toBeTruthy()
    expect(screen.queryByText('hmm')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Thought for 12s/ }))
    expect(screen.getByText('hmm')).toBeTruthy()
  })

  it('says Thinking… while it streams, and makes up no duration it doesn’t have', () => {
    render(<TranscriptItemView item={say('reasoning', 'a', { isStreaming: true, startedAt: 0, endedAt: 0 })} />)
    expect(screen.getByText('Thinking…')).toBeTruthy()
    cleanup()
    render(<TranscriptItemView item={say('reasoning', 'old')} />)
    expect(screen.getByRole('button', { name: 'Thought' })).toBeTruthy()
  })
})

describe('notices and actions', () => {
  it('offers Try again on the error that ended the last turn, and sends it', () => {
    const retry = vi.fn()
    const error = say('notice', 'The provider is overloaded', { noticeIsError: true })
    render(
      <TranscriptActionsProvider value={{ retry, retryNoticeId: error.kind === 'message' ? error.message.id : null }}>
        <TranscriptItemView item={error} />
        <TranscriptItemView item={say('notice', 'Earlier failure', { noticeIsError: true })} />
        <TranscriptItemView item={say('notice', 'Interrupted')} />
      </TranscriptActionsProvider>
    )
    const buttons = screen.getAllByRole('button', { name: /Try again/ })
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0])
    expect(retry).toHaveBeenCalledOnce()
    // Information is a line, not an alert.
    expect(screen.getAllByRole('alert')).toHaveLength(2)
    expect(screen.getByRole('note').textContent).toContain('Interrupted')
  })

  it('offers Edit & resend on the newest user message only', () => {
    const editMessage = vi.fn()
    const older = say('user', 'first try')
    const newest = say('user', 'second try')
    render(
      <TranscriptActionsProvider
        value={{ editMessage, lastUserMessageId: newest.kind === 'message' ? newest.message.id : null }}
      >
        <TranscriptItemView item={older} />
        <TranscriptItemView item={newest} />
      </TranscriptActionsProvider>
    )
    const edits = screen.getAllByRole('button', { name: 'Edit & resend' })
    expect(edits).toHaveLength(1)
    fireEvent.click(edits[0])
    expect(editMessage).toHaveBeenCalledWith('second try')
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(2)
  })
})

describe('a steer sent mid-turn', () => {
  it('says it is queued, then Delivered for a moment, then nothing', () => {
    vi.useFakeTimers()
    const queued = say('user', 'also fix ProfileForm', { steering: 'queued' })
    const { rerender } = render(<TranscriptItemView item={queued} />)
    expect(screen.getByText('Queued · will be seen at the next step')).toBeTruthy()

    const message = (queued as { message: ChatMessage }).message
    rerender(<TranscriptItemView item={{ kind: 'message', message: { ...message, steering: 'delivered' } }} />)
    expect(screen.getByText('Delivered')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.queryByText('Delivered')).toBeNull()
  })

  it('says nothing for a steer that was delivered before the chat was opened', () => {
    render(<TranscriptItemView item={say('user', 'old steer', { steering: 'delivered' })} />)
    expect(screen.queryByText('Delivered')).toBeNull()
  })
})

describe('tool rows', () => {
  it('opens an edit to a numbered unified diff', () => {
    const before = 'a\nb\nc\nd\n'
    const after = 'a\nb\nC\nd\n'
    renderRows([
      tool({
        title: 'file-edit {}',
        kind: 'edit',
        argsJSON: JSON.stringify({ path: '/app/src/x.ts' }),
        diffs: [{ path: '/app/src/x.ts', oldText: before, newText: after }]
      })
    ])
    const row = screen.getByRole('button', { name: /Edit x\.ts/ })
    expect(row.textContent).toContain('+1')
    expect(row.textContent).toContain('−1')
    fireEvent.click(row)
    const lines = screen.getAllByRole('row').map((r) => r.textContent)
    expect(lines).toContain('3+C')
    expect(lines).toContain('44 d')
    expect(lines).toContain('3−c')
  })

  it('opens a command to `$ command` and its output, held to 30 lines', () => {
    const output = Array.from({ length: 45 }, (_, i) => `out ${i + 1}`).join('\n')
    renderRows([
      tool({ title: 'bash {}', kind: 'execute', argsJSON: JSON.stringify({ command: 'npm test' }), output })
    ])
    fireEvent.click(screen.getByRole('button', { name: /Bash npm test/ }))
    expect(screen.getByText('$')).toBeTruthy()
    expect(screen.getByText(/out 30$/m)).toBeTruthy()
    expect(screen.queryByText(/out 31/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show 15 more lines' }))
    expect(screen.getByText(/out 45/)).toBeTruthy()
  })

  it('marks a call waiting for the user’s approval', () => {
    let push: (event: MainEvent) => void = () => undefined
    ;(window as unknown as { spettro: unknown }).spettro = {
      platform: 'linux',
      onEvent: (cb: (event: MainEvent) => void) => {
        push = cb
        return () => undefined
      },
      call: () => Promise.resolve(null)
    }
    initStore()
    const item = tool({ title: 'bash {}', kind: 'execute', status: 'pending', argsJSON: '{"command":"rm -rf dist"}' })
    render(<TranscriptItemView item={item} />)
    expect(screen.getByRole('img', { name: 'Not started' })).toBeTruthy()
    act(() =>
      push({
        type: 'permissions',
        requests: [
          {
            id: 'p1',
            sessionId: 's',
            chatId: 'c',
            toolCallId: (item as { tool: ToolCallItem }).tool.id,
            title: 'Run rm -rf dist',
            content: { texts: [], diffs: [] },
            locations: [],
            options: []
          }
        ]
      })
    )
    expect(screen.getByRole('img', { name: 'Needs approval' })).toBeTruthy()
    expect(screen.getByText('Needs approval', { selector: '.tr-tool-meta' })).toBeTruthy()
  })
})

describe('what the run ticker says the turn is doing', () => {
  const user = say('user', 'go')
  it('working while a tool runs, writing once every tool has settled', () => {
    expect(runPhase([user, read('/a', 'in_progress')], false)).toBe('Working…')
    expect(runPhase([user, read('/a')], false)).toBe('Writing the answer…')
  })

  it('thinking while reasoning streams, waiting while an approval is open', () => {
    expect(runPhase([user, say('reasoning', 'x', { isStreaming: true })], false)).toBe('Thinking…')
    expect(runPhase([user, read('/a', 'pending')], true)).toBe('Waiting for your approval…')
  })

  it('only looks at this turn: an old answer is not this turn writing', () => {
    expect(runPhase([say('user', 'a'), read('/a'), say('assistant', 'done'), say('user', 'b')], false)).toBe(
      'Working…'
    )
  })
})

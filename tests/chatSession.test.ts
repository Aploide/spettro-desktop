// ChatSession owns the transcript mutations the whole app is downstream of.
// One of them — applyToolEvent's argsJSON overwrite — is the direct cause of a
// finished workflow losing its phase plan, which is why orchestration.ts has
// a text-recovery path at all. Pinning that behaviour here means the day
// somebody "fixes" it, the fold's fallback stops being load-bearing on
// purpose rather than by accident.

import { describe, expect, it } from 'vitest'
import { ChatSession } from '@main/model/chatSession'
import type { ACPToolCallEvent } from '@shared/acp'

function session(): ChatSession {
  return new ChatSession('/project', 'test', 'chat-1', 1_700_000_000_000)
}

function toolEvent(partial: Partial<ACPToolCallEvent> & { toolCallId: string }): ACPToolCallEvent {
  return { texts: [], diffs: [], locations: [], ...partial }
}

function toolAt(s: ChatSession, index = 0) {
  const item = s.items[index]
  if (item?.kind !== 'tool') throw new Error(`item ${index} is not a tool call`)
  return item.tool
}

describe('applyToolEvent', () => {
  it('appends on first sight and merges on the same toolCallId', () => {
    const s = session()
    s.applyToolEvent(toolEvent({ toolCallId: 'c1', title: 'bash {}', status: 'in_progress' }), true)
    s.applyToolEvent(toolEvent({ toolCallId: 'c1', status: 'completed', texts: ['done'] }), false)

    expect(s.items).toHaveLength(1)
    expect(toolAt(s).status).toBe('completed')
    expect(toolAt(s).output).toBe('done')
    // The title from the start survives an update that did not resend one.
    expect(toolAt(s).title).toBe('bash {}')
  })

  it('does not let a contentless update wipe output already received', () => {
    const s = session()
    s.applyToolEvent(toolEvent({ toolCallId: 'c1', title: 't', texts: ['the answer'] }), true)
    s.applyToolEvent(toolEvent({ toolCallId: 'c1', status: 'completed' }), false)
    expect(toolAt(s).output).toBe('the answer')
  })

  it('keeps the original timestamp, so elapsed time is measured from the start', () => {
    const s = session()
    s.applyToolEvent(toolEvent({ toolCallId: 'c1', title: 't' }), true)
    const started = toolAt(s).timestamp
    s.applyToolEvent(toolEvent({ toolCallId: 'c1', status: 'completed' }), false)
    expect(toolAt(s).timestamp).toBe(started)
  })

  it('OVERWRITES argsJSON whenever an update carries rawInput', () => {
    // This is the behaviour orchestration.ts has to work around, and it is
    // load-bearing that it stays documented: the CLI's workflow finish update
    // sends a completely different payload, so a finished run's `phases` and
    // `description` are gone from here and can only be recovered from the
    // rendered text. If this ever stops being true, that fallback becomes
    // dead weight rather than the only thing holding the card up.
    const s = session()
    s.applyToolEvent(
      toolEvent({
        toolCallId: 'wf-1',
        title: 'workflow review',
        rawInput: { run_id: 'wf_1', workflow: 'review', phases: [{ title: 'Review' }] }
      }),
      true
    )
    expect(toolAt(s).argsJSON).toContain('phases')

    s.applyToolEvent(
      toolEvent({
        toolCallId: 'wf-1',
        status: 'completed',
        rawInput: { run_id: 'wf_1', workflow: 'review', agents: 3, failed: 0, cached: 0 }
      }),
      false
    )
    expect(toolAt(s).argsJSON).not.toContain('phases')
    expect(toolAt(s).argsJSON).toContain('agents')
  })

  it('keeps two different tool calls apart', () => {
    const s = session()
    s.applyToolEvent(toolEvent({ toolCallId: 'c1', title: 'first' }), true)
    s.applyToolEvent(toolEvent({ toolCallId: 'c2', title: 'second' }), true)
    s.applyToolEvent(toolEvent({ toolCallId: 'c1', status: 'completed' }), false)

    expect(s.items).toHaveLength(2)
    expect(toolAt(s, 0).status).toBe('completed')
    expect(toolAt(s, 1).status).not.toBe('completed')
  })

  it('treats a completion with no matching start as an already-finished call', () => {
    // A call rejected before it ran arrives exactly once, as a completion.
    const s = session()
    s.applyToolEvent(toolEvent({ toolCallId: 'c9', title: 'denied', texts: ['no'] }), false)
    expect(s.items).toHaveLength(1)
    expect(toolAt(s).status).toBe('completed')
  })

  it('emits the item it touched, so the renderer can upsert one row', () => {
    const s = session()
    const seen: string[] = []
    s.onItem = (_s, item) => {
      if (item.kind === 'tool') seen.push(item.tool.id)
    }
    s.applyToolEvent(toolEvent({ toolCallId: 'c1', title: 't' }), true)
    s.applyToolEvent(toolEvent({ toolCallId: 'c1', status: 'completed' }), false)
    expect(seen).toEqual(['c1', 'c1'])
  })
})

describe('config values', () => {
  it('reports what the chips are showing', () => {
    const s = session()
    s.configOptions = [
      { id: 'mode', name: 'Mode', kind: { type: 'select', currentValue: 'coding', groups: [], flat: [] } },
      { id: 'ultra', name: 'Ultra', kind: { type: 'boolean', currentValue: true } }
    ]
    expect(s.displayedConfigValues()).toEqual({ mode: 'coding', ultra: true })
  })

  it('applies a value of the right type and refuses a mismatched one', () => {
    const s = session()
    s.configOptions = [{ id: 'ultra', name: 'Ultra', kind: { type: 'boolean', currentValue: false } }]

    s.applyLocalConfigValue('ultra', true)
    expect(s.displayedConfigValues()['ultra']).toBe(true)

    // A string into a boolean chip is a bug upstream; applying it would put a
    // value on screen that the option cannot hold.
    s.applyLocalConfigValue('ultra', 'yes' as never)
    expect(s.displayedConfigValues()['ultra']).toBe(true)
  })

  it('ignores an option the agent never advertised', () => {
    const s = session()
    expect(() => s.applyLocalConfigValue('nope', true)).not.toThrow()
  })
})

describe('scratch sessions', () => {
  it('are ordinary chats that simply are not filed', () => {
    // The studio depends on a scratch chat behaving exactly like a real one
    // for streaming, and on nothing else treating it as a conversation.
    const s = session()
    expect(s.isScratch).toBe(false)
    s.isScratch = true
    s.applyToolEvent(toolEvent({ toolCallId: 'c1', title: 't' }), true)
    expect(s.items).toHaveLength(1)
  })
})

// ChatSession owns the transcript mutations the whole app is downstream of.
// One of them — applyToolEvent's argsJSON overwrite — is the direct cause of a
// finished workflow losing its phase plan, which is why orchestration.ts has
// a text-recovery path at all. Pinning that behaviour here means the day
// somebody "fixes" it, the fold's fallback stops being load-bearing on
// purpose rather than by accident.

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatSession } from '@main/model/chatSession'
import { AppModel } from '@main/model/appModel'
import type { ACPToolCallEvent } from '@shared/acp'
import type { StoredSession } from '@shared/model'

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

// ---------------------------------------------------------------------------
// Rename, unread, recents — through AppModel, which is what the IPC handlers
// call (renameChat, rememberProject and removeRecentProject pass straight
// through in src/main/ipc.ts), against a real sessions.json on disk.
// ---------------------------------------------------------------------------

describe('ChatSession.rename', () => {
  it('trims, collapses whitespace and announces the new title', () => {
    const s = session()
    const metas: unknown[] = []
    s.onMeta = (_s, meta) => metas.push(meta)
    expect(s.rename('  Fix   the\nlogin bug ')).toBe(true)
    expect(s.title).toBe('Fix the login bug')
    expect(metas).toEqual([{ title: 'Fix the login bug' }])
  })

  it('refuses a blank title and a no-op', () => {
    const s = session()
    expect(s.rename('   ')).toBe(false)
    expect(s.rename('test')).toBe(false)
    expect(s.title).toBe('test')
  })

  it('is not overwritten by the first prompt once the user has named it', () => {
    const s = new ChatSession('/work/acme', undefined, 'chat-2')
    s.rename('My session')
    s.appendUserMessage('please refactor everything')
    expect(s.title).toBe('My session')
  })
})

describe('AppModel sessions (rename, unread, recents)', () => {
  async function setup(stored: StoredSession[]): Promise<{
    dir: string
    model: AppModel
    remote: unknown[]
  }> {
    const dir = mkdtempSync(join(tmpdir(), 'spettro-rename-'))
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify(stored))
    const model = load(dir)
    const remote: unknown[] = []
    model.on('chat-state', (summary: unknown) => remote.push(summary))
    return { dir, model, remote }
  }

  /** A model over `dir` with its saved chats loaded — bootstrap's first step,
   *  without the CLI lookup that follows it. */
  function load(dir: string): AppModel {
    const model = new AppModel({ userDataDir: dir, appVersion: '0.0.0-test' })
    ;(model as unknown as { loadPersistedSessions(): void }).loadPersistedSessions()
    return model
  }

  function stored(id: string, title: string): StoredSession {
    return {
      id,
      acpSessionId: null,
      projectPath: '/work/acme',
      title,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      isPinned: false,
      isArchived: false,
      items: [
        {
          kind: 'message',
          message: {
            id: `m-${id}`,
            role: 'user',
            text: 'hello',
            attachments: [],
            isStreaming: false,
            timestamp: 1_700_000_000_000
          }
        }
      ],
      configOptions: [],
      pendingConfigChanges: {}
    }
  }

  it('persists a rename across a restart and tells the sidebar and paired phones', async () => {
    const { dir, model, remote } = await setup([stored('a', 'hello'), stored('b', 'other')])
    model.renameChat('a', 'Login bug')

    expect(model.getState().sessions.find((s) => s.id === 'a')?.title).toBe('Login bug')
    expect(remote).toHaveLength(1)
    // A fresh model over the same folder is what a relaunch sees.
    expect(load(dir).getState().sessions.find((s) => s.id === 'a')?.title).toBe('Login bug')
    rmSync(dir, { recursive: true, force: true })
  })

  it('ignores a blank rename and an unknown chat', async () => {
    const { dir, model, remote } = await setup([stored('a', 'hello')])
    model.renameChat('a', '   ')
    model.renameChat('nope', 'x')
    expect(model.getState().sessions[0].title).toBe('hello')
    expect(remote).toHaveLength(0)
    rmSync(dir, { recursive: true, force: true })
  })

  it('marks a turn that ends out of sight as unread, and clears it on open', async () => {
    const { dir, model } = await setup([stored('a', 'hello'), stored('b', 'other')])
    const internals = model as unknown as {
      agent: unknown
      liveACPSessionId: (s: ChatSession) => string | null
      runTurn(s: ChatSession, blocks: unknown[]): Promise<void>
      connect(): Promise<void>
    }
    internals.agent = { prompt: () => Promise.resolve('end_turn') }
    internals.liveACPSessionId = () => 'acp-1'
    // openChat warms the session through the agent; nothing to warm here.
    internals.connect = () => Promise.resolve()
    ;(model as unknown as { warmSession(): void }).warmSession = () => undefined

    model.selectSession('b')
    await internals.runTurn(model.sessionById('a') as ChatSession, [])
    expect(model.getState().sessions.find((s) => s.id === 'a')?.unread).toBe(true)

    // The chat on screen never goes unread: the user watched it finish.
    await internals.runTurn(model.sessionById('b') as ChatSession, [])
    expect(model.getState().sessions.find((s) => s.id === 'b')?.unread).toBe(false)

    model.openChat('a')
    expect(model.getState().sessions.find((s) => s.id === 'a')?.unread).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('remembers a folder without creating a chat, and forgets it on request', async () => {
    const { dir, model } = await setup([])
    const folder = mkdtempSync(join(tmpdir(), 'spettro-project-'))
    model.rememberProject(folder)
    expect(model.getState().recentProjects).toEqual([folder])
    expect(model.getState().defaultProjectPath).toBe(folder)
    expect(model.getState().sessions).toHaveLength(0)

    // A recent that has since disappeared is reported, not hidden.
    model.rememberProject(join(folder, 'gone'))
    expect(model.getState().missingProjects).toEqual([join(folder, 'gone')])

    model.removeRecentProject(join(folder, 'gone'))
    expect(model.getState().recentProjects).toEqual([folder])
    expect(model.getState().missingProjects).toEqual([])
    rmSync(folder, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })
})

// ChatSession owns the transcript mutations the whole app is downstream of.
// One of them — applyToolEvent's argsJSON overwrite — is the direct cause of a
// finished workflow (from an older CLI) losing its phase plan, which is why
// orchestration.ts has a text-recovery path at all. Pinning that behaviour
// here means the day somebody "fixes" it, the fold's fallback stops being
// load-bearing on purpose rather than by accident. The current CLI sends the
// whole run as `_meta` on every card update, which is kept whole.

import { describe, expect, it, vi } from 'vitest'
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
  return { texts: [], diffs: [], images: [], locations: [], ...partial }
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
    // load-bearing that it stays documented: an older CLI's workflow finish
    // update sent a completely different payload, so a finished run's `phases` and
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

  it('keeps a workflow card’s metadata, replaced whole by each update that carries it', () => {
    // internal/acp/workflow.go sends the run's full state on every update, so
    // the latest one is the truth; an update without it (none, today) must
    // not erase it.
    const s = session()
    s.applyToolEvent(
      toolEvent({ toolCallId: 'workflow-wf_1', title: 'workflow audit', workflowMeta: { version: 1, status: 'running' } }),
      true
    )
    expect(toolAt(s).workflow).toEqual({ version: 1, status: 'running' })
    s.applyToolEvent(
      toolEvent({ toolCallId: 'workflow-wf_1', workflowMeta: { version: 1, status: 'paused' } }),
      false
    )
    expect(toolAt(s).workflow).toEqual({ version: 1, status: 'paused' })
    s.applyToolEvent(toolEvent({ toolCallId: 'workflow-wf_1', status: 'completed' }), false)
    expect(toolAt(s).workflow).toEqual({ version: 1, status: 'paused' })
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

  it('keeps a later turn’s call-1 off the earlier turn’s card', () => {
    // spettro numbers tool calls per turn (content.go nextToolCallID), so
    // every turn has a call-1.
    const s = session()
    s.appendUserMessage('ls')
    s.applyToolEvent(toolEvent({ toolCallId: 'call-1', title: 'Run ls -la' }), true)
    s.applyToolEvent(toolEvent({ toolCallId: 'call-1', status: 'completed' }), false)
    s.appendUserMessage('touch it')
    expect(s.toolById('call-1')).toBeNull() // that one is the last turn's
    s.applyToolEvent(toolEvent({ toolCallId: 'call-1', title: 'Run touch a.txt' }), true)
    s.applyToolEvent(toolEvent({ toolCallId: 'call-1', status: 'failed' }), false)

    const tools = s.items.filter((i) => i.kind === 'tool').map((i) => (i.kind === 'tool' ? i.tool : null))
    expect(tools.map((t) => [t?.id, t?.title, t?.status])).toEqual([
      ['call-1', 'Run ls -la', 'completed'],
      ['call-1~2', 'Run touch a.txt', 'failed']
    ])
    expect(s.toolById('call-1')?.title).toBe('Run touch a.txt')
    expect(s.toolById('call-1~2')?.title).toBe('Run touch a.txt')
    // A steer is part of the running turn, not a new one.
    s.appendUserMessage('also b.txt', [], 'sending')
    expect(s.toolById('call-1')?.title).toBe('Run touch a.txt')
  })

  it('still finds a workflow card from an earlier turn', () => {
    const s = session()
    s.appendUserMessage('run it')
    s.applyToolEvent(toolEvent({ toolCallId: 'workflow-wf_1', title: 'workflow review' }), true)
    s.appendUserMessage('next')
    s.applyToolEvent(toolEvent({ toolCallId: 'workflow-wf_1', status: 'completed' }), false)
    expect(s.items.filter((i) => i.kind === 'tool')).toHaveLength(1)
    expect(s.toolById('workflow-wf_1')?.status).toBe('completed')
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

describe('reasoning timing', () => {
  it('stamps a reasoning bubble with its first and latest chunk, for "Thought for Ns"', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const s = session()
    s.appendReasoning('Looking at ')
    vi.setSystemTime(9_500)
    s.appendReasoning('the form.')
    vi.setSystemTime(12_000)
    s.appendAssistant('Fixed.')
    vi.useRealTimers()
    const item = s.items[0]
    if (item.kind !== 'message') throw new Error('expected the reasoning bubble')
    expect(item.message).toMatchObject({ startedAt: 1_000, endedAt: 9_500, isStreaming: false })
    // An answer is not reasoning, and is not stamped.
    const answer = s.items[1]
    expect(answer.kind === 'message' && answer.message.startedAt).toBeUndefined()
  })
})

describe('interim prose', () => {
  it('is finished once the agent moves on to a tool call', () => {
    const s = session()
    s.appendAssistant('Let me look at the form.')
    s.applyToolEvent(toolEvent({ toolCallId: 'c1', title: 'file-read {}', status: 'in_progress' }), true)
    const prose = s.items[0]
    expect(prose.kind === 'message' && prose.message.isStreaming).toBe(false)
    // …and the next prose starts a bubble of its own.
    s.appendAssistant('Fixed.')
    expect(s.items).toHaveLength(3)
    s.endStreaming()
    expect(s.items.every((item) => item.kind !== 'message' || !item.message.isStreaming)).toBe(true)
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

describe('ChatSession.updatedAt', () => {
  it('moves with the conversation, not with notices the app adds itself', () => {
    const s = new ChatSession('/work/acme', 'Old chat', 'chat-3', 1_000)
    expect(s.updatedAt).toBe(1_000)
    s.appendUserMessage('hello')
    const spoke = s.updatedAt
    expect(spoke).toBeGreaterThan(1_000)
    // Opening an old chat whose context can't be restored adds a notice;
    // that must not make the chat look (and sort) as if it just moved.
    s.items.push({
      kind: 'message',
      message: {
        id: 'n1',
        role: 'notice',
        text: "Couldn't restore this chat's earlier context — starting fresh.",
        attachments: [],
        isStreaming: false,
        timestamp: spoke + 60_000
      }
    })
    expect(s.updatedAt).toBe(spoke)
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

  it('Try again resends the newest prompt, and never while a turn is running', async () => {
    const { dir, model } = await setup([stored('a', 'hello')])
    const send = vi.spyOn(model, 'send').mockImplementation(() => undefined)
    model.retryLast('a')
    expect(send).toHaveBeenCalledWith('a', 'hello', [])
    send.mockClear()
    model.sessionById('a')?.setBusy(true)
    model.retryLast('a')
    model.retryLast('nope')
    expect(send).not.toHaveBeenCalled()
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
    internals.agent = { prompt: () => Promise.resolve({ stopReason: 'end_turn' }) }
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

  it('marks the error a turn ended on, and not a refused settings change', async () => {
    const { dir, model } = await setup([stored('a', 'hello')])
    const internals = model as unknown as {
      agent: unknown
      liveACPSessionId: (s: ChatSession) => string | null
      runTurn(s: ChatSession, blocks: unknown[]): Promise<void>
    }
    internals.agent = {
      prompt: () => Promise.reject(new Error('provider overloaded')),
      setConfigOption: () => Promise.reject(new Error('unknown model'))
    }
    internals.liveACPSessionId = () => 'acp-1'
    const session = model.sessionById('a') as ChatSession
    const lastNotice = () => {
      const item = session.items[session.items.length - 1]
      return item.kind === 'message' ? item.message : null
    }

    await internals.runTurn(session, [])
    expect(lastNotice()).toMatchObject({ role: 'notice', noticeIsError: true, endsTurn: true })

    // Try again resends the prompt; that fixes neither of these, so they
    // must not look like the end of a turn.
    await model.setConfigValue('a', 'model', 'nope')
    expect(lastNotice()?.text).toContain("Couldn't change model")
    expect(lastNotice()?.endsTurn).toBeUndefined()
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

describe('sessions saved by an older build', () => {
  function legacy(): StoredSession {
    return {
      id: 'old',
      acpSessionId: 'acp-old',
      projectPath: '/work/acme',
      title: 'Old',
      createdAt: 1,
      updatedAt: 1,
      isPinned: false,
      isArchived: false,
      items: [
        {
          kind: 'tool',
          // Before line numbers were kept, locations were bare paths.
          tool: { id: 'c1', title: 'Read a.go', status: 'completed', output: '', diffs: [], locations: ['/p/a.go'] as never, timestamp: 1 }
        },
        {
          kind: 'message',
          message: { id: 'm1', role: 'user', text: 'and also…', attachments: [], isStreaming: false, timestamp: 2, steering: 'queued' }
        }
      ],
      configOptions: [],
      pendingConfigChanges: {}
    }
  }

  it('get their tool locations upgraded to { path }', () => {
    const s = ChatSession.restore(legacy())
    expect(toolAt(s).locations).toEqual([{ path: '/p/a.go' }])
  })

  it('drop a malformed item instead of failing the whole load', () => {
    const stored = legacy()
    stored.items.push({ kind: 'message' } as never, null as never, { kind: 'tool' } as never)
    const s = ChatSession.restore(stored)
    expect(s.items).toHaveLength(2)
  })

  it('stop "streaming" a bubble saved mid-stream, so it shows no typing dots', () => {
    const stored = legacy()
    stored.items.push({
      kind: 'message',
      message: { id: 'm2', role: 'assistant', text: 'Let me look…', attachments: [], isStreaming: true, timestamp: 3 }
    })
    const s = ChatSession.restore(stored)
    const item = s.items[2]
    expect(item.kind === 'message' && item.message.isStreaming).toBe(false)
  })

  it('lose a steering state no turn is left to resolve', () => {
    const s = ChatSession.restore(legacy())
    const item = s.items[1]
    expect(item.kind === 'message' && item.message.steering).toBeUndefined()
  })

  it('start counting tokens from zero, and keep the count from then on', () => {
    const s = ChatSession.restore(legacy())
    expect(s.sessionTokens).toBe(0)
    s.recordTurn({ stopReason: 'end_turn', inputTokens: 1, outputTokens: 1, cachedReadTokens: 0, totalTokens: 2, durationMs: 5 })
    expect(ChatSession.restore(s.snapshot()).sessionTokens).toBe(2)
  })
})

describe('the commands cache', () => {
  it('is per folder, migrates the old single list, and falls back to the last list seen', async () => {
    const { Prefs } = await import('@main/model/prefs')
    const dir = mkdtempSync(join(tmpdir(), 'spettro-prefs-'))
    writeFileSync(join(dir, 'preferences.json'), JSON.stringify({ cachedCommands: [{ name: 'help' }] }))
    const prefs = new Prefs(dir)
    // The old global list serves every folder until one has its own.
    expect(prefs.cachedCommands('/a')).toEqual([{ name: 'help' }])

    prefs.setCachedCommands('/a', [{ name: 'help' }, { name: 'deploy' }])
    prefs.setCachedCommands('/b', [{ name: 'help' }])
    expect(prefs.cachedCommands('/a')).toEqual([{ name: 'help' }, { name: 'deploy' }])
    expect(prefs.cachedCommands('/b')).toEqual([{ name: 'help' }])
    expect(prefs.cachedCommands('/never-opened')).toEqual([{ name: 'help' }])
    // An empty announcement never wipes what was there.
    prefs.setCachedCommands('/a', [])
    expect(new Prefs(dir).cachedCommands('/a')).toEqual([{ name: 'help' }, { name: 'deploy' }])
    rmSync(dir, { recursive: true, force: true })
  })
})

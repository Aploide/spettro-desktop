// Performance properties of the main process and its IPC: the things that
// made the window freeze or flood (sessions.json rewritten whole on every
// config reply, one message per streamed chunk, every chat copied across on
// every switch). Each test pins a property, not a timing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatSession } from '@main/model/chatSession'
import { AppModel } from '@main/model/appModel'
import { SessionStore } from '@main/model/sessionStore'
import { FRAME_MS, RendererEventQueue } from '@main/rendererEvents'
import { AcpConnection } from '@main/acp/connection'
import type { MainEvent } from '@shared/ipc'
import type { ACPConfigOption } from '@shared/acp'
import type { ChatDetail, StoredSession, TranscriptItem } from '@shared/model'

function message(id: string, text: string): TranscriptItem {
  return {
    kind: 'message',
    message: { id, role: 'assistant', text, attachments: [], isStreaming: false, timestamp: 1 }
  }
}

function detail(id: string): ChatDetail {
  return {
    id,
    title: id,
    projectPath: '/p',
    acpSessionId: null,
    isPinned: false,
    isArchived: false,
    isBusy: false,
    createdAt: 1,
    items: [],
    configOptions: [],
    commands: [],
    plan: [],
    usage: null,
    lastTurn: null,
    sessionTokens: 0
  }
}

function option(id: string, value: string): ACPConfigOption {
  return {
    id,
    name: id,
    kind: {
      type: 'select',
      currentValue: value,
      flat: ['a', 'b', 'low', 'max', 'm', 'other'].map((v) => ({ value: v, name: v })),
      groups: []
    }
  } as unknown as ACPConfigOption
}

describe('RendererEventQueue (main → window)', () => {
  let sent: MainEvent[]
  let queue: RendererEventQueue
  beforeEach(() => {
    vi.useFakeTimers()
    sent = []
    queue = new RendererEventQueue((e) => sent.push(e))
  })
  afterEach(() => {
    queue.dispose()
    vi.useRealTimers()
  })

  it('sends a streamed item once per frame, in its newest state', () => {
    queue.push({ type: 'chat-reset', chat: detail('a') })
    sent = []
    const item = message('m1', '')
    for (let i = 0; i < 50; i++) {
      ;(item as Extract<TranscriptItem, { kind: 'message' }>).message.text += 'x'
      queue.push({ type: 'chat-item', chatId: 'a', item })
    }
    expect(sent).toHaveLength(0)
    vi.advanceTimersByTime(FRAME_MS)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'chat-item', chatId: 'a' })
    expect((sent[0] as { item: TranscriptItem }).item).toBe(item)
  })

  it('keeps new items in the order they were created, however often each changes', () => {
    queue.push({ type: 'chat-reset', chat: detail('a') })
    sent = []
    queue.push({ type: 'chat-item', chatId: 'a', item: message('m1', 'a') })
    queue.push({ type: 'chat-item', chatId: 'a', item: message('m2', 'b') })
    queue.push({ type: 'chat-item', chatId: 'a', item: message('m1', 'a2') })
    queue.flush()
    expect(sent.map((e) => (e as { item: { message: { id: string } } }).item.message.id)).toEqual(['m1', 'm2'])
  })

  it('merges chat-meta per chat and sends one app-state per frame', () => {
    queue.push({ type: 'chat-reset', chat: detail('a') })
    sent = []
    queue.push({ type: 'chat-meta', chatId: 'a', meta: { isBusy: true } })
    queue.push({ type: 'chat-meta', chatId: 'a', meta: { title: 'T' } })
    queue.push({ type: 'chat-meta', chatId: 'a', meta: { isBusy: false } })
    for (let i = 0; i < 7; i++) queue.push({ type: 'app-state', state: { n: i } as never })
    vi.advanceTimersByTime(FRAME_MS)
    expect(sent).toEqual([
      { type: 'chat-meta', chatId: 'a', meta: { isBusy: false, title: 'T' } },
      { type: 'app-state', state: { n: 6 } }
    ])
  })

  it('sends an app-state only when it differs from the last one sent', () => {
    const state = { n: 1, list: ['a'] }
    queue.push({ type: 'app-state', state: state as never })
    queue.flush()
    queue.push({ type: 'app-state', state: { n: 1, list: ['a'] } as never })
    queue.flush()
    expect(sent).toHaveLength(1)
    // Changed in place since it was sent: still seen as a change.
    state.list.push('b')
    queue.push({ type: 'app-state', state: state as never })
    queue.flush()
    expect(sent).toHaveLength(2)
    // A reloaded page has nothing: it gets the next one whatever it says.
    queue.reset()
    queue.push({ type: 'app-state', state: state as never })
    queue.flush()
    expect(sent).toHaveLength(3)
  })

  it('never coalesces away a banner, which is in one snapshot only', () => {
    queue.push({ type: 'app-state', state: { banner: 'Restarting', bannerNonce: 1 } as never })
    queue.push({ type: 'app-state', state: { banner: null, bannerNonce: 1 } as never })
    vi.advanceTimersByTime(FRAME_MS)
    expect(sent.map((e) => (e as { state: { banner: string | null } }).state.banner)).toEqual(['Restarting', null])
  })

  it('sends a chip change as its value, not the whole option set', () => {
    queue.push({ type: 'chat-reset', chat: detail('a') })
    sent = []
    queue.push({ type: 'chat-config-value', chatId: 'a', configId: 'thinking', value: 'low' })
    queue.push({ type: 'chat-config-value', chatId: 'a', configId: 'thinking', value: 'max' })
    queue.push({ type: 'chat-config-value', chatId: 'a', configId: 'ultra', value: true })
    queue.flush()
    expect(sent).toEqual([
      { type: 'chat-config-value', chatId: 'a', configId: 'thinking', value: 'max' },
      { type: 'chat-config-value', chatId: 'a', configId: 'ultra', value: true }
    ])
    // A whole set supersedes the values queued before it; a value after it
    // is applied on top.
    sent = []
    const options = [option('thinking', 'high')]
    queue.push({ type: 'chat-config-value', chatId: 'a', configId: 'thinking', value: 'max' })
    queue.push({ type: 'chat-meta', chatId: 'a', meta: { configOptions: options } })
    queue.flush()
    expect(sent).toEqual([{ type: 'chat-meta', chatId: 'a', meta: { configOptions: options } }])
    sent = []
    queue.push({ type: 'chat-meta', chatId: 'a', meta: { configOptions: options } })
    queue.push({ type: 'chat-config-value', chatId: 'a', configId: 'thinking', value: 'low' })
    queue.flush()
    expect(sent).toEqual([
      { type: 'chat-meta', chatId: 'a', meta: { configOptions: options } },
      { type: 'chat-config-value', chatId: 'a', configId: 'thinking', value: 'low' }
    ])
  })

  it('end to end: a chip change in main reaches the window as one small value event', () => {
    const s = new ChatSession('/p', 'Chat', 'a', 1)
    s.setConfigOptions([option('thinking', 'low'), option('model', 'm')])
    queue.push({ type: 'chat-reset', chat: s.detail() })
    sent = []
    s.onMeta = (_s, meta) => queue.push({ type: 'chat-meta', chatId: 'a', meta })
    s.onConfigValue = (_s, configId, value) => queue.push({ type: 'chat-config-value', chatId: 'a', configId, value })
    s.applyLocalConfigValue('thinking', 'max')
    s.setConfigOptions([option('thinking', 'max'), option('model', 'm')]) // the CLI's reply
    queue.flush()
    expect(sent).toEqual([{ type: 'chat-config-value', chatId: 'a', configId: 'thinking', value: 'max' }])
  })

  it('sends nothing for a chat the renderer never loaded', () => {
    queue.push({ type: 'chat-item', chatId: 'cold', item: message('m1', 'a') })
    queue.push({ type: 'chat-meta', chatId: 'cold', meta: { isBusy: true } })
    vi.advanceTimersByTime(FRAME_MS * 4)
    expect(sent).toHaveLength(0)
    queue.markLoaded('cold')
    queue.push({ type: 'chat-meta', chatId: 'cold', meta: { isBusy: true } })
    queue.flush()
    expect(sent).toHaveLength(1)
  })

  it('copies a chat across once: a second reset for a held chat is dropped, until the page reloads', () => {
    queue.push({ type: 'chat-reset', chat: detail('a') })
    queue.push({ type: 'chat-reset', chat: detail('a') })
    expect(sent.filter((e) => e.type === 'chat-reset')).toHaveLength(1)
    queue.reset()
    queue.push({ type: 'chat-reset', chat: detail('a') })
    expect(sent.filter((e) => e.type === 'chat-reset')).toHaveLength(2)
    // A removed chat is no longer held.
    queue.push({ type: 'chat-removed', chatId: 'a' })
    queue.push({ type: 'chat-reset', chat: detail('a') })
    expect(sent.filter((e) => e.type === 'chat-reset')).toHaveLength(3)
  })

  it('sends what is queued before an event that is not coalesced', () => {
    queue.push({ type: 'chat-reset', chat: detail('a') })
    sent = []
    queue.push({ type: 'chat-item', chatId: 'a', item: message('m1', 'a') })
    queue.push({ type: 'permissions', requests: [] })
    expect(sent.map((e) => e.type)).toEqual(['chat-item', 'permissions'])
  })
})

describe('sessions.json', () => {
  function stored(): StoredSession {
    const s = new ChatSession('/work/acme', 'Chat', 'c1', 1)
    s.appendUserMessage('hello')
    s.appendAssistant('hi there')
    s.setConfigOptions([option('model', 'a')])
    return s.snapshot()
  }

  it('stores the same sessions as snapshot() did, and re-encodes an item once it changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spettro-perf-'))
    const s = ChatSession.restore(stored())
    const store = new SessionStore(dir)
    await store.saveParts([s.persistParts()])
    expect(JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'))).toEqual([s.snapshot()])

    s.appendAssistant(' and more') // a finished bubble: a new one
    s.rename('Renamed')
    await store.saveParts([s.persistParts()])
    expect(new SessionStore(dir).load()).toEqual([s.snapshot()])
    rmSync(dir, { recursive: true, force: true })
  })

  it('encodes a long transcript for its first save in slices, not in one go', () => {
    const s = new ChatSession('/p', 'Chat', 'c1', 1)
    for (let i = 0; i < 200; i++) s.appendNotice('x'.repeat(10_000), false)
    // A deadline already past: one item per slice.
    expect(s.encodeStoredItems(0)).toBe(false)
    let slices = 1
    while (!s.encodeStoredItems(0)) slices++
    expect(slices).toBe(200)
    // Everything encoded: saving re-encodes nothing.
    const stringify = vi.spyOn(JSON, 'stringify')
    s.persistParts()
    expect(stringify).toHaveBeenCalledTimes(1) // the session's own fields
    stringify.mockRestore()
  })

  it('a burst of changes is one background write, and quitting writes what is pending', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'spettro-perf-'))
    try {
      writeFileSync(join(dir, 'sessions.json'), JSON.stringify([stored()]))
      const model = new AppModel({ userDataDir: dir, appVersion: '0.0.0-test' })
      ;(model as unknown as { loadPersistedSessions(): void }).loadPersistedSessions()
      const store = (model as unknown as { store: SessionStore }).store
      const parts = vi.spyOn(store, 'saveParts')
      const sync = vi.spyOn(store, 'savePartsSync')
      // No agent: each change is queued for the session and persisted.
      for (let i = 0; i < 7; i++) await model.setConfigValue('c1', 'model', i % 2 ? 'a' : 'b')
      expect(parts).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1000)
      expect(parts).toHaveBeenCalledTimes(1)
      model.renameChat('c1', 'Before quitting')
      model.shutdown()
      expect(sync).toHaveBeenCalledTimes(1)
      expect(new SessionStore(dir).load()[0].title).toBe('Before quitting')
    } finally {
      vi.useRealTimers()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('config options', () => {
  it('a reply that matches what the chat shows sends no chat-meta', () => {
    const s = new ChatSession('/p', 'Chat', 'c1', 1)
    s.setConfigOptions([option('thinking', 'low'), option('model', 'm')])
    const metas: unknown[] = []
    s.onMeta = (_s, meta) => metas.push(meta)
    // The slider applies its stop at once…
    s.applyLocalConfigValue('thinking', 'max')
    expect(metas).toHaveLength(1)
    // …and the CLI's answer (a fresh copy of the same set) changes nothing.
    s.setConfigOptions([option('thinking', 'max'), option('model', 'm')])
    expect(metas).toHaveLength(1)
    s.setConfigOptions([option('thinking', 'max'), option('model', 'other')])
    expect(metas).toHaveLength(2)
  })
})

describe('the agent stream', () => {
  it('reads a long line delivered in many chunks as one line, joined once', () => {
    const conn = new AcpConnection({ executablePath: '/bin/false', workingDirectory: '/' })
    const lines: string[] = []
    ;(conn as unknown as { handleLine(t: string): void }).handleLine = (t) => lines.push(t)
    const ingest = (b: Buffer): void => (conn as unknown as { ingest(b: Buffer): void }).ingest(b)
    const long = JSON.stringify({ jsonrpc: '2.0', method: 'x', params: { text: 'é'.repeat(200_000) } })
    const bytes = Buffer.from(`${long}\n{"a":1}\n{"b"`, 'utf8')
    const concat = vi.spyOn(Buffer, 'concat')
    for (let i = 0; i < bytes.length; i += 4096) ingest(bytes.subarray(i, i + 4096))
    ingest(Buffer.from(':2}\n'))
    expect(lines).toEqual([long, '{"a":1}', '{"b":2}'])
    // One join per line that spanned reads, not one per read.
    expect(concat.mock.calls.length).toBeLessThanOrEqual(2)
    concat.mockRestore()
  })
})

describe('streaming bubbles', () => {
  it('an answer chunk does not walk the transcript to close reasoning', () => {
    const s = new ChatSession('/p', 'Chat', 'c1', 1)
    for (let i = 0; i < 500; i++) s.appendNotice(`n${i}`, false)
    s.appendReasoning('thinking')
    const emitted: TranscriptItem[] = []
    s.onItem = (_s, item) => emitted.push(item)
    const iterate = vi.spyOn(s.items, Symbol.iterator)
    for (let i = 0; i < 20; i++) s.appendAssistant('x')
    expect(iterate).not.toHaveBeenCalled()
    // The reasoning bubble closed exactly once, the answer streamed in one.
    const reasoning = emitted.filter((it) => it.kind === 'message' && it.message.role === 'reasoning')
    expect(reasoning).toHaveLength(1)
    expect(reasoning[0].kind === 'message' && reasoning[0].message.isStreaming).toBe(false)
  })
})

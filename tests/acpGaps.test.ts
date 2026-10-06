// The main process against the ACP surface the CLI actually speaks, driven
// through the real pipe: AcpConnection parses every line exactly as it does in
// the app, and only the subprocess is faked. Each case is a way the app used
// to show something wrong, or wedge, while every screenshot looked fine — a
// permission prompt nobody could answer, "Internal error" instead of the
// reason, a reopened chat that quietly forgot its conversation.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpAgent, AcpConnection, parseAgentCapabilities, parseToolCallEvent } from '@main/acp'
import { AppModel } from '@main/model/appModel'
import type { ChatSession } from '@main/model/chatSession'
import type { ACPPermissionRequest, JSONValue } from '@shared/acp'
import type { MainEvent } from '@shared/ipc'
import type { StoredSession } from '@shared/model'
import {
  agentChunk,
  compactRequest,
  initializeResult,
  permissionAttached,
  permissionFresh,
  promptResult,
  rpcError,
  sessionList,
  STEERING_QUEUED_TEXT,
  steeringDeliveredText,
  userChunk
} from './wire'

// ---------------------------------------------------------------------------
// A fake `spettro --acp` on the far side of a real AcpConnection
// ---------------------------------------------------------------------------

type Message = { id?: number | string; method?: string; params?: JSONValue; result?: JSONValue }
type Handler = (params: JSONValue) => JSONValue | Promise<JSONValue>

/** Thrown from a handler to answer with a JSON-RPC error instead. */
class Reply extends Error {
  constructor(readonly error: { code: number; message: string; data?: JSONValue }) {
    super(error.message)
  }
}

class FakeAgent {
  readonly conn = new AcpConnection({ executablePath: 'spettro', workingDirectory: '/' })
  /** Everything the app wrote, in order. */
  readonly sent: Message[] = []
  readonly handlers: Record<string, Handler> = {}

  constructor() {
    const internals = this.conn as unknown as { running: boolean; child: unknown }
    internals.running = true
    internals.child = {
      stdin: { write: (line: string) => this.receive(JSON.parse(line) as Message) },
      exitCode: null,
      killed: false,
      kill: () => undefined
    }
  }

  /** What the app sent for `method`, requests and notifications alike. */
  calls(method: string): Message[] {
    return this.sent.filter((m) => m.method === method)
  }

  /** A line from the agent, through the connection's own parser. */
  push(message: object): void {
    ;(this.conn as unknown as { handleLine(text: string): void }).handleLine(
      JSON.stringify({ jsonrpc: '2.0', ...message })
    )
  }

  update(sessionId: string, update: JSONValue): void {
    this.push({ method: 'session/update', params: { sessionId, update } })
  }

  /** An agent → app request, e.g. session/request_permission. */
  ask(id: number, method: string, params: JSONValue): void {
    this.push({ id, method, params })
  }

  private receive(message: Message): void {
    this.sent.push(message)
    if (message.method === undefined || message.id === undefined) return
    const handler = this.handlers[message.method]
    if (!handler) return
    const id = message.id
    Promise.resolve()
      .then(() => handler(message.params ?? null))
      .then(
        (result) => this.push({ id, result }),
        (err: unknown) => {
          if (err instanceof Reply) this.push({ id, error: err.error })
          else throw err
        }
      )
  }
}

/** A promise someone else settles. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/** Lets every queued continuation run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

let dir: string
let fake: FakeAgent
let model: AppModel
let events: MainEvent[]
let remote: { event: string; args: unknown[] }[]

/** An AppModel whose live agent is `fake`, wired exactly as connect() wires
 *  a real one. `stored` is put on disk first and loaded, as at launch. */
function liveModel(stored: StoredSession[] = []): void {
  dir = mkdtempSync(join(tmpdir(), 'spettro-acp-'))
  if (stored.length > 0) writeFileSync(join(dir, 'sessions.json'), JSON.stringify(stored))
  model = new AppModel({ userDataDir: dir, appVersion: '0.0.0-test' })
  const internals = model as unknown as {
    connection: AcpConnection
    agent: AcpAgent
    liveConnectionToken: number
    phase: { kind: string }
    wire(connection: AcpConnection, token: number): void
    loadPersistedSessions(): void
  }
  internals.loadPersistedSessions()
  const agent = new AcpAgent(fake.conn)
  agent.capabilities = parseAgentCapabilities(initializeResult())
  internals.connection = fake.conn
  internals.agent = agent
  internals.liveConnectionToken = 1
  internals.phase = { kind: 'ready' }
  internals.wire(fake.conn, 1)
  events = []
  remote = []
  model.on('event', (e: MainEvent) => events.push(e))
  for (const name of ['permission-resolved', 'question-resolved', 'chat-state']) {
    model.on(name, (...args: unknown[]) => remote.push({ event: name, args }))
  }
}

/** The permission queue as the renderer last heard it. */
function shownPermissions(): ACPPermissionRequest[] {
  const last = events.filter((e) => e.type === 'permissions').at(-1)
  return last && last.type === 'permissions' ? last.requests : []
}

/** A chat with a live ACP session `s1`. */
async function liveChat(): Promise<ChatSession> {
  fake.handlers['session/new'] = () => ({ sessionId: 's1', configOptions: [] })
  const session = model.newChat(dir)
  await settle()
  expect(session.acpSessionId).toBe('s1')
  return session
}

function stored(id: string, acpSessionId: string | null): StoredSession {
  return {
    id,
    acpSessionId,
    projectPath: '/work/acme',
    title: id,
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

function notices(session: ChatSession): string[] {
  return session.items.flatMap((i) =>
    i.kind === 'message' && i.message.role === 'notice' ? [i.message.text] : []
  )
}

beforeEach(() => {
  fake = new FakeAgent()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('JSON-RPC errors', () => {
  it('carry the reason from data.error, not the SDK’s category', async () => {
    liveModel()
    fake.handlers['x/fail'] = () => {
      throw new Reply(rpcError('invalid api key for provider anthropic'))
    }
    await expect(fake.conn.request('x/fail', {})).rejects.toMatchObject({
      kind: 'rpc',
      code: -32603,
      message: 'invalid api key for provider anthropic',
      data: { error: 'invalid api key for provider anthropic' }
    })
  })

  it('reach the chat as the reason when a turn fails', async () => {
    liveModel()
    const session = await liveChat()
    fake.handlers['session/prompt'] = () => {
      throw new Reply(rpcError('rate limit exceeded, retry in 20s'))
    }
    model.send(session.id, 'hi', [])
    await settle()
    expect(notices(session)).toEqual(['rate limit exceeded, retry in 20s'])
    expect(session.isBusy).toBe(false)
  })
})

describe('permission prompts', () => {
  it('take the title, kind and chat of the card they attach to, and show its diff', async () => {
    liveModel()
    const session = await liveChat()
    fake.update('s1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-3',
      title: 'Edit src/a.ts',
      kind: 'edit',
      status: 'in_progress'
    })
    fake.ask(
      7,
      'session/request_permission',
      permissionAttached({
        sessionId: 's1',
        toolCallId: 'call-3',
        diff: { path: '/p/src/a.ts', oldText: 'a', newText: 'b' },
        reason: 'outside the sandbox'
      })
    )

    const [request] = shownPermissions()
    expect(request.title).toBe('Edit src/a.ts')
    expect(request.toolKind).toBe('edit')
    expect(request.chatId).toBe(session.id)
    expect(request.content.diffs).toEqual([
      { type: 'diff', path: '/p/src/a.ts', oldText: 'a', newText: 'b' }
    ])
    expect(request.content.texts).toEqual(['outside the sandbox'])
    expect(session.toolById('call-3')?.status).toBe('pending')
  })

  it('make exactly one titled card for a perm-N request and its settle update', async () => {
    liveModel()
    const session = await liveChat()
    fake.ask(
      8,
      'session/request_permission',
      permissionFresh({ sessionId: 's1', n: 1, title: 'Run rm -rf build', command: 'rm -rf build' })
    )
    model.resolvePermission(shownPermissions()[0].id, 'allow-once')
    fake.update('s1', { sessionUpdate: 'tool_call_update', toolCallId: 'perm-1', status: 'completed' })

    const tools = session.items.filter((i) => i.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(session.toolById('perm-1')).toMatchObject({ title: 'Run rm -rf build', kind: 'execute', status: 'completed' })
    expect(fake.sent.find((m) => m.id === 8)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
  })

  it('write a title from the kind when there is no card and no title', async () => {
    liveModel()
    await liveChat()
    fake.ask(9, 'session/request_permission', {
      sessionId: 's1',
      toolCall: { toolCallId: 'call-99', status: 'pending', kind: 'execute', content: [] },
      options: []
    })
    expect(shownPermissions()[0].title).toBe('Run a command')
  })

  it('mark the compaction prompt and give it no card', async () => {
    liveModel()
    const session = await liveChat()
    fake.ask(10, 'session/request_permission', compactRequest('s1'))
    expect(shownPermissions()[0].variant).toBe('compact')
    expect(session.items.filter((i) => i.kind === 'tool')).toHaveLength(0)
  })

  it('disappear when the agent withdraws them with $/cancel_request', async () => {
    liveModel()
    const session = await liveChat()
    fake.update('s1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-3',
      title: 'Run make',
      kind: 'execute',
      status: 'in_progress'
    })
    fake.ask(11, 'session/request_permission', permissionAttached({ sessionId: 's1', toolCallId: 'call-3', command: 'make' }))
    const id = shownPermissions()[0].id

    fake.push({ method: '$/cancel_request', params: { requestId: 11 } })

    expect(shownPermissions()).toEqual([])
    // Back to what it was showing, not stuck on "waiting for you".
    expect(session.toolById('call-3')?.status).toBe('in_progress')
    // Phones are told too, so theirs closes.
    expect(remote).toContainEqual({ event: 'permission-resolved', args: [id, null] })
  })

  it('fail the card a withdrawn perm-N request made', async () => {
    liveModel()
    const session = await liveChat()
    fake.ask(12, 'session/request_permission', permissionFresh({ sessionId: 's1', n: 2, title: 'Run x', command: 'x' }))
    fake.push({ method: '$/cancel_request', params: { requestId: 12 } })
    // The CLI counts an unanswered request as a denial.
    expect(session.toolById('perm-2')?.status).toBe('failed')
  })

  it('are cleared when the agent is torn down', async () => {
    liveModel()
    await liveChat()
    fake.ask(13, 'session/request_permission', permissionFresh({ sessionId: 's1', n: 3, title: 'Run y', command: 'y' }))
    ;(model as unknown as { teardownAgent(): void }).teardownAgent()
    expect(shownPermissions()).toEqual([])
  })

  it('are answered "cancelled" and cleared when the user stops the turn', async () => {
    liveModel()
    const session = await liveChat()
    fake.handlers['session/prompt'] = () => new Promise(() => undefined)
    model.send(session.id, 'go', [])
    await settle()
    fake.ask(14, 'session/request_permission', permissionFresh({ sessionId: 's1', n: 4, title: 'Run z', command: 'z' }))
    fake.ask(15, '_spettro/question/ask', {
      version: 2,
      sessionId: 's1',
      questions: [{ id: 'q-1', header: 'Pick', question: 'Which?', options: [{ id: 'a', label: 'A' }] }]
    })

    model.cancel(session.id)

    expect(fake.calls('session/cancel')).toHaveLength(1)
    expect(shownPermissions()).toEqual([])
    expect(fake.sent.find((m) => m.id === 14)?.result).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(fake.sent.find((m) => m.id === 15)?.result).toEqual({ kind: 'cancelled' })
  })

  it('go with a turn that ends in an error', async () => {
    liveModel()
    const session = await liveChat()
    const turn = deferred<JSONValue>()
    fake.handlers['session/prompt'] = () => turn.promise
    model.send(session.id, 'go', [])
    await settle()
    fake.ask(16, 'session/request_permission', permissionFresh({ sessionId: 's1', n: 5, title: 'Run w', command: 'w' }))
    expect(shownPermissions()).toHaveLength(1)

    fake.handlers['session/prompt'] = () => {
      throw new Reply(rpcError('boom'))
    }
    // Answer the outstanding prompt with an error.
    const promptId = fake.calls('session/prompt')[0].id as number
    fake.push({ id: promptId, error: rpcError('provider went away') })
    await settle()
    expect(shownPermissions()).toEqual([])
  })
})

describe('sending', () => {
  it('gives an image-only prompt the text spettro requires, and the bubble none', async () => {
    liveModel()
    const session = await liveChat()
    fake.handlers['session/prompt'] = () => promptResult({})
    model.send(session.id, '   ', [{ data: 'aGk=', mimeType: 'image/png' }])
    await settle()

    const prompt = (fake.calls('session/prompt')[0].params as { prompt: JSONValue[] }).prompt
    expect(prompt).toEqual([
      { type: 'text', text: '(see the attached image)' },
      { type: 'image', data: 'aGk=', mimeType: 'image/png' }
    ])
    const user = session.items.find((i) => i.kind === 'message' && i.message.role === 'user')
    expect(user?.kind === 'message' && user.message.text).toBe('')
  })

  it('steers the running turn with a message sent while busy', async () => {
    liveModel()
    const session = await liveChat()
    const turn = deferred<JSONValue>()
    let prompts = 0
    fake.handlers['session/prompt'] = () => {
      prompts += 1
      if (prompts === 1) return turn.promise
      // bridge.go steerRunningTurn: acknowledge, then end this prompt at once.
      fake.update('s1', agentChunk(STEERING_QUEUED_TEXT))
      return promptResult({ stopReason: 'end_turn' })
    }

    model.send(session.id, 'refactor the parser', [])
    await settle()
    model.send(session.id, 'also keep the old API', [])
    await settle()

    // The steer went out after the turn it steers, and ended nothing.
    expect(fake.calls('session/prompt')).toHaveLength(2)
    expect(session.isBusy).toBe(true)
    expect(notices(session)).toEqual([])
    const steer = session.messageById(session.steeringMessage('queued') ?? '')
    expect(steer?.text).toBe('also keep the old API')
    // The acknowledgement is state, not a message.
    expect(session.items.some((i) => i.kind === 'message' && i.message.role === 'assistant')).toBe(false)

    fake.update('s1', agentChunk(steeringDeliveredText('also keep the old API')))
    expect(steer?.steering).toBe('delivered')
    expect(session.items.some((i) => i.kind === 'message' && i.message.role === 'assistant')).toBe(false)

    turn.resolve(promptResult({ stopReason: 'end_turn' }))
    await settle()
    expect(session.isBusy).toBe(false)
  })

  it('leaves the running turn alone when a mid-turn send is answered on its own', async () => {
    liveModel()
    const session = await liveChat()
    const turn = deferred<JSONValue>()
    let prompts = 0
    fake.handlers['session/prompt'] = () => {
      prompts += 1
      if (prompts === 1) return turn.promise
      if (prompts === 2) {
        // bridge.go Prompt: a slash command is answered at once, never
        // steered, even while a turn runs.
        fake.update('s1', agentChunk('Commands: /help /model …'))
        return promptResult({ stopReason: 'end_turn' })
      }
      throw new Reply(rpcError('steering queue closed'))
    }

    model.send(session.id, 'refactor the parser', [])
    await settle()
    fake.update('s1', agentChunk('Reading the parser'))
    fake.ask(20, 'session/request_permission', permissionFresh({ sessionId: 's1', n: 9, title: 'Run make', command: 'make' }))

    model.send(session.id, '/help', [])
    await settle()
    // Not filed as the turn, and the turn's reply is still streaming.
    expect(session.lastTurn).toBeNull()
    const streaming = session.items.some(
      (i) => i.kind === 'message' && i.message.role === 'assistant' && i.message.isStreaming
    )
    expect(streaming).toBe(true)

    model.send(session.id, 'also keep the old API', [])
    await settle()
    // A failed steer says so, but the turn's own prompt stays answerable.
    expect(notices(session)).toEqual(['steering queue closed'])
    expect(shownPermissions()).toHaveLength(1)
    expect(fake.sent.some((m) => m.id === 20 && m.method === undefined)).toBe(false)
    expect(session.isBusy).toBe(true)

    turn.resolve(promptResult({ stopReason: 'end_turn' }))
    await settle()
    expect(session.isBusy).toBe(false)
    expect(session.lastTurn?.stopReason).toBe('end_turn')
  })

  it('reads the turn’s usage and files it on the chat', async () => {
    liveModel()
    const session = await liveChat()
    fake.handlers['session/prompt'] = () =>
      promptResult({
        stopReason: 'max_tokens',
        usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500, cachedReadTokens: 800 },
        tokensUsed: 1550
      })
    model.send(session.id, 'write a novel', [])
    await settle()

    expect(session.lastTurn).toMatchObject({
      stopReason: 'max_tokens',
      inputTokens: 1200,
      outputTokens: 300,
      cachedReadTokens: 800,
      totalTokens: 1500
    })
    expect(session.sessionTokens).toBe(1500)
    expect(notices(session)).toEqual(['The reply hit the length limit.'])
  })

  it('says "Interrupted" for a cancelled turn', async () => {
    liveModel()
    const session = await liveChat()
    fake.handlers['session/prompt'] = () => promptResult({ stopReason: 'cancelled' })
    model.send(session.id, 'x', [])
    await settle()
    expect(notices(session)).toEqual(['Interrupted'])
  })
})

describe('closing a chat', () => {
  it('cancels its running turn, then closes the session on the agent', async () => {
    liveModel()
    const session = await liveChat()
    fake.handlers['session/prompt'] = () => new Promise(() => undefined)
    fake.handlers['session/close'] = () => ({})
    model.send(session.id, 'long job', [])
    await settle()

    model.closeChat(session.id)

    const order = fake.sent.map((m) => m.method).filter((m) => m === 'session/cancel' || m === 'session/close')
    expect(order).toEqual(['session/cancel', 'session/close'])
    expect(fake.calls('session/close')[0].params).toEqual({ sessionId: 's1' })
  })

  it('does not close a session the agent never said it could', async () => {
    liveModel()
    const session = await liveChat()
    ;(model as unknown as { agent: AcpAgent }).agent.capabilities.closeSession = false
    model.closeChat(session.id)
    expect(fake.calls('session/close')).toHaveLength(0)
  })
})

describe('reopening saved chats', () => {
  it('resumes only the chat that is opened', async () => {
    liveModel([stored('a', 'old-a'), stored('b', 'old-b')])
    fake.handlers['session/resume'] = () => ({ configOptions: [] })
    model.openChat('a')
    await settle()
    expect(fake.calls('session/resume').map((m) => (m.params as { sessionId: string }).sessionId)).toEqual([
      'old-a'
    ])
  })

  it('makes a send during the resume wait for it, never starting a new session', async () => {
    liveModel([stored('a', 'old-a')])
    const resume = deferred<JSONValue>()
    fake.handlers['session/resume'] = () => resume.promise
    fake.handlers['session/new'] = () => ({ sessionId: 'fresh', configOptions: [] })
    fake.handlers['session/prompt'] = () => promptResult({})

    model.openChat('a')
    await settle()
    model.send('a', 'where were we?', [])
    await settle()
    expect(fake.calls('session/prompt')).toHaveLength(0)

    resume.resolve({ configOptions: [] })
    await settle()
    expect(fake.calls('session/new')).toHaveLength(0)
    expect((fake.calls('session/prompt')[0].params as { sessionId: string }).sessionId).toBe('old-a')
  })

  it('seed the slash palette from the folder’s cached commands', () => {
    dir = mkdtempSync(join(tmpdir(), 'spettro-acp-'))
    writeFileSync(
      join(dir, 'preferences.json'),
      JSON.stringify({ cachedCommandsByProject: { '/work/acme': [{ name: 'deploy' }] } })
    )
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify([stored('a', 'old-a')]))
    const m = new AppModel({ userDataDir: dir, appVersion: '0.0.0-test' })
    ;(m as unknown as { loadPersistedSessions(): void }).loadPersistedSessions()
    expect(m.getChatDetail('a')?.commands).toEqual([{ name: 'deploy' }])
  })
})

describe('sessions started in the terminal', () => {
  it('are listed unless a chat is already linked to them', async () => {
    liveModel([stored('a', 'linked')])
    fake.handlers['session/list'] = () =>
      sessionList([
        { id: 'linked', cwd: '/work/acme', title: 'mine' },
        { id: 'tui-1', cwd: '/work/acme', title: 'from the terminal', updatedAt: '2026-10-05T10:00:00Z' }
      ])
    const entries = await model.listCLISessions('/work/acme')
    expect(entries).toEqual([
      { sessionId: 'tui-1', title: 'from the terminal', updatedAt: Date.parse('2026-10-05T10:00:00Z') }
    ])
    expect(fake.calls('session/list')[0].params).toEqual({ cwd: '/work/acme' })
  })

  it('import as a chat with the user’s messages replayed — only during the load', async () => {
    liveModel()
    fake.handlers['session/load'] = () => {
      fake.update('tui-1', userChunk('fix the flaky test'))
      fake.update('tui-1', agentChunk('Fixed: the timeout was too short.'))
      fake.update('tui-1', userChunk('thanks'))
      fake.update('tui-1', agentChunk('You’re welcome.'))
      return { configOptions: [] }
    }
    const chatId = await model.importCLISession('tui-1', dir)
    const session = model.sessionById(chatId ?? '') as ChatSession
    const lines = session.items.map((i) => (i.kind === 'message' ? `${i.message.role}: ${i.message.text}` : ''))
    expect(lines).toEqual([
      'user: fix the flaky test',
      'assistant: Fixed: the timeout was too short.',
      'user: thanks',
      'assistant: You’re welcome.'
    ])
    expect(session.title).toBe('fix the flaky test')

    // Outside a load, the agent doesn't get to speak for the user.
    fake.update('tui-1', userChunk('injected'))
    expect(session.items).toHaveLength(4)
  })
})

describe('tool output', () => {
  it('keeps images (at most four), rawOutput and location lines', () => {
    const image = { type: 'content', content: { type: 'image', data: 'iVBOR', mimeType: 'image/png' } }
    const event = parseToolCallEvent({
      toolCallId: 'call-1',
      content: [{ type: 'content', content: { type: 'text', text: 'shot taken' } }, image, image, image, image, image],
      rawOutput: { output: 'the full output' },
      locations: [{ path: '/p/a.go', line: 42 }, { path: '/p/b.go' }]
    })
    expect(event?.texts).toEqual(['shot taken'])
    expect(event?.images).toHaveLength(4)
    expect(event?.images[0]).toEqual({ data: 'iVBOR', mimeType: 'image/png' })
    expect(event?.rawOutput).toBe('the full output')
    expect(event?.locations).toEqual([{ path: '/p/a.go', line: 42 }, { path: '/p/b.go' }])
  })
})

describe('workflow calls for a chat with no live session', () => {
  it('name the chat’s folder instead of coming back empty', async () => {
    liveModel()
    const internals = model as unknown as { agent: AcpAgent; extensions: { attach(c: unknown): void } }
    internals.extensions.attach(internals.agent)
    fake.handlers['_spettro/workflow/list'] = () => ({ workflows: [], searchPaths: [], cwd: '/work/acme' })
    const session = model.newChat('/work/acme')
    // Cold: never warmed.
    session.acpSessionId = null
    await model.listWorkflows(session.id)
    expect(fake.calls('_spettro/workflow/list').at(-1)?.params).toEqual({ cwd: '/work/acme' })
  })

  it('fail fast for a method the handshake didn’t list', async () => {
    liveModel()
    const internals = model as unknown as { agent: AcpAgent; extensions: { attach(c: unknown): void } }
    internals.agent.extensionMethods = ['_spettro/account/status']
    internals.extensions.attach(internals.agent)
    const session = model.newChat('/work/acme')
    await expect(model.listWorkflows(session.id)).rejects.toThrow(/doesn't support/)
    expect(fake.calls('_spettro/workflow/list')).toHaveLength(0)
  })
})

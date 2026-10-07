// A typed facade over AcpConnection — the TypeScript port of spettro-apple's
// ACPAgent.swift (plus the reply encodings of ACPQuestion.swift). Exposes the
// semantic ACP calls the app uses (initialize, session/new, session/resume,
// session/load, session/list, session/close, session/prompt, session/cancel,
// session/set_config_option) and the permission/question replies, hiding
// method strings and params shapes.

import type {
  ACPAgentCapabilities,
  ACPConfigOption,
  ACPContentBlock,
  ACPPromptResult,
  ACPQuestionAnswer,
  ACPQuestionRequest,
  ACPSessionInfo,
  JSONValue,
  RPCID
} from '../../shared/acp'
import { AcpConnection, AcpError } from './connection'
import {
  intValue,
  objectValue,
  parseAgentCapabilities,
  parseConfigOptions,
  parseExtensionMethods,
  parsePromptResult,
  parseSessionList,
  stringValue
} from './parse'

// Wire keys for questions walked over the permission transport
// (ACPQuestionMeta in ACPQuestion.swift).
const QUESTION_ANSWER_META = 'spettro.app/questionAnswer'

/** The result that refuses the whole interaction. Declining is
 *  all-or-nothing: half a form delivered as if the rest had been skipped
 *  would misreport what the user said. */
const DECLINED: JSONValue = { kind: 'declined' }

/** What the app answers a question it is withdrawing with — the turn was
 *  cancelled under it, so nobody declined anything (question_form.go reads a
 *  top-level `kind` of "declined" or "cancelled" as ending the form). */
const CANCELLED: JSONValue = { kind: 'cancelled' }

/** JSON-RPC "method not found". */
const METHOD_NOT_FOUND = -32601

/** The extension surface this client implements, mirrored to the agent so it
 *  knows it may call `_spettro/question/ask` on us (ext.go, version 4). */
const CLIENT_EXTENSIONS = { version: 4, methods: ['_spettro/question/ask'] }

/** Assumed until `initialize` says otherwise: nothing optional. */
const NO_CAPABILITIES: ACPAgentCapabilities = {
  loadSession: false,
  listSessions: false,
  resumeSession: false,
  closeSession: false,
  promptImage: false,
  promptEmbeddedContext: false
}

export class AcpAgent {
  readonly connection: AcpConnection
  /** What `initialize` said the agent can do. Calls an agent didn't
   *  advertise are skipped instead of tried and failed. */
  capabilities: ACPAgentCapabilities = { ...NO_CAPABILITIES }
  /** The `_spettro/*` methods the agent serves, or null when it didn't list
   *  them (then every method is worth a try). */
  extensionMethods: string[] | null = null

  constructor(connection: AcpConnection) {
    this.connection = connection
  }

  // MARK: Handshake

  /** The first call after connection.start(). `clientCapabilities` is
   *  deliberately empty — we support none of the optional client features
   *  (fs, terminal, auth), so the agent will not call back into us for file
   *  or terminal operations. `_meta` mirrors back the `_spettro/*` methods
   *  this client serves. Records the agent's capabilities and extension
   *  methods for feature detection. */
  async initialize(
    clientName: string,
    clientVersion: string
  ): Promise<{ agentVersion: string | null; agentName: string | null }> {
    const params: JSONValue = {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: clientName, title: null, version: clientVersion },
      _meta: { 'spettro.app/extensions': CLIENT_EXTENSIONS }
    }
    const result = await this.connection.request('initialize', params)
    const obj = objectValue(result)
    if (!obj || intValue(obj['protocolVersion']) === null) {
      throw new AcpError('decode', 'malformed initialize result')
    }
    this.capabilities = parseAgentCapabilities(result)
    this.extensionMethods = parseExtensionMethods(result)
    const agentInfo = objectValue(obj['agentInfo'])
    return {
      agentVersion: agentInfo ? stringValue(agentInfo['version']) : null,
      agentName: agentInfo ? stringValue(agentInfo['name']) : null
    }
  }

  // MARK: Sessions

  async newSession(
    cwd: string
  ): Promise<{ sessionId: string; configOptions: ACPConfigOption[] }> {
    const result = await this.connection.request('session/new', { cwd, mcpServers: [] })
    const obj = objectValue(result)
    const sessionId = obj ? stringValue(obj['sessionId']) : null
    if (sessionId === null) {
      throw new AcpError('decode', 'session/new response missing sessionId')
    }
    return { sessionId, configOptions: parseConfigOptions(obj?.['configOptions']) }
  }

  /** Reattaches to a previously created session so the agent restores its
   *  memory of the conversation, WITHOUT replaying the transcript. The client
   *  keeps its own persisted transcript, so the replay that `session/load`
   *  performs would show every message again. */
  async resumeSession(
    sessionId: string,
    cwd: string
  ): Promise<{ configOptions: ACPConfigOption[] }> {
    const result = await this.connection.request('session/resume', {
      sessionId,
      cwd,
      mcpServers: []
    })
    return { configOptions: parseConfigOptions(objectValue(result)?.['configOptions']) }
  }

  /** Reattaches to a stored session AND replays its conversation: the agent
   *  streams `user_message_chunk` / `agent_thought_chunk` /
   *  `agent_message_chunk` updates for it before this resolves (sessions.go
   *  LoadSession). For importing a conversation the app has no copy of. */
  async loadSession(
    sessionId: string,
    cwd: string
  ): Promise<{ configOptions: ACPConfigOption[] }> {
    const result = await this.connection.request('session/load', {
      sessionId,
      cwd,
      mcpServers: []
    })
    return { configOptions: parseConfigOptions(objectValue(result)?.['configOptions']) }
  }

  /** The conversations the agent keeps on disk, newest first, optionally only
   *  those for one folder. Empty when the agent can't list. */
  async listSessions(cwd?: string): Promise<ACPSessionInfo[]> {
    if (!this.capabilities.listSessions) return []
    const out: ACPSessionInfo[] = []
    let cursor: string | null = null
    // spettro answers in one page; the cursor is followed for agents that
    // don't, with a bound so a looping cursor can't hang the call.
    for (let page = 0; page < 20; page++) {
      const params: { [key: string]: JSONValue } = {}
      if (cwd !== undefined) params['cwd'] = cwd
      if (cursor !== null) params['cursor'] = cursor
      const { sessions, nextCursor } = parseSessionList(
        await this.connection.request('session/list', params)
      )
      out.push(...sessions)
      if (nextCursor === null) break
      cursor = nextCursor
    }
    return out
  }

  /** Frees a session on the agent: its running turn is cancelled and any
   *  paused workflow stops (bridge.go CloseSession). The conversation stays
   *  on the agent's disk. A no-op against an agent that can't close, and an
   *  agent that turns out not to know the method is not an error. */
  async closeSession(sessionId: string): Promise<void> {
    if (!this.capabilities.closeSession) return
    try {
      await this.connection.request('session/close', { sessionId })
    } catch (err) {
      if (err instanceof AcpError && err.code === METHOD_NOT_FOUND) return
      throw err
    }
  }

  /** Sends a prompt turn. Resolves once the turn completes, with its stop
   *  reason and, when the agent reports them, its token counts; streamed
   *  content arrives via the connection's onSessionUpdate. */
  async prompt(sessionId: string, blocks: ACPContentBlock[]): Promise<ACPPromptResult> {
    const result = await this.connection.request('session/prompt', {
      sessionId,
      prompt: blocks as unknown as JSONValue
    })
    const parsed = parsePromptResult(result)
    if (!parsed) {
      throw new AcpError('decode', 'session/prompt response missing stopReason')
    }
    return parsed
  }

  /** Fire-and-forget notification; the in-flight prompt resolves with
   *  stopReason "cancelled". */
  cancel(sessionId: string): void {
    this.connection.notify('session/cancel', { sessionId })
  }

  // MARK: Config options

  /** Applies a config option; returns the refreshed option set. A boolean
   *  value sends the extra `"type": "boolean"` discriminator. */
  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean
  ): Promise<ACPConfigOption[]> {
    const params: JSONValue =
      typeof value === 'boolean'
        ? { sessionId, configId, type: 'boolean', value }
        : { sessionId, configId, value }
    const result = await this.connection.request('session/set_config_option', params)
    return parseConfigOptions(objectValue(result)?.['configOptions'])
  }

  // MARK: Permission replies

  replyPermission(rpcId: RPCID, selectedOptionId: string): void {
    this.connection.respond(rpcId, {
      outcome: { outcome: 'selected', optionId: selectedOptionId }
    })
  }

  cancelPermission(rpcId: RPCID): void {
    this.connection.respond(rpcId, { outcome: { outcome: 'cancelled' } })
  }

  /** Withdraws a question the user never answered because its turn ended —
   *  in whichever shape its transport reads back. */
  cancelQuestion(delivered: { rpcId: RPCID; transport: 'ask' | 'permission' }): void {
    if (delivered.transport === 'ask') {
      this.connection.respond(delivered.rpcId, CANCELLED)
      return
    }
    this.connection.consumeQuestionCustomOption(delivered.rpcId)
    this.connection.respond(delivered.rpcId, { outcome: { outcome: 'cancelled' } })
  }

  // MARK: Agent questions

  /** Answers a question delivered via onQuestionRequest, in the shape its own
   *  transport reads back (ACPQuestionRequest.result / declineResult in
   *  ACPQuestion.swift). `answers === null` declines the whole form; a
   *  question the user left alone is simply absent from `answers`, which the
   *  CLI reports to the model as unanswered. */
  replyQuestion(
    delivered: { rpcId: RPCID; request: ACPQuestionRequest; transport: 'ask' | 'permission' },
    answers: ACPQuestionAnswer[] | null
  ): void {
    const { rpcId, request, transport } = delivered
    if (transport === 'ask') {
      if (answers === null) {
        this.connection.respond(rpcId, DECLINED)
        return
      }
      if (request.version >= 2) {
        this.connection.respond(rpcId, { answers: answers.map(answerJson) })
        return
      }
      // Version 1 takes the bare tagged answer to its one question.
      const first = answers[0]
      this.connection.respond(rpcId, first ? answerFlatJson(first) : DECLINED)
      return
    }

    // Permission transport: the structured answer rides back in the response
    // `_meta`; the selected option keeps the core-ACP half well formed.
    const customOptionId = this.connection.consumeQuestionCustomOption(rpcId)
    const first = answers?.[0]
    if (!answers || first === undefined) {
      this.connection.respond(rpcId, permissionResult(null, DECLINED))
      return
    }
    // Free text has no option of its own, so it selects the synthetic one the
    // CLI appended — which means "collect text from me", and the text itself
    // travels in `_meta`.
    const select = firstOptionId(first) ?? customOptionId
    this.connection.respond(rpcId, permissionResult(select, answerFlatJson(first)))
  }

  // MARK: Passthrough

  /** Raw request passthrough for the remote host's agent/call relay — and the
   *  seam the typed `_spettro/*` calls in acp/extensions.ts are built on
   *  (`ExtensionCaller`). */
  raw(method: string, params: JSONValue): Promise<JSONValue> {
    return this.connection.request(method, params)
  }

  /** Whether the agent serves a `_spettro/*` method — the `ExtensionCaller`
   *  hook that lets an unsupported call fail fast instead of round-tripping
   *  to a method-not-found. True when the agent didn't list its methods. */
  supports(method: string): boolean {
    return this.extensionMethods === null || this.extensionMethods.includes(method)
  }
}

// ---------------------------------------------------------------------------
// Question answer encodings (ACPQuestionAnswer.json / .flatJSON)
// ---------------------------------------------------------------------------

function answerOptionIds(answer: ACPQuestionAnswer): string[] {
  if (answer.kind !== 'option') return []
  if (answer.optionIds.length > 0) return answer.optionIds
  return answer.optionId !== undefined ? [answer.optionId] : []
}

function firstOptionId(answer: ACPQuestionAnswer): string | null {
  return answerOptionIds(answer)[0] ?? null
}

/** One answer of a v2 `answers[]` envelope. */
function answerJson(answer: ACPQuestionAnswer): JSONValue {
  const obj: { [key: string]: JSONValue } = {
    questionId: answer.questionId,
    kind: answer.kind
  }
  if (answer.kind === 'option') {
    const ids = answerOptionIds(answer)
    if (ids.length > 0) {
      obj['optionIds'] = ids
      // Version 1's spelling of a single choice, alongside the array, so a
      // reader that only knows the old field still sees the answer.
      if (ids.length === 1) obj['optionId'] = ids[0] as string
    }
  } else {
    obj['text'] = answer.text
  }
  if (answer.notes !== undefined) obj['notes'] = answer.notes
  return obj
}

/** The bare tagged shape, for the transports that carry one question and have
 *  nowhere to put a question id or a note. */
function answerFlatJson(answer: ACPQuestionAnswer): JSONValue {
  const obj: { [key: string]: JSONValue } = { kind: answer.kind }
  if (answer.kind === 'option') {
    const first = firstOptionId(answer)
    if (first !== null) obj['optionId'] = first
  } else {
    obj['text'] = answer.text
  }
  return obj
}

/** The permission-response envelope carrying the structured answer in `_meta`. */
function permissionResult(selectOptionId: string | null, answer: JSONValue): JSONValue {
  const outcome: JSONValue =
    selectOptionId !== null
      ? { outcome: 'selected', optionId: selectOptionId }
      : { outcome: 'cancelled' }
  return {
    outcome,
    _meta: { [QUESTION_ANSWER_META]: answer }
  }
}

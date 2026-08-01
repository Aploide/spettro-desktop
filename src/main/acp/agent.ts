// A typed facade over AcpConnection — the TypeScript port of spettro-apple's
// ACPAgent.swift (plus the reply encodings of ACPQuestion.swift). Exposes the
// semantic ACP calls the app uses (initialize, session/new, session/resume,
// session/prompt, session/cancel, session/set_config_option) and the
// permission/question replies, hiding method strings and params shapes.

import type {
  ACPConfigOption,
  ACPContentBlock,
  ACPQuestionAnswer,
  ACPQuestionRequest,
  ACPStopReason,
  JSONValue,
  RPCID
} from '../../shared/acp'
import { AcpConnection, AcpError } from './connection'
import { arrayValue, intValue, objectValue, parseConfigOptions, stringValue } from './parse'

// Wire keys for questions walked over the permission transport
// (ACPQuestionMeta in ACPQuestion.swift).
const QUESTION_ANSWER_META = 'spettro.app/questionAnswer'

/** The result that refuses the whole interaction. Declining is
 *  all-or-nothing: half a form delivered as if the rest had been skipped
 *  would misreport what the user said. */
const DECLINED: JSONValue = { kind: 'declined' }

const STOP_REASONS: readonly ACPStopReason[] = [
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled'
]

export class AcpAgent {
  readonly connection: AcpConnection

  constructor(connection: AcpConnection) {
    this.connection = connection
  }

  // MARK: Handshake

  /** The first call after connection.start(). `clientCapabilities` is
   *  deliberately empty — we support none of the optional client features
   *  (fs, terminal, auth), so the agent will not call back into us for file
   *  or terminal operations. `_meta` mirrors back the `_spettro/*` methods
   *  this client serves. */
  async initialize(
    clientName: string,
    clientVersion: string
  ): Promise<{ agentVersion: string | null; agentName: string | null }> {
    const params: JSONValue = {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: clientName, title: null, version: clientVersion },
      _meta: {
        'spettro.app/extensions': { version: 3, methods: ['_spettro/question/ask'] }
      }
    }
    const result = await this.connection.request('initialize', params)
    const obj = objectValue(result)
    if (!obj || intValue(obj['protocolVersion']) === null) {
      throw new AcpError('decode', 'malformed initialize result')
    }
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

  /** Sends a prompt turn. Resolves with the stop reason once the turn
   *  completes; streamed content arrives via the connection's onSessionUpdate. */
  async prompt(sessionId: string, blocks: ACPContentBlock[]): Promise<ACPStopReason> {
    const result = await this.connection.request('session/prompt', {
      sessionId,
      prompt: blocks as unknown as JSONValue
    })
    const raw = stringValue(objectValue(result)?.['stopReason'])
    if (raw === null) {
      throw new AcpError('decode', 'session/prompt response missing stopReason')
    }
    return (STOP_REASONS as readonly string[]).includes(raw) ? (raw as ACPStopReason) : 'unknown'
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

  /** Raw request passthrough for the remote host's agent/call relay. */
  raw(method: string, params: JSONValue): Promise<JSONValue> {
    return this.connection.request(method, params)
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

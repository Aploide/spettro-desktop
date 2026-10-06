// The client half of Spettro's `_spettro/*` ACP extension methods — the
// TypeScript port of spettro-apple's ACPExtensions.swift (the wire surface for
// everything the TUI does that core ACP has no concept of: subscription
// login/logout, provider API-key management, local endpoints, and the model
// catalog).
//
// These mirror the CLI's Go definitions in internal/acp/ext_account.go and
// internal/acp/ext_providers.go. API keys travel one way only: the app posts a
// key to connect a provider and never reads one back — keys stay in the CLI's
// encrypted store (~/.spettro/keys.enc), which is also why none of this can be
// done app-side. Nothing here ever logs or persists a key.
//
// Decoding is deliberately lenient and applies every default the Swift
// decoders do (missing bool → false, missing modelCount → 0, displayName →
// name, providerName → provider, a local endpoint's name → its endpoint, a
// missing login status → "idle", …), so a newer or older CLI still renders.

import type { JSONValue } from '../../shared/acp'
import {
  EMPTY_PROVIDERS,
  ExtensionMethod,
  type AccountStatus,
  type ConnectResult,
  type LocalEndpoint,
  type LocalProbeResult,
  type LoginState,
  type LoginStatus,
  type ModelEntry,
  type ModelsList,
  type ProviderEntry,
  type ProvidersList,
  type WorkflowInfo,
  type WorkflowList,
  type WorkflowPhaseInfo,
  type WorkflowRunInfo,
  type WorkflowScope,
  type WorkflowSource,
  type WorkflowValidation
} from '../../shared/extensions'
import { arrayValue, boolValue, intValue, objectValue, stringValue } from './parse'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The agent does not implement a `_spettro/*` extension method — an older CLI
 *  than this app expects. Reported distinctly (rather than as a plain RPC
 *  error) so the UI can offer an update instead of a failure. */
export class UnsupportedExtensionError extends Error {
  readonly method: string

  constructor(method: string) {
    super(`This version of the Spettro CLI doesn't support ${method}. Update it to continue.`)
    this.name = 'UnsupportedExtensionError'
    this.method = method
  }
}

/** JSON-RPC's "method not found" — what an older CLI answers a `_spettro/*`
 *  request it has never heard of with. */
const METHOD_NOT_FOUND = -32601

/** True for both shapes the verdict arrives in: an AcpError from the local
 *  pipe, and a fault relayed over the remote link. Both carry `code`. */
function isMethodNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return (error as { code?: unknown }).code === METHOD_NOT_FOUND
}

// ---------------------------------------------------------------------------
// The transport seam
// ---------------------------------------------------------------------------

/** Anything that can put one `_spettro/*` request to the CLI and hand back its
 *  raw `result`. `AcpAgent` satisfies it through its `raw()` passthrough; a
 *  relay (a paired phone reaching the CLI through its Mac) satisfies it just
 *  as well, which is what lets the same store code serve both. */
export interface ExtensionCaller {
  raw(method: string, params: JSONValue): Promise<JSONValue>
  /** Whether the other end serves `method`, when it said so up front
   *  (`initialize` lists the agent's `_spettro/*` methods). A caller that
   *  can't tell leaves this out, and every call is tried. */
  supports?(method: string): boolean
}

/** Which project a workflow call is about: a live ACP session (the CLI uses
 *  that session's folder, exactly as it would for a prompt), or — for a chat
 *  with no live session yet — the absolute folder itself (ext_workflow.go
 *  resolveCwd accepts either). */
export type WorkflowTarget = { sessionId: string } | { cwd: string }

/** The typed extension calls, written against the seam above. */
export class SpettroExtensions {
  private readonly caller: ExtensionCaller

  constructor(caller: ExtensionCaller) {
    this.caller = caller
  }

  // MARK: Account

  accountStatus(): Promise<AccountStatus> {
    return this.call(ExtensionMethod.accountStatus, {}, decodeAccountStatus)
  }

  startLogin(): Promise<LoginStatus> {
    return this.call(ExtensionMethod.accountLoginStart, {}, decodeLoginStatus)
  }

  pollLogin(): Promise<LoginStatus> {
    return this.call(ExtensionMethod.accountLoginPoll, {}, decodeLoginStatus)
  }

  cancelLogin(): Promise<LoginStatus> {
    return this.call(ExtensionMethod.accountLoginCancel, {}, decodeLoginStatus)
  }

  logout(): Promise<AccountStatus> {
    return this.call(ExtensionMethod.accountLogout, {}, decodeAccountStatus)
  }

  // MARK: Workflows
  //
  // Every call names its project the way the CLI resolves one for a prompt:
  // by the chat's live ACP session when there is one, so a script can never
  // land in a different repo than the conversation's. An unknown session id
  // is an error there, not a quiet fall back to the process cwd. A chat with
  // no live session names its absolute folder instead.

  listWorkflows(target: WorkflowTarget): Promise<WorkflowList> {
    return this.call(ExtensionMethod.workflowList, { ...target }, decodeWorkflowList)
  }

  readWorkflow(target: WorkflowTarget, name: string): Promise<WorkflowSource> {
    return this.call(ExtensionMethod.workflowRead, { ...target, name }, decodeWorkflowSource)
  }

  /** Saves and returns the *parsed* header: the script is the source of truth
   *  for the phase list, not whatever the editor was showing. */
  writeWorkflow(
    target: WorkflowTarget,
    name: string,
    scope: WorkflowScope,
    script: string
  ): Promise<WorkflowInfo> {
    return this.call(
      ExtensionMethod.workflowWrite,
      { ...target, name, scope, script },
      decodeWorkflowInfo
    )
  }

  deleteWorkflow(target: WorkflowTarget, name: string, scope: WorkflowScope): Promise<boolean> {
    return this.call(
      ExtensionMethod.workflowDelete,
      { ...target, name, scope },
      (v) => boolValue(objectValue(v)?.['deleted']) ?? false
    )
  }

  validateWorkflow(target: WorkflowTarget, script: string): Promise<WorkflowValidation> {
    return this.call(ExtensionMethod.workflowValidate, { ...target, script }, decodeWorkflowValidation)
  }

  listWorkflowRuns(target: WorkflowTarget, limit = 50): Promise<WorkflowRunInfo[]> {
    return this.call(ExtensionMethod.workflowRuns, { ...target, limit }, decodeWorkflowRuns)
  }

  // MARK: Providers

  listProviders(): Promise<ProvidersList> {
    return this.call(ExtensionMethod.providersList, {}, decodeProvidersList)
  }

  /** Verifies and stores an API key CLI-side. The key is posted once and never
   *  read back; it is not logged, cached, or persisted here. */
  connectProvider(id: string, apiKey: string, activate = false): Promise<ConnectResult> {
    return this.call(
      ExtensionMethod.providersConnect,
      { providerId: id, apiKey, activate },
      decodeConnectResult
    )
  }

  disconnectProvider(id: string): Promise<ProvidersList> {
    return this.call(ExtensionMethod.providersDisconnect, { providerId: id }, decodeProvidersList)
  }

  // MARK: Local endpoints

  probeLocalEndpoint(endpoint: string, apiKey: string | null): Promise<LocalProbeResult> {
    return this.call(ExtensionMethod.localProbe, localParams(endpoint, apiKey), decodeLocalProbe)
  }

  addLocalEndpoint(endpoint: string, apiKey: string | null): Promise<ProvidersList> {
    return this.call(ExtensionMethod.localAdd, localParams(endpoint, apiKey), decodeProvidersList)
  }

  removeLocalEndpoint(endpoint: string): Promise<ProvidersList> {
    return this.call(ExtensionMethod.localRemove, localParams(endpoint, null), decodeProvidersList)
  }

  // MARK: Models

  listModels(): Promise<ModelsList> {
    return this.call(ExtensionMethod.modelsList, {}, decodeModelsList)
  }

  setModelFavorite(provider: string, model: string, favorite: boolean): Promise<ModelsList> {
    return this.call(
      ExtensionMethod.modelsFavorite,
      { provider, model, favorite },
      decodeModelsList
    )
  }

  // MARK: Plumbing

  /** Sends one extension request and decodes its result. A method-not-found
   *  reply means the CLI predates this surface, which surfaces as
   *  `UnsupportedExtensionError` so callers can offer an update — as does a
   *  method the agent's handshake didn't list, without asking at all. */
  private async call<T>(
    method: string,
    params: JSONValue,
    decode: (value: JSONValue) => T
  ): Promise<T> {
    if (this.caller.supports && !this.caller.supports(method)) {
      throw new UnsupportedExtensionError(method)
    }
    let result: JSONValue
    try {
      result = await this.caller.raw(method, params)
    } catch (error) {
      if (isMethodNotFound(error)) throw new UnsupportedExtensionError(method)
      throw error
    }
    return decode(result)
  }
}

/** `apiKey` is omitted rather than sent as null when absent, matching the
 *  Swift encoder's `String?` (and the CLI's `omitempty`). */
function localParams(endpoint: string, apiKey: string | null): JSONValue {
  const params: { [key: string]: JSONValue } = { endpoint }
  if (apiKey !== null && apiKey !== '') params['apiKey'] = apiKey
  return params
}

// ---------------------------------------------------------------------------
// Decoders (every Swift `decodeIfPresent … ?? default` applied)
// ---------------------------------------------------------------------------

/** Doubles, unlike `intValue`, must not be truncated: credit figures are
 *  fractional. */
function doubleValue(value: JSONValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const LOGIN_STATES: readonly LoginState[] = [
  'idle',
  'starting',
  'pending',
  'complete',
  'expired',
  'cancelled',
  'error'
]

export function decodeLoginStatus(value: JSONValue): LoginStatus {
  const obj = objectValue(value) ?? {}
  const raw = stringValue(obj['status']) ?? 'idle'
  return {
    loginId: stringValue(obj['loginId']),
    // An unrecognised state from a newer CLI still renders, as `unknown`.
    status: (LOGIN_STATES as readonly string[]).includes(raw) ? (raw as LoginState) : 'unknown',
    browserUrl: stringValue(obj['browserUrl']),
    error: stringValue(obj['error'])
  }
}

export function decodeAccountStatus(value: JSONValue): AccountStatus {
  const obj = objectValue(value) ?? {}
  const login = obj['login']
  return {
    signedIn: boolValue(obj['signedIn']) ?? false,
    email: stringValue(obj['email']),
    plan: stringValue(obj['plan']),
    planStatus: stringValue(obj['planStatus']),
    creditsUsed: doubleValue(obj['creditsUsed']),
    creditLimit: doubleValue(obj['creditLimit']),
    remainingCredits: doubleValue(obj['remainingCredits']),
    modelCount: intValue(obj['modelCount']) ?? 0,
    pricingUrl: stringValue(obj['pricingUrl']),
    login: login === undefined || login === null ? null : decodeLoginStatus(login),
    stale: boolValue(obj['stale']) ?? false
  }
}

/** Null when `id`/`name` are missing — the two fields Swift decodes
 *  non-optionally, so a malformed row is dropped rather than half-rendered. */
export function decodeProviderEntry(value: JSONValue): ProviderEntry | null {
  const obj = objectValue(value)
  if (!obj) return null
  const id = stringValue(obj['id'])
  const name = stringValue(obj['name'])
  if (id === null || name === null) return null
  return {
    id,
    name,
    envKey: stringValue(obj['envKey']),
    connected: boolValue(obj['connected']) ?? false,
    suggested: boolValue(obj['suggested']) ?? false,
    modelCount: intValue(obj['modelCount']) ?? 0
  }
}

export function decodeLocalEndpoint(value: JSONValue): LocalEndpoint | null {
  const obj = objectValue(value)
  if (!obj) return null
  const endpoint = stringValue(obj['endpoint'])
  if (endpoint === null) return null
  return {
    endpoint,
    name: stringValue(obj['name']) ?? endpoint,
    hasKey: boolValue(obj['hasKey']) ?? false,
    modelCount: intValue(obj['modelCount']) ?? 0
  }
}

export function decodeProvidersList(value: JSONValue): ProvidersList {
  const obj = objectValue(value) ?? {}
  const providers = (arrayValue(obj['providers']) ?? [])
    .map(decodeProviderEntry)
    .filter((entry): entry is ProviderEntry => entry !== null)
  const local = (arrayValue(obj['local']) ?? [])
    .map(decodeLocalEndpoint)
    .filter((entry): entry is LocalEndpoint => entry !== null)
  const subscription = obj['subscription'] === undefined ? null : decodeProviderEntry(obj['subscription'])
  return {
    providers,
    local,
    subscription: subscription ?? { ...EMPTY_PROVIDERS.subscription }
  }
}

export function decodeConnectResult(value: JSONValue): ConnectResult {
  const obj = objectValue(value) ?? {}
  return {
    connected: boolValue(obj['connected']) ?? false,
    modelCount: intValue(obj['modelCount']) ?? 0,
    activeModel: stringValue(obj['activeModel'])
  }
}

export function decodeModelEntry(value: JSONValue): ModelEntry | null {
  const obj = objectValue(value)
  if (!obj) return null
  const provider = stringValue(obj['provider'])
  const name = stringValue(obj['name'])
  if (provider === null || name === null) return null
  return {
    provider,
    providerName: stringValue(obj['providerName']) ?? provider,
    name,
    displayName: stringValue(obj['displayName']) ?? name,
    vision: boolValue(obj['vision']) ?? false,
    reasoning: boolValue(obj['reasoning']) ?? false,
    toolCall: boolValue(obj['toolCall']) ?? false,
    context: intValue(obj['context']) ?? 0,
    local: boolValue(obj['local']) ?? false,
    favorite: boolValue(obj['favorite']) ?? false,
    active: boolValue(obj['active']) ?? false
  }
}

function decodeModels(value: JSONValue | undefined): ModelEntry[] {
  return (arrayValue(value) ?? [])
    .map(decodeModelEntry)
    .filter((entry): entry is ModelEntry => entry !== null)
}

export function decodeModelsList(value: JSONValue): ModelsList {
  const obj = objectValue(value) ?? {}
  return {
    models: decodeModels(obj['models']),
    activeProvider: stringValue(obj['activeProvider']),
    activeModel: stringValue(obj['activeModel'])
  }
}

export function decodeLocalProbe(value: JSONValue): LocalProbeResult {
  const obj = objectValue(value) ?? {}
  const endpoint = stringValue(obj['endpoint']) ?? ''
  return {
    endpoint,
    name: stringValue(obj['name']) ?? endpoint,
    models: decodeModels(obj['models'])
  }
}

// ---------------------------------------------------------------------------
// Workflow decoders
//
// Lenient in the same way the rest of this file is: an older CLI that predates
// a field should render with a sensible blank rather than fail the call. The
// one field worth being careful with is `error`, which is null when absent —
// "" would read as "checked and fine" for a script nobody checked.
// ---------------------------------------------------------------------------

function decodeWorkflowPhases(value: JSONValue | undefined): WorkflowPhaseInfo[] {
  return (arrayValue(value) ?? []).flatMap((entry) => {
    const obj = objectValue(entry)
    const title = obj ? stringValue(obj['title']) : null
    if (title === null) return []
    return [{ title, detail: stringValue(obj?.['detail'] as JSONValue) ?? '' }]
  })
}

function decodeScope(value: JSONValue | undefined): WorkflowScope {
  return stringValue(value) === 'global' ? 'global' : 'project'
}

export function decodeWorkflowInfo(value: JSONValue): WorkflowInfo {
  const obj = objectValue(value) ?? {}
  const name = stringValue(obj['name']) ?? ''
  return {
    name,
    path: stringValue(obj['path']) ?? '',
    scope: decodeScope(obj['scope']),
    description: stringValue(obj['description']) ?? '',
    whenToUse: stringValue(obj['whenToUse']) ?? '',
    phases: decodeWorkflowPhases(obj['phases']),
    error: stringValue(obj['error'])
  }
}

export function decodeWorkflowList(value: JSONValue): WorkflowList {
  const obj = objectValue(value) ?? {}
  return {
    workflows: (arrayValue(obj['workflows']) ?? []).map(decodeWorkflowInfo),
    searchPaths: (arrayValue(obj['searchPaths']) ?? []).flatMap((p) => {
      const s = stringValue(p)
      return s === null ? [] : [s]
    }),
    cwd: stringValue(obj['cwd']) ?? ''
  }
}

export function decodeWorkflowSource(value: JSONValue): WorkflowSource {
  const obj = objectValue(value) ?? {}
  return { ...decodeWorkflowInfo(value), script: stringValue(obj['script']) ?? '' }
}

export function decodeWorkflowValidation(value: JSONValue): WorkflowValidation {
  const obj = objectValue(value) ?? {}
  return {
    // A reply that omits `ok` entirely is not a pass. Defaulting to true would
    // let a decoding slip read as a clean compile and save a broken script.
    ok: boolValue(obj['ok']) ?? false,
    error: stringValue(obj['error']),
    name: stringValue(obj['name']) ?? '',
    description: stringValue(obj['description']) ?? '',
    whenToUse: stringValue(obj['whenToUse']) ?? '',
    phases: decodeWorkflowPhases(obj['phases'])
  }
}

export function decodeWorkflowRuns(value: JSONValue): WorkflowRunInfo[] {
  const obj = objectValue(value) ?? {}
  return (arrayValue(obj['runs']) ?? []).flatMap((entry) => {
    const row = objectValue(entry)
    const runId = row ? stringValue(row['runId']) : null
    if (runId === null) return []
    return [
      {
        runId,
        dir: stringValue(row?.['dir'] as JSONValue) ?? '',
        modifiedAt: intValue(row?.['modifiedAt'] as JSONValue) ?? 0,
        name: '',
        finished: false
      }
    ]
  })
}

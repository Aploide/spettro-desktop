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
  type ProvidersList
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
}

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
   *  `UnsupportedExtensionError` so callers can offer an update. */
  private async call<T>(
    method: string,
    params: JSONValue,
    decode: (value: JSONValue) => T
  ): Promise<T> {
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

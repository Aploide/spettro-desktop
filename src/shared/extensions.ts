// The `_spettro/*` ACP extension surface — subscription login/logout, provider
// API-key management, local endpoints, and the model catalog. Port of
// Spettro/Core/ACP/ACPExtensions.swift.
//
// API keys travel one way only: the app posts a key to connect a provider and
// never reads one back — keys stay in the CLI's encrypted store
// (~/.spettro/keys.enc), which is why none of this can be done app-side.

export const ExtensionMethod = {
  accountStatus: '_spettro/account/status',
  accountLoginStart: '_spettro/account/login/start',
  accountLoginPoll: '_spettro/account/login/poll',
  accountLoginCancel: '_spettro/account/login/cancel',
  accountLogout: '_spettro/account/logout',

  providersList: '_spettro/providers/list',
  providersConnect: '_spettro/providers/connect',
  providersDisconnect: '_spettro/providers/disconnect',
  localProbe: '_spettro/providers/local/probe',
  localAdd: '_spettro/providers/local/add',
  localRemove: '_spettro/providers/local/remove',
  modelsList: '_spettro/models/list',
  modelsFavorite: '_spettro/models/favorite',

  // Workflow authoring (CLI extensions v4). Core ACP can carry a workflow
  // *run* — it becomes tool calls — but has no vocabulary for writing one,
  // checking whether it compiles, or keeping it. See the CLI's
  // internal/acp/ext_workflow.go.
  workflowList: '_spettro/workflow/list',
  workflowRead: '_spettro/workflow/read',
  workflowWrite: '_spettro/workflow/write',
  workflowDelete: '_spettro/workflow/delete',
  workflowValidate: '_spettro/workflow/validate',
  workflowRuns: '_spettro/workflow/runs',

  /** Agent → client: pushed when account state changes (notably as a
   *  device-flow login advances). */
  accountUpdate: '_spettro/account/update'
} as const

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export type LoginState =
  | 'idle'
  | 'starting'
  | 'pending'
  | 'complete'
  | 'expired'
  | 'cancelled'
  | 'error'
  | 'unknown'

export interface LoginStatus {
  loginId: string | null
  status: LoginState
  browserUrl: string | null
  error: string | null
}

/** The user's Spettro Subscription state. Carries no secret material. */
export interface AccountStatus {
  signedIn: boolean
  email: string | null
  plan: string | null
  planStatus: string | null
  creditsUsed: number | null
  creditLimit: number | null
  remainingCredits: number | null
  modelCount: number
  pricingUrl: string | null
  login: LoginStatus | null
  /** True when the values came from the CLI's on-disk cache because the
   *  backend was unreachable, so the UI can present them as stale. */
  stale: boolean
}

export const EMPTY_ACCOUNT: AccountStatus = {
  signedIn: false,
  email: null,
  plan: null,
  planStatus: null,
  creditsUsed: null,
  creditLimit: null,
  remainingCredits: null,
  modelCount: 0,
  pricingUrl: null,
  login: null,
  stale: false
}

/** A signed-in account with no explicit plan is on the free tier — the same
 *  rule the TUI's badge applies. */
export function effectivePlan(status: AccountStatus): string {
  if (!status.signedIn) return ''
  const raw = (status.plan ?? '').trim()
  return raw === '' ? 'free' : raw.toLowerCase()
}

/** Fraction of the monthly credit budget still available, 0…1. Prefers the
 *  backend's own `remainingCredits` over `limit - used`: the two can
 *  legitimately disagree (rollover, overflow tier, mid-cycle plan change), and
 *  the figure the service calls "remaining" is the one the user is billed
 *  against. */
export function remainingFraction(status: AccountStatus): number | null {
  const limit = status.creditLimit
  if (limit === null || limit <= 0) return null
  if (status.remainingCredits !== null) {
    return Math.min(1, Math.max(0, status.remainingCredits / limit))
  }
  if (status.creditsUsed === null) return null
  return Math.min(1, Math.max(0, 1 - status.creditsUsed / limit))
}

/** The exact figures, for the tooltip behind the percentage. */
export function creditDetail(status: AccountStatus): string | null {
  const limit = status.creditLimit
  if (limit === null || limit <= 0) return null
  const remaining =
    status.remainingCredits ?? (status.creditsUsed === null ? null : limit - status.creditsUsed)
  if (remaining === null) return null
  const fmt = (v: number): string => (v === Math.round(v) ? String(Math.round(v)) : v.toFixed(1))
  return `${fmt(remaining)} of ${fmt(limit)} credits remaining`
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export interface ProviderEntry {
  id: string
  name: string
  envKey: string | null
  connected: boolean
  suggested: boolean
  modelCount: number
}

/** One connected OpenAI-compatible local server. */
export interface LocalEndpoint {
  endpoint: string
  name: string
  hasKey: boolean
  modelCount: number
}

/** "localhost:1234" — the endpoint without its scheme, as the TUI labels it. */
export function shortHost(endpoint: string): string {
  return endpoint.replace(/^https?:\/\//, '')
}

export interface ProvidersList {
  providers: ProviderEntry[]
  local: LocalEndpoint[]
  subscription: ProviderEntry
}

export const EMPTY_PROVIDERS: ProvidersList = {
  providers: [],
  local: [],
  subscription: {
    id: 'spettro',
    name: 'Spettro',
    envKey: null,
    connected: false,
    suggested: false,
    modelCount: 0
  }
}

export function connectedCount(list: ProvidersList): number {
  return (
    list.providers.filter((p) => p.connected).length +
    list.local.length +
    (list.subscription.connected ? 1 : 0)
  )
}

/** True when nothing at all is configured — the state that must route the user
 *  into provider setup rather than a chat they can't use. */
export function providersEmpty(list: ProvidersList): boolean {
  return connectedCount(list) === 0
}

export interface ConnectResult {
  connected: boolean
  modelCount: number
  activeModel: string | null
}

export interface LocalProbeResult {
  endpoint: string
  name: string
  models: ModelEntry[]
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface ModelEntry {
  provider: string
  providerName: string
  name: string
  displayName: string
  vision: boolean
  reasoning: boolean
  toolCall: boolean
  context: number
  local: boolean
  favorite: boolean
  active: boolean
}

/** "128k" / "1.0M" — the context window in the compact form the TUI uses. */
export function contextLabel(model: ModelEntry): string | null {
  if (model.context <= 0) return null
  if (model.context >= 1_000_000) return `${(model.context / 1_000_000).toFixed(1)}M`
  if (model.context >= 1_000) return `${Math.floor(model.context / 1_000)}k`
  return String(model.context)
}

export interface ModelsList {
  models: ModelEntry[]
  activeProvider: string | null
  activeModel: string | null
}

export const EMPTY_MODELS: ModelsList = { models: [], activeProvider: null, activeModel: null }

/** Models grouped by provider, favorites first within each group, in the order
 *  the model picker should render them. */
export function groupedModels(list: ModelsList): { provider: string; models: ModelEntry[] }[] {
  const order: string[] = []
  const byProvider = new Map<string, ModelEntry[]>()
  for (const model of list.models) {
    if (!byProvider.has(model.providerName)) {
      order.push(model.providerName)
      byProvider.set(model.providerName, [])
    }
    byProvider.get(model.providerName)!.push(model)
  }
  return order.map((provider) => ({
    provider,
    models: [...(byProvider.get(provider) ?? [])].sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
      return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
    })
  }))
}

/** State the main process mirrors to the renderer (AccountStore +
 *  ProviderStore ports). */
export interface ExtensionsState {
  account: AccountStatus
  providers: ProvidersList
  models: ModelsList
  /** True when the CLI predates the `_spettro/*` surface (-32601). */
  unsupported: boolean
  busy: boolean
  /** Last error from a store refresh, for inline display. */
  error: string | null
}

export const EMPTY_EXTENSIONS: ExtensionsState = {
  account: EMPTY_ACCOUNT,
  providers: EMPTY_PROVIDERS,
  models: EMPTY_MODELS,
  unsupported: false,
  busy: false,
  error: null
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

/** A phase a workflow's `meta` declares, before anything has run. */
export interface WorkflowPhaseInfo {
  title: string
  detail: string
}

/**
 * A saved workflow script.
 *
 * `error` is set when the file exists but does not compile. That is
 * deliberately not the same as the call failing: a broken script is still
 * listable, still readable and still the thing you were about to edit, and a
 * listing that hides it just moves the discovery to whoever runs it next.
 */
export interface WorkflowInfo {
  name: string
  path: string
  /** 'project' — `<repo>/.spettro/workflows` — or 'global' — `~/.spettro/…`. */
  scope: WorkflowScope
  description: string
  whenToUse: string
  phases: WorkflowPhaseInfo[]
  error: string | null
}

export type WorkflowScope = 'project' | 'global'

export interface WorkflowList {
  workflows: WorkflowInfo[]
  /** Where the CLI looks, project first — also where it would save. Shown so
   *  a project with no workflow folder yet can still be offered one. */
  searchPaths: string[]
  cwd: string
}

export interface WorkflowSource extends WorkflowInfo {
  script: string
}

/** The editor's live feedback. `ok: false` is an ordinary answer — an editor
 *  validates on every keystroke and most keystrokes leave a script mid-edit. */
export interface WorkflowValidation {
  ok: boolean
  error: string | null
  name: string
  description: string
  whenToUse: string
  phases: WorkflowPhaseInfo[]
}

/** A past run's transcript directory — what makes resume possible. */
export interface WorkflowRunInfo {
  runId: string
  dir: string
  /** ms since epoch. */
  modifiedAt: number
}

export const EMPTY_WORKFLOW_LIST: WorkflowList = { workflows: [], searchPaths: [], cwd: '' }

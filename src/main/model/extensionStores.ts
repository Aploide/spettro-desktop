// Account, providers, and models — the port of AccountStore.swift and
// ProviderStore.swift fused into one store, because the renderer mirrors them
// as a single `ExtensionsState` field of AppStateDTO.
//
// The CLI is the single source of truth for the whole account lifecycle, so
// signing in and out work from the app exactly as `/login` and `/logout` do in
// the TUI, and the encrypted key store stays where it belongs. API keys are
// write-only from here: a key is posted to the CLI, verified against the
// provider's own API, and stored encrypted CLI-side. This process never
// receives one back, never logs one, and never persists one.
//
// The CLI owns the device-flow poller and pushes `_spettro/account/update`
// notifications as the flow advances (`applyAccountUpdate` is where those
// land). We *also* poll `_spettro/account/login/poll` on the CLI's own cadence
// while a login is in flight, so a dropped notification can't strand the
// sign-in sheet on its spinner.

import type { JSONValue } from '../../shared/acp'
import {
  EMPTY_ACCOUNT,
  EMPTY_MODELS,
  EMPTY_PROVIDERS,
  providersEmpty,
  type AccountStatus,
  type ConnectResult,
  type ExtensionsState,
  type LocalProbeResult,
  type LoginStatus,
  type ModelsList,
  type ProvidersList
} from '../../shared/extensions'
import {
  SpettroExtensions,
  UnsupportedExtensionError,
  decodeAccountStatus,
  type ExtensionCaller
} from '../acp/extensions'

/** How often an in-flight device-flow login is re-read from the CLI. Matches
 *  the CLI's own `loginPollInterval` (internal/acp/ext_account.go), which is
 *  the TUI's cadence. */
const LOGIN_POLL_INTERVAL_MS = 2_000

/** Bounds a forgotten flow, mirroring the CLI's `loginMaxWait`. */
const LOGIN_MAX_WAIT_MS = 10 * 60 * 1_000

/** Consecutive poll failures tolerated before the loop gives up. A transient
 *  hiccup shouldn't end a sign-in; a dead agent shouldn't be polled forever. */
const LOGIN_POLL_MAX_FAILURES = 3

const NO_AGENT = 'Not connected to the Spettro agent.'

const IDLE_LOGIN: LoginStatus = { loginId: null, status: 'idle', browserUrl: null, error: null }

export class ExtensionStores {
  /** Called after every state change, so AppModel can push a fresh
   *  AppStateDTO. */
  private readonly onChange: () => void

  /** Set by AppModel: a completed sign-in is usually what unblocks a CLI that
   *  had no provider at all, so the setup gate is re-evaluated. */
  onLoginComplete: (() => void) | null = null

  private account: AccountStatus = { ...EMPTY_ACCOUNT }
  private providers: ProvidersList = cloneProviders(EMPTY_PROVIDERS)
  private models: ModelsList = { ...EMPTY_MODELS }
  private unsupported = false
  private error: string | null = null
  /** Depth counter rather than a flag: overlapping refreshes must not have the
   *  first one to finish clear the spinner for the others. */
  private inFlight = 0

  /** True once a provider refresh has **succeeded**, so callers can tell
   *  "nothing is configured" apart from "we don't know yet". A failed refresh
   *  deliberately leaves this false: treating a failure as "loaded, and empty"
   *  is what would lock users into provider setup on launch. */
  private hasLoadedProviders = false

  private calls: SpettroExtensions | null = null

  private loginTimer: NodeJS.Timeout | null = null
  /** Bumped whenever a login starts or stops, so a timer that fires after its
   *  flow was superseded (or the agent died) bows out. */
  private loginGeneration = 0

  constructor(onChange: () => void) {
    this.onChange = onChange
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  /** Attaches the live agent (or detaches on `null`). Deliberately does not
   *  kick off its own refresh: the caller decides when to load, so a refresh
   *  whose result gates the UI can't race a second one fired from here. */
  attach(caller: ExtensionCaller | null): void {
    this.stopLoginLoop()
    this.calls = caller ? new SpettroExtensions(caller) : null
    if (!caller) {
      // An agent that isn't there tells us nothing about what's configured.
      this.hasLoadedProviders = false
      this.inFlight = 0
      this.emit()
    }
  }

  /**
   * The typed extension client, or null when no agent is attached.
   *
   * Everything else on this class caches its result into the app-state
   * snapshot, because account/provider/model state is global and every screen
   * reads the same copy. Workflows are neither: they belong to a project, they
   * are read and written on demand, and the answer is a file the user is about
   * to edit. Caching that here would put a stale script in front of an editor.
   * So the workflow calls go straight through — the store lends its client
   * rather than owning the state.
   */
  get client(): SpettroExtensions | null {
    return this.calls
  }

  /** Stops the login poller. Called on shutdown. */
  dispose(): void {
    this.stopLoginLoop()
  }

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  snapshot(): ExtensionsState {
    return {
      account: this.account,
      providers: this.providers,
      models: this.models,
      unsupported: this.unsupported,
      busy: this.inFlight > 0,
      error: this.error
    }
  }

  get isSignedIn(): boolean {
    return this.account.signedIn
  }

  /** True only when we positively know there is no usable way to run a model.
   *  Unknown states report false — the app must fail open. */
  get needsProviderSetup(): boolean {
    return this.hasLoadedProviders && providersEmpty(this.providers)
  }

  // -------------------------------------------------------------------------
  // Refreshes
  // -------------------------------------------------------------------------

  /** Providers first, then the account: the provider answer gates the UI, and
   *  the account fetch hits the network. */
  async refresh(): Promise<void> {
    await this.refreshProviders()
    await this.refreshAccount()
  }

  async refreshAccount(): Promise<void> {
    const calls = this.calls
    if (!calls) return
    this.begin()
    try {
      const status = await calls.accountStatus()
      this.account = status
      this.unsupported = false
      this.error = null
    } catch (err) {
      if (err instanceof UnsupportedExtensionError) {
        this.unsupported = true
      }
      // A refresh failure is not worth a banner: the CLI already falls back to
      // its cached plan and flags it stale.
    } finally {
      this.end()
    }
  }

  /** The provider list and the model catalog, sequentially — both land on the
   *  CLI's config layer, and issuing them together is what made startup
   *  flaky. Two round trips over a local pipe cost nothing measurable. */
  async refreshProviders(): Promise<void> {
    const calls = this.calls
    if (!calls) return
    this.begin()
    try {
      const providers = await calls.listProviders()
      const models = await calls.listModels()
      this.providers = providers
      this.models = models
      this.unsupported = false
      this.hasLoadedProviders = true
      this.error = null
    } catch (err) {
      if (err instanceof UnsupportedExtensionError) {
        // An old CLI tells us nothing about what's configured. Don't claim to
        // have loaded — locking someone out of their app over a missing
        // extension method is far worse than letting them through.
        this.unsupported = true
        this.hasLoadedProviders = false
      }
      // Leave the last-known lists in place; a transient failure shouldn't
      // blank the connect screen or trigger setup.
      this.error = errMessage(err)
    } finally {
      this.end()
    }
  }

  async refreshModels(): Promise<void> {
    const calls = this.calls
    if (!calls) return
    this.begin()
    try {
      this.models = await calls.listModels()
      this.unsupported = false
    } catch (err) {
      if (err instanceof UnsupportedExtensionError) this.unsupported = true
    } finally {
      this.end()
    }
  }

  // -------------------------------------------------------------------------
  // Agent-pushed account updates
  // -------------------------------------------------------------------------

  /** Applies an agent-pushed `_spettro/account/update` notification. A payload
   *  that isn't an object is ignored rather than decoded into an empty
   *  account: that would report a signed-in user as signed out. */
  applyAccountUpdate(params: JSONValue): void {
    if (params === null || typeof params !== 'object' || Array.isArray(params)) return
    const status = decodeAccountStatus(params)
    this.account = status
    const state = status.login?.status ?? null
    if (state !== null && state !== 'pending' && state !== 'starting') {
      // A completed or failed flow ends the sheet's busy state and the poller
      // that was watching it.
      this.stopLoginLoop()
    }
    const message = status.login?.error ?? null
    if (message !== null && message !== '') this.error = message
    this.emit()
    if (state === 'complete') this.finishLogin()
  }

  // -------------------------------------------------------------------------
  // Account actions
  // -------------------------------------------------------------------------

  /** Starts a device-flow sign-in and begins polling it. The returned status
   *  carries the URL the caller opens — the app, not the CLI, owns browser
   *  launching. */
  async startLogin(): Promise<LoginStatus> {
    const calls = this.calls
    if (!calls) {
      const failed: LoginStatus = { ...IDLE_LOGIN, status: 'error', error: NO_AGENT }
      this.setLogin(failed)
      this.error = NO_AGENT
      this.emit()
      return failed
    }
    this.stopLoginLoop()
    this.error = null
    this.begin()
    try {
      const status = await calls.startLogin()
      this.setLogin(status)
      if (status.status === 'error') {
        this.error = status.error ?? 'Sign-in could not be started.'
      } else if (status.status === 'pending' || status.status === 'starting') {
        this.startLoginLoop()
      } else if (status.status === 'complete') {
        this.finishLogin()
      }
      return status
    } catch (err) {
      const message =
        err instanceof UnsupportedExtensionError
          ? "This version of the Spettro CLI can't sign in from the app. Update it and try again."
          : errMessage(err)
      if (err instanceof UnsupportedExtensionError) this.unsupported = true
      this.error = message
      const failed: LoginStatus = { ...IDLE_LOGIN, status: 'error', error: message }
      this.setLogin(failed)
      return failed
    } finally {
      this.end()
    }
  }

  /** Re-reads the login state from the CLI once. Used when a screen reappears
   *  and may have missed a notification. */
  async pollLogin(): Promise<LoginStatus> {
    const calls = this.calls
    if (!calls) return this.account.login ?? { ...IDLE_LOGIN }
    try {
      const status = await calls.pollLogin()
      this.setLogin(status)
      this.emit()
      if (status.status === 'complete') this.finishLogin()
      return status
    } catch (err) {
      if (err instanceof UnsupportedExtensionError) {
        this.unsupported = true
        this.emit()
      }
      return this.account.login ?? { ...IDLE_LOGIN }
    }
  }

  async cancelLogin(): Promise<void> {
    this.stopLoginLoop()
    this.setLogin(null)
    this.emit()
    const calls = this.calls
    if (!calls) return
    try {
      await calls.cancelLogin()
    } catch {
      // Cancelling a flow the CLI has already forgotten is not an error.
    }
  }

  async logout(): Promise<void> {
    const calls = this.calls
    if (!calls) return
    this.stopLoginLoop()
    this.begin()
    try {
      this.account = await calls.logout()
      this.error = null
    } catch (err) {
      if (err instanceof UnsupportedExtensionError) this.unsupported = true
      this.error = errMessage(err)
    } finally {
      this.end()
    }
    // Signing out removes the subscription's models, so the catalog and the
    // provider list both move.
    await this.refreshProviders()
  }

  // -------------------------------------------------------------------------
  // Provider actions
  // -------------------------------------------------------------------------

  /** Verifies and stores an API key. The failure reason lands in `error` (the
   *  renderer shows it inline) rather than being thrown, mirroring
   *  ProviderStore.connect's `-> Bool`. */
  async connect(providerId: string, apiKey: string, activate = false): Promise<ConnectResult> {
    const calls = this.calls
    if (!calls) {
      this.error = NO_AGENT
      this.emit()
      return { connected: false, modelCount: 0, activeModel: null }
    }
    this.error = null
    this.begin()
    let result: ConnectResult = { connected: false, modelCount: 0, activeModel: null }
    try {
      result = await calls.connectProvider(providerId, apiKey, activate)
    } catch (err) {
      if (err instanceof UnsupportedExtensionError) this.unsupported = true
      this.error = errMessage(err)
    } finally {
      this.end()
    }
    await this.refreshProviders()
    return result
  }

  async disconnect(providerId: string): Promise<void> {
    const calls = this.calls
    if (!calls) return
    this.begin()
    try {
      this.providers = await calls.disconnectProvider(providerId)
      this.error = null
    } catch (err) {
      if (err instanceof UnsupportedExtensionError) this.unsupported = true
      this.error = errMessage(err)
    } finally {
      this.end()
    }
    await this.refreshModels()
  }

  // -------------------------------------------------------------------------
  // Local endpoints
  // -------------------------------------------------------------------------

  /** Probes a local OpenAI-compatible server without saving it, so the user
   *  can see what it offers before committing. Throws on failure: an empty
   *  result would be indistinguishable from a server with no models. */
  async probeLocal(endpoint: string, apiKey: string | null): Promise<LocalProbeResult> {
    const calls = this.calls
    if (!calls) throw new Error(NO_AGENT)
    this.error = null
    this.begin()
    try {
      return await calls.probeLocalEndpoint(endpoint, apiKey)
    } catch (err) {
      if (err instanceof UnsupportedExtensionError) this.unsupported = true
      this.error = errMessage(err)
      throw err
    } finally {
      this.end()
    }
  }

  async addLocal(endpoint: string, apiKey: string | null): Promise<void> {
    const calls = this.calls
    if (!calls) {
      this.error = NO_AGENT
      this.emit()
      return
    }
    this.error = null
    this.begin()
    try {
      this.providers = await calls.addLocalEndpoint(endpoint, apiKey)
    } catch (err) {
      if (err instanceof UnsupportedExtensionError) this.unsupported = true
      this.error = errMessage(err)
    } finally {
      this.end()
    }
    await this.refreshModels()
  }

  async removeLocal(endpoint: string): Promise<void> {
    const calls = this.calls
    if (!calls) return
    this.begin()
    try {
      this.providers = await calls.removeLocalEndpoint(endpoint)
    } catch (err) {
      if (err instanceof UnsupportedExtensionError) this.unsupported = true
      this.error = errMessage(err)
    } finally {
      this.end()
    }
    await this.refreshModels()
  }

  // -------------------------------------------------------------------------
  // Models
  // -------------------------------------------------------------------------

  async setFavorite(provider: string, model: string, favorite: boolean): Promise<void> {
    const calls = this.calls
    if (!calls) return
    this.begin()
    try {
      this.models = await calls.setModelFavorite(provider, model, favorite)
      this.error = null
    } catch (err) {
      if (err instanceof UnsupportedExtensionError) this.unsupported = true
      this.error = errMessage(err)
    } finally {
      this.end()
    }
  }

  // -------------------------------------------------------------------------
  // The device-flow login loop
  // -------------------------------------------------------------------------

  private startLoginLoop(): void {
    this.stopLoginLoop()
    this.loginGeneration += 1
    const generation = this.loginGeneration
    const deadline = Date.now() + LOGIN_MAX_WAIT_MS
    let failures = 0

    const tick = async (): Promise<void> => {
      if (generation !== this.loginGeneration) return
      const calls = this.calls
      if (!calls) {
        this.stopLoginLoop()
        return
      }
      let status: LoginStatus
      try {
        status = await calls.pollLogin()
        failures = 0
      } catch (err) {
        if (generation !== this.loginGeneration) return
        failures += 1
        if (err instanceof UnsupportedExtensionError || failures >= LOGIN_POLL_MAX_FAILURES) {
          if (err instanceof UnsupportedExtensionError) this.unsupported = true
          this.error = errMessage(err)
          this.stopLoginLoop()
          this.emit()
          return
        }
        schedule()
        return
      }
      if (generation !== this.loginGeneration) return

      this.setLogin(status)
      switch (status.status) {
        case 'complete':
          this.stopLoginLoop()
          this.emit()
          this.finishLogin()
          return
        case 'expired':
        case 'cancelled':
        case 'error':
          if (status.error !== null && status.error !== '') this.error = status.error
          this.stopLoginLoop()
          this.emit()
          return
        default:
          break
      }
      this.emit()
      if (Date.now() >= deadline) {
        // The CLI bounds the flow the same way; if its notification never
        // arrived, don't leave the sheet spinning forever.
        this.setLogin({
          ...status,
          status: 'expired',
          error: status.error ?? 'the login link expired — please sign in again'
        })
        this.stopLoginLoop()
        this.emit()
        return
      }
      schedule()
    }

    const schedule = (): void => {
      if (generation !== this.loginGeneration) return
      this.loginTimer = setTimeout(() => {
        this.loginTimer = null
        void tick()
      }, LOGIN_POLL_INTERVAL_MS)
      // A pending sign-in must never hold the app open on quit.
      this.loginTimer.unref?.()
    }

    schedule()
  }

  private stopLoginLoop(): void {
    this.loginGeneration += 1
    if (this.loginTimer) {
      clearTimeout(this.loginTimer)
      this.loginTimer = null
    }
  }

  /** A finished sign-in: re-read the plan and the catalog it just unlocked,
   *  then let AppModel re-check the provider gate. */
  private finishLogin(): void {
    void (async () => {
      await this.refreshAccount()
      await this.refreshProviders()
      this.onLoginComplete?.()
    })()
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private setLogin(login: LoginStatus | null): void {
    this.account = { ...this.account, login }
  }

  private begin(): void {
    this.inFlight += 1
    this.emit()
  }

  private end(): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
    this.emit()
  }

  private emit(): void {
    this.onChange()
  }
}

function cloneProviders(list: ProvidersList): ProvidersList {
  return {
    providers: [...list.providers],
    local: [...list.local],
    subscription: { ...list.subscription }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

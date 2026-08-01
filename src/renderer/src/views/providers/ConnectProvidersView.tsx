// Port of Spettro/Views/Providers/ConnectProvidersView.swift — the app's
// `/connect`: sign in to a subscription, paste a provider API key, or attach a
// local OpenAI-compatible server.
//
// Keys are verified against the provider's own API by the CLI before they are
// stored (encrypted, in ~/.spettro/keys.enc), so a rejected key never gets
// written. Nothing entered here is persisted by the app — `providerConnect`
// posts the key and the app never reads one back.
//
// Two presentations, as in the Swift: a sheet ("Providers", Done) opened from
// Settings, and the onboarding pass shown full-window in the `needsProvider`
// phase, which activates the first model that connects, reports completion,
// and offers "Continue Without" so setup is never a dead end.

import { useEffect, useMemo, useState } from 'react'
import type { ProviderEntry } from '@shared/extensions'
import { EMPTY_EXTENSIONS, shortHost } from '@shared/extensions'
import { call, getState, useApp } from '@renderer/state/store'
import PlanBadge from '@renderer/views/shell/PlanBadge'
import Spinner from '@renderer/views/shell/Spinner'
import SignInView from '@renderer/views/account/SignInView'
import AddLocalEndpointView from './AddLocalEndpointView'
import ModelPickerView from './ModelPickerView'
import { badgePlan, CheckSealIcon, DesktopIcon, KeyIcon, PersonIcon, WarningTriangleIcon } from './icons'
import '@renderer/design/form.css'
import './providers.css'

interface Props {
  /** The first-run pass: activates the first model that connects and reports
   *  completion to the host. */
  isOnboarding?: boolean
  onComplete?: () => void
  /** Leaves setup without connecting anything (onboarding only). */
  onSkip?: () => void
  /** Dismisses the sheet presentation. */
  onClose?: () => void
  /** 'gate' fills the window (the `needsProvider` phase); 'sheet' presents
   *  over Settings. */
  presentation?: 'sheet' | 'gate'
}

export default function ConnectProvidersView({
  isOnboarding = false,
  onComplete,
  onSkip,
  onClose,
  presentation = 'sheet'
}: Props): JSX.Element {
  const app = useApp()
  const ext = app?.extensions ?? EMPTY_EXTENSIONS
  const { account, providers, models } = ext

  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [connectErrors, setConnectErrors] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [showSignIn, setShowSignIn] = useState(false)
  const [showAddLocal, setShowAddLocal] = useState(false)
  const [showModels, setShowModels] = useState(false)

  // `.task { await providers.refresh() }`
  useEffect(() => {
    void call('refreshExtensions')
  }, [])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (query === '') return providers.providers
    return providers.providers.filter(
      (p) => p.id.toLowerCase().includes(query) || p.name.toLowerCase().includes(query)
    )
  }, [providers.providers, search])

  // `providerConnect` doesn't throw: a rejected key comes back as
  // `connected: false` with the reason already pushed into `extensions.error`,
  // which is read back here so the failure lands on the row that caused it
  // (the port of ProviderStore.connectErrors).
  const connect = async (provider: ProviderEntry): Promise<void> => {
    const key = keyDraft.trim()
    if (key === '') return
    setBusyId(provider.id)
    setConnectErrors((e) => ({ ...e, [provider.id]: '' }))
    try {
      const result = await call('providerConnect', provider.id, key, isOnboarding)
      if (result.connected) {
        setKeyDraft('')
        setExpanded(null)
        if (isOnboarding) onComplete?.()
      } else {
        setConnectErrors((e) => ({ ...e, [provider.id]: lastError() ?? 'That key wasn’t accepted.' }))
      }
    } catch (err) {
      setConnectErrors((e) => ({ ...e, [provider.id]: message(err) }))
    } finally {
      setBusyId(null)
    }
  }

  const disconnect = (provider: ProviderEntry): void => {
    setBusyId(provider.id)
    void call('providerDisconnect', provider.id)
      .then(() => {
        const failure = lastError()
        if (failure !== null) setConnectErrors((e) => ({ ...e, [provider.id]: failure }))
      })
      .catch((err) => setConnectErrors((e) => ({ ...e, [provider.id]: message(err) })))
      .finally(() => setBusyId(null))
  }

  const signOut = (): void => {
    void call('accountLogout')
  }

  const content = (
    <>
      <div className="modal-head">
        <div className="modal-head-texts">
          <span className="modal-title">{isOnboarding ? 'Connect a model' : 'Providers'}</span>
          <span className="modal-subtitle">
            {isOnboarding
              ? 'Spettro needs one model provider to get started.'
              : 'Sign in, add an API key, or attach a local server.'}
          </span>
        </div>
        <div className="modal-actions">
          {models.models.length > 0 && (
            <button className="btn" onClick={() => setShowModels(true)}>
              Models…
            </button>
          )}
          {isOnboarding
            ? onSkip && (
                <button
                  className="btn"
                  onClick={onSkip}
                  title="Open the app anyway. You can connect a provider later from Settings."
                >
                  Continue Without
                </button>
              )
            : onClose && (
                <button className="btn btn--prominent" onClick={onClose}>
                  Done
                </button>
              )}
        </div>
      </div>

      <div className="divider" />

      <div className="form-scroll">
        {ext.unsupported && <UnsupportedCLINotice />}

        {/* A failed load leaves the lists empty with nothing to explain it —
            the one case where the store's last error is worth showing. */}
        {ext.error !== null && ext.error !== '' && providers.providers.length === 0 && (
          <div className="notice">
            <span className="notice-icon notice-icon--warn">
              <WarningTriangleIcon size={14} />
            </span>
            <div className="notice-texts">
              <span className="notice-title">Couldn&rsquo;t read your providers</span>
              <span className="notice-sub">{ext.error}</span>
            </div>
            <button className="btn btn--small" onClick={() => void call('refreshExtensions')}>
              Retry
            </button>
          </div>
        )}

        {/* ------------------------------------------------ subscription */}
        <section className="form-section">
          <div className="form-section-title">Spettro Subscription</div>
          <div className="form-card">
            <div className="prov-row prov-row--lead">
              <span className={`prov-icon ${account.signedIn ? 'prov-icon--accent' : ''}`}>
                {account.signedIn ? <CheckSealIcon size={22} /> : <PersonIcon size={22} />}
              </span>
              <div className="prov-texts">
                {account.signedIn ? (
                  <>
                    <span className="prov-title-line">
                      <span className="prov-name">{account.email ?? 'Signed in'}</span>
                      <PlanBadge plan={badgePlan(account)} size={10} />
                    </span>
                    <span className="prov-sub">
                      {providers.subscription.modelCount} models on your plan
                    </span>
                  </>
                ) : (
                  <>
                    <span className="prov-name">Use Spettro&rsquo;s models with no API keys</span>
                    <span className="prov-sub">Inference credits included with your plan</span>
                  </>
                )}
              </div>
              {account.signedIn ? (
                <button className="btn btn--small" onClick={signOut}>
                  Sign Out
                </button>
              ) : (
                <button className="btn btn--small btn--prominent" onClick={() => setShowSignIn(true)}>
                  Sign In
                </button>
              )}
            </div>
          </div>
        </section>

        {/* ----------------------------------------------- local servers */}
        <section className="form-section">
          <div className="form-section-title">Local servers</div>
          <div className="form-card">
            {providers.local.length === 0 ? (
              <div className="prov-row">
                <span className="form-text">
                  Run models on this machine with LM Studio, Ollama, or llama.cpp.
                </span>
              </div>
            ) : (
              providers.local.map((endpoint) => (
                <div className="prov-row" key={endpoint.endpoint}>
                  <span className="prov-icon">
                    <DesktopIcon size={16} />
                  </span>
                  <div className="prov-texts">
                    <span className="prov-name">{endpoint.name}</span>
                    <span className="prov-sub">
                      {shortHost(endpoint.endpoint)} · {endpoint.modelCount} models
                    </span>
                  </div>
                  <button
                    className="btn btn--small"
                    onClick={() => void call('localEndpointRemove', endpoint.endpoint)}
                  >
                    Remove
                  </button>
                </div>
              ))
            )}
            <div className="prov-row prov-row--actions">
              <button className="btn btn--small" onClick={() => setShowAddLocal(true)}>
                Add Local Server…
              </button>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------- API providers */}
        <section className="form-section">
          <div className="form-section-title">API providers</div>
          <div className="form-card">
            <div className="prov-row prov-row--search">
              <input
                className="input"
                type="search"
                placeholder="Search providers"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {filtered.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                isExpanded={expanded === provider.id}
                keyDraft={keyDraft}
                setKeyDraft={setKeyDraft}
                error={connectErrors[provider.id] ?? null}
                isBusy={busyId === provider.id}
                onToggle={() => {
                  setKeyDraft('')
                  setExpanded((current) => (current === provider.id ? null : provider.id))
                }}
                onConnect={() => void connect(provider)}
                onDisconnect={() => disconnect(provider)}
              />
            ))}
            {filtered.length === 0 && (
              <div className="prov-row">
                <span className="form-text">
                  {providers.providers.length === 0
                    ? 'The agent advertised no API providers.'
                    : `No provider matches “${search}”.`}
                </span>
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  )

  return (
    <>
      {presentation === 'gate' ? (
        <div className="provider-gate">
          <div className="provider-gate-inner">{content}</div>
        </div>
      ) : (
        <div className="modal-backdrop modal-backdrop--stacked" role="presentation">
          <div
            className="modal-panel modal-panel--providers"
            role="dialog"
            aria-modal="true"
            aria-label="Providers"
          >
            {content}
          </div>
        </div>
      )}

      {showSignIn && (
        <SignInView
          stacked
          onClose={() => setShowSignIn(false)}
          onComplete={() => {
            void call('refreshExtensions')
            if (isOnboarding) onComplete?.()
          }}
        />
      )}
      {showAddLocal && (
        <AddLocalEndpointView
          onClose={() => setShowAddLocal(false)}
          onAdded={() => {
            if (isOnboarding) onComplete?.()
          }}
        />
      )}
      {showModels && <ModelPickerView onClose={() => setShowModels(false)} />}
    </>
  )
}

// ---------------------------------------------------------------------------
// Provider row
// ---------------------------------------------------------------------------

function ProviderRow({
  provider,
  isExpanded,
  keyDraft,
  setKeyDraft,
  error,
  isBusy,
  onToggle,
  onConnect,
  onDisconnect
}: {
  provider: ProviderEntry
  isExpanded: boolean
  keyDraft: string
  setKeyDraft: (value: string) => void
  error: string | null
  isBusy: boolean
  onToggle: () => void
  onConnect: () => void
  onDisconnect: () => void
}): JSX.Element {
  return (
    <div className="prov-row prov-row--stack">
      <div className="prov-line">
        <span className={`prov-icon ${provider.connected ? 'prov-icon--connected' : ''}`}>
          {provider.connected ? <CheckSealIcon size={15} /> : <KeyIcon size={15} />}
        </span>
        <div className="prov-texts">
          <span className="prov-title-line">
            <span className="prov-name">{provider.name}</span>
            {provider.suggested && !provider.connected && <span className="prov-pill">popular</span>}
          </span>
          {provider.modelCount > 0 && <span className="prov-sub">{provider.modelCount} models</span>}
        </div>
        {provider.connected ? (
          <button className="btn btn--small" onClick={onDisconnect} disabled={isBusy}>
            Disconnect
          </button>
        ) : (
          <button className="btn btn--small" onClick={onToggle}>
            {isExpanded ? 'Cancel' : 'Connect'}
          </button>
        )}
      </div>

      {isExpanded && !provider.connected && (
        <div className="prov-key">
          <div className="prov-key-line">
            {/* A password field so a shoulder-surfer or a screen share doesn't
                capture the key while it's typed. */}
            <input
              className="input"
              type="password"
              autoFocus
              placeholder={`Paste your ${provider.name} API key`}
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.stopPropagation()
                  onConnect()
                }
              }}
            />
            {isBusy ? (
              <Spinner size={14} />
            ) : (
              <button
                className="btn btn--small btn--prominent"
                disabled={keyDraft.trim() === ''}
                onClick={onConnect}
              >
                Save
              </button>
            )}
          </div>
          {provider.envKey && (
            <span className="prov-hint">
              Verified before it&rsquo;s saved, then stored encrypted. You can also set{' '}
              <code>{provider.envKey}</code> in your environment.
            </span>
          )}
          {error !== null && error !== '' && <span className="form-error">{error}</span>}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Unsupported CLI
// ---------------------------------------------------------------------------

export function UnsupportedCLINotice(): JSX.Element {
  return (
    <div className="notice">
      <span className="notice-icon notice-icon--warn">
        <WarningTriangleIcon size={14} />
      </span>
      <div className="notice-texts">
        <span className="notice-title">Your Spettro CLI is out of date</span>
        <span className="notice-sub">
          Signing in and managing providers from the app needs a newer CLI. Update it, then
          reconnect.
        </span>
      </div>
    </div>
  )
}

export function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+':\s*/, '')
}

/** The store's last error, read straight after a mutating call: the main
 *  process swallows most failures into `extensions.error` rather than
 *  rejecting, and pushes the new state before the call resolves. */
export function lastError(): string | null {
  const error = getState().app?.extensions?.error ?? null
  return error === null || error === '' ? null : error
}

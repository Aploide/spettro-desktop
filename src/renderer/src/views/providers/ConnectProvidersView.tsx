// Port of Spettro/Views/Providers/ConnectProvidersView.swift — the app's
// `/connect`: sign in to a subscription, paste a provider API key, or attach a
// local OpenAI-compatible server.
//
// Keys are verified against the provider's own API by the CLI before they are
// stored (encrypted, in ~/.spettro/keys.enc), so a rejected key never gets
// written. Nothing entered here is persisted by the app — `providerConnect`
// posts the key and the app never reads one back.
//
// This is the sheet opened from Settings › Models & Providers. First-run setup
// (OnboardingView's connect step) leads with "Sign in" and reuses the key list
// below, ProviderKeyList, for "Use my own API key".
//
// Everything that takes a way of running models away asks first: signing
// out, removing a local server, disconnecting a provider — and disconnecting
// the only one says that Spettro won't be able to answer until another is
// connected.

import { useEffect, useMemo, useState } from 'react'
import type { ExtensionsState, ProviderEntry } from '@shared/extensions'
import { EMPTY_EXTENSIONS, connectedCount, shortHost } from '@shared/extensions'
import { humanizeError } from '@shared/humanize'
import { call, getState, quietCall, useApp } from '@renderer/state/store'
import { confirmDialog } from '@renderer/views/common/ConfirmDialog'
import { updateEngine } from '@renderer/views/shell/actions'
import PlanBadge from '@renderer/views/shell/PlanBadge'
import Spinner from '@renderer/views/shell/Spinner'
import SignInView from '@renderer/views/account/SignInView'
import AddLocalEndpointView from './AddLocalEndpointView'
import ModelPickerView from './ModelPickerView'
import { badgePlan, CheckSealIcon, DesktopIcon, KeyIcon, PersonIcon, WarningTriangleIcon } from './icons'
import '@renderer/design/form.css'
import './providers.css'

/** Where each well-known provider hands out API keys — the "Get a key" link,
 *  so someone without one isn't left at a password field they can't fill. */
const KEY_PAGES: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  google: 'https://aistudio.google.com/apikey',
  gemini: 'https://aistudio.google.com/apikey',
  openrouter: 'https://openrouter.ai/settings/keys',
  groq: 'https://console.groq.com/keys',
  mistral: 'https://console.mistral.ai/api-keys',
  deepseek: 'https://platform.deepseek.com/api_keys',
  xai: 'https://console.x.ai',
  together: 'https://api.together.ai/settings/api-keys',
  togetherai: 'https://api.together.ai/settings/api-keys',
  fireworks: 'https://fireworks.ai/account/api-keys',
  'fireworks-ai': 'https://fireworks.ai/account/api-keys',
  cerebras: 'https://cloud.cerebras.ai/platform',
  perplexity: 'https://www.perplexity.ai/settings/api',
  cohere: 'https://dashboard.cohere.com/api-keys',
  moonshotai: 'https://platform.moonshot.ai/console/api-keys',
  zai: 'https://z.ai/manage-apikey/apikey-list',
  huggingface: 'https://huggingface.co/settings/tokens',
  'github-models': 'https://github.com/settings/tokens'
}

export function providerKeyPage(id: string): string | null {
  return KEY_PAGES[id.toLowerCase()] ?? null
}

/** "Disconnect Anthropic?" — and, when it is the last way to run a model,
 *  that Spettro won't answer until another is connected. */
async function confirmRemoval(what: string, verb: string, ext: ExtensionsState): Promise<boolean> {
  const last = connectedCount(ext.providers) <= 1
  const answer = await confirmDialog({
    title: `${verb} ${what}?`,
    message: last
      ? `This is the only way Spettro can run a model right now. Until you connect another, Spettro won’t be able to answer.`
      : `Sessions using its models will need another model.`,
    confirmLabel: verb,
    destructive: true
  })
  return answer === 'confirm'
}

/** Sign Out, asked first — from the sheet, Settings › Account, or setup. */
export async function signOutWithConfirm(): Promise<void> {
  const ext = getState().app?.extensions ?? EMPTY_EXTENSIONS
  const last = connectedCount(ext.providers) <= 1 && ext.providers.subscription.connected
  const answer = await confirmDialog({
    title: 'Sign out of Spettro?',
    message: last
      ? 'Your Spettro account is the only way Spettro can run a model right now. Until you sign in again or connect a provider, it won’t be able to answer.'
      : 'Sessions using Spettro’s own models will need another model.',
    confirmLabel: 'Sign Out',
    destructive: true
  })
  if (answer === 'confirm') await call('accountLogout')
}

interface Props {
  onClose: () => void
}

export default function ConnectProvidersView({ onClose }: Props): JSX.Element {
  const app = useApp()
  const ext = app?.extensions ?? EMPTY_EXTENSIONS
  const { account, providers, models } = ext

  const [showSignIn, setShowSignIn] = useState(false)
  const [showAddLocal, setShowAddLocal] = useState(false)
  const [showModels, setShowModels] = useState(false)

  // `.task { await providers.refresh() }`
  useEffect(() => {
    void quietCall('refreshExtensions')
  }, [])

  const removeLocal = async (endpoint: string, name: string): Promise<void> => {
    if (await confirmRemoval(name, 'Remove', getState().app?.extensions ?? ext)) {
      await call('localEndpointRemove', endpoint)
    }
  }

  return (
    <>
      <div className="modal-backdrop modal-backdrop--stacked" role="presentation">
        <div className="modal-panel modal-panel--providers" role="dialog" aria-modal="true" aria-label="Providers">
          <div className="modal-head">
            <div className="modal-head-texts">
              <span className="modal-title">Models &amp; Providers</span>
              <span className="modal-subtitle">Sign in, add an API key, or use a model on this computer.</span>
            </div>
            <div className="modal-actions">
              {models.models.length > 0 && (
                <button className="btn" onClick={() => setShowModels(true)}>
                  Browse Models…
                </button>
              )}
              <button className="btn btn--prominent" onClick={onClose}>
                Done
              </button>
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
                  <span className="notice-title">Couldn&rsquo;t load your providers</span>
                  <span className="notice-sub">{humanizeError(ext.error).detail}</span>
                </div>
                <button className="btn btn--small" onClick={() => void call('refreshExtensions')}>
                  Try Again
                </button>
              </div>
            )}

            {/* ------------------------------------------------ subscription */}
            <section className="form-section">
              <div className="form-section-title">Spettro account</div>
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
                        <span className="prov-sub">{providers.subscription.modelCount} models on your plan</span>
                      </>
                    ) : (
                      <>
                        <span className="prov-name">Use Spettro&rsquo;s models with no API keys</span>
                        <span className="prov-sub">Credits are included with your plan</span>
                      </>
                    )}
                  </div>
                  {account.signedIn ? (
                    <button className="btn btn--small" onClick={() => void signOutWithConfirm()}>
                      Sign Out…
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
              <div className="form-section-title">Models on this computer</div>
              <div className="form-card">
                {providers.local.length === 0 ? (
                  <div className="prov-row">
                    <span className="form-text">Run models privately with LM Studio, Ollama, or llama.cpp.</span>
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
                        onClick={() => void removeLocal(endpoint.endpoint, endpoint.name)}
                      >
                        Remove…
                      </button>
                    </div>
                  ))
                )}
                <div className="prov-row prov-row--actions">
                  <button className="btn btn--small" onClick={() => setShowAddLocal(true)}>
                    Add a Model on This Computer…
                  </button>
                </div>
              </div>
            </section>

            {/* ---------------------------------------------- API providers */}
            <section className="form-section">
              <div className="form-section-title">API keys</div>
              <div className="form-card">
                <ProviderKeyList />
              </div>
            </section>
          </div>
        </div>
      </div>

      {showSignIn && (
        <SignInView stacked onClose={() => setShowSignIn(false)} onComplete={() => void call('refreshExtensions')} />
      )}
      {showAddLocal && <AddLocalEndpointView onClose={() => setShowAddLocal(false)} />}
      {showModels && <ModelPickerView onClose={() => setShowModels(false)} />}
    </>
  )
}

// ---------------------------------------------------------------------------
// The API-key list
// ---------------------------------------------------------------------------

/**
 * Every API provider the CLI knows, searchable, each with Connect (paste a
 * key, verified before it's saved) or Disconnect, and a "Get a key" link to
 * the provider's console. `activate` makes the first model of a newly
 * connected provider the active one — what setup wants, so the first
 * message just works.
 */
export function ProviderKeyList({
  activate = false,
  onConnected
}: {
  activate?: boolean
  onConnected?: () => void
}): JSX.Element {
  const app = useApp()
  const ext = app?.extensions ?? EMPTY_EXTENSIONS
  const { providers } = ext
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [connectErrors, setConnectErrors] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    // Popular ones first, the way people look for them.
    const list = [...providers.providers].sort((a, b) => Number(b.suggested) - Number(a.suggested))
    if (query === '') return list
    return list.filter((p) => p.id.toLowerCase().includes(query) || p.name.toLowerCase().includes(query))
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
      const result = await quietCall('providerConnect', provider.id, key, activate)
      if (result.connected) {
        setKeyDraft('')
        setExpanded(null)
        onConnected?.()
      } else {
        setConnectErrors((e) => ({ ...e, [provider.id]: keyError(lastError()) }))
      }
    } catch (err) {
      setConnectErrors((e) => ({ ...e, [provider.id]: keyError(err) }))
    } finally {
      setBusyId(null)
    }
  }

  const disconnect = async (provider: ProviderEntry): Promise<void> => {
    if (!(await confirmRemoval(provider.name, 'Disconnect', getState().app?.extensions ?? ext))) return
    setBusyId(provider.id)
    try {
      await quietCall('providerDisconnect', provider.id)
      const failure = lastError()
      if (failure !== null) setConnectErrors((e) => ({ ...e, [provider.id]: keyError(failure) }))
    } catch (err) {
      setConnectErrors((e) => ({ ...e, [provider.id]: keyError(err) }))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <div className="prov-row prov-row--search">
        <input
          className="input"
          type="search"
          placeholder="Search providers"
          aria-label="Search providers"
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
          onDisconnect={() => void disconnect(provider)}
        />
      ))}
      {filtered.length === 0 && (
        <div className="prov-row">
          <span className="form-text">
            {providers.providers.length === 0
              ? 'No providers to show yet. Spettro may still be starting.'
              : `No provider matches “${search}”.`}
          </span>
        </div>
      )}
    </>
  )
}

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
  const keyPage = providerKeyPage(provider.id)
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
          {provider.connected && provider.modelCount > 0 && (
            <span className="prov-sub">{provider.modelCount} models</span>
          )}
        </div>
        {provider.connected ? (
          <button className="btn btn--small" onClick={onDisconnect} disabled={isBusy}>
            Disconnect…
          </button>
        ) : (
          <button className="btn btn--small" onClick={onToggle} aria-expanded={isExpanded}>
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
              aria-label={`${provider.name} API key`}
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
              <button className="btn btn--small btn--prominent" disabled={keyDraft.trim() === ''} onClick={onConnect}>
                Connect
              </button>
            )}
          </div>
          <span className="prov-hint">
            {keyPage ? (
              <>
                Don&rsquo;t have one?{' '}
                <button className="link" onClick={() => void quietCall('openExternal', keyPage)}>
                  Get a {provider.name} key
                </button>
                . Spettro checks it, then stores it encrypted on this computer.
              </>
            ) : (
              <>Spettro checks the key, then stores it encrypted on this computer.</>
            )}
          </span>
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
        <span className="notice-title">Spettro needs an update</span>
        <span className="notice-sub">
          Signing in and managing providers here needs a newer version of Spettro&rsquo;s engine.
        </span>
      </div>
      <button className="btn btn--small" onClick={() => void updateEngine()}>
        Update
      </button>
    </div>
  )
}

/** A key's failure, said beside the key: a rejection is about the key in
 *  the field (not "go to Settings", which is where this already is). */
function keyError(err: unknown): string {
  if (err === null || err === undefined) return 'That key wasn’t accepted. Check it and try again.'
  const human = humanizeError(err)
  if (human.action?.kind === 'connect') return 'That key wasn’t accepted. Check it and try again.'
  return human.known ? `${human.title}. ${human.detail}` : human.detail
}

/** The store's last error, read straight after a mutating call: the main
 *  process swallows most failures into `extensions.error` rather than
 *  rejecting, and pushes the new state before the call resolves. */
export function lastError(): string | null {
  const error = getState().app?.extensions?.error ?? null
  return error === null || error === '' ? null : error
}

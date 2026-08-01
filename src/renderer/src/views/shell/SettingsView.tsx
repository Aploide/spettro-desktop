// Port of Platforms/macOS/Views/SettingsView.swift (docs 29-settings.md): a
// fixed 580x520 sheet with a segmented pane picker and, in each pane, a
// grouped Form — a section caption above a rounded inset card, rows sharing
// one label column with their values right-aligned, hairlines between rows,
// and a caption underneath. Those metrics live in design/form.css; the Swift
// gets them free from `.formStyle(.grouped)`, and reproducing them is what
// stops the sheet reading as a handful of boxes floating in dead space.
//
// Deviations forced by the platform:
// - "Choose Executable…" is a typed-path field: the IPC contract exposes a
//   folder picker only, and `useExplicitCLIPath` validates and banners on a
//   bad path exactly like the Swift override flow.
// - Remote access, a separate sheet on macOS, is also reachable here as a
//   fifth pane embedding RemoteAccessView (a desktop-port addition).
//
// Everything account/provider related is live: the panes read `extensions`
// (the mirrored AccountStore + ProviderStore) and drive the `_spettro/*`
// surface through the IPC methods.

import { useEffect, useState } from 'react'
import { EMPTY_EXTENSIONS, creditDetail, remainingFraction, shortHost } from '@shared/extensions'
import { call, useApp } from '@renderer/state/store'
import MemoryView from '@renderer/views/sheets/MemoryView'
import RemoteAccessView from '@renderer/views/remote/RemoteAccessView'
import ConnectProvidersView, {
  UnsupportedCLINotice
} from '@renderer/views/providers/ConnectProvidersView'
import ModelPickerView from '@renderer/views/providers/ModelPickerView'
import SignInView from '@renderer/views/account/SignInView'
import { badgePlan, WarningTriangleIcon } from '@renderer/views/providers/icons'
import PlanBadge from './PlanBadge'
import Spinner from './Spinner'
import { defaultProjectPath } from './util'
import '@renderer/design/form.css'

export type SettingsPane = 'account' | 'agent' | 'providers' | 'memory' | 'remote'

const PANES: { id: SettingsPane; label: string }[] = [
  { id: 'account', label: 'Account' },
  { id: 'agent', label: 'Agent' },
  { id: 'providers', label: 'Providers' },
  { id: 'memory', label: 'Memory' },
  { id: 'remote', label: 'Remote' }
]

const DASHBOARD_URL = 'https://spettro.app/dashboard'
const PRICING_FALLBACK = 'https://spettro.app/pricing'

interface Props {
  initialPane?: SettingsPane
  onClose: () => void
}

export default function SettingsView({ initialPane = 'account', onClose }: Props): JSX.Element {
  const app = useApp()
  const [pane, setPane] = useState<SettingsPane>(initialPane)
  const [showSignIn, setShowSignIn] = useState(false)
  const [showConnect, setShowConnect] = useState(false)
  const [showModels, setShowModels] = useState(false)
  const version = app?.agentVersion ?? app?.cli?.version ?? null

  // Credits and plan are a snapshot from when the agent connected; opening
  // Settings is exactly when they need to be current (the Swift's
  // `.task { await account.refresh() }`).
  useEffect(() => {
    void call('refreshExtensions')
  }, [])

  return (
    <>
      <div className="modal-backdrop" role="presentation">
        <div
          className="modal-panel modal-panel--settings"
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) onClose()
          }}
        >
          <div className="settings-panes">
            <div className="segmented" role="tablist">
              {PANES.map((p) => (
                <button
                  key={p.id}
                  role="tab"
                  aria-selected={pane === p.id}
                  className={pane === p.id ? 'active' : ''}
                  onClick={() => setPane(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="divider" />

          <div className="settings-body">
            {pane === 'account' && <AccountPane onSignIn={() => setShowSignIn(true)} />}
            {pane === 'agent' && <AgentPane />}
            {pane === 'providers' && (
              <ProvidersPane
                onManage={() => setShowConnect(true)}
                onBrowseModels={() => setShowModels(true)}
              />
            )}
            {pane === 'memory' && (
              // MemoryView is a standalone screen that presents its own
              // backdrop; `.pane-embed` confines it to the pane, which is what
              // `memoryTab` does in the Swift by embedding rather than
              // presenting it.
              <div className="pane-embed">
                <MemoryView
                  projectPath={app ? (defaultProjectPath(app) ?? null) : null}
                  onClose={onClose}
                />
              </div>
            )}
            {pane === 'remote' && (
              <div className="pane-scroll">
                <RemoteAccessView />
              </div>
            )}
          </div>

          <div className="divider" />

          <div className="modal-foot">
            <span className="settings-version">{version ? `spettro ${version}` : ''}</span>
            <button className="btn btn--prominent" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>

      {showSignIn && (
        <SignInView
          stacked
          onClose={() => setShowSignIn(false)}
          onComplete={() => void call('refreshExtensions')}
        />
      )}
      {showConnect && <ConnectProvidersView onClose={() => setShowConnect(false)} />}
      {showModels && <ModelPickerView onClose={() => setShowModels(false)} />}
    </>
  )
}

// ---------------------------------------------------------------- account

function AccountPane({ onSignIn }: { onSignIn: () => void }): JSX.Element {
  const app = useApp()
  const ext = app?.extensions ?? EMPTY_EXTENSIONS
  const account = ext.account
  const remaining = remainingFraction(account)
  const planStatus = account.planStatus ?? ''
  const showStatus = planStatus !== '' && planStatus !== 'active'

  if (!account.signedIn) {
    return (
      <div className="form-scroll">
        {ext.unsupported && <UnsupportedCLINotice />}
        <section className="form-section">
          <div className="form-section-title">Spettro Subscription</div>
          <div className="form-card">
            <div className="form-row form-row--stack">
              <span className="form-text">
                Sign in to use Spettro&rsquo;s own models without configuring API keys.
              </span>
              <div className="form-inline">
                <button className="btn btn--prominent" onClick={onSignIn}>
                  Sign In…
                </button>
                <span className="form-spacer" />
                <button
                  className="link"
                  onClick={() => void call('openExternal', account.pricingUrl ?? PRICING_FALLBACK)}
                >
                  See plans
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="form-scroll">
      {ext.unsupported && <UnsupportedCLINotice />}

      <section className="form-section">
        <div className="form-section-title">Subscription</div>
        <div className="form-card">
          {account.email !== null && (
            <div className="form-row">
              <span className="form-label">Email</span>
              <span className="form-value form-value--primary">{account.email}</span>
            </div>
          )}

          <div className="form-row">
            <span className="form-label">Plan</span>
            <span className="form-value">
              <PlanBadge plan={badgePlan(account)} size={12} />
              {showStatus && <span className="plan-status">{planStatus}</span>}
            </span>
          </div>

          {remaining !== null && (
            <div className="form-row">
              <span className="form-label">Credits</span>
              <span className="form-value">
                <CreditMeter remaining={remaining} detail={creditDetail(account)} />
              </span>
            </div>
          )}

          {account.stale && (
            <div className="form-row">
              <span className="form-note">
                <span className="form-note-icon">
                  <WarningTriangleIcon size={12} />
                </span>
                Showing the last known plan — the Spettro service couldn&rsquo;t be reached.
              </span>
            </div>
          )}
        </div>
      </section>

      <section className="form-section">
        <div className="form-card">
          <div className="form-row form-row--actions">
            <button className="btn" onClick={() => void call('accountLogout')}>
              Sign Out
            </button>
            {ext.busy && <Spinner size={14} />}
            <span className="form-spacer" />
            <button className="link" onClick={() => void call('openExternal', DASHBOARD_URL)}>
              Manage subscription
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

/** CreditMeter in SettingsView.swift: how much of the monthly credit budget is
 *  left as a share rather than a raw balance — the absolute number means
 *  nothing without the plan's limit, and the limit changes per tier. The exact
 *  figures stay available on hover. */
function CreditMeter({
  remaining,
  detail
}: {
  remaining: number
  detail: string | null
}): JSX.Element {
  // Never round a non-empty balance down to a flat 0%.
  const percent = remaining > 0 ? Math.max(1, Math.round(remaining * 100)) : 0
  const level = remaining < 0.1 ? 'critical' : remaining < 0.25 ? 'low' : 'ok'
  const fill = level === 'critical' ? ' credit-fill--critical' : level === 'low' ? ' credit-fill--low' : ''

  return (
    <span
      className="credit-meter"
      title={detail ?? 'Credits remaining on your plan'}
      aria-label={`${percent} percent of credits remaining`}
    >
      <span className="credit-track">
        <span
          className={`credit-fill${fill}`}
          style={{ width: `${Math.min(100, Math.max(0, remaining * 100))}%` }}
        />
      </span>
      <span className={`credit-label${level === 'critical' ? ' credit-label--critical' : ''}`}>
        {percent}% left
      </span>
    </span>
  )
}

// ------------------------------------------------------------------ agent

function AgentPane(): JSX.Element {
  const app = useApp()
  const [showPathEditor, setShowPathEditor] = useState(false)
  const [pathDraft, setPathDraft] = useState('')

  const cliPath = app?.cli ? `${app.cli.path}${app.cli.isDev ? ' (dev)' : ''}` : 'Not found'
  const projectPath = app ? (defaultProjectPath(app) ?? null) : null

  const useExplicitPath = (): void => {
    const trimmed = pathDraft.trim()
    if (trimmed === '') return
    void call('useExplicitCLIPath', trimmed)
    setShowPathEditor(false)
    setPathDraft('')
  }

  /** The NSOpenPanel port: a native file picker rooted at ~/.local/bin. The
   *  typed-path field stays as the fallback when the dialog is dismissed
   *  without a choice on a system with no portal. */
  const chooseExecutable = async (): Promise<void> => {
    const path = await call('pickExecutable')
    if (path) {
      void call('useExplicitCLIPath', path)
      setShowPathEditor(false)
      setPathDraft('')
    } else {
      setShowPathEditor((s) => !s)
    }
  }

  const changeProjectFolder = async (): Promise<void> => {
    const path = await call('pickFolder')
    if (path) await call('chooseProject', path)
  }

  return (
    <div className="form-scroll">
      <section className="form-section">
        <div className="form-section-title">Spettro CLI</div>
        <div className="form-card">
          <div className="form-row">
            <span className="form-label">Executable</span>
            {/* Truncated from the head, so the binary's name stays visible. */}
            <span
              className="form-value path-value"
              title={app?.cli?.path ?? 'No Spettro CLI was found.'}
            >
              {cliPath}
            </span>
          </div>
          <div className="form-row">
            <span className="form-label">Version</span>
            <span className="form-value">{app?.agentVersion ?? 'unknown'}</span>
          </div>
          <div className="form-row form-row--actions">
            <button className="btn" onClick={() => void chooseExecutable()}>
              Choose Executable…
            </button>
            {/* Forced: stops the running agent and starts a new one. */}
            <button className="btn" onClick={() => void call('retryBootstrap')}>
              Reconnect
            </button>
          </div>
          {showPathEditor && (
            <div className="form-row form-row--stack">
              <div className="path-input-row">
                <input
                  className="text-input"
                  type="text"
                  placeholder="/home/you/.local/bin/spettro"
                  value={pathDraft}
                  autoFocus
                  onChange={(e) => setPathDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.stopPropagation()
                      useExplicitPath()
                    }
                  }}
                />
                <button className="btn" disabled={pathDraft.trim() === ''} onClick={useExplicitPath}>
                  Use
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="form-footer">The app drives this binary over the Agent Client Protocol.</div>
      </section>

      <section className="form-section">
        <div className="form-section-title">Projects</div>
        <div className="form-card">
          <div className="form-row">
            <span className="form-label">Default folder</span>
            <span className="form-value path-value" title={projectPath ?? undefined}>
              {projectPath ?? 'Home folder'}
            </span>
          </div>
          <div className="form-row form-row--actions">
            <button className="btn" onClick={() => void changeProjectFolder()}>
              Change Project Folder…
            </button>
          </div>
        </div>
        <div className="form-footer">Where new chats open when you don&rsquo;t pick a folder.</div>
      </section>
    </div>
  )
}

// -------------------------------------------------------------- providers

function ProvidersPane({
  onManage,
  onBrowseModels
}: {
  onManage: () => void
  onBrowseModels: () => void
}): JSX.Element {
  const app = useApp()
  const ext = app?.extensions ?? EMPTY_EXTENSIONS
  const { providers, models } = ext

  // One row per connected provider, local server, and the subscription.
  const entries: { name: string; detail: string }[] = [
    ...providers.providers
      .filter((p) => p.connected)
      .map((p) => ({ name: p.name, detail: `${p.modelCount} models` })),
    ...providers.local.map((l) => ({
      name: l.name,
      detail: `${shortHost(l.endpoint)} · ${l.modelCount} models`
    })),
    ...(providers.subscription.connected
      ? [{ name: 'Spettro Subscription', detail: `${providers.subscription.modelCount} models` }]
      : [])
  ]

  return (
    <div className="form-scroll">
      {ext.unsupported && <UnsupportedCLINotice />}

      <section className="form-section">
        <div className="form-section-title">Connected</div>
        <div className="form-card">
          {entries.length === 0 ? (
            <div className="form-row">
              <span className="form-warning">
                <span className="form-note-icon">
                  <WarningTriangleIcon size={13} />
                </span>
                No provider is connected — Spettro can&rsquo;t answer a prompt until one is.
              </span>
            </div>
          ) : (
            entries.map((entry) => (
              <div className="form-row form-row--entry" key={`${entry.name}:${entry.detail}`}>
                <span className="form-label">{entry.name}</span>
                <span className="form-value">{entry.detail}</span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="form-section">
        <div className="form-card">
          <div className="form-row">
            <span className="form-label">Active model</span>
            <span className={`form-value${models.activeModel !== null ? ' form-value--primary' : ''}`}>
              {models.activeModel ?? 'None selected'}
            </span>
          </div>
          <div className="form-row form-row--actions">
            <button className="btn btn--prominent" onClick={onManage}>
              Manage Providers…
            </button>
            {models.models.length > 0 && (
              <button className="btn" onClick={onBrowseModels}>
                Browse Models…
              </button>
            )}
          </div>
        </div>
        <div className="form-footer">
          Keys are verified by the Spettro CLI and stored encrypted on this machine — the app never
          reads one back.
        </div>
      </section>
    </div>
  )
}

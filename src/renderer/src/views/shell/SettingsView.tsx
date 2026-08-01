// Port of SettingsView.swift (per docs/29-settings.md): a fixed 580x520 sheet
// with a segmented pane picker — Account, Agent, Providers, Memory, Remote —
// a footer carrying the agent version and the Done button (Enter dismisses).
//
// Deviations forced by the platform:
// - "Choose Executable…" is a typed-path field (the bridge has no file picker;
//   useExplicitCLIPath validates and banners on a bad path, exactly like the
//   Swift override flow).
// - The Providers pane is informational only: providers, models, and API keys
//   are owned by the CLI and no provider state crosses the IPC contract, so it
//   renders a "managed by the CLI" card mirroring doc 29's caption.
// - Remote access, a separate sheet on macOS, is also reachable here as a pane
//   embedding RemoteAccessView.

import { useState } from 'react'
import { call, useApp } from '@renderer/state/store'
import MemoryView from '@renderer/views/sheets/MemoryView'
import RemoteAccessView from '@renderer/views/remote/RemoteAccessView'
import PlanBadge from './PlanBadge'
import { defaultProjectPath } from './util'

export type SettingsPane = 'account' | 'agent' | 'providers' | 'memory' | 'remote'

const PANES: { id: SettingsPane; label: string }[] = [
  { id: 'account', label: 'Account' },
  { id: 'agent', label: 'Agent' },
  { id: 'providers', label: 'Providers' },
  { id: 'memory', label: 'Memory' },
  { id: 'remote', label: 'Remote' }
]

interface Props {
  initialPane?: SettingsPane
  onClose: () => void
}

export default function SettingsView({ initialPane = 'account', onClose }: Props): JSX.Element {
  const app = useApp()
  const [pane, setPane] = useState<SettingsPane>(initialPane)
  const version = app?.agentVersion ?? app?.cli?.version ?? null

  return (
    <div className="sheet-backdrop">
      <div
        className="sheet-card settings-card"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) onClose()
        }}
      >
        <div className="settings-tabs">
          <div className="segmented">
            {PANES.map((p) => (
              <button key={p.id} className={pane === p.id ? 'active' : ''} onClick={() => setPane(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="divider" />

        <div className="settings-pane">
          {pane === 'account' && <AccountPane />}
          {pane === 'agent' && <AgentPane />}
          {pane === 'providers' && <ProvidersPane />}
          {pane === 'memory' && (
            <MemoryView projectPath={app ? (defaultProjectPath(app) ?? null) : null} onClose={onClose} />
          )}
          {pane === 'remote' && <RemoteAccessView />}
        </div>

        <div className="divider" />

        <div className="sheet-footer">
          <span className="settings-version">{version ? `spettro ${version}` : ''}</span>
          <button className="btn btn--prominent" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- account

function AccountPane(): JSX.Element {
  const app = useApp()
  const subscription = app?.subscription
  const signedIn = subscription?.email != null

  return (
    <div className="form">
      <section>
        <div className="form-section-header">{signedIn ? 'Subscription' : 'Spettro Subscription'}</div>
        <div className="form-card">
          {signedIn ? (
            <>
              <div className="form-row">
                <span className="form-label">Email</span>
                <span className="form-value">{subscription?.email}</span>
              </div>
              <div className="form-row">
                <span className="form-label">Plan</span>
                <PlanBadge plan={subscription?.plan ?? 'unknown'} size={12} />
              </div>
            </>
          ) : (
            <div className="managed-card">
              <span>
                No subscription is linked. Sign in from the CLI — run <code>spettro</code> in a
                terminal and use its <code>/connect</code> command — and the plan appears here.
              </span>
            </div>
          )}
        </div>
      </section>

      <section>
        <div className="form-card">
          <div className="form-row">
            <span className="form-label" />
            <button
              className="link"
              onClick={() => void call('openExternal', 'https://spettro.app/dashboard')}
            >
              Upgrade or manage your subscription
            </button>
          </div>
        </div>
      </section>
    </div>
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
    if (!trimmed) return
    void call('useExplicitCLIPath', trimmed)
    setShowPathEditor(false)
    setPathDraft('')
  }

  const changeProjectFolder = async (): Promise<void> => {
    const path = await call('pickFolder')
    if (path) await call('chooseProject', path)
  }

  return (
    <div className="form">
      <section>
        <div className="form-section-header">Spettro CLI</div>
        <div className="form-card">
          <div className="form-row">
            <span className="form-label">Executable</span>
            <span className="form-value path-value" title={app?.cli?.path ?? 'No Spettro CLI was found.'}>
              {cliPath}
            </span>
          </div>
          <div className="form-row">
            <span className="form-label">Version</span>
            <span className="form-value">{app?.agentVersion ?? 'unknown'}</span>
          </div>
          <div className="form-row form-row--stack">
            <div className="form-buttons">
              <button className="btn" onClick={() => setShowPathEditor((s) => !s)}>
                Choose Executable…
              </button>
              <button className="btn" onClick={() => void call('retryBootstrap')}>
                Reconnect
              </button>
            </div>
            {showPathEditor && (
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
                <button className="btn" disabled={!pathDraft.trim()} onClick={useExplicitPath}>
                  Use
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="form-footer-caption">
          The app drives this binary over the Agent Client Protocol.
        </div>
      </section>

      <section>
        <div className="form-section-header">Projects</div>
        <div className="form-card">
          <div className="form-row">
            <span className="form-label">Default folder</span>
            <span className="form-value path-value" title={projectPath ?? undefined}>
              {projectPath ?? 'Home folder'}
            </span>
          </div>
          <div className="form-row">
            <span className="form-label" />
            <button className="btn" onClick={() => void changeProjectFolder()}>
              Change Project Folder…
            </button>
          </div>
        </div>
        <div className="form-footer-caption">Where new chats open when you don&rsquo;t pick a folder.</div>
      </section>
    </div>
  )
}

// -------------------------------------------------------------- providers

function ProvidersPane(): JSX.Element {
  return (
    <div className="form">
      <section>
        <div className="form-section-header">Providers &amp; Models</div>
        <div className="form-card managed-card">
          <span>
            Models and API keys are managed by the Spettro CLI, not the app. Run{' '}
            <code>spettro</code> in a terminal and use its <code>/connect</code> and{' '}
            <code>/models</code> commands — ACP sessions reuse that stored configuration, and the
            active model can be switched per chat from the toolbar.
          </span>
        </div>
      </section>
    </div>
  )
}

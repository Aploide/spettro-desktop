// Settings, as one window with a sidebar of panes — the shape of macOS System
// Settings and the Claude app's settings — rather than the Swift port's
// segmented strip, which ran out of room at six tabs. Each pane is a grouped
// Form (design/form.css): a caption above a rounded inset card, rows sharing
// one label column, a footer caption underneath.
//
//   General         appearance, default permission, "notify me when done"
//   Account         the Spettro subscription
//   Models & Providers   what can run a model, and the active one
//   Permissions     what each level lets Spettro do, and the default
//   Memory          facts about you / about this project
//   Remote          pairing a phone (formerly its own sheet)
//   Updates         one "up to date / Update now" row; the parts under Details
//   Advanced        where the engine lives, restarting it, the default
//                   folder, resuming a session started in the terminal
//   Keyboard Shortcuts, About
//
// The pane is part of the shell store (openSettings / closeSettings), so the
// sidebar, Ctrl/Cmd+, the menu and a toast's action can all open it on the
// right pane. Leaving a pane with unsaved memory edits asks first (closeGuard);
// Enter no longer closes the window — it presses whatever has focus.

import { useEffect, useState } from 'react'
import type { ACPConfigOption } from '@shared/acp'
import { EMPTY_EXTENSIONS, creditDetail, remainingFraction, shortHost } from '@shared/extensions'
import { diagnosticsText, humanizeError } from '@shared/humanize'
import type { Appearance, CLISessionEntry } from '@shared/model'
import { SHORTCUTS, shortcutText } from '@shared/shortcuts'
import { call, quietCall, useApp, useStore } from '@renderer/state/store'
import { closeSettings, openSettings, type SettingsPane } from '@renderer/state/shell'
import { mayClose } from '@renderer/views/common/closeGuard'
import { CopyButton } from '@renderer/views/common/Disclosure'
import MemoryView from '@renderer/views/sheets/MemoryView'
import RemoteAccessView from '@renderer/views/remote/RemoteAccessView'
import ConnectProvidersView, {
  UnsupportedCLINotice,
  signOutWithConfirm
} from '@renderer/views/providers/ConnectProvidersView'
import ModelPickerView from '@renderer/views/providers/ModelPickerView'
import SignInView from '@renderer/views/account/SignInView'
import { badgePlan, WarningTriangleIcon } from '@renderer/views/providers/icons'
import {
  choicesOf,
  permissionDescription,
  permissionName,
  PERMISSION_ID
} from '@renderer/views/chat/SessionSettingsPopover'
import { Icon, type IconName } from '@renderer/design/icons'
import AppIcon from './AppIcon'
import { ConnectChooser } from './OnboardingView'
import PlanBadge from './PlanBadge'
import Spinner from './Spinner'
import UpdatesPane from './UpdatesPane'
import { restartEngine } from './actions'
import { basename, defaultProjectPath, isMac, relativeTime } from './util'
import '@renderer/design/form.css'

export type { SettingsPane }

export const PANES: { id: SettingsPane; label: string; icon: IconName }[] = [
  { id: 'general', label: 'General', icon: 'gearshape' },
  { id: 'account', label: 'Account', icon: 'person.crop.circle' },
  { id: 'models', label: 'Models & Providers', icon: 'key' },
  { id: 'permissions', label: 'Permissions', icon: 'lock.shield' },
  { id: 'memory', label: 'Memory', icon: 'brain' },
  { id: 'remote', label: 'Remote', icon: 'iphone' },
  { id: 'updates', label: 'Updates', icon: 'arrow.down.circle.fill' },
  { id: 'advanced', label: 'Advanced', icon: 'wrench.and.screwdriver' },
  { id: 'shortcuts', label: 'Keyboard Shortcuts', icon: 'keyboard' },
  { id: 'about', label: 'About', icon: 'info.circle.fill' }
]

const DASHBOARD_URL = 'https://spettro.app/dashboard'
const PRICING_FALLBACK = 'https://spettro.app/pricing'
const WEBSITE = 'https://spettro.app'
const SOURCE = 'https://github.com/aploide/spettro-desktop'

interface Props {
  pane: SettingsPane
  /** Asks the close guard first (App owns it). */
  onClose: () => void
}

export default function SettingsView({ pane, onClose }: Props): JSX.Element {
  const app = useApp()
  const [showSignIn, setShowSignIn] = useState(false)
  const [showConnect, setShowConnect] = useState(false)
  const [showModels, setShowModels] = useState(false)
  const updateAvailable = Boolean(app?.update.app.available || app?.update.cli.available)
  const current = PANES.find((p) => p.id === pane) ?? PANES[0]

  // Credits and plan are a snapshot from when the agent connected; opening
  // Settings is exactly when they need to be current (the Swift's
  // `.task { await account.refresh() }`).
  useEffect(() => {
    void quietCall('refreshExtensions')
  }, [])

  // A pane with unsaved edits (Memory) is asked before it is left.
  const goTo = async (next: SettingsPane): Promise<void> => {
    if (next === pane) return
    if (await mayClose('settings')) openSettings(next)
  }

  return (
    <>
      <div className="modal-backdrop" role="presentation">
        <div className="modal-panel modal-panel--settings" role="dialog" aria-modal="true" aria-label="Settings">
          <nav className="settings-nav" aria-label="Settings">
            <div className="settings-nav-title">Settings</div>
            <div role="tablist" aria-orientation="vertical" className="settings-nav-list">
              {PANES.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="tab"
                  aria-selected={pane === p.id}
                  data-testid={`settings-pane-${p.id}`}
                  className={'settings-nav-item' + (pane === p.id ? ' settings-nav-item--active' : '')}
                  onClick={() => void goTo(p.id)}
                  onKeyDown={(e) => {
                    // ↑/↓ walk the list, the way a sidebar does.
                    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
                    e.preventDefault()
                    const at = PANES.findIndex((x) => x.id === pane)
                    const next = PANES[(at + (e.key === 'ArrowDown' ? 1 : -1) + PANES.length) % PANES.length]
                    void goTo(next.id).then(() =>
                      document.querySelector<HTMLElement>(`[data-testid="settings-pane-${next.id}"]`)?.focus()
                    )
                  }}
                >
                  <span className="settings-nav-icon" aria-hidden>
                    <Icon name={p.icon} size={14} />
                  </span>
                  <span className="settings-nav-label">{p.label}</span>
                  {/* One dot is the whole "you have an update" affordance in
                      here — the sidebar row says it outside. */}
                  {p.id === 'updates' && updateAvailable && <span className="segmented-dot" />}
                </button>
              ))}
            </div>
          </nav>

          <div className="settings-main">
            <header className="settings-head">
              <h2 className="settings-head-title">{current.label}</h2>
              <button type="button" className="btn btn--prominent" onClick={onClose}>
                Done
              </button>
            </header>
            <div className="settings-body" role="tabpanel" aria-label={current.label}>
              {pane === 'general' && <GeneralPane />}
              {pane === 'account' && <AccountPane onSignIn={() => setShowSignIn(true)} />}
              {pane === 'models' && (
                <ModelsPane onManage={() => setShowConnect(true)} onBrowseModels={() => setShowModels(true)} />
              )}
              {pane === 'permissions' && <PermissionsPane />}
              {pane === 'memory' && (
                <div className="settings-pane-fill">
                  <MemoryView projectPath={app ? (defaultProjectPath(app) ?? null) : null} />
                </div>
              )}
              {pane === 'remote' && (
                <div className="pane-scroll">
                  <RemoteAccessView embedded />
                </div>
              )}
              {pane === 'updates' && <UpdatesPane />}
              {pane === 'advanced' && <AdvancedPane />}
              {pane === 'shortcuts' && <ShortcutsPane />}
              {pane === 'about' && <AboutPane />}
            </div>
          </div>
        </div>
      </div>

      {showSignIn && (
        <SignInView stacked onClose={() => setShowSignIn(false)} onComplete={() => void quietCall('refreshExtensions')} />
      )}
      {showConnect && <ConnectProvidersView onClose={() => setShowConnect(false)} />}
      {showModels && (
        <ModelPickerView chatId={app?.selectedSessionId ?? null} onClose={() => setShowModels(false)} />
      )}
    </>
  )
}

// ---------------------------------------------------------------- general

const APPEARANCES: { id: Appearance; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' }
]

/** The permission option Settings edits: the selected chat's, which is the
 *  live one, else what new chats start with. */
function usePermissionOption(): ACPConfigOption | null {
  const app = useApp()
  const selectedId = app?.selectedSessionId ?? null
  const fromChat = useStore((s) =>
    selectedId ? s.chats[selectedId]?.configOptions.find((o) => o.id === PERMISSION_ID) : undefined
  )
  return fromChat ?? app?.defaultConfigOptions.find((o) => o.id === PERMISSION_ID) ?? null
}

/** The permission levels by their short names, for a control too narrow for
 *  "Don’t ask (YOLO)"; the Permissions pane spells each one out. */
const PERMISSION_SHORT: Record<string, string> = {
  'ask-first': 'Ask first',
  restricted: 'Restricted',
  yolo: 'Don’t ask'
}

function GeneralPane(): JSX.Element {
  const app = useApp()
  const current = app?.appearance ?? 'system'
  const permission = usePermissionOption()
  return (
    <div className="form-scroll">
      <section className="form-section">
        <div className="form-section-title">Appearance</div>
        <div className="form-card">
          <div className="form-row">
            <span className="form-label">Theme</span>
            <span className="form-value">
              <Segmented
                label="Theme"
                value={current}
                choices={APPEARANCES.map((a) => ({ value: a.id, label: a.label }))}
                onChange={(id) => void call('setAppearance', id as Appearance)}
              />
            </span>
          </div>
        </div>
        <div className="form-footer">System follows your computer&rsquo;s light or dark setting.</div>
      </section>

      <section className="form-section">
        <div className="form-section-title">Working</div>
        <div className="form-card">
          <div className="form-row">
            <span className="form-label">Permission</span>
            <span className="form-value">
              {permission && permission.kind.type === 'select' ? (
                <Segmented
                  label="Default permission"
                  value={permission.kind.currentValue ?? ''}
                  choices={choicesOf(permission).map((c) => ({
                    value: c.value,
                    label: PERMISSION_SHORT[c.value] ?? permissionName(c),
                    title: permissionDescription(c)
                  }))}
                  onChange={(value) => void call('setDefaultOption', PERMISSION_ID, value)}
                />
              ) : (
                <span className="form-text">Available once Spettro is running</span>
              )}
            </span>
          </div>
          <div className="form-row form-row--entry">
            <span className="form-label">Notify me when Spettro finishes</span>
            <span className="form-value">
              <Toggle
                label="Notify me when Spettro finishes"
                on={app?.notifyWhenDone ?? true}
                onChange={(on) => void call('setNotifyWhenDone', on)}
              />
            </span>
          </div>
        </div>
        <div className="form-footer">
          Spettro keeps the permission level for every session; Permissions explains each one. The
          notification only appears while Spettro&rsquo;s window is in the background.
        </div>
      </section>
    </div>
  )
}

/**
 * A segmented control as a row's value: one radio group, one tab stop, the
 * arrows moving the choice (and the focus) along it the way a native
 * segmented control does. Theme and Permission share it, so the two choices
 * in one pane look like one kind of thing.
 */
function Segmented({
  label,
  value,
  choices,
  onChange
}: {
  label: string
  value: string
  choices: { value: string; label: string; title?: string }[]
  onChange: (value: string) => void
}): JSX.Element {
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>): void => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    e.preventDefault()
    const at = choices.findIndex((c) => c.value === value)
    const next = (at + step + choices.length) % choices.length
    onChange(choices[next].value)
    const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    buttons[next]?.focus()
  }
  // A value none of the choices names (an older CLI's level) still leaves the
  // group reachable by Tab, through its first segment.
  const known = choices.some((c) => c.value === value)
  return (
    <span className="segmented segmented--inline" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {choices.map((c, i) => (
        <button
          key={c.value}
          type="button"
          role="radio"
          aria-checked={value === c.value}
          tabIndex={value === c.value || (!known && i === 0) ? 0 : -1}
          className={value === c.value ? 'active' : ''}
          title={c.title}
          onClick={() => onChange(c.value)}
        >
          {c.label}
        </button>
      ))}
    </span>
  )
}

/** An on/off switch: a real checkbox, drawn as a switch. */
function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }): JSX.Element {
  return (
    <label className="form-toggle">
      <input type="checkbox" role="switch" aria-label={label} checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span className="form-toggle-track" aria-hidden>
        <span className="form-toggle-thumb" />
      </span>
    </label>
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
          <div className="form-section-title">Spettro account</div>
          <div className="form-card">
            <div className="form-row form-row--stack">
              <span className="form-text">
                Sign in to use Spettro&rsquo;s own models, with credits included — no API keys to set up.
              </span>
              <div className="form-inline">
                <button className="btn btn--prominent" onClick={onSignIn}>
                  Sign in…
                </button>
                <span className="form-spacer" />
                <button
                  className="link"
                  onClick={() => void quietCall('openExternal', account.pricingUrl ?? PRICING_FALLBACK)}
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
                Showing your last known plan — Spettro couldn&rsquo;t reach its service.
              </span>
            </div>
          )}
        </div>
      </section>

      <section className="form-section">
        <div className="form-card">
          <div className="form-row form-row--actions">
            <button className="btn" onClick={() => void signOutWithConfirm()}>
              Sign out…
            </button>
            {ext.busy && <Spinner size={14} />}
            <span className="form-spacer" />
            <button className="link" onClick={() => void quietCall('openExternal', DASHBOARD_URL)}>
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
function CreditMeter({ remaining, detail }: { remaining: number; detail: string | null }): JSX.Element {
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
        <span className={`credit-fill${fill}`} style={{ width: `${Math.min(100, Math.max(0, remaining * 100))}%` }} />
      </span>
      <span className={`credit-label${level === 'critical' ? ' credit-label--critical' : ''}`}>{percent}% left</span>
    </span>
  )
}

// ------------------------------------------------------- models & providers

function ModelsPane({ onManage, onBrowseModels }: { onManage: () => void; onBrowseModels: () => void }): JSX.Element {
  const app = useApp()
  const ext = app?.extensions ?? EMPTY_EXTENSIONS
  const { providers, models } = ext

  // One row per connected provider, local server, and the subscription.
  const entries: { name: string; detail: string }[] = [
    ...(providers.subscription.connected
      ? [{ name: 'Spettro account', detail: `${providers.subscription.modelCount} models` }]
      : []),
    ...providers.providers.filter((p) => p.connected).map((p) => ({ name: p.name, detail: `${p.modelCount} models` })),
    ...providers.local.map((l) => ({ name: l.name, detail: `${shortHost(l.endpoint)} · ${l.modelCount} models` }))
  ]

  // Nothing connected: the chooser itself, right here, rather than a warning
  // and a button that stacks a second sheet over this one.
  if (entries.length === 0 && !ext.unsupported) {
    return (
      <div className="form-scroll">
        <ConnectChooser inPane />
      </div>
    )
  }

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
                Nothing is connected yet — Spettro can&rsquo;t answer until a model is.
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
              {models.models.find((m) => m.name === models.activeModel && m.provider === models.activeProvider)
                ?.displayName ??
                models.activeModel ??
                'None selected'}
            </span>
          </div>
          <div className="form-row form-row--actions">
            <button className="btn btn--prominent" onClick={onManage}>
              {entries.length === 0 ? 'Connect a model…' : 'Manage providers…'}
            </button>
            {models.models.length > 0 && (
              <button className="btn" onClick={onBrowseModels}>
                Browse models…
              </button>
            )}
          </div>
        </div>
        <div className="form-footer">
          API keys are checked before they&rsquo;re saved and stored encrypted on this computer — Spettro
          never shows one again.
        </div>
      </section>
    </div>
  )
}

// ------------------------------------------------------------ permissions

function PermissionsPane(): JSX.Element {
  const permission = usePermissionOption()
  const choices = permission ? choicesOf(permission) : []
  const value = permission?.kind.type === 'select' ? permission.kind.currentValue : null

  return (
    <div className="form-scroll">
      <section className="form-section">
        <div className="form-section-title">What Spettro may do without asking</div>
        <div className="form-card" role="radiogroup" aria-label="Permission">
          {choices.length === 0 ? (
            <div className="form-row">
              <span className="form-text">These appear once Spettro is running.</span>
            </div>
          ) : (
            choices.map((c) => (
              <label key={c.value} className="form-row form-row--choice">
                <input
                  type="radio"
                  name="permission"
                  checked={value === c.value}
                  onChange={() => void call('setDefaultOption', PERMISSION_ID, c.value)}
                />
                <span className="form-choice-texts">
                  <span className="form-choice-name">{permissionName(c)}</span>
                  <span className="form-choice-detail">
                    {permissionDescription(c)}
                  </span>
                </span>
              </label>
            ))
          )}
        </div>
        <div className="form-footer">
          Applies to every session. Ultra&rsquo;s multi-agent workflows need Restricted or Don&rsquo;t
          ask — under Ask first they wait for you.
        </div>
      </section>
    </div>
  )
}

// --------------------------------------------------------------- advanced

function AdvancedPane(): JSX.Element {
  const app = useApp()
  const [showPathEditor, setShowPathEditor] = useState(false)
  const [pathDraft, setPathDraft] = useState('')
  const projectPath = app ? (defaultProjectPath(app) ?? null) : null
  const running = app?.phase.kind === 'ready' || app?.phase.kind === 'needsProvider'
  const reconnecting = app?.connection === 'reconnecting'

  const useExplicitPath = (path: string): void => {
    const trimmed = path.trim()
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
    if (path) useExplicitPath(path)
    else setShowPathEditor(true)
  }

  // Remembers the folder for new sessions; it does not start one.
  const changeProjectFolder = async (): Promise<void> => {
    const path = await call('pickFolder')
    if (path) await call('rememberProject', path)
  }

  return (
    <div className="form-scroll">
      <section className="form-section">
        <div className="form-section-title">Spettro engine</div>
        <div className="form-card">
          <div className="form-row">
            <span className="form-label">Status</span>
            <span className="form-value">
              {reconnecting ? (
                <span className="form-status">
                  <Spinner size={11} /> Restarting…
                </span>
              ) : running ? (
                <span className="form-status form-status--ok">
                  <Icon name="checkmark.circle.fill" size={12} /> Running
                  {app?.agentVersion ? ` · ${app.agentVersion}` : ''}
                </span>
              ) : (
                <span className="form-status">Not running</span>
              )}
            </span>
          </div>
          <div className="form-row">
            <span className="form-label">Location</span>
            {/* Truncated from the head, so the binary's name stays visible. */}
            <span className="form-value path-value" title={app?.cli?.path ?? 'Spettro’s engine wasn’t found.'}>
              {app?.cli ? `${app.cli.path}${app.cli.isDev ? ' (development build)' : ''}` : 'Not found'}
            </span>
          </div>
          <div className="form-row form-row--actions">
            <button className="btn" onClick={() => void restartEngine()} disabled={reconnecting}>
              Restart engine
            </button>
            <button className="btn" onClick={() => void chooseExecutable()}>
              Use a different copy…
            </button>
            {/* Not running (the wrong file was chosen, or none is found):
                the way back to the copy Spettro installs itself. */}
            {!running && !reconnecting && (
              <button
                className="btn btn--prominent"
                onClick={() => {
                  closeSettings()
                  void call('installCLI')
                }}
              >
                Install Spettro
              </button>
            )}
          </div>
          {showPathEditor && (
            <div className="form-row form-row--stack">
              <div className="path-input-row">
                <input
                  className="text-input"
                  type="text"
                  placeholder={isMac() ? '/usr/local/bin/spettro' : '/home/you/.local/bin/spettro'}
                  aria-label="Path to the spettro engine"
                  value={pathDraft}
                  autoFocus
                  onChange={(e) => setPathDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.stopPropagation()
                      useExplicitPath(pathDraft)
                    }
                  }}
                />
                <button className="btn" disabled={pathDraft.trim() === ''} onClick={() => useExplicitPath(pathDraft)}>
                  Use
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="form-footer">
          Restarting stops anything Spettro is working on. Your sessions and their history stay.
        </div>
      </section>

      <section className="form-section">
        <div className="form-section-title">New sessions</div>
        <div className="form-card">
          <div className="form-row">
            <span className="form-label">Default folder</span>
            <span className="form-value path-value" title={projectPath ?? undefined}>
              {projectPath ?? 'Home folder'}
            </span>
          </div>
          <div className="form-row form-row--actions">
            <button className="btn" onClick={() => void changeProjectFolder()}>
              Change folder…
            </button>
          </div>
        </div>
        <div className="form-footer">Where a new session works when you don&rsquo;t pick a folder.</div>
      </section>

      <TerminalSessions projectPath={projectPath} />
    </div>
  )
}

/** "Resume a terminal session…": conversations the CLI has for this folder
 *  that no session here knows — started with `spettro` in a terminal. */
function TerminalSessions({ projectPath }: { projectPath: string | null }): JSX.Element {
  const [entries, setEntries] = useState<CLISessionEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const load = (): void => {
    if (!projectPath) return
    setError(null)
    setEntries(null)
    void quietCall('listCLISessions', projectPath)
      .then(setEntries)
      .catch((err) => {
        setEntries([])
        setError(humanizeError(err).detail)
      })
  }
  const [asked, setAsked] = useState(false)
  const now = Date.now()

  return (
    <section className="form-section">
      <div className="form-section-title">Sessions started in a terminal</div>
      <div className="form-card">
        {!asked ? (
          <div className="form-row form-row--actions">
            <span className="form-text">
              Continue a conversation you started with <code>spettro</code> in{' '}
              {projectPath ? basename(projectPath) : 'a folder'}.
            </span>
            <span className="form-spacer" />
            <button
              className="btn"
              disabled={!projectPath}
              onClick={() => {
                setAsked(true)
                load()
              }}
            >
              Resume a terminal session…
            </button>
          </div>
        ) : entries === null ? (
          <div className="form-row">
            <span className="form-status">
              <Spinner size={11} /> Looking…
            </span>
          </div>
        ) : entries.length === 0 ? (
          <div className="form-row">
            <span className="form-text">{error ?? 'No terminal sessions in this folder.'}</span>
          </div>
        ) : (
          entries.map((entry) => (
            <div className="form-row form-row--entry" key={entry.sessionId}>
              <span className="form-label">{entry.title ?? 'Untitled session'}</span>
              <span className="form-value">
                {entry.updatedAt ? relativeTime(entry.updatedAt, now) : ''}
                <button
                  className="btn btn--small"
                  disabled={opening !== null}
                  onClick={() => {
                    if (!projectPath) return
                    setOpening(entry.sessionId)
                    void call('importCLISession', entry.sessionId, projectPath).finally(() => setOpening(null))
                  }}
                >
                  {opening === entry.sessionId ? 'Opening…' : 'Open'}
                </button>
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  )
}

// -------------------------------------------------------------- shortcuts

function ShortcutsPane(): JSX.Element {
  const mac = isMac()
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))]
  return (
    <div className="form-scroll">
      {groups.map((group) => (
        <section className="form-section" key={group}>
          <div className="form-section-title">{group}</div>
          <div className="form-card">
            {SHORTCUTS.filter((s) => s.group === group).map((s) => (
              <div className="form-row form-row--entry" key={`${s.label}:${s.key}`}>
                <span className="form-label">{s.label}</span>
                <span className="form-value">
                  <kbd className="form-kbd">{shortcutText(s, mac)}</kbd>
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ about

function AboutPane(): JSX.Element {
  const app = useApp()
  const appVersion = app?.update.app.current ?? null
  const engine = app?.agentVersion ?? app?.cli?.version ?? null
  return (
    <div className="form-scroll">
      <div className="about-hero">
        <AppIcon size={72} />
        <div className="about-name">Spettro</div>
        <div className="about-version">Version {appVersion ?? 'unknown'}</div>
      </div>
      <section className="form-section">
        <div className="form-card">
          <div className="form-row">
            <span className="form-label">App</span>
            <span className="form-value">{appVersion ?? 'unknown'}</span>
          </div>
          <div className="form-row">
            <span className="form-label">Engine</span>
            <span className="form-value">{engine ?? 'not running'}</span>
          </div>
          <div className="form-row form-row--actions">
            <button className="link" onClick={() => void quietCall('openExternal', WEBSITE)}>
              spettro.app
            </button>
            <button className="link" onClick={() => void quietCall('openExternal', SOURCE)}>
              Source code
            </button>
            <span className="form-spacer" />
            <CopyButton
              label="Copy diagnostics"
              text={() =>
                diagnosticsText({
                  appVersion,
                  engineVersion: engine,
                  platform: `${window.spettro?.platform ?? 'unknown'}`,
                  log: app?.agentLog ?? []
                })
              }
            />
          </div>
        </div>
        <div className="form-footer">Spettro is free software, licensed under the GPL 3.0.</div>
      </section>
    </div>
  )
}

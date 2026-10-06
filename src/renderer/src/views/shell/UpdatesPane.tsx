// Settings › Updates. To the person using it Spettro is one thing, so the pane
// leads with one row: "Spettro is up to date ✓", or "An update is available"
// with Update Now — which updates whichever halves need it (the engine first,
// then the app, since installing the app restarts it). Running work is asked
// about first: update now, or when it finishes.
//
// The two halves — this app and the CLI engine it drives — are still there,
// under "Details", with their versions, their own buttons and their release
// notes rendered as the markdown they are.
//
// The check runs on its own in the main process (every few hours, and once
// shortly after launch); this pane renders `app.update` and offers a manual
// re-check. Nothing installs without a button being pressed.

import { useEffect } from 'react'
import { humanizeError } from '@shared/humanize'
import { isUpdateBusy, type ComponentUpdate, type UpdateState } from '@shared/update'
import { quietCall, useApp } from '@renderer/state/store'
import Disclosure from '@renderer/views/common/Disclosure'
import { MarkdownText } from '@renderer/views/chat/transcript/MarkdownText'
import { Icon } from '@renderer/design/icons'
import Spinner from './Spinner'
import { updateEverything } from './actions'
import { DownloadIcon, WarningIcon } from './icons'

export default function UpdatesPane(): JSX.Element {
  const app = useApp()
  const update = app?.update
  const appUpdate = update?.app
  const cliUpdate = update?.cli
  const checking = appUpdate?.status === 'checking' || cliUpdate?.status === 'checking'

  // Opening this pane is exactly when the versions need to be current — the
  // background check may be hours old.
  useEffect(() => {
    void quietCall('checkForUpdates')
  }, [])

  return (
    <div className="form-scroll">
      <section className="form-section">
        <div className="form-card">{update && <SummaryRow update={update} />}</div>
        <div className="form-footer">
          <span>{lastChecked(appUpdate, cliUpdate)}</span>
          {' · '}
          <button className="link" disabled={checking} onClick={() => void quietCall('checkForUpdates')}>
            {checking ? 'Checking…' : 'Check Now'}
          </button>
        </div>
      </section>

      <section className="form-section">
        <Disclosure label="Details" openLabel="Details" className="updates-details">
          <div className="form-section-title">Spettro app</div>
          <div className="form-card">
            <ComponentRows update={appUpdate} />
            {appUpdate?.available && !update?.canInstallApp && (
              <div className="form-row form-row--actions">
                <span className="form-text">This copy can&rsquo;t update itself.</span>
                <span className="form-spacer" />
                <button
                  className="btn btn--small"
                  onClick={() => void quietCall('openExternal', appUpdate.releaseUrl ?? '')}
                >
                  Download {appUpdate.latest}…
                </button>
              </div>
            )}
            <ReleaseNotes update={appUpdate} />
          </div>
          <div className="form-section-title">Spettro engine</div>
          <div className="form-card">
            <ComponentRows update={cliUpdate} />
            <div className="form-row form-row--actions">
              <span className="form-text">The engine is the part that talks to the model.</span>
              <span className="form-spacer" />
              <button
                className="btn btn--small"
                disabled={!cliUpdate || isUpdateBusy(cliUpdate)}
                onClick={() => void quietCall('installCLIUpdate', false)}
              >
                Reinstall
              </button>
            </div>
            <ReleaseNotes update={cliUpdate} />
          </div>
        </Disclosure>
      </section>
    </div>
  )
}

/** The one row: up to date, an update waiting, one in progress, or what
 *  went wrong. */
function SummaryRow({ update }: { update: UpdateState }): JSX.Element {
  const { app, cli } = update
  const busy = isUpdateBusy(app) ? app : isUpdateBusy(cli) ? cli : null
  const failed = app.status === 'failed' ? app : cli.status === 'failed' ? cli : null
  const available = app.available || cli.available
  const checked = app.latest !== null || cli.latest !== null

  if (busy) {
    return (
      <div className="form-row form-row--stack">
        <div className="update-status">
          <Spinner size={12} />
          <span className="update-status-text">{busy.message ?? 'Updating…'}</span>
          {busy.progress !== null && <span className="update-percent">{Math.round(busy.progress * 100)}%</span>}
        </div>
        {busy.progress !== null && (
          <span className="update-track" aria-hidden="true">
            <span className="update-fill" style={{ width: `${Math.round(busy.progress * 100)}%` }} />
          </span>
        )}
      </div>
    )
  }

  return (
    <>
      <div className="form-row form-row--actions">
        {available ? (
          <span className="update-summary">
            <span className="update-summary-icon update-summary-icon--new">
              <DownloadIcon size={14} />
            </span>
            <span className="update-summary-texts">
              <span className="update-summary-title">An update is available</span>
              <span className="update-summary-sub">{availableText(update)}</span>
            </span>
          </span>
        ) : checked ? (
          <span className="update-summary">
            <span className="update-summary-icon update-summary-icon--ok">
              <Icon name="checkmark.circle.fill" size={15} />
            </span>
            <span className="update-summary-texts">
              <span className="update-summary-title">Spettro is up to date</span>
              <span className="update-summary-sub">
                Version {app.current ?? 'unknown'}
                {cli.current ? ` · engine ${cli.current}` : ''}
              </span>
            </span>
          </span>
        ) : (
          <span className="update-summary">
            <span className="update-summary-icon">
              {app.status === 'checking' ? <Spinner size={13} /> : <WarningIcon size={14} />}
            </span>
            <span className="update-summary-texts">
              <span className="update-summary-title">
                {app.status === 'checking' ? 'Checking for updates…' : 'Couldn’t check for updates'}
              </span>
              {app.status !== 'checking' && app.message && (
                <span className="update-summary-sub">{humanizeError(app.message).detail}</span>
              )}
            </span>
          </span>
        )}
        <span className="form-spacer" />
        {available && (
          <button className="btn btn--prominent" onClick={() => void updateEverything(update)}>
            <span className="btn-icon">
              <DownloadIcon size={12} />
            </span>
            Update Now
          </button>
        )}
      </div>
      {failed && (
        <div className="form-row">
          <span className="form-error">
            <span className="form-note-icon">
              <WarningIcon size={12} />
            </span>
            {humanizeError(failed.message ?? 'The update failed.').detail}
          </span>
        </div>
      )}
      {!failed && (app.status === 'done' || cli.status === 'done') && (
        <div className="form-row">
          <span className="form-note">{(cli.status === 'done' ? cli.message : app.message) ?? 'Updated.'}</span>
        </div>
      )}
    </>
  )
}

/** "Engine 2.9.1 is ready to install." — what moved, and what updating
 *  will do about it. */
function availableText(update: UpdateState): string {
  const parts: string[] = []
  if (update.app.available) parts.push(`Spettro ${update.app.latest}`)
  if (update.cli.available) parts.push(`${parts.length > 0 ? 'engine' : 'Engine'} ${update.cli.latest}`)
  const verb = parts.length > 1 ? 'are' : 'is'
  const tail = update.app.available && update.canInstallApp ? ' Spettro restarts to finish.' : ''
  return `${parts.join(' and ')} ${verb} ready to install.${tail}`
}

/** Installed / latest, with the "new" marker on the latest when it is ahead. */
function ComponentRows({ update }: { update: ComponentUpdate | undefined }): JSX.Element {
  return (
    <>
      <div className="form-row">
        <span className="form-label">Installed</span>
        <span className="form-value form-value--primary">{update?.current ?? 'unknown'}</span>
      </div>
      <div className="form-row">
        <span className="form-label">Latest</span>
        <span className="form-value">
          {update?.latest ?? '—'}
          {update?.available && <span className="update-badge">new</span>}
        </span>
      </div>
    </>
  )
}

/** The release body, rendered as the markdown it is — only for a release
 *  the user could install; notes for a version already running are noise. */
function ReleaseNotes({ update }: { update: ComponentUpdate | undefined }): JSX.Element | null {
  if (!update?.available || !update.releaseNotes) return null
  return (
    <div className="form-row form-row--stack">
      <div className="update-notes update-notes--md">
        <MarkdownText source={update.releaseNotes} />
      </div>
      {update.releaseUrl && (
        <button className="link" onClick={() => void quietCall('openExternal', update.releaseUrl ?? '')}>
          Full release notes
        </button>
      )}
    </div>
  )
}

function lastChecked(appUpdate: ComponentUpdate | undefined, cliUpdate: ComponentUpdate | undefined): string {
  const latest = Math.max(appUpdate?.checkedAt ?? 0, cliUpdate?.checkedAt ?? 0)
  if (latest === 0) return 'Spettro checks for updates every few hours'
  return `Last checked ${new Date(latest).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

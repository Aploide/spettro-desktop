// The Settings > Updates pane. Two rows — this app and the CLI it drives —
// each showing the installed version against the newest GitHub release, with
// the button that applies it.
//
// The check runs on its own in the main process (every few hours, and once
// shortly after launch); this pane only renders `app.update` and offers a
// manual re-check. Nothing installs without the button being pressed: the app
// update replaces this build and restarts it, and the CLI update re-runs the
// official install script and reconnects the agent underneath the open chats.

import { useEffect } from 'react'
import { call, useApp } from '@renderer/state/store'
import { isUpdateBusy, type ComponentUpdate } from '@shared/update'
import Spinner from './Spinner'
import { DownloadIcon, WarningIcon } from './icons'

export default function UpdatesPane(): JSX.Element {
  const app = useApp()
  const update = app?.update
  const appUpdate = update?.app
  const cliUpdate = update?.cli
  const canInstallApp = update?.canInstallApp ?? false
  const checking = appUpdate?.status === 'checking' || cliUpdate?.status === 'checking'

  // Opening this pane is exactly when the versions need to be current — the
  // background check may be hours old.
  useEffect(() => {
    void call('checkForUpdates')
  }, [])

  return (
    <div className="form-scroll">
      <section className="form-section">
        <div className="form-section-title">Spettro Desktop</div>
        <div className="form-card">
          <VersionRows update={appUpdate} />
          <StatusRow update={appUpdate} />

          <div className="form-row form-row--actions">
            {appUpdate?.available && canInstallApp && (
              <button
                className="btn btn--prominent"
                disabled={isUpdateBusy(appUpdate)}
                onClick={() => void call('installAppUpdate')}
              >
                <span className="btn-icon">
                  <DownloadIcon size={12} />
                </span>
                Update to {appUpdate.latest}
              </button>
            )}
            {appUpdate?.available && !canInstallApp && (
              <button
                className="btn btn--prominent"
                onClick={() => void call('openExternal', appUpdate.releaseUrl ?? '')}
              >
                Download {appUpdate.latest}…
              </button>
            )}
            {!appUpdate?.available && <span className="form-text">{idleText(appUpdate)}</span>}
            <span className="form-spacer" />
            {appUpdate?.releaseUrl && (
              <button
                className="link"
                onClick={() => void call('openExternal', appUpdate.releaseUrl ?? '')}
              >
                Release notes
              </button>
            )}
          </div>

          <ReleaseNotes update={appUpdate} />
        </div>
        <div className="form-footer">
          {appUpdate?.available && canInstallApp
            ? 'Spettro downloads the installer, closes itself, and reopens on the new version.'
            : appUpdate?.available
              ? 'This build can’t replace itself — install the download by hand, over the current copy.'
              : 'Checked against the published releases of Spettro Desktop.'}
        </div>
      </section>

      <section className="form-section">
        <div className="form-section-title">Spettro CLI</div>
        <div className="form-card">
          <VersionRows update={cliUpdate} />
          <StatusRow update={cliUpdate} />

          <div className="form-row form-row--actions">
            <button
              className={`btn${cliUpdate?.available ? ' btn--prominent' : ''}`}
              disabled={!cliUpdate || isUpdateBusy(cliUpdate)}
              onClick={() => void call('installCLIUpdate')}
            >
              <span className="btn-icon">
                <DownloadIcon size={12} />
              </span>
              {cliUpdate?.available ? `Update to ${cliUpdate.latest}` : 'Reinstall Latest'}
            </button>
            <span className="form-spacer" />
            {cliUpdate?.releaseUrl && (
              <button
                className="link"
                onClick={() => void call('openExternal', cliUpdate.releaseUrl ?? '')}
              >
                Release notes
              </button>
            )}
          </div>

          <ReleaseNotes update={cliUpdate} />
        </div>
        <div className="form-footer">
          Runs the official install script, then restarts the agent on the new binary. Open chats
          keep their transcripts.
        </div>
      </section>

      <section className="form-section">
        <div className="form-card">
          <div className="form-row form-row--actions">
            <button className="btn" disabled={checking} onClick={() => void call('checkForUpdates')}>
              Check Now
            </button>
            {checking && <Spinner size={14} />}
            <span className="form-spacer" />
            <span className="form-value">{lastChecked(appUpdate, cliUpdate)}</span>
          </div>
        </div>
        <div className="form-footer">Spettro checks for updates automatically every few hours.</div>
      </section>
    </div>
  )
}

/** Installed / latest, with the "new" marker on the latest when it is ahead. */
function VersionRows({ update }: { update: ComponentUpdate | undefined }): JSX.Element {
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

/** Whatever the update is doing right now: the progress bar while a download
 *  runs, the installer's last line while it installs, the error when it
 *  failed. Idle rows render nothing so the card stays quiet. */
function StatusRow({ update }: { update: ComponentUpdate | undefined }): JSX.Element | null {
  if (!update) return null

  if (update.status === 'failed') {
    return (
      <div className="form-row">
        <span className="form-error">
          <span className="form-note-icon">
            <WarningIcon size={12} />
          </span>
          {update.message ?? 'The update failed.'}
        </span>
      </div>
    )
  }

  // Two things still worth a line while the row is idle: a finished install,
  // and a check that never reached GitHub — staying silent about the latter
  // would read as "up to date", which is exactly what it doesn't know.
  if (!isUpdateBusy(update)) {
    const unreachable = update.status !== 'checking' && update.latest === null
    if (update.message === null || (update.status !== 'done' && !unreachable)) return null
    return (
      <div className="form-row">
        <span className="form-note">
          {unreachable && (
            <span className="form-note-icon">
              <WarningIcon size={12} />
            </span>
          )}
          {unreachable ? `Couldn’t check for updates — ${update.message}` : update.message}
        </span>
      </div>
    )
  }

  return (
    <div className="form-row form-row--stack">
      <div className="update-status">
        <Spinner size={12} />
        <span className="update-status-text">{update.message ?? 'Working…'}</span>
        {update.progress !== null && (
          <span className="update-percent">{Math.round(update.progress * 100)}%</span>
        )}
      </div>
      {update.progress !== null && (
        <span className="update-track" aria-hidden="true">
          <span className="update-fill" style={{ width: `${Math.round(update.progress * 100)}%` }} />
        </span>
      )}
    </div>
  )
}

/** The release body, shown only when the release is one the user could
 *  install — notes for a version already running are noise. */
function ReleaseNotes({ update }: { update: ComponentUpdate | undefined }): JSX.Element | null {
  if (!update?.available || !update.releaseNotes) return null
  return (
    <div className="form-row form-row--stack">
      <div className="update-notes">{update.releaseNotes}</div>
    </div>
  )
}

/** What the action row says when there is nothing to install: only claim
 *  "up to date" once a release has actually been read. */
function idleText(update: ComponentUpdate | undefined): string {
  if (!update || update.status === 'checking') return 'Checking…'
  if (update.latest === null) return 'Latest version unknown.'
  return 'Spettro is up to date.'
}

function lastChecked(
  appUpdate: ComponentUpdate | undefined,
  cliUpdate: ComponentUpdate | undefined
): string {
  const latest = Math.max(appUpdate?.checkedAt ?? 0, cliUpdate?.checkedAt ?? 0)
  if (latest === 0) return 'Not checked yet'
  return `Checked ${new Date(latest).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

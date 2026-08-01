// Port of OnboardingView.swift — first-run setup. Either installs the CLI via
// the official script (streaming app.installLog into a self-tailing log card)
// or accepts a path to an existing binary. macOS uses a file-only NSOpenPanel
// for the manual route; the desktop bridge only exposes a directory picker, so
// here the second card expands into a typed-path field validated by
// useExplicitCLIPath (a bad path surfaces the same orange banner).

import { useEffect, useRef, useState } from 'react'
import { call, useApp } from '@renderer/state/store'
import AppIcon from './AppIcon'
import Spinner from './Spinner'
import { DownloadIcon, FolderFillIcon } from './icons'

export default function OnboardingView(): JSX.Element {
  const app = useApp()
  const installing = app?.phase.kind === 'installing'

  return (
    <div className="onboarding">
      <div className="onb-column">
        <div className="onb-header">
          <AppIcon size={104} />
          <h1 className="onb-title">Welcome to Spettro</h1>
          <div className="onb-sub">
            Spettro runs on the official command-line agent. Install it to get started — it lives in
            your home folder and needs no admin rights.
          </div>
        </div>
        {installing ? <InstallProgress log={app?.installLog ?? []} /> : <Options banner={app?.banner ?? null} />}
      </div>
    </div>
  )
}

function Options({ banner }: { banner: string | null }): JSX.Element {
  const [manualOpen, setManualOpen] = useState(false)
  const [path, setPath] = useState('')

  const usePath = (): void => {
    const trimmed = path.trim()
    if (trimmed) void call('useExplicitCLIPath', trimmed)
  }

  /** The Swift card opens an NSOpenPanel; the typed field remains as the
   *  fallback when the dialog closes without a choice. */
  const browse = async (): Promise<void> => {
    const chosen = await call('pickExecutable')
    if (chosen) void call('useExplicitCLIPath', chosen)
    else setManualOpen((o) => !o)
  }

  return (
    <div className="onb-options">
      <button className="onb-card" onClick={() => void call('installCLI')}>
        <span className="onb-card-icon">
          <DownloadIcon size={18} />
        </span>
        <span>
          <div className="onb-card-title">Install automatically</div>
          <div className="onb-card-sub">Runs the official install script</div>
        </span>
      </button>

      <button className="onb-card" onClick={() => void browse()}>
        <span className="onb-card-icon">
          <FolderFillIcon size={18} />
        </span>
        <span>
          <div className="onb-card-title">Choose an existing binary…</div>
          <div className="onb-card-sub">
            Point Spettro at a <code>spettro</code> you already have
          </div>
        </span>
      </button>

      {manualOpen && (
        <div className="path-input-row">
          <input
            className="text-input"
            type="text"
            placeholder="/home/you/.local/bin/spettro"
            value={path}
            autoFocus
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') usePath()
            }}
          />
          <button className="btn" disabled={!path.trim()} onClick={usePath}>
            Use
          </button>
        </div>
      )}

      {banner && <div className="banner-inline">{banner}</div>}

      <div className="onb-hint">Manual install: curl -sSfL https://spettro.app/install | sh</div>
    </div>
  )
}

/** The live install log: one monospaced line per installer output line,
 *  pinned to the bottom like a terminal as new lines stream in. */
function InstallProgress({ log }: { log: string[] }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log.length])

  return (
    <div className="install-progress">
      <div className="install-progress-head">
        <Spinner size={13} />
        Installing…
      </div>
      <div ref={scrollRef} className="card install-log">
        {log.map((line, i) => (
          <div key={i} className="log-line">
            {line}
          </div>
        ))}
      </div>
    </div>
  )
}

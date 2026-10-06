// First-run setup, as one assistant with two steps — the port of
// OnboardingView.swift and the provider gate, which used to be two unrelated
// full-window screens with a spinner between them.
//
//   Step 1 of 2 · Install       Spettro needs its helper app (the CLI). One
//                               button installs it; a determinate bar follows
//                               the installer's phases (checking → downloading
//                               → verifying → installing), Cancel stops it,
//                               and a failure says why in a sentence with Try
//                               Again — the installer's log is behind "Show
//                               details". "Use an existing copy…" and the
//                               terminal one-liner wait behind "Advanced".
//   Step 2 of 2 · Connect       Spettro needs a model. Signing in is the big
//                               button; "Use my own API key" and "Use a model
//                               on this computer" are the quieter ways, and
//                               "Continue without" is remembered.
//
// A machine that already has the CLI starts on step 2 with step 1 ticked.

import { useEffect, useRef, useState } from 'react'
import type { InstallState } from '@shared/model'
import { call, quietCall, useApp } from '@renderer/state/store'
import Disclosure, { CopyButton } from '@renderer/views/common/Disclosure'
import SignInView from '@renderer/views/account/SignInView'
import AddLocalEndpointView from '@renderer/views/providers/AddLocalEndpointView'
import { ProviderKeyList } from '@renderer/views/providers/ConnectProvidersView'
import { Icon } from '@renderer/design/icons'
import AppIcon from './AppIcon'
import '@renderer/design/form.css'

/** The same one-liner the install button runs, for anyone who would rather
 *  paste it into their own terminal. Kept in step with
 *  CLIInstaller.manualCommand in the main process. */
const REPO_RAW = 'https://raw.githubusercontent.com/aploide/spettro/main'

function manualInstallCommand(): string {
  return window.spettro.platform === 'win32'
    ? `irm ${REPO_RAW}/install.ps1 | iex`
    : `curl -sSfL ${REPO_RAW}/install.sh | sh`
}

type Step = 'install' | 'connect'

export default function SetupAssistant({ step, onSkip }: { step: Step; onSkip?: () => void }): JSX.Element {
  return (
    <div className="setup">
      <div className="setup-column">
        <header className="setup-header">
          <AppIcon size={80} />
          <StepIndicator step={step} />
        </header>
        {step === 'install' ? <InstallStep /> : <ConnectStep onSkip={onSkip} />}
      </div>
    </div>
  )
}

function StepIndicator({ step }: { step: Step }): JSX.Element {
  const steps: { id: Step; label: string }[] = [
    { id: 'install', label: 'Install' },
    { id: 'connect', label: 'Connect a model' }
  ]
  const at = steps.findIndex((s) => s.id === step)
  return (
    <div className="setup-steps" aria-label={`Step ${at + 1} of 2 · ${steps[at].label}`}>
      <span className="setup-steps-caption">
        Step {at + 1} of 2 · {steps[at].label}
      </span>
      <span className="setup-steps-track" aria-hidden>
        {steps.map((s, i) => (
          <span
            key={s.id}
            className={'setup-step-dot' + (i < at ? ' setup-step-dot--done' : i === at ? ' setup-step-dot--now' : '')}
          >
            {i < at ? <Icon name="checkmark" size={9} /> : i + 1}
          </span>
        ))}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------- install

/** How far along the bar each installer phase puts it. */
const STAGE_PROGRESS: Record<InstallState['stage'], number> = {
  idle: 0,
  checking: 0.12,
  downloading: 0.45,
  verifying: 0.78,
  installing: 0.92,
  done: 1,
  failed: 0
}

const STAGE_TEXT: Record<InstallState['stage'], string> = {
  idle: '',
  checking: 'Checking for the latest version…',
  downloading: 'Downloading…',
  verifying: 'Verifying the download…',
  installing: 'Installing…',
  done: 'Installed. Starting Spettro…',
  failed: ''
}

function InstallStep(): JSX.Element {
  const app = useApp()
  const install = app?.install ?? { stage: 'idle', failure: null }
  const installing = app?.phase.kind === 'installing'
  const failed = !installing && install.stage === 'failed'

  if (installing) {
    const progress = STAGE_PROGRESS[install.stage]
    return (
      <div className="setup-body">
        <h1 className="setup-title">Installing Spettro…</h1>
        <div className="setup-sub">This takes a few seconds.</div>
        <div className="setup-progress">
          <div
            className="setup-progress-track"
            role="progressbar"
            aria-label="Installing Spettro"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <span className="setup-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <div className="setup-progress-text">{STAGE_TEXT[install.stage]}</div>
        </div>
        <div className="setup-actions">
          <button type="button" className="btn" onClick={() => void call('cancelInstall')}>
            Cancel
          </button>
        </div>
        <InstallLog log={app?.installLog ?? []} />
      </div>
    )
  }

  return (
    <div className="setup-body">
      {failed ? (
        <>
          <div className="setup-failure-icon" aria-hidden>
            <Icon name="exclamationmark.triangle.fill" size={26} />
          </div>
          <h1 className="setup-title">{failureTitle(install)}</h1>
          <div className="setup-sub">{failureDetail(install)}</div>
        </>
      ) : (
        <>
          <h1 className="setup-title">Welcome to Spettro</h1>
          <div className="setup-sub">
            Spettro needs a small helper app. We&rsquo;ll install it for you — it lives in your home
            folder and needs no password.
          </div>
        </>
      )}
      <div className="setup-actions">
        <button
          type="button"
          className="btn btn--prominent btn--large setup-primary"
          autoFocus
          onClick={() => void call('installCLI')}
        >
          {failed ? 'Try Again' : 'Install Spettro'}
        </button>
      </div>
      {failed && <InstallLog log={app?.installLog ?? []} />}
      <Advanced banner={app?.banner ?? null} bannerNonce={app?.bannerNonce ?? 0} />
    </div>
  )
}

function failureTitle(install: InstallState): string {
  switch (install.failure?.kind) {
    case 'missing-tool':
      return `Spettro needs “${install.failure.tool}” to download its helper`
    case 'timeout':
      return 'The download took too long'
    default:
      return 'Couldn’t download Spettro'
  }
}

function failureDetail(install: InstallState): string {
  switch (install.failure?.kind) {
    case 'missing-tool':
      return `Install ${install.failure.tool} with your system’s package manager, then try again.`
    default:
      return 'Check your internet connection, then try again.'
  }
}

/** The installer's own output, behind "Show details" — a terminal log is
 *  for whoever is curious or filing a bug, not the first thing to read. */
function InstallLog({ log }: { log: string[] }): JSX.Element | null {
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log.length])
  if (log.length === 0) return null
  return (
    <Disclosure className="setup-details">
      <div ref={scrollRef} className="diagnostics-log setup-log">
        {log.map((line, i) => (
          <div key={i} className="log-line">
            {line}
          </div>
        ))}
      </div>
      <div className="diagnostics-actions">
        <CopyButton text={log.join('\n')} label="Copy Log" />
      </div>
    </Disclosure>
  )
}

/** Using a copy already on disk, or installing by hand — for the few who
 *  need it, out of everyone else's way. */
function Advanced({ banner, bannerNonce }: { banner: string | null; bannerNonce: number }): JSX.Element {
  const [manualOpen, setManualOpen] = useState(false)
  const [path, setPath] = useState('')
  // The banner (a bad path) is shown once per nonce, here instead of a toast.
  const [shownBanner, setShownBanner] = useState<string | null>(null)
  useEffect(() => {
    if (banner) setShownBanner(banner)
  }, [banner, bannerNonce])

  const usePath = (value: string): void => {
    const trimmed = value.trim()
    if (trimmed) {
      setShownBanner(null)
      void call('useExplicitCLIPath', trimmed)
    }
  }

  /** A native file picker; cancelling it does nothing (the typed field is
   *  its own button). */
  const browse = async (): Promise<void> => {
    const chosen = await quietCall('pickExecutable')
    if (chosen) usePath(chosen)
  }

  return (
    <Disclosure label="Advanced" openLabel="Advanced" className="setup-advanced">
      <div className="setup-advanced-body">
        <div className="setup-advanced-row">
          <span className="setup-advanced-text">Already have Spettro&rsquo;s helper (the <code>spettro</code> command)?</span>
          <button type="button" className="btn btn--small" onClick={() => void browse()}>
            Use an Existing Copy…
          </button>
          <button type="button" className="link" onClick={() => setManualOpen((o) => !o)}>
            Type a path
          </button>
        </div>
        {manualOpen && (
          <div className="path-input-row">
            <input
              className="text-input"
              type="text"
              aria-label="Path to spettro"
              placeholder={
                window.spettro.platform === 'win32'
                  ? 'C:\\Users\\you\\AppData\\Local\\Programs\\spettro\\spettro.exe'
                  : '/home/you/.local/bin/spettro'
              }
              value={path}
              autoFocus
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') usePath(path)
              }}
            />
            <button className="btn" disabled={!path.trim()} onClick={() => usePath(path)}>
              Use
            </button>
          </div>
        )}
        {shownBanner && <div className="banner-inline" role="alert">{shownBanner}</div>}
        <div className="setup-advanced-row setup-advanced-row--manual">
          <span className="setup-advanced-text">Or install it yourself in a terminal:</span>
          <code className="setup-command">{manualInstallCommand()}</code>
          <CopyButton text={manualInstallCommand()} />
        </div>
      </div>
    </Disclosure>
  )
}

// ---------------------------------------------------------------- connect

function ConnectStep({ onSkip }: { onSkip?: () => void }): JSX.Element {
  const [showSignIn, setShowSignIn] = useState(false)
  const [showLocal, setShowLocal] = useState(false)
  const [showKeys, setShowKeys] = useState(false)

  // The provider list comes from the engine; fetched once on the way in.
  useEffect(() => {
    void quietCall('refreshExtensions')
  }, [])

  return (
    <div className="setup-body">
      {showKeys ? (
        <>
          <h1 className="setup-title">Use your own API key</h1>
          <div className="setup-sub">
            Pick your provider and paste a key. Spettro checks it before saving it, encrypted, on this
            computer.
          </div>
          <div className="setup-keys form-scroll">
            <div className="form-card">
              <ProviderKeyList activate onConnected={() => void quietCall('refreshExtensions')} />
            </div>
          </div>
          <div className="setup-actions">
            <button type="button" className="btn" onClick={() => setShowKeys(false)}>
              Back
            </button>
          </div>
        </>
      ) : (
        <>
          <h1 className="setup-title">Connect a model</h1>
          <div className="setup-sub">
            Spettro needs an AI model to work with. The simplest way is your Spettro account — models
            and credits are included.
          </div>
          <div className="setup-actions setup-actions--stack">
            <button
              type="button"
              className="btn btn--prominent btn--large setup-primary"
              autoFocus
              onClick={() => setShowSignIn(true)}
            >
              Sign in to Spettro
            </button>
            <span className="setup-recommended">Recommended</span>
          </div>
          <div className="setup-alternatives">
            <button type="button" className="setup-alt" onClick={() => setShowKeys(true)}>
              <Icon name="key" size={15} />
              <span className="setup-alt-texts">
                <span className="setup-alt-title">Use my own API key</span>
                <span className="setup-alt-sub">Anthropic, OpenAI, Google, OpenRouter and more</span>
              </span>
              <Icon name="chevron.right" size={9} />
            </button>
            <button type="button" className="setup-alt" onClick={() => setShowLocal(true)}>
              <Icon name="desktopcomputer" size={15} />
              <span className="setup-alt-texts">
                <span className="setup-alt-title">Use a model on this computer</span>
                <span className="setup-alt-sub">LM Studio, Ollama or llama.cpp</span>
              </span>
              <Icon name="chevron.right" size={9} />
            </button>
          </div>
        </>
      )}
      {onSkip && (
        <button
          type="button"
          className="link setup-skip"
          onClick={onSkip}
          title="Open Spettro anyway. You can connect a model later from Settings."
        >
          Continue without a model
        </button>
      )}

      {showSignIn && (
        <SignInView
          stacked
          onClose={() => setShowSignIn(false)}
          onComplete={() => void quietCall('refreshExtensions')}
        />
      )}
      {showLocal && (
        <AddLocalEndpointView
          onClose={() => setShowLocal(false)}
          onAdded={() => void quietCall('refreshExtensions')}
        />
      )}
    </div>
  )
}

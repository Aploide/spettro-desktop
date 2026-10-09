// Settings › Remote › Access over the internet: the Cloudflare tunnel.
//
// Off by default, and easy to leave off: until it is set up the card is one
// switch and two sentences saying what it needs (a free Cloudflare account and
// a domain on Cloudflare). Turning it on, or opening "Set it up", gives the
// numbered steps with the fields where the steps say to paste — the token
// field takes the whole install command the dashboard shows, and the hostname
// fills itself in from the tunnel's routes once cloudflared connects.
//
// What's on screen after that is one status line (Off / Downloading
// cloudflared… / Connecting… / Connected as <host>), and when something is
// wrong, main's sentence about it with the one button that fixes it. The token
// never comes back from main: the card only knows there is one, and which
// tunnel it names.

import { useEffect, useRef, useState } from 'react'
import type { RemoteHostState, RemoteTunnelCheck, RemoteTunnelErrorKind, RemoteTunnelState } from '@shared/model'
import { call, quietCall } from '../../state/store'
import { confirmDialog } from '@renderer/views/common/ConfirmDialog'
import Disclosure, { CopyButton } from '@renderer/views/common/Disclosure'
import { Icon } from '@renderer/design/icons'

/** Where step 1 starts: Zero Trust's dashboard (Networks › Tunnels). */
export const CLOUDFLARE_DASHBOARD = 'https://one.dash.cloudflare.com/'

export type TunnelTone = 'off' | 'busy' | 'ok' | 'warn' | 'error'

/** The headline for an error; main's message under it says what to do. */
const ERROR_TITLES: Record<RemoteTunnelErrorKind, string> = {
  'bad-token': 'Cloudflare didn’t accept the token',
  unauthorized: 'Cloudflare turned this tunnel away',
  network: 'Can’t reach Cloudflare',
  'port-in-use': 'The tunnel’s port is taken',
  'binary-missing': 'cloudflared is missing',
  'unsupported-platform': 'cloudflared isn’t available for this computer',
  'download-failed': 'Couldn’t download cloudflared',
  launch: 'cloudflared couldn’t start',
  exited: 'cloudflared stopped'
}

/** "0:30" until `retryAt`, or null once it is due (or nothing is waiting). */
export function retryIn(retryAt: number | null, now: number): string | null {
  if (retryAt === null) return null
  const seconds = Math.ceil((retryAt - now) / 1000)
  if (seconds <= 0) return null
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** The line under "Access over the internet". `sharing` is whether remote
 *  access itself is on: the tunnel only runs while it is. */
export function tunnelStatus(t: RemoteTunnelState, sharing: boolean, now: number): { text: string; tone: TunnelTone } {
  if (!t.enabled) return { text: t.hasToken && t.hostname ? `Off · ${t.hostname}` : 'Off', tone: 'off' }
  switch (t.status) {
    case 'needs-setup':
      return { text: 'Finish setting it up below', tone: 'warn' }
    case 'off':
      return sharing ? { text: 'Connecting…', tone: 'busy' } : { text: 'Off while sharing is off', tone: 'off' }
    case 'locating':
      return { text: 'Looking for cloudflared…', tone: 'busy' }
    case 'downloading':
      return {
        text:
          t.downloadProgress !== null
            ? `Downloading cloudflared… ${Math.round(t.downloadProgress * 100)}%`
            : 'Downloading cloudflared…',
        tone: 'busy'
      }
    case 'starting':
      return { text: 'Connecting…', tone: 'busy' }
    case 'connected':
      return t.hostname
        ? { text: `Connected as ${t.hostname}`, tone: t.warning ? 'warn' : 'ok' }
        : { text: 'Connected · add the public hostname below', tone: 'warn' }
    case 'reconnecting': {
      const wait = retryIn(t.retryAt, now)
      return { text: wait ? `Reconnecting… trying again in ${wait}` : 'Reconnecting…', tone: 'busy' }
    }
    case 'error':
      return { text: t.error ? ERROR_TITLES[t.error.kind] : 'Not connected', tone: 'error' }
  }
}

/** The first block of the tunnel's UUID, to match against the dashboard. */
export function shortTunnelId(id: string | null): string | null {
  return id ? id.split('-')[0] : null
}

export default function InternetAccess({ remote, now }: { remote: RemoteHostState; now: number }): JSX.Element {
  const t = remote.tunnel
  // The steps are open while there is something to do in them: on, but not
  // set up yet. After that they hold the settings, folded away.
  const [stepsOpen, setStepsOpen] = useState(() => t.enabled && !t.hasToken)
  // Bumped by "Paste a new token": opens the steps on the token field.
  const [tokenFocus, setTokenFocus] = useState(0)
  const status = tunnelStatus(t, remote.enabled, now)

  const replaceToken = (): void => {
    setStepsOpen(true)
    setTokenFocus((n) => n + 1)
  }

  return (
    <section className="remote__card remote__tunnel" aria-label="Access over the internet">
      <div className="remote__tunnel-head">
        <span className={`remote__tunnel-icon remote__tunnel-icon--${status.tone}`}>
          <Icon name="globe" size={18} />
        </span>
        <div className="remote__switch-text">
          <span className="remote__status-title">Access over the internet</span>
          <span className={`remote__tunnel-status remote__tunnel-status--${status.tone}`} data-testid="tunnel-status">
            {status.tone === 'busy' && <span className="spinner remote__tunnel-spinner" aria-hidden />}
            {status.text}
          </span>
        </div>
        <label className="remote__toggle">
          <input
            type="checkbox"
            role="switch"
            aria-label="Access over the internet"
            checked={t.enabled}
            onChange={(e) => {
              const on = e.target.checked
              if (on && !t.hasToken) setStepsOpen(true)
              void call('remoteTunnelSetEnabled', on)
            }}
          />
          <span className="remote__toggle-track">
            <span className="remote__toggle-thumb" />
          </span>
        </label>
      </div>

      {!t.hasToken && (
        <p className="remote__tunnel-text">
          Reach this computer from your phone when it isn&rsquo;t on the same Wi-Fi. Spettro uses a
          Cloudflare tunnel, which is free: you need a free Cloudflare account and a domain on Cloudflare.
        </p>
      )}

      {t.enabled && t.status === 'downloading' && <DownloadBar progress={t.downloadProgress} />}

      {t.enabled && <Problems t={t} now={now} onReplaceToken={replaceToken} onChangePort={() => setStepsOpen(true)} />}

      {t.enabled && t.status === 'connected' && t.hostname !== '' && <CheckFromInternet />}

      {t.hasToken && <PairingChoice t={t} />}

      <Disclosure
        className="remote__tunnel-setup"
        label={t.hasToken ? 'Tunnel settings' : 'Set it up'}
        openLabel={t.hasToken ? 'Hide tunnel settings' : 'Hide the steps'}
        open={stepsOpen}
        onOpenChange={setStepsOpen}
      >
        <SetupSteps t={t} tokenFocus={tokenFocus} />
      </Disclosure>

      {t.log.length > 0 && (
        <Disclosure className="diagnostics">
          <div className="diagnostics-log">
            {t.log.map((line, i) => (
              <div key={i} className="log-line">
                {line}
              </div>
            ))}
          </div>
          <div className="diagnostics-actions">
            <CopyButton text={() => t.log.join('\n')} label="Copy log" />
          </div>
        </Disclosure>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// What's wrong, and the button that fixes it
// ---------------------------------------------------------------------------

function Problems({
  t,
  now,
  onReplaceToken,
  onChangePort
}: {
  t: RemoteTunnelState
  now: number
  onReplaceToken: () => void
  onChangePort: () => void
}): JSX.Element | null {
  const error = t.status === 'error' || t.status === 'reconnecting' ? t.error : null
  const waiting = t.status === 'reconnecting' && retryIn(t.retryAt, now) !== null
  if (!error && !t.warning && !t.internetPairingPaused) return null
  return (
    <>
      {error && (
        <div className="remote__tunnel-problem remote__tunnel-problem--error" role="alert">
          <span className="remote__tunnel-problem-text">{error.message}</span>
          <span className="remote__tunnel-actions">
            {(error.kind === 'bad-token' || error.kind === 'unauthorized') && (
              <button className="remote__button" onClick={onReplaceToken}>
                Paste a new token
              </button>
            )}
            {error.kind === 'port-in-use' && (
              <button className="remote__button" onClick={onChangePort}>
                Choose another port
              </button>
            )}
            {error.kind !== 'unsupported-platform' && error.kind !== 'bad-token' && error.kind !== 'unauthorized' && (
              <button className="remote__button" onClick={() => void call('remoteTunnelRetry')}>
                {waiting ? 'Try now' : 'Try again'}
              </button>
            )}
          </span>
        </div>
      )}
      {t.warning && (
        <div className="remote__tunnel-problem remote__tunnel-problem--warn">
          <Icon name="exclamationmark.triangle.fill" size={12} />
          <span className="remote__tunnel-problem-text">{t.warning}</span>
        </div>
      )}
      {t.internetPairingPaused && (
        <div className="remote__tunnel-problem remote__tunnel-problem--warn">
          <Icon name="exclamationmark.triangle.fill" size={12} />
          <span className="remote__tunnel-problem-text">
            Someone kept failing to sign in over the internet, so pairing over the internet is paused.
            Choose Pair a device to turn it back on.
          </span>
        </div>
      )}
    </>
  )
}

function DownloadBar({ progress }: { progress: number | null }): JSX.Element {
  return (
    <div
      className={`remote__progress${progress === null ? ' remote__progress--indeterminate' : ''}`}
      role="progressbar"
      aria-label="Downloading cloudflared"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress === null ? undefined : Math.round(progress * 100)}
    >
      <span className="remote__progress-fill" style={progress === null ? undefined : { width: `${progress * 100}%` }} />
    </div>
  )
}

function CheckFromInternet(): JSX.Element {
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<RemoteTunnelCheck | null>(null)
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    []
  )
  return (
    <div className="remote__tunnel-check">
      <button
        className="remote__button"
        disabled={checking}
        onClick={async () => {
          setChecking(true)
          setResult(null)
          const answer = await call('remoteTunnelCheck')
          if (!mounted.current) return
          setChecking(false)
          setResult(answer ?? null)
        }}
      >
        {checking ? 'Checking…' : 'Check from the internet'}
      </button>
      {result && (
        <span className={`remote__tunnel-check-result remote__tunnel-check-result--${result.ok ? 'ok' : 'warn'}`}>
          {result.message}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pairing over the internet
// ---------------------------------------------------------------------------

function PairingChoice({ t }: { t: RemoteTunnelState }): JSX.Element {
  return (
    <div className="remote__tunnel-option">
      <label className="remote__tunnel-checkbox">
        <input
          type="checkbox"
          checked={t.allowInternetPairing}
          onChange={(e) => void call('remoteTunnelConfigure', { allowInternetPairing: e.target.checked })}
        />
        <span>Allow pairing over the internet</span>
      </label>
      <span className="remote__tunnel-note">
        {t.allowInternetPairing
          ? 'Anyone who gets a pairing code or link from you can pair while it lasts, from anywhere.'
          : 'New phones pair on the same Wi-Fi first. Paired phones connect from anywhere either way.'}
      </span>
      <span className="remote__tunnel-note remote__tunnel-note--lock">
        <Icon name="lock.shield" size={12} />
        Over the internet, Cloudflare decrypts the traffic at its edge and encrypts it again on the
        way to this computer.
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The steps, with the fields where they say to paste
// ---------------------------------------------------------------------------

function SetupSteps({ t, tokenFocus }: { t: RemoteTunnelState; tokenFocus: number }): JSX.Element {
  const service = `localhost:${t.port}`
  return (
    <div className="remote__steps-wrap">
      <ol className="remote__steps">
        <li className="remote__step">
          <span className="remote__step-text">
            In the Cloudflare dashboard, open Zero Trust › Networks › Tunnels and create a tunnel. Choose
            Cloudflared as its type and give it any name.
          </span>
          <span className="remote__step-row">
            <button className="remote__button" onClick={() => void quietCall('openExternal', CLOUDFLARE_DASHBOARD)}>
              Open Cloudflare
            </button>
          </span>
        </li>
        <li className="remote__step">
          <span className="remote__step-text">
            Cloudflare shows a command to install the connector. Copy it, for any system, and paste it
            here. Spettro takes the token out of it and runs cloudflared itself, so you don&rsquo;t need to
            run the command.
          </span>
          <TokenField t={t} focus={tokenFocus} />
        </li>
        <li className="remote__step">
          <span className="remote__step-text">
            Add a public hostname on your domain, such as spettro.example.com. Set its service type to HTTP
            and the URL to {service}.
          </span>
          <span className="remote__step-row">
            <CopyChip label="Type" value="HTTP" />
            <CopyChip label="URL" value={service} />
          </span>
          <HostnameField t={t} />
        </li>
        <li className="remote__step">
          <span className="remote__step-text">
            {t.enabled ? 'That’s it.' : 'Turn on Access over the internet.'} Phones you&rsquo;ve paired learn
            the address the next time they connect on the same Wi-Fi; from then on they reach this
            computer from anywhere.
          </span>
        </li>
      </ol>
      <PortField t={t} />
      <BinaryLine t={t} />
    </div>
  )
}

function CopyChip({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <span className="remote__chip">
      <span className="remote__chip-label">{label}</span>
      <code className="remote__chip-value">{value}</code>
      <CopyButton text={value} className="remote__chip-copy" />
    </span>
  )
}

function TokenField({ t, focus }: { t: RemoteTunnelState; focus: number }): JSX.Element {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  // "Paste a new token" from the status: the field, open and focused.
  useEffect(() => {
    if (focus === 0) return
    setReplacing(true)
    requestAnimationFrame(() => input.current?.focus())
  }, [focus])

  const save = async (text: string): Promise<void> => {
    if (text.trim() === '') return
    setSaving(true)
    const result = await call('remoteTunnelConfigure', { token: text })
    setSaving(false)
    if (result && !result.ok) {
      setError(result.message)
      return
    }
    setDraft('')
    setError(null)
    setReplacing(false)
  }

  if (t.hasToken && !replacing) {
    const id = shortTunnelId(t.tunnelId)
    return (
      <span className="remote__step-row">
        <span className="remote__saved">
          <Icon name="checkmark.circle.fill" size={12} />
          {id ? `Tunnel ${id}… is saved` : 'The token is saved'}
        </span>
        <button className="link" onClick={() => setReplacing(true)}>
          Replace
        </button>
        <button
          className="link remote__link--danger"
          onClick={async () => {
            const answer = await confirmDialog({
              title: 'Forget the tunnel token?',
              message: 'Phones won’t reach this computer over the internet until you paste it again.',
              confirmLabel: 'Forget',
              destructive: true
            })
            if (answer === 'confirm') void call('remoteTunnelForgetToken')
          }}
        >
          Forget
        </button>
      </span>
    )
  }

  return (
    <span className="remote__field">
      <span className="remote__step-row">
        {/* A password field: the token is the tunnel's key, and screens get
            shared. */}
        <input
          ref={input}
          className="input input--mono"
          type="password"
          aria-label="Tunnel token"
          placeholder="Paste the token or the whole install command"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setDraft(e.target.value)
            setError(null)
          }}
          // A paste is the whole action: save it there and then.
          onPaste={(e) => {
            const text = e.clipboardData.getData('text')
            if (text.trim() === '') return
            e.preventDefault()
            setDraft(text)
            void save(text)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save(draft)
            if (e.key === 'Escape' && t.hasToken) {
              e.stopPropagation()
              setReplacing(false)
              setDraft('')
              setError(null)
            }
          }}
        />
        <button className="remote__button" disabled={saving || draft.trim() === ''} onClick={() => void save(draft)}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {t.hasToken && (
          <button
            className="link"
            onClick={() => {
              setReplacing(false)
              setDraft('')
              setError(null)
            }}
          >
            Cancel
          </button>
        )}
      </span>
      {error && (
        <span className="remote__field-error" role="alert">
          {error}
        </span>
      )}
    </span>
  )
}

function HostnameField({ t }: { t: RemoteTunnelState }): JSX.Element {
  const [draft, setDraft] = useState(t.hostname)
  const [error, setError] = useState<string | null>(null)
  const editing = useRef(false)

  // Main may fill the hostname in from the tunnel's routes: follow it,
  // unless the user is in the middle of typing one.
  useEffect(() => {
    if (!editing.current) setDraft(t.hostname)
  }, [t.hostname])

  const save = async (): Promise<void> => {
    editing.current = false
    if (draft.trim() === t.hostname) {
      setDraft(t.hostname)
      return
    }
    const result = await call('remoteTunnelConfigure', { hostname: draft })
    if (result && !result.ok) setError(result.message)
    else setError(null)
  }

  const found = t.hostname !== '' && t.log.some((line) => line.includes(`public hostname ${t.hostname} in the tunnel`))
  return (
    <span className="remote__field">
      <span className="remote__step-row">
        <span className="remote__field-label">Public hostname</span>
        <input
          className="input"
          aria-label="Public hostname"
          placeholder="spettro.example.com"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            editing.current = true
            setDraft(e.target.value)
            setError(null)
          }}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
          }}
        />
      </span>
      {error ? (
        <span className="remote__field-error" role="alert">
          {error}
        </span>
      ) : (
        <span className="remote__tunnel-note">
          {found
            ? 'Found in the tunnel’s settings in Cloudflare.'
            : 'Leave it empty and Spettro fills it in from the tunnel once it connects.'}
        </span>
      )}
    </span>
  )
}

function PortField({ t }: { t: RemoteTunnelState }): JSX.Element {
  const [draft, setDraft] = useState(String(t.port))
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setDraft(String(t.port))
  }, [t.port])

  const save = async (): Promise<void> => {
    const port = Number(draft.trim())
    if (port === t.port) return
    if (!Number.isInteger(port)) {
      setError('Choose a port from 1024 to 65535.')
      return
    }
    const result = await call('remoteTunnelConfigure', { port })
    setError(result && !result.ok ? result.message : null)
  }

  return (
    <span className="remote__field remote__field--aside">
      <span className="remote__step-row">
        <span className="remote__field-label">Local port</span>
        <input
          className="input input--mono remote__port"
          aria-label="Local port"
          inputMode="numeric"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            setError(null)
          }}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
          }}
        />
      </span>
      {error ? (
        <span className="remote__field-error" role="alert">
          {error}
        </span>
      ) : (
        <span className="remote__tunnel-note">
          Change it only if another program uses {t.port}, then update the URL in Cloudflare to match.
        </span>
      )}
    </span>
  )
}

function BinaryLine({ t }: { t: RemoteTunnelState }): JSX.Element | null {
  const downloading = t.status === 'downloading'
  const where = !t.binary
    ? 'Spettro downloads cloudflared from Cloudflare’s GitHub releases the first time the tunnel starts.'
    : t.binary.source === 'downloaded'
      ? `Using Spettro’s own cloudflared${t.binary.version ? ` ${t.binary.version}` : ''}.`
      : `Using the cloudflared${t.binary.version ? ` ${t.binary.version}` : ''} installed on this computer.`
  return (
    <span className="remote__step-row remote__field--aside">
      <span className="remote__tunnel-note remote__binary">{where}</span>
      {t.binary && (
        <button
          className="remote__button"
          disabled={downloading}
          onClick={() => void call('remoteTunnelInstallCloudflared')}
        >
          {t.binary.source === 'downloaded' ? 'Update cloudflared' : 'Use Spettro’s own copy'}
        </button>
      )}
    </span>
  )
}

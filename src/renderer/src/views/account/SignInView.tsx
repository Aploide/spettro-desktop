// Port of Spettro/Views/Account/SignInView.swift — the Spettro Subscription
// device-flow sign-in, the app's `/login`.
//
// The CLI owns the flow and the main process drives it: `accountLoginStart`
// hands back a browser URL — which the RENDERER opens, the CLI never launches
// a browser — and main polls the device flow from there, pushing each state
// change into `extensions.account.login`. So this sheet only reflects
// `login.status`, exactly as SignInView.swift reflects `AccountStore.login`.
// `accountLoginPoll` is used for one case only: a sheet that reappears while a
// flow is still outstanding, the port of `AccountStore.syncLoginState()`.
//
// The four states are the TUI's, with the TUI's wording: starting, waiting,
// complete, failed/expired. Note a *pending* login legitimately reports
// `signedIn: false` with no plan — that is not the signed-out state.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { LoginStatus } from '@shared/extensions'
import { call, getState, useApp } from '@renderer/state/store'
import AppIcon from '@renderer/views/shell/AppIcon'
import Spinner from '@renderer/views/shell/Spinner'
import '@renderer/design/form.css'
import './account.css'

const PRICING_FALLBACK = 'https://spettro.app/pricing'

interface Props {
  /** Called once the account is signed in, so the host can move on (leave
   *  onboarding, re-check the provider gate). */
  onComplete?: () => void
  onClose: () => void
  /** Presented from another sheet (Settings, Connect Providers). */
  stacked?: boolean
}

export default function SignInView({ onComplete, onClose, stacked = false }: Props): JSX.Element {
  const app = useApp()
  const account = app?.extensions?.account
  const pushed = account?.login ?? null

  const [login, setLogin] = useState<LoginStatus | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [didCopy, setDidCopy] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const finished = useRef(false)

  const state = login?.status ?? 'idle'
  const browserUrl = login?.browserUrl ?? null
  const pricingUrl = account?.pricingUrl ?? PRICING_FALLBACK

  const start = useCallback(async (): Promise<void> => {
    setFailure(null)
    setDidCopy(false)
    setLogin({ loginId: null, status: 'starting', browserUrl: null, error: null })
    try {
      const status = await call('accountLoginStart')
      setLogin(status)
      if (status.status === 'error') {
        setFailure(status.error ?? 'Sign-in could not be started.')
        return
      }
      // The app, not the CLI, owns browser launching.
      if (status.browserUrl) void call('openExternal', status.browserUrl)
    } catch (err) {
      setLogin({ loginId: null, status: 'error', browserUrl: null, error: null })
      setFailure(message(err))
    }
  }, [])

  // A flow already outstanding when the sheet appears is resynced rather than
  // restarted — starting a second device flow would invalidate the URL the
  // user may already have open in their browser.
  useEffect(() => {
    const existing = getState().app?.extensions?.account.login ?? null
    if (existing !== null && (existing.status === 'pending' || existing.status === 'starting')) {
      setLogin(existing)
      void call('accountLoginPoll')
        .then((status) => setLogin(status))
        .catch(() => {
          /* A failed resync is not a failed login; the pushes still land. */
        })
    } else {
      void start()
    }
    return () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current)
    }
  }, [start])

  // Main advances the flow and pushes every state change, so reflecting
  // `extensions.account.login` is all the sheet has to do.
  useEffect(() => {
    if (pushed === null) return
    setLogin((current) => {
      if (current === null) return pushed
      // An update belonging to an earlier flow must not clobber this one.
      if (current.loginId !== null && pushed.loginId !== null && pushed.loginId !== current.loginId) {
        return current
      }
      return pushed.status === current.status && pushed.browserUrl === current.browserUrl
        ? current
        : pushed
    })
  }, [pushed])

  // Signed in: report completion once, then dismiss. Being signed in at all
  // counts, even if the flow's own status notification never landed.
  const isComplete = state === 'complete' || account?.signedIn === true
  useEffect(() => {
    if (!isComplete || finished.current) return
    finished.current = true
    void call('refreshExtensions')
    const timer = setTimeout(() => {
      onComplete?.()
      onClose()
    }, 600)
    return () => clearTimeout(timer)
  }, [isComplete, onComplete, onClose])

  const cancel = (): void => {
    void call('accountLoginCancel')
    onClose()
  }

  const copy = (text: string): void => {
    void navigator.clipboard.writeText(text)
    setDidCopy(true)
    if (copyTimer.current !== null) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setDidCopy(false), 2000)
  }

  return (
    <div className={`modal-backdrop${stacked ? ' modal-backdrop--stacked' : ''}`} role="presentation">
      <div className="modal-panel modal-panel--signin" role="dialog" aria-modal="true" aria-label="Sign in to Spettro">
        <div className="signin">
          <header className="signin-header">
            <AppIcon size={72} />
            <h2 className="signin-title">Sign in to Spettro</h2>
            <p className="signin-blurb">
              Use your subscription&rsquo;s models without configuring any API keys.
            </p>
          </header>

          <div className="signin-content">
            {isComplete ? (
              <div className="signin-state">
                <CheckSealIcon size={32} />
                <span className="signin-muted">Signed in — loading your plan…</span>
              </div>
            ) : state === 'error' || state === 'expired' ? (
              <div className="signin-state">
                <span className="signin-warning">
                  <WarnIcon size={28} />
                </span>
                <span className="signin-strong">
                  {state === 'expired' ? 'That sign-in link expired.' : 'Sign-in failed.'}
                </span>
                {(login?.error ?? failure) && (
                  <span className="signin-muted signin-detail">{login?.error ?? failure}</span>
                )}
                <button className="btn btn--prominent" onClick={() => void start()}>
                  Try Again
                </button>
              </div>
            ) : state === 'pending' ? (
              <div className="signin-waiting">
                <div className="signin-waiting-head">
                  <Spinner size={16} />
                  <span className="signin-strong">Waiting for you to sign in…</span>
                </div>
                <p className="signin-muted signin-detail">
                  A browser window should have opened. If not, open this link:
                </p>
                {browserUrl && (
                  <>
                    <div className="signin-url">
                      <span className="signin-url-text mono">{browserUrl}</span>
                      <button className="btn btn--small" onClick={() => copy(browserUrl)}>
                        {didCopy ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <button
                      className="btn btn--small"
                      onClick={() => void call('openExternal', browserUrl)}
                    >
                      Open in Browser
                    </button>
                  </>
                )}
              </div>
            ) : (
              <div className="signin-state">
                <Spinner size={20} />
                <span className="signin-muted">Starting sign-in…</span>
              </div>
            )}
          </div>

          <footer className="signin-footer">
            <button className="link" onClick={() => void call('openExternal', pricingUrl)}>
              See plans
            </button>
            <button className="btn" onClick={cancel}>
              Cancel
            </button>
          </footer>
        </div>
      </div>
    </div>
  )
}

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  // Electron prefixes rejected invokes with its own routing noise.
  return text.replace(/^Error invoking remote method '[^']+':\s*/, '')
}

/** checkmark.circle.fill */
function CheckSealIcon({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="signin-ok">
      <path d="M8 .8a7.2 7.2 0 1 0 0 14.4A7.2 7.2 0 0 0 8 .8zm-.9 10.6L3.9 8.2l1.2-1.2 2 2 4-4 1.2 1.2z" />
    </svg>
  )
}

/** exclamationmark.triangle.fill */
function WarnIcon({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 1.4 15.4 14a.8.8 0 0 1-.7 1.2H1.3A.8.8 0 0 1 .6 14zM7.2 5.6v4.2h1.6V5.6zm0 5.4v1.6h1.6V11z" />
    </svg>
  )
}

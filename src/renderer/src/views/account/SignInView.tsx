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
//
// Nothing happens behind the user's back: the sheet first says a browser
// window is about to open and waits for "Continue in browser". While it waits
// for the sign-in, the raw link sits behind "Having trouble?" for whoever's
// browser didn't open. Escape (or Cancel) cancels the flow on the CLI too, and
// once signed in there is nothing left to cancel.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { LoginStatus } from '@shared/extensions'
import { humanizeError } from '@shared/humanize'
import { getState, quietCall, useApp } from '@renderer/state/store'
import Disclosure from '@renderer/views/common/Disclosure'
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
  /** Drawn in place of the connect chooser (setup's step 2, Settings ›
   *  Models while nothing is connected) instead of as a sheet over it: one
   *  page under one icon, with Back where Cancel was. */
  inline?: boolean
}

/** What signing in gets you, for someone who has never heard of a plan: the
 *  account is how models come without keys, and it can be made from here. */
const BLURB =
  'Sign in, or create a Spettro account. Plans include the models and credits — no API keys to set up.'

export default function SignInView({ onComplete, onClose, stacked = false, inline = false }: Props): JSX.Element {
  const app = useApp()
  const account = app?.extensions?.account
  const pushed = account?.login ?? null

  const [login, setLogin] = useState<LoginStatus | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [didCopy, setDidCopy] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const finished = useRef(false)

  // 'idle' until "Continue in browser": the browser never opens unannounced.
  const state = login?.status ?? 'idle'
  const browserUrl = login?.browserUrl ?? null
  const pricingUrl = account?.pricingUrl ?? PRICING_FALLBACK

  const start = useCallback(async (): Promise<void> => {
    setFailure(null)
    setDidCopy(false)
    setLogin({ loginId: null, status: 'starting', browserUrl: null, error: null })
    try {
      const status = await quietCall('accountLoginStart')
      setLogin(status)
      if (status.status === 'error') {
        setFailure(status.error ?? 'Sign-in could not be started.')
        return
      }
      // The app, not the CLI, owns browser launching.
      if (status.browserUrl) void quietCall('openExternal', status.browserUrl)
    } catch (err) {
      setLogin({ loginId: null, status: 'error', browserUrl: null, error: null })
      setFailure(message(err))
    }
  }, [])

  // A flow already outstanding when the sheet appears is resynced rather than
  // restarted — starting a second device flow would invalidate the URL the
  // user may already have open in their browser. Otherwise the sheet waits
  // for "Continue in browser".
  useEffect(() => {
    const existing = getState().app?.extensions?.account.login ?? null
    if (existing !== null && (existing.status === 'pending' || existing.status === 'starting')) {
      setLogin(existing)
      void quietCall('accountLoginPoll')
        .then((status) => setLogin(status))
        .catch(() => {
          /* A failed resync is not a failed login; the pushes still land. */
        })
    }
    return () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current)
    }
  }, [])

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
    void quietCall('refreshExtensions')
    const timer = setTimeout(() => {
      onComplete?.()
      onClose()
    }, 600)
    return () => clearTimeout(timer)
  }, [isComplete, onComplete, onClose])

  const cancel = useCallback((): void => {
    // Only a flow that was started has anything to cancel on the CLI.
    if (state === 'starting' || state === 'pending') void quietCall('accountLoginCancel')
    onClose()
  }, [state, onClose])

  // Escape is this sheet's Cancel — and only this sheet's: the Settings
  // window behind it must not close with it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      e.stopPropagation()
      if (!isComplete) cancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [cancel, isComplete])

  const copy = (text: string): void => {
    void navigator.clipboard.writeText(text)
    setDidCopy(true)
    if (copyTimer.current !== null) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setDidCopy(false), 2000)
  }

  const content = isComplete ? (
    <div className="signin-state">
      <CheckSealIcon size={32} />
      <span className="signin-muted">Signed in — loading your plan…</span>
    </div>
  ) : state === 'idle' || state === 'cancelled' || state === 'unknown' ? (
    <div className="signin-state">
      <p className="signin-muted signin-detail">
        Spettro will open your web browser so you can sign in. Come back here when you&rsquo;re
        done.
      </p>
      <button className="btn btn--prominent btn--large" autoFocus onClick={() => void start()}>
        Continue in browser
      </button>
      {/* What it costs, beside the button that might cost something. */}
      <button className="link signin-plans" onClick={() => void quietCall('openExternal', pricingUrl)}>
        See plans and prices
      </button>
    </div>
  ) : state === 'error' || state === 'expired' ? (
    <div className="signin-state">
      <span className="signin-warning">
        <WarnIcon size={28} />
      </span>
      <span className="signin-strong">
        {state === 'expired' ? 'That sign-in link expired.' : 'Couldn’t sign in.'}
      </span>
      {(login?.error ?? failure) && (
        <span className="signin-muted signin-detail">{message(login?.error ?? failure)}</span>
      )}
      <button className="btn btn--prominent" onClick={() => void start()}>
        Try again
      </button>
    </div>
  ) : state === 'pending' ? (
    <div className="signin-waiting">
      <div className="signin-waiting-head">
        <Spinner size={16} />
        <span className="signin-strong">Waiting for you to sign in…</span>
      </div>
      <p className="signin-muted signin-detail">
        Finish signing in in your browser. This window updates on its own.
      </p>
      {browserUrl && (
        <Disclosure label="Having trouble?" openLabel="Having trouble?">
          <p className="signin-muted signin-detail">
            If no browser window opened, open this link yourself:
          </p>
          <div className="signin-url">
            <span className="signin-url-text mono">{browserUrl}</span>
            <button className="btn btn--small" onClick={() => copy(browserUrl)}>
              {didCopy ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button
            className="btn btn--small"
            onClick={() => void quietCall('openExternal', browserUrl)}
          >
            Open in browser
          </button>
        </Disclosure>
      )}
    </div>
  ) : (
    <div className="signin-state">
      <Spinner size={20} />
      <span className="signin-muted">Starting sign-in…</span>
    </div>
  )

  if (inline) {
    return (
      <div className="signin signin--inline">
        <h1 className="setup-title">Sign in to Spettro</h1>
        <div className="setup-sub">{BLURB}</div>
        <div className="signin-content">{content}</div>
        {!isComplete && (
          <div className="setup-actions">
            <button type="button" className="btn" onClick={cancel}>
              Back
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={`modal-backdrop${stacked ? ' modal-backdrop--stacked' : ''}`} role="presentation">
      <div className="modal-panel modal-panel--signin" role="dialog" aria-modal="true" aria-label="Sign in to Spettro">
        <div className="signin">
          <header className="signin-header">
            <AppIcon size={72} />
            <h2 className="signin-title">Sign in to Spettro</h2>
            <p className="signin-blurb">{BLURB}</p>
          </header>

          <div className="signin-content">{content}</div>

          {!isComplete && (
            <footer className="signin-footer">
              <button className="btn" onClick={cancel}>
                Cancel
              </button>
            </footer>
          )}
        </div>
      </div>
    </div>
  )
}

/** A sign-in failure in words ("You appear to be offline. Check your
 *  internet connection…"); an unknown one as its own first line. */
function message(err: unknown): string {
  const human = humanizeError(err)
  return human.known ? `${human.title}. ${human.detail}` : human.detail
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

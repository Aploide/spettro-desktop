// "Show details": where raw logs and error text live once a screen has said
// what went wrong in words. Closed by default — the details are for a bug
// report or the curious, not the first thing anyone should have to read.
//
// DiagnosticsDisclosure is the common case: the raw error and the engine's
// recent output in a mono box, with Copy Diagnostics putting the lot (plus
// versions and platform) on the clipboard for a bug report.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { JSX } from 'react'
import { diagnosticsText } from '@shared/humanize'
import { useApp } from '@renderer/state/store'
import { Icon } from '@renderer/design/icons'
import './common.css'

export default function Disclosure({
  label = 'Show details',
  openLabel = 'Hide details',
  children,
  defaultOpen = false,
  className
}: {
  label?: string
  openLabel?: string
  children: ReactNode
  defaultOpen?: boolean
  className?: string
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`disclosure${open ? ' disclosure--open' : ''}${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className="disclosure-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="disclosure-chevron" aria-hidden>
          <Icon name="chevron.right" size={8} />
        </span>
        {open ? openLabel : label}
      </button>
      {open && <div className="disclosure-body">{children}</div>}
    </div>
  )
}

/** Copies `text`, then says so on the button for a moment. */
export function CopyButton({
  text,
  label = 'Copy',
  className = 'btn btn--small'
}: {
  text: string | (() => string)
  label?: string
  className?: string
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        void navigator.clipboard?.writeText(typeof text === 'function' ? text() : text)
        setCopied(true)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1600)
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  )
}

/** The raw error plus the engine's last output lines, behind "Show details". */
export function DiagnosticsDisclosure({
  error,
  log
}: {
  error?: string | null
  log: string[]
}): JSX.Element | null {
  const app = useApp()
  const lines = [...(error ? [error] : []), ...log.slice(-40)]
  const diagnostics = (): string =>
    diagnosticsText({
      appVersion: app?.update.app.current ?? null,
      engineVersion: app?.agentVersion ?? app?.cli?.version ?? null,
      platform: `${window.spettro?.platform ?? 'unknown'} · ${navigator.userAgent.match(/\(([^)]*)\)/)?.[1] ?? ''}`,
      error,
      log
    })
  return (
    <Disclosure className="diagnostics">
      {lines.length > 0 ? (
        <div className="diagnostics-log">
          {lines.map((line, i) => (
            <div key={i} className="log-line">
              {line}
            </div>
          ))}
        </div>
      ) : (
        <div className="diagnostics-empty">Spettro&rsquo;s engine didn&rsquo;t print anything.</div>
      )}
      <div className="diagnostics-actions">
        <CopyButton text={diagnostics} label="Copy Diagnostics" />
      </div>
    </Disclosure>
  )
}

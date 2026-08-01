// Port of the private FailureView in ContentView.swift: warning triangle,
// title, the bootstrap failure message, a tail of the agent's stderr log, and
// Open Settings / Retry actions. Retry re-runs the full bootstrap.

import { call, useApp } from '@renderer/state/store'
import { WarningIcon } from './icons'

interface Props {
  message: string
  onOpenSettings: () => void
}

export default function FailureView({ message, onOpenSettings }: Props): JSX.Element {
  const app = useApp()
  const logTail = (app?.agentLog ?? []).slice(-12)

  return (
    <div className="failure-view">
      <span className="failure-icon">
        <WarningIcon size={40} />
      </span>
      <div className="failure-title">Something went wrong</div>
      <div className="failure-message">{message}</div>
      {logTail.length > 0 && (
        <div className="card failure-log">
          {logTail.map((line, i) => (
            <div key={i} className="log-line">
              {line}
            </div>
          ))}
        </div>
      )}
      <div className="failure-buttons">
        <button className="btn" onClick={onOpenSettings}>
          Open Settings
        </button>
        <button className="btn btn--prominent" onClick={() => void call('retryBootstrap')}>
          Retry
        </button>
      </div>
    </div>
  )
}

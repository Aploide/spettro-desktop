// Port of the private FailureView in ContentView.swift, reworded: what went
// wrong in one sentence a person can act on (shared/humanize.ts), the one
// button that is most likely to fix it, and Settings beside it. The raw
// error and the engine's last output sit behind "Show details", with Copy
// Diagnostics for a bug report — available, never the first thing read.

import { humanizeError } from '@shared/humanize'
import { call, quietCall, useApp } from '@renderer/state/store'
import { openSettings } from '@renderer/state/shell'
import { DiagnosticsDisclosure } from '@renderer/views/common/Disclosure'
import { WarningIcon } from './icons'

interface Props {
  message: string
  onOpenSettings: () => void
}

export default function FailureView({ message, onOpenSettings }: Props): JSX.Element {
  const app = useApp()
  const human = humanizeError(message)
  const kind = human.action?.kind ?? 'restart'

  // Reinstalling is the setup's install step; updating, its own pane. Every
  // other failure is worth one more start before anything else.
  const primary =
    kind === 'reinstall'
      ? {
          label: human.action?.label === 'Install Spettro' ? 'Install Spettro' : 'Reinstall Spettro',
          run: () => void call('installCLI')
        }
      : kind === 'update'
        ? { label: 'Check for Updates', run: () => openSettings('updates') }
        : { label: 'Try Again', run: () => void call('retryBootstrap') }

  return (
    <div className="failure-view">
      <span className="failure-icon">
        <WarningIcon size={40} />
      </span>
      <div className="failure-title">{human.known ? human.title : 'Spettro couldn’t start'}</div>
      <div className="failure-message">{human.detail}</div>
      <div className="failure-buttons">
        {kind === 'reinstall' ? (
          // The engine is the wrong file or a broken one: the other way out
          // is a different file, chosen right here.
          <button className="btn" onClick={() => void chooseAnotherFile()}>
            Choose Another File…
          </button>
        ) : (
          <button className="btn" onClick={onOpenSettings}>
            Open Settings
          </button>
        )}
        <button className="btn btn--prominent" onClick={primary.run}>
          {primary.label}
        </button>
      </div>
      <div className="failure-details">
        <DiagnosticsDisclosure error={human.raw} log={app?.agentLog ?? []} />
      </div>
    </div>
  )
}

/** A native file picker for the engine; cancelling it changes nothing. */
async function chooseAnotherFile(): Promise<void> {
  const path = await quietCall('pickExecutable')
  if (path) await call('useExplicitCLIPath', path)
}

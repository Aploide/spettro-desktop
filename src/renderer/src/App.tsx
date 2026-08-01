// Port of ContentView.swift + the SpettroApp command layer: routes exactly one
// screen per app phase, hosts the app-wide sheets (permission, question,
// settings, remote access) so they are reachable in every phase, shows the
// transient banner as a top toast, and binds the global keyboard shortcuts.

import { useEffect, useState } from 'react'
import './design/theme.css'
import './design/shell.css'
import { call, ensureChatLoaded, getState, initStore, useApp, useStore } from './state/store'
import LoadingView from './views/shell/LoadingView'
import FailureView from './views/shell/FailureView'
import Sidebar from './views/shell/Sidebar'
import ProjectPickerView from './views/shell/ProjectPickerView'
import OnboardingView from './views/shell/OnboardingView'
import SettingsView, { type SettingsPane } from './views/shell/SettingsView'
import { defaultProjectPath } from './views/shell/util'
import ChatView from '@renderer/views/chat/ChatView'
import PermissionSheet from '@renderer/views/sheets/PermissionSheet'
import QuestionSheet from '@renderer/views/sheets/QuestionSheet'
import RemoteAccessView from '@renderer/views/remote/RemoteAccessView'
import ConnectProvidersView from '@renderer/views/providers/ConnectProvidersView'

export default function App(): JSX.Element {
  const app = useApp()
  const permissions = useStore((s) => s.permissions)
  const questions = useStore((s) => s.questions)

  // Settings sheet visibility is local renderer state (the sidebar gear, the
  // failure view, and Ctrl/Cmd+, all funnel here); the value doubles as the
  // pane the sheet opens on.
  const [settingsPane, setSettingsPane] = useState<SettingsPane | null>(null)
  const [remoteOpen, setRemoteOpen] = useState(false)

  // Port of AppModel.providerSetupSkipped: the user chose to continue without
  // finishing provider setup, so the gate doesn't pull them back. The chat
  // will fail on its first prompt if nothing is connected, which is theirs to
  // decide — being unable to reach settings, sessions, or the sidebar is not a
  // reasonable price for an unfinished setup step.
  const [providerSetupSkipped, setProviderSetupSkipped] = useState(false)

  useEffect(() => {
    initStore()
  }, [])

  // Keep the selected chat's detail loaded so the sidebar footer (model label)
  // and ChatView have data the moment the selection lands.
  const selectedId = app?.selectedSessionId ?? null
  useEffect(() => {
    if (selectedId) void ensureChatLoaded(selectedId)
  }, [selectedId])

  // Global shortcuts: Ctrl/Cmd+N new chat (ready only), Ctrl/Cmd+, settings,
  // Ctrl/Cmd+Shift+R remote access, Escape closes the topmost shell sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (remoteOpen) setRemoteOpen(false)
        else if (settingsPane) setSettingsPane(null)
        return
      }
      if (!(e.metaKey || e.ctrlKey)) return
      const key = e.key.toLowerCase()
      if (key === 'n' && !e.shiftKey && !e.altKey) {
        const state = getState().app
        if (state?.phase.kind === 'ready') {
          e.preventDefault()
          void call('newChat', defaultProjectPath(state))
        }
      } else if (e.key === ',') {
        e.preventDefault()
        setSettingsPane('account')
      } else if (key === 'r' && e.shiftKey) {
        e.preventDefault()
        setRemoteOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [remoteOpen, settingsPane])

  // The transient banner toast. It re-arms whenever the banner text changes
  // and hides itself; onboarding shows the same banner inline, so the toast
  // stays out of the way there.
  const banner = app?.banner ?? null
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => {
    if (!banner) {
      setToast(null)
      return
    }
    setToast(banner)
    const timer = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(timer)
  }, [banner])

  const phase = app?.phase ?? { kind: 'locating' as const }
  const onboarding = phase.kind === 'needsSetup' || phase.kind === 'installing'

  return (
    <div className="app-root">
      {renderPhase()}

      {settingsPane && <SettingsView initialPane={settingsPane} onClose={() => setSettingsPane(null)} />}

      {remoteOpen && (
        <div className="sheet-backdrop">
          <div className="sheet-card remote-card">
            <div className="remote-sheet-body">
              <RemoteAccessView />
            </div>
            <div className="divider" />
            <div className="sheet-footer">
              <span />
              <button className="btn btn--prominent" onClick={() => setRemoteOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* The agent's turn blocks on these, so they sit above everything and
          are available in every phase — first in, first out. */}
      {questions.length > 0 && <QuestionSheet request={questions[0]} />}
      {permissions.length > 0 && <PermissionSheet request={permissions[0]} />}

      {toast && !onboarding && <div className="toast">{toast}</div>}
    </div>
  )

  function renderPhase(): JSX.Element {
    switch (phase.kind) {
      case 'locating':
      case 'connecting':
        return (
          <LoadingView
            message={
              phase.kind === 'connecting' ? 'Starting the Spettro agent…' : 'Looking for the Spettro CLI…'
            }
          />
        )
      case 'needsSetup':
      case 'installing':
        return <OnboardingView />
      case 'failed':
        return <FailureView message={phase.message} onOpenSettings={() => setSettingsPane('agent')} />
      case 'needsProvider':
        // The CLI is running but has no model to run: finish setup here rather
        // than dropping the user into a chat that would fail on its first
        // prompt. Skipping falls through to the normal shell below.
        if (!providerSetupSkipped) {
          return (
            <ConnectProvidersView
              presentation="gate"
              isOnboarding
              // Main re-evaluates the gate when the extension state refreshes,
              // which is what moves the phase back to `ready`.
              onComplete={() => void call('refreshExtensions')}
              onSkip={() => {
                // Main owns the gate (`skipProviderSetup` moves the phase to
                // ready and keeps it there); the local flag releases the
                // screen immediately either way.
                void call('skipProviderSetup')
                setProviderSetupSkipped(true)
              }}
            />
          )
        }
      // falls through — a skipped gate behaves exactly like `ready`.
      case 'needsProject':
      case 'ready':
        return (
          <div className="split">
            <Sidebar
              onOpenSettings={() => setSettingsPane('account')}
              onOpenRemote={() => setRemoteOpen(true)}
            />
            <div className="detail">
              {phase.kind !== 'needsProject' && selectedId ? (
                // Keyed by session id so switching chats rebuilds the whole
                // chat hierarchy instead of diffing two conversations.
                <ChatView key={selectedId} chatId={selectedId} />
              ) : (
                <ProjectPickerView />
              )}
            </div>
          </div>
        )
    }
  }
}

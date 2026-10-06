// Port of ContentView.swift + the SpettroApp command layer: routes exactly one
// screen per app phase, hosts the app-wide sheets (settings, remote access,
// and the fallback for an approval no chat claims) so they are reachable in
// every phase, shows the transient banner as a top toast, and binds the
// global keyboard shortcuts.
//
// Once the agent is up the shell is persistent, like the Claude Code tab: the
// sidebar stays put (unless collapsed with Ctrl/Cmd+B) and the main column
// shows either the selected session or the new-session empty state.

import { useEffect, useState } from 'react'
import './design/theme.css'
import './design/shell.css'
import { call, ensureChatLoaded, getState, initStore, useApp, useStore } from './state/store'
import { focusComposer, startNewSession, toggleSidebar, toggleTerminal, useShell } from './state/shell'
import LoadingView from './views/shell/LoadingView'
import FailureView from './views/shell/FailureView'
import Sidebar from './views/shell/Sidebar'
import NewSessionView from './views/shell/NewSessionView'
import QuickSwitcher from './views/shell/QuickSwitcher'
import OnboardingView from './views/shell/OnboardingView'
import SettingsView, { type SettingsPane } from './views/shell/SettingsView'
import { visibleSessionOrder } from './views/shell/sessionGroups'
import { isMac } from './views/shell/util'
import ChatView from '@renderer/views/chat/ChatView'
import PermissionCard from '@renderer/views/chat/PermissionCard'
import QuestionCard from '@renderer/views/chat/QuestionCard'
import RemoteAccessView from '@renderer/views/remote/RemoteAccessView'
import ConnectProvidersView from '@renderer/views/providers/ConnectProvidersView'
import WorkflowStudio from '@renderer/views/workflows/WorkflowStudio'

export default function App(): JSX.Element {
  const app = useApp()
  const permissions = useStore((s) => s.permissions)
  const questions = useStore((s) => s.questions)

  // Settings sheet visibility is local renderer state (the sidebar gear, the
  // failure view, and Ctrl/Cmd+, all funnel here); the value doubles as the
  // pane the sheet opens on.
  const [settingsPane, setSettingsPane] = useState<SettingsPane | null>(null)
  const [remoteOpen, setRemoteOpen] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const sidebarCollapsed = useShell((s) => s.sidebarCollapsed)
  // The studio is pinned to the chat that opened it, not to whatever is
  // selected now: it holds an unsaved draft, and having the project shift out
  // from under an editor mid-edit would be a good way to save into the wrong
  // repo.
  const [workflowsChatId, setWorkflowsChatId] = useState<string | null>(null)

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

  // Global shortcuts. Ctrl/Cmd+N new session, +B sidebar, +K switch session,
  // +L focus the composer, +1…9 the Nth session in the sidebar, +, settings,
  // +Shift+R remote access, +Shift+W workflows; Ctrl+` the terminal; Escape
  // closes the topmost shell sheet.
  //
  // Inside the terminal every key belongs to the shell (Ctrl+N is its history,
  // Ctrl+K kills a line, Ctrl+L clears), so none of these fire there — except
  // Ctrl+`, which is how you get out of it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const state = getState().app
      const phase = state?.phase.kind
      const sheetOpen = remoteOpen || workflowsChatId !== null || settingsPane !== null
      const shellUp =
        phase === 'ready' ||
        phase === 'needsProject' ||
        (phase === 'needsProvider' && providerSetupSkipped)

      if (e.ctrlKey && !e.metaKey && !e.altKey && (e.code === 'Backquote' || e.key === '`')) {
        if (shellUp && !sheetOpen && state?.selectedSessionId) {
          e.preventDefault()
          toggleTerminal()
        }
        return
      }
      if (e.target instanceof Element && e.target.closest('.xterm')) return

      if (e.key === 'Escape') {
        if (switcherOpen) setSwitcherOpen(false)
        else if (remoteOpen) setRemoteOpen(false)
        else if (workflowsChatId) setWorkflowsChatId(null)
        else if (settingsPane) setSettingsPane(null)
        return
      }
      // Cmd on macOS, Ctrl elsewhere: on a Mac, Ctrl+K and friends are text
      // editing keys in every field and must keep working.
      if (!(isMac() ? e.metaKey : e.ctrlKey) || e.altKey) return
      const key = e.key.toLowerCase()
      if (e.key === ',') {
        e.preventDefault()
        setSettingsPane('general')
      } else if (key === 'r' && e.shiftKey) {
        e.preventDefault()
        setRemoteOpen(true)
      } else if (key === 'w' && e.shiftKey) {
        const selected = state?.selectedSessionId ?? null
        if (selected) {
          e.preventDefault()
          setWorkflowsChatId(selected)
        }
      } else if (!shellUp || e.shiftKey || sheetOpen) {
        // A sheet (Settings, Workflows, Remote) is in front: changing the
        // session or the layout behind it would happen out of sight.
        return
      } else if (key === 'n') {
        e.preventDefault()
        startNewSession()
      } else if (key === 'b') {
        e.preventDefault()
        toggleSidebar()
      } else if (key === 'k') {
        e.preventDefault()
        setSwitcherOpen((open) => !open)
      } else if (key === 'l') {
        e.preventDefault()
        focusComposer()
      } else if (/^[1-9]$/.test(e.key)) {
        const target = visibleSessionOrder(state?.sessions ?? [])[Number(e.key) - 1]
        if (target) {
          e.preventDefault()
          void call('openChat', target.id)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [remoteOpen, settingsPane, workflowsChatId, providerSetupSkipped, switcherOpen])

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

  // A prompt is shown inline when its chat can be on screen: a chat in the
  // sidebar, or the one selected (a draft that isn't listed yet).
  const isOrphan = (chatId: string | null): boolean =>
    chatId === null || (chatId !== selectedId && !app?.sessions.some((s) => s.id === chatId))
  const orphanPermission = permissions.find((p) => isOrphan(p.chatId))
  const orphanQuestion = questions.find((q) => isOrphan(q.chatId))

  const phase = app?.phase ?? { kind: 'locating' as const }
  const onboarding = phase.kind === 'needsSetup' || phase.kind === 'installing'

  return (
    <div className="app-root">
      {renderPhase()}

      {settingsPane && <SettingsView initialPane={settingsPane} onClose={() => setSettingsPane(null)} />}

      {switcherOpen && <QuickSwitcher onClose={() => setSwitcherOpen(false)} />}

      {workflowsChatId && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-panel modal-panel--workflows"
            role="dialog"
            aria-modal="true"
            aria-label="Workflows"
          >
            <WorkflowStudio chatId={workflowsChatId} onClose={() => setWorkflowsChatId(null)} />
          </div>
        </div>
      )}

      {remoteOpen && (
        <div className="modal-backdrop" role="presentation">
          <div
            className={
              'modal-panel modal-panel--remote' +
              (app?.remote?.pairingQR ? ' modal-panel--remote-pairing' : '')
            }
            role="dialog"
            aria-modal="true"
            aria-label="Remote Access"
          >
            {/* The view carries its own header (with the close button) and
                footer, so the panel adds chrome only — no nested card. */}
            <RemoteAccessView onClose={() => setRemoteOpen(false)} />
          </div>
        </div>
      )}

      {/* Approvals and questions are answered inline, above the composer of
          the chat that asked (PromptDock). One that no chat claims — its
          session belongs to no chat this window knows — still blocks the
          agent's turn, so it comes up here, over everything, first in first
          out. */}
      {orphanQuestion ? (
        <div className="prompt-backdrop" role="presentation">
          <QuestionCard key={orphanQuestion.id} request={orphanQuestion} presentation="sheet" />
        </div>
      ) : orphanPermission ? (
        <div className="prompt-backdrop" role="presentation">
          <PermissionCard key={orphanPermission.id} request={orphanPermission} presentation="sheet" />
        </div>
      ) : null}

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
            {!sidebarCollapsed && (
              <Sidebar
                onOpenSettings={(pane) => setSettingsPane(pane ?? 'general')}
                onOpenRemote={() => setRemoteOpen(true)}
                onOpenWorkflows={() => selectedId && setWorkflowsChatId(selectedId)}
              />
            )}
            <main className="detail">
              {phase.kind !== 'needsProject' && selectedId ? (
                // Keyed by session id so switching chats rebuilds the whole
                // chat hierarchy instead of diffing two conversations.
                <ChatView key={selectedId} chatId={selectedId} />
              ) : (
                <NewSessionView />
              )}
            </main>
          </div>
        )
    }
  }
}

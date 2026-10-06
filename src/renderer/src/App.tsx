// Port of ContentView.swift + the SpettroApp command layer: routes exactly one
// screen per app phase, hosts the app-wide sheets (settings, the workflow
// studio, and the fallback for an approval no chat claims) so they are
// reachable in every phase, draws the toasts and alerts, and binds the
// global keyboard shortcuts and the application menu's commands.
//
// Once the agent is up the shell is persistent, like the Claude Code tab: the
// sidebar stays put (unless collapsed with Ctrl/Cmd+B) and the main column
// shows either the selected session or the new-session empty state. It stays
// up through an engine restart, too — main keeps the phase and says
// "reconnecting" instead — so a crash or an update never unmounts a draft.

import { useEffect, useState } from 'react'
import './design/theme.css'
import './design/shell.css'
import type { MenuCommand } from '@shared/shortcuts'
import {
  call,
  ensureChatLoaded,
  getState,
  initStore,
  quietCall,
  setFailureReporter,
  useApp,
  useStore
} from './state/store'
import {
  closeSettings,
  focusComposer,
  openSettings,
  setNewSessionPath,
  startNewSession,
  toggleSidebar,
  toggleTerminal,
  useShell
} from './state/shell'
import { pendingDeletes, usePendingDeletes } from './state/pendingDeletes'
import LoadingView from './views/shell/LoadingView'
import FailureView from './views/shell/FailureView'
import Sidebar from './views/shell/Sidebar'
import NewSessionView from './views/shell/NewSessionView'
import QuickSwitcher from './views/shell/QuickSwitcher'
import SetupAssistant from './views/shell/OnboardingView'
import SettingsView from './views/shell/SettingsView'
import { reportActionFailure } from './views/shell/actions'
import { visibleSessionOrder } from './views/shell/sessionGroups'
import { isMac } from './views/shell/util'
import { ConfirmHost, isConfirmOpen } from './views/common/ConfirmDialog'
import { showToast, ToastHost } from './views/common/Toast'
import { mayClose } from './views/common/closeGuard'
import ChatView from '@renderer/views/chat/ChatView'
import PermissionCard from '@renderer/views/chat/PermissionCard'
import QuestionCard from '@renderer/views/chat/QuestionCard'
import WorkflowStudio from '@renderer/views/workflows/WorkflowStudio'

export default function App(): JSX.Element {
  const app = useApp()
  const permissions = useStore((s) => s.permissions)
  const questions = useStore((s) => s.questions)

  // Settings is opened from all over (the sidebar, Ctrl/Cmd+, the menu, a
  // toast, the composer's "Connect a model" bar), so its pane lives in the
  // shell store; null is closed.
  const settingsPane = useShell((s) => s.settingsPane)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const deleting = usePendingDeletes()
  const sidebarCollapsed = useShell((s) => s.sidebarCollapsed)
  // The studio is pinned to the chat that opened it, not to whatever is
  // selected now: it holds an unsaved draft, and having the project shift out
  // from under an editor mid-edit would be a good way to save into the wrong
  // repo.
  const [workflowsChatId, setWorkflowsChatId] = useState<string | null>(null)

  // Port of AppModel.providerSetupSkipped: the user chose to continue without
  // finishing provider setup, so the gate doesn't pull them back (main keeps
  // the choice across launches; the local flag releases the screen at once).
  // The composer's "Connect a model" bar stays as the way back.
  const [skippedHere, setSkippedHere] = useState(false)
  const providerSetupSkipped = skippedHere || app?.providerSetupSkipped === true

  useEffect(() => {
    // Every failed action becomes a toast in words from here on.
    setFailureReporter(reportActionFailure)
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
      // An alert is up: it owns the keyboard (it answers Escape itself).
      if (isConfirmOpen()) return
      const state = getState().app
      const phase = state?.phase.kind
      const sheetOpen = workflowsChatId !== null || settingsPane !== null
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
        // The studio and Settings may hold unsaved edits: they are asked
        // (mayClose) rather than dropped.
        if (switcherOpen) setSwitcherOpen(false)
        else if (workflowsChatId) void closeWorkflows()
        else if (settingsPane) void requestCloseSettings()
        return
      }
      // Cmd on macOS, Ctrl elsewhere: on a Mac, Ctrl+K and friends are text
      // editing keys in every field and must keep working.
      if (!(isMac() ? e.metaKey : e.ctrlKey) || e.altKey) return
      const key = e.key.toLowerCase()
      if (e.key === ',') {
        e.preventDefault()
        openSettings('general')
      } else if (key === 'r' && e.shiftKey) {
        e.preventDefault()
        openSettings('remote')
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
        const sessions = (state?.sessions ?? []).filter((s) => !pendingDeletes.isPending(s.id))
        const target = visibleSessionOrder(sessions)[Number(e.key) - 1]
        if (target) {
          e.preventDefault()
          void call('openChat', target.id)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsPane, workflowsChatId, providerSetupSkipped, switcherOpen])

  // The application menu's items (main/menu.ts): the same actions as the
  // shortcuts, for whoever looks for them there.
  useEffect(() => {
    return window.spettro.onEvent((event) => {
      if (event.type === 'menu') runMenuCommand(event.command)
    })
  })

  // Main's one-off messages (a bad CLI path, the engine restarting). Keyed
  // on the nonce, so the same message twice is shown twice. Setup shows its
  // own inline.
  // The banner is read from the snapshot this render saw, not the store at
  // effect time: main clears it right after sending, and the next app-state
  // can land before the effect runs.
  const bannerNonce = app?.bannerNonce ?? 0
  const banner = app?.banner ?? null
  const bannerPhase = app?.phase.kind
  useEffect(() => {
    if (!banner || bannerNonce === 0) return
    if (bannerPhase === 'needsSetup' || bannerPhase === 'installing') return
    showToast({ title: banner, key: 'banner' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bannerNonce])

  // A prompt is shown inline when its chat can be on screen: a chat in the
  // sidebar, or the one selected (a draft that isn't listed yet).
  const isOrphan = (chatId: string | null): boolean =>
    chatId === null || (chatId !== selectedId && !app?.sessions.some((s) => s.id === chatId))
  const orphanPermission = permissions.find((p) => isOrphan(p.chatId))
  const orphanQuestion = questions.find((q) => isOrphan(q.chatId))

  const phase = app?.phase ?? { kind: 'locating' as const }

  async function closeWorkflows(): Promise<void> {
    if (await mayClose('workflows')) setWorkflowsChatId(null)
  }

  async function requestCloseSettings(): Promise<void> {
    if (await mayClose('settings')) closeSettings()
  }

  function runMenuCommand(command: MenuCommand): void {
    const state = getState().app
    const kind = state?.phase.kind
    const shellUp = kind === 'ready' || (kind === 'needsProvider' && providerSetupSkipped)
    switch (command) {
      case 'settings':
        openSettings('general')
        break
      case 'shortcuts':
        openSettings('shortcuts')
        break
      case 'about':
        openSettings('about')
        break
      case 'remote':
        openSettings('remote')
        break
      case 'new-session':
        if (shellUp) startNewSession()
        break
      case 'open-folder':
        if (!shellUp) break
        void quietCall('pickFolder').then((path) => {
          if (!path) return
          startNewSession(path)
          setNewSessionPath(path)
          void call('rememberProject', path)
        })
        break
      case 'toggle-sidebar':
        if (shellUp) toggleSidebar()
        break
      case 'toggle-terminal':
        if (shellUp && state?.selectedSessionId) toggleTerminal()
        break
      case 'quick-switcher':
        if (shellUp) setSwitcherOpen(true)
        break
      case 'focus-composer':
        if (shellUp) focusComposer()
        break
      case 'workflows':
        if (state?.selectedSessionId) setWorkflowsChatId(state.selectedSessionId)
        break
    }
  }

  return (
    <div className="app-root">
      {renderPhase()}

      {settingsPane && <SettingsView pane={settingsPane} onClose={() => void requestCloseSettings()} />}

      {switcherOpen && <QuickSwitcher onClose={() => setSwitcherOpen(false)} hidden={deleting} />}

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

      <ConfirmHost />
      <ToastHost />
    </div>
  )

  function renderPhase(): JSX.Element {
    switch (phase.kind) {
      case 'locating':
      case 'connecting':
        return <LoadingView message="Starting Spettro…" onOpenSettings={() => openSettings('advanced')} />
      case 'needsSetup':
      case 'installing':
        // Setup, step 1 of 2: install the helper app.
        return <SetupAssistant step="install" />
      case 'failed':
        return <FailureView message={phase.message} onOpenSettings={() => openSettings('advanced')} />
      case 'needsProvider':
        // Setup, step 2 of 2: the CLI is running but has no model to run.
        // Finish here rather than dropping the user into a chat that would
        // fail on its first prompt. Skipping falls through to the shell.
        if (!providerSetupSkipped) {
          return (
            <SetupAssistant
              step="connect"
              onSkip={() => {
                // Main owns the gate (`skipProviderSetup` moves the phase to
                // ready and remembers the choice); the local flag releases
                // the screen immediately either way.
                void call('skipProviderSetup')
                setSkippedHere(true)
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
              <Sidebar onOpenWorkflows={() => selectedId && setWorkflowsChatId(selectedId)} />
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

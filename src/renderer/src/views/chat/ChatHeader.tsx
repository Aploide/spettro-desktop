// The chat's slim (44px) title bar, after ChatHeaderView.swift (doc 22) and
// the Claude Code tab: the session title, which you click to rename in place,
// a muted `project › branch` breadcrumb, and on the right the uncommitted-change
// chip, the context-window ring and the terminal toggle. While the sidebar is
// collapsed its reopen button leads the bar, where the sidebar's own was.
// While the engine restarts underneath (a crash, an update, Restart Engine)
// a "Reconnecting…" pill sits in the bar — the only sign of it besides Send
// waiting; nothing on screen is unmounted.

import { useEffect, useRef, useState } from 'react'
import type { ACPUsage } from '@shared/acp'
import type { ChatDetail, GitStat } from '@shared/model'
import { call, useApp, useStore } from '@renderer/state/store'
import { startNewSession, toggleSidebar, toggleTerminal, useShell } from '@renderer/state/shell'
import { Icon } from '@renderer/design/icons'
import InlineRename from '@renderer/views/shell/InlineRename'
import { withShortcut } from '@renderer/views/shell/util'
import { DiffStatLabel } from './transcript/ToolCallView'

/** `projectURL.lastPathComponent` — works for both / and \ separators. */
export function projectName(projectPath: string): string {
  const parts = projectPath.replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts[parts.length - 1] || projectPath
}

/** Ctrl+` everywhere, macOS included — it is the terminal toggle people
 *  already know from their editor. */
export const TERMINAL_SHORTCUT = 'Ctrl+`'

export default function ChatHeader({ chat }: { chat: ChatDetail }): JSX.Element {
  const git = useGitStat(chat.projectPath, chat.isBusy)
  const name = projectName(chat.projectPath)
  const [renaming, setRenaming] = useState(false)
  const terminalVisible = useShell((s) => s.terminalVisible)

  return (
    <header className="chat-header">
      <SidebarReopenButton withNewSession />
      <div className="chat-header-titles">
        {renaming ? (
          <InlineRename
            chatId={chat.id}
            title={chat.title}
            className="chat-header-rename"
            onDone={() => setRenaming(false)}
          />
        ) : (
          <button
            type="button"
            className="chat-header-title"
            title="Rename session"
            onClick={() => setRenaming(true)}
          >
            {chat.title}
          </button>
        )}
        <span className="chat-header-crumb" title={chat.projectPath}>
          <span className="chat-header-crumb-part">{name}</span>
          {git.branch && (
            <>
              <span className="chat-header-crumb-sep" aria-hidden>
                ›
              </span>
              <span className="chat-header-crumb-part">{git.branch}</span>
            </>
          )}
        </span>
      </div>
      <div className="chat-header-spacer" />
      <ReconnectingPill />
      <div className="chat-header-chips">
        {git.files.length > 0 && <GitStatChip git={git} projectPath={chat.projectPath} />}
        {chat.usage && <ContextMeter usage={chat.usage} />}
        <button
          type="button"
          className={'header-btn' + (terminalVisible ? ' header-btn--on' : '')}
          title={`${terminalVisible ? 'Hide terminal' : 'Show terminal'} (${TERMINAL_SHORTCUT})`}
          aria-label="Terminal"
          aria-pressed={terminalVisible}
          onClick={toggleTerminal}
        >
          <Icon name="terminal" size={15} />
        </button>
      </div>
    </header>
  )
}

/** "Reconnecting…" while the engine restarts under the window; nothing
 *  otherwise. */
export function ReconnectingPill(): JSX.Element | null {
  const reconnecting = useApp()?.connection === 'reconnecting'
  if (!reconnecting) return null
  return (
    <span className="reconnecting-pill" role="status" data-testid="reconnecting">
      <span className="reconnecting-dot" aria-hidden />
      Reconnecting…
    </span>
  )
}

/** Leads a title bar while the sidebar is collapsed — the way back is where
 *  the sidebar's own hide button was, and (in a chat) New session beside it,
 *  so starting over never depends on knowing the shortcut. Renders nothing
 *  while the sidebar is showing. */
export function SidebarReopenButton({ withNewSession = false }: { withNewSession?: boolean }): JSX.Element | null {
  const collapsed = useShell((s) => s.sidebarCollapsed)
  // With the sidebar away, its "Needs you" badges are too: the button says
  // that another session is waiting on you.
  const selectedId = useApp()?.selectedSessionId ?? null
  const elsewhere = useStore(
    (s) =>
      s.permissions.some((p) => p.chatId !== null && p.chatId !== selectedId) ||
      s.questions.some((q) => q.chatId !== null && q.chatId !== selectedId)
  )
  if (!collapsed) return null
  return (
    <>
      <button
        type="button"
        className="header-btn header-btn--badged"
        title={elsewhere ? 'Show sidebar — another session needs you' : withShortcut('Show sidebar', 'B')}
        aria-label={elsewhere ? 'Show sidebar (another session needs you)' : 'Show sidebar'}
        onClick={toggleSidebar}
      >
        <Icon name="sidebar.left" size={15} />
        {elsewhere && <span className="header-btn-badge" aria-hidden="true" />}
      </button>
      {withNewSession && (
        <button
          type="button"
          className="header-btn"
          title={withShortcut('New session', 'N')}
          aria-label="New session"
          onClick={() => startNewSession()}
        >
          <Icon name="square.and.pencil" size={15} />
        </button>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Popover plumbing (shared by the chips below)
// ---------------------------------------------------------------------------

/** Closes an open popover on outside pointerdown or Escape. */
export function useDismiss(open: boolean, onClose: () => void): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])
  return ref
}

// ---------------------------------------------------------------------------
// Git stat chip
// ---------------------------------------------------------------------------

/** GitStatModel port: polls the main-process `gitStat` endpoint every 5s and
 *  immediately when the session's busy state flips (the Swift `refreshSoon`
 *  triggers). */
function useGitStat(projectPath: string, isBusy: boolean): GitStat {
  const [stat, setStat] = useState<GitStat>({ branch: '', files: [] })
  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      void call('gitStat', projectPath).then((s) => {
        if (alive) setStat(s)
      })
    }
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [projectPath, isBusy])
  return stat
}

function GitStatChip({ git, projectPath }: { git: GitStat; projectPath: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  const added = git.files.reduce((sum, f) => sum + f.added, 0)
  const removed = git.files.reduce((sum, f) => sum + f.removed, 0)

  return (
    <div className="chip-wrap" ref={ref}>
      <button
        type="button"
        className="chip"
        title={`Uncommitted changes in ${projectName(projectPath)}`}
        onClick={() => setOpen((o) => !o)}
      >
        <PlusMinusIcon />
        <DiffStatLabel added={added} removed={removed} />
      </button>
      {open && (
        <div className="popover popover--git">
          <div className="popover-heading">Uncommitted changes</div>
          {git.files.slice(0, 14).map((file) => (
            <div className="git-file-row" key={file.path}>
              <span className="git-file-path">{file.path}</span>
              <DiffStatLabel added={file.added} removed={file.removed} />
            </div>
          ))}
          {git.files.length > 14 && (
            <div className="git-file-more">… {git.files.length - 14} more files</div>
          )}
        </div>
      )}
    </div>
  )
}

function PlusMinusIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5 6.2h6M8 3.2v6M5 10.6h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Context window meter
// ---------------------------------------------------------------------------

const RING_SIZE = 13
const RING_STROKE = 2.5
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

function ContextMeter({ usage }: { usage: ACPUsage }): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))

  const fraction = Math.min(1, Math.max(0, usage.used / usage.size))
  const ringColor =
    fraction > 0.9 ? 'var(--diff-removed)' : fraction > 0.75 ? 'var(--mode-yellow)' : 'var(--accent)'

  return (
    <div className="chip-wrap" ref={ref}>
      <button
        type="button"
        className="chip"
        title="Context window used"
        onClick={() => setOpen((o) => !o)}
      >
        <svg
          className="context-ring"
          width={RING_SIZE}
          height={RING_SIZE}
          viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        >
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            stroke="var(--text-secondary)"
            strokeOpacity={0.45}
            strokeWidth={RING_STROKE}
          />
          <circle
            className="context-ring-fill"
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            stroke={ringColor}
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={RING_CIRCUMFERENCE * (1 - fraction)}
            transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
          />
        </svg>
        <span className="chip-label mono-digits">{percentLabel(fraction)}</span>
      </button>
      {open && (
        <div className="popover popover--context">
          <div className="popover-heading">Context window</div>
          <div className="context-usage-line">
            {formatTokens(usage.used)} of {formatTokens(usage.size)} tokens ({percentLabel(fraction)})
          </div>
          {usage.tokensUsed != null && usage.tokensUsed > usage.used && (
            <div className="context-total-line">
              Total processed: {formatTokens(usage.tokensUsed)} tokens
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** ContextMeter.percentLabel — whole percents; non-zero below 1% is "<1%". */
export function percentLabel(fraction: number): string {
  const percent = Math.round(fraction * 100)
  if (percent === 0 && fraction > 0) return '<1%'
  return `${percent}%`
}

/** ContextMeter.tokens — "1.2k" / "3.4M" abbreviation. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}

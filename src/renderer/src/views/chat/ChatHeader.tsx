// Port of Platforms/macOS/Views/ChatHeaderView.swift (doc 22): chat title and
// project on the left; plan chip, git stat chip, and context-window ring on
// the right.

import { useEffect, useRef, useState } from 'react'
import type { ACPPlanEntry, ACPUsage } from '@shared/acp'
import type { ChatDetail, GitStat } from '@shared/model'
import { call } from '@renderer/state/store'
import { DiffStatLabel } from './transcript/ToolCallView'

/** `projectURL.lastPathComponent` — works for both / and \ separators. */
export function projectName(projectPath: string): string {
  const parts = projectPath.replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts[parts.length - 1] || projectPath
}

export default function ChatHeader({ chat }: { chat: ChatDetail }): JSX.Element {
  const git = useGitStat(chat.projectPath, chat.isBusy)
  const name = projectName(chat.projectPath)
  return (
    <div className="chat-header">
      <div className="chat-header-titles">
        <div className="chat-header-title">{chat.title}</div>
        <div className="chat-header-project">
          <FolderIcon />
          <span className="chat-header-project-name">
            {git.branch ? `${name} · ${git.branch}` : name}
          </span>
        </div>
      </div>
      <div className="chat-header-spacer" />
      <div className="chat-header-chips">
        {chat.plan.length > 0 && <PlanChip entries={chat.plan} />}
        {git.files.length > 0 && <GitStatChip git={git} projectPath={chat.projectPath} />}
        {chat.usage && <ContextMeter usage={chat.usage} />}
      </div>
    </div>
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
// Plan chip
// ---------------------------------------------------------------------------

function PlanChip({ entries }: { entries: ACPPlanEntry[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  const completed = entries.filter((e) => e.status === 'completed').length

  return (
    <div className="chip-wrap" ref={ref}>
      <button
        type="button"
        className="chip"
        title="Agent plan"
        onClick={() => setOpen((o) => !o)}
      >
        <ChecklistIcon />
        <span className="chip-label mono-digits">
          {completed}/{entries.length}
        </span>
      </button>
      {open && (
        <div className="popover popover--plan">
          <div className="popover-heading">Plan</div>
          {entries.map((entry, i) => (
            <div className="plan-row" key={i}>
              <span
                className={
                  'plan-row-icon' + (entry.status === 'completed' ? ' plan-row-icon--done' : '')
                }
              >
                <PlanStatusIcon status={entry.status} />
              </span>
              <span
                className={'plan-row-text' + (entry.status === 'completed' ? ' plan-row-text--done' : '')}
              >
                {entry.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
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

// ---------------------------------------------------------------------------
// Icons (SF Symbol stand-ins)
// ---------------------------------------------------------------------------

function FolderIcon(): JSX.Element {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3l1.5 2H13a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5v-8Z"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  )
}

function ChecklistIcon(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M2 4.5 3.3 6 6 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.5 4.5H14M8.5 11.5H14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M2 11.5 3.3 13 6 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PlanStatusIcon({ status }: { status: string }): JSX.Element {
  if (status === 'completed') {
    // checkmark.circle.fill
    return (
      <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path
          d="m5 8.2 2 2.1 4-4.6"
          stroke="var(--canvas)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    )
  }
  if (status === 'in_progress') {
    // circle.dotted.circle
    return (
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
        <circle
          cx="8"
          cy="8"
          r="7"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeDasharray="2 2.4"
          strokeLinecap="round"
        />
        <circle cx="8" cy="8" r="3.4" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    )
  }
  // circle
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

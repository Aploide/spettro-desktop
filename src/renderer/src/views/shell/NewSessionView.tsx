// The new-session empty state: what the main column shows when no session is
// selected. It replaces the old full-window project picker with the Claude
// Code tab's arrangement — a greeting, the composer, and a "Working in" chip
// that says (and changes) which folder the session will work in — so starting
// is "type and press Enter", and picking a folder is a detail of that rather
// than a gate in front of it.
//
// No chat exists until the first message is sent: sending creates the chat in
// the chosen folder and hands it the message, and the column becomes that
// chat. Nothing is created by looking at this screen or changing the folder.

import { useCallback, useState } from 'react'
import { call, useApp } from '@renderer/state/store'
import { setNewSessionPath, useShell } from '@renderer/state/shell'
import { Icon } from '@renderer/design/icons'
import Composer, { draftChat, type PromptSeed, type SubmitAttachment } from '@renderer/views/chat/Composer'
import { SidebarReopenButton, useDismiss } from '@renderer/views/chat/ChatHeader'
import StarterPrompts from '@renderer/views/chat/StarterPrompts'
import { basename, isBroadFolder } from './util'

export default function NewSessionView(): JSX.Element {
  const app = useApp()
  const chosen = useShell((s) => s.newSessionPath)
  const path = chosen ?? app?.defaultProjectPath ?? ''
  const homePath = app?.homePath ?? ''
  const missing = (app?.missingProjects ?? []).includes(path)
  const broad = path !== '' && isBroadFolder(path, homePath)

  // Folders the user has already said "Continue" for, this run.
  const [acknowledged, setAcknowledged] = useState<string[]>([])
  const [nudge, setNudge] = useState(0)
  const [promptSeed, setPromptSeed] = useState<PromptSeed | null>(null)
  const needsConfirm = broad && !acknowledged.includes(path)

  const choose = useCallback((next: string): void => {
    setNewSessionPath(next)
    void call('rememberProject', next)
  }, [])

  const pickFolder = useCallback(async (): Promise<void> => {
    const picked = await call('pickFolder')
    if (picked) choose(picked)
  }, [choose])

  const submit = (text: string, attachments: SubmitAttachment[]): boolean => {
    if (missing || needsConfirm) {
      // Keep the message and point at what needs answering first.
      setNudge((n) => n + 1)
      return false
    }
    void (async () => {
      const chatId = await call('newChat', path)
      if (chatId) await call('send', chatId, text, attachments)
    })()
    return true
  }

  return (
    <div className="new-session">
      <div className="new-session-bar">
        <SidebarReopenButton />
      </div>
      <div className="new-session-body">
        <h1 className="new-session-greeting">What should we build?</h1>
        <div className="new-session-composer">
          <Composer chat={draftChat(path)} promptSeed={promptSeed} onSubmit={submit} />
        </div>
        <div className="new-session-meta">
          <ProjectChip
            path={path}
            missing={missing}
            recents={app?.recentProjects ?? []}
            missingProjects={app?.missingProjects ?? []}
            onChoose={choose}
            onPickFolder={() => void pickFolder()}
          />
        </div>
        {missing ? (
          <FolderNotice key={`m${nudge}`} nudged={nudge > 0} tone="danger">
            <span className="new-session-notice-text">
              {basename(path)} can&rsquo;t be found. It may have been moved or deleted.
            </span>
            <button type="button" className="btn btn--small" onClick={() => void pickFolder()}>
              Choose Folder…
            </button>
          </FolderNotice>
        ) : needsConfirm ? (
          <FolderNotice key={`b${nudge}`} nudged={nudge > 0} tone="warning">
            <span className="new-session-notice-text">
              {path.replace(/[/\\]+$/, '') === homePath.replace(/[/\\]+$/, '')
                ? 'Spettro will be able to read everything in your home folder.'
                : 'Spettro will be able to read everything on this computer.'}{' '}
              Choose a project folder instead?
            </span>
            <button type="button" className="btn btn--small" onClick={() => setAcknowledged((a) => [...a, path])}>
              Continue
            </button>
            <button type="button" className="btn btn--small btn--prominent" onClick={() => void pickFolder()}>
              Choose Folder…
            </button>
          </FolderNotice>
        ) : null}
        <StarterPrompts onPrompt={(text) => setPromptSeed({ text, nonce: Date.now() })} />
      </div>
    </div>
  )
}

function FolderNotice({
  tone,
  nudged,
  children
}: {
  tone: 'warning' | 'danger'
  nudged: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <div
      className={`new-session-notice new-session-notice--${tone}${nudged ? ' new-session-notice--nudge' : ''}`}
      role={nudged ? 'alert' : 'status'}
    >
      <Icon name="exclamationmark.triangle" size={14} />
      {children}
    </div>
  )
}

// ------------------------------------------------------------ folder chip

/** "Working in ▸ acme-web". Opens the recents, each removable, plus Choose
 *  folder…; a recent that no longer exists is greyed with "Folder not found"
 *  rather than failing when clicked. */
function ProjectChip({
  path,
  missing,
  recents,
  missingProjects,
  onChoose,
  onPickFolder
}: {
  path: string
  missing: boolean
  recents: string[]
  missingProjects: string[]
  onChoose: (path: string) => void
  onPickFolder: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const ref = useDismiss(open, close)
  // The current folder is always offered, even before it is a recent.
  const rows = recents.includes(path) || path === '' ? recents : [path, ...recents]

  return (
    <div className="chip-wrap" ref={ref}>
      <button
        type="button"
        className={'project-chip' + (missing ? ' project-chip--missing' : '')}
        aria-haspopup="menu"
        aria-expanded={open}
        title={path}
        onClick={() => setOpen((o) => !o)}
        data-testid="project-chip"
      >
        <span className="project-chip-caption">Working in</span>
        <Icon name="folder" size={13} />
        <span className="project-chip-name">{path ? basename(path) : 'Choose a folder'}</span>
        <Icon name="chevron.down" size={9} />
      </button>
      {open && (
        <div className="popover project-menu" role="menu" aria-label="Project folder">
          {rows.length > 0 && <div className="project-menu-caption">Recent folders</div>}
          {rows.map((p) => {
            const gone = missingProjects.includes(p)
            return (
              <div
                key={p}
                className={'project-menu-row' + (gone ? ' project-menu-row--missing' : '')}
              >
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={p === path}
                  className="project-menu-choose"
                  disabled={gone}
                  title={p}
                  onClick={() => {
                    onChoose(p)
                    close()
                  }}
                >
                  <span className="project-menu-check">
                    {p === path && <Icon name="checkmark" size={11} />}
                  </span>
                  <span className="project-menu-text">
                    <span className="project-menu-name">{basename(p)}</span>
                    <span className="project-menu-path">{gone ? 'Folder not found' : p}</span>
                  </span>
                </button>
                {recents.includes(p) && (
                  <button
                    type="button"
                    className="project-menu-remove"
                    title="Remove from recents"
                    aria-label={`Remove ${basename(p)} from recents`}
                    onClick={() => void call('removeRecentProject', p)}
                  >
                    <Icon name="xmark.circle.fill" size={12} />
                  </button>
                )}
              </div>
            )
          })}
          {rows.length > 0 && <div className="project-menu-separator" />}
          <button
            type="button"
            role="menuitem"
            className="project-menu-choose project-menu-pick"
            onClick={() => {
              close()
              onPickFolder()
            }}
          >
            <span className="project-menu-check">
              <Icon name="folder.badge.plus" size={12} />
            </span>
            <span className="project-menu-name">Choose folder…</span>
          </button>
        </div>
      )}
    </div>
  )
}

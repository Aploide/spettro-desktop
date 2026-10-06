// The session sidebar, after the Claude Code tab: a "New session" row and a
// quiet search field on top; sessions grouped under their project's name,
// most recent first, with pinned ones lifted and archived ones tucked into a
// collapsed section; and an account row with Settings at the bottom.
//
// Every row action is reachable two ways — right-click, or the "…" button a
// row shows on hover and focus — and both open the same menu, so nothing
// depends on discovering the secondary click. The sidebar is resizable from
// its right edge and collapsible (Ctrl/Cmd+B); both live in state/shell.ts.
//
// Delete… asks, then hides the row with eight seconds to Undo (actions.ts);
// a row on its way out is simply not drawn. The update row asks before it
// stops running work.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatSummary } from '@shared/model'
import { isUpdateBusy, type UpdateState } from '@shared/update'
import { call, useApp, useStore } from '@renderer/state/store'
import { chatsNeedingYou } from '@renderer/views/chat/prompts'
import {
  SIDEBAR_DEFAULT_WIDTH,
  openSettings,
  setSidebarWidth,
  startNewSession,
  toggleSidebar,
  useShell
} from '@renderer/state/shell'
import { usePendingDeletes } from '@renderer/state/pendingDeletes'
import { Icon } from '@renderer/design/icons'
import { deleteChat, updateEverything } from './actions'
import PlanBadge from './PlanBadge'
import Spinner from './Spinner'
import ContextMenu, { type ContextMenuEntry } from './ContextMenu'
import InlineRename from './InlineRename'
import { groupSessions, type ProjectGroup } from './sessionGroups'
import { basename, isMac, relativeTime, shortcutLabel, withShortcut } from './util'
import { ArchiveIcon, ChevronRightIcon, ClearIcon, DownloadIcon, GearIcon, MagnifyIcon, PinIcon, PlusIcon } from './icons'

interface Props {
  /** Opens the workflow studio on the selected chat's project. Disabled with
   *  no chat selected: a workflow belongs to a repo, and without a chat there
   *  is no repo to belong to. */
  onOpenWorkflows: () => void
}

interface MenuState {
  x: number
  y: number
  session: ChatSummary
}

export default function Sidebar({ onOpenWorkflows }: Props): JSX.Element {
  const app = useApp()
  const deleting = usePendingDeletes()
  const width = useShell((s) => s.sidebarWidth)
  const [searchText, setSearchText] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [footerMenu, setFooterMenu] = useState<{ x: number; y: number } | null>(null)

  const now = useClock()
  // Chats waiting on an approval or an answer. The selected one shows its
  // card above the composer; every other one says so in its row.
  const permissions = useStore((s) => s.permissions)
  const questions = useStore((s) => s.questions)
  const needsYou = useMemo(() => chatsNeedingYou(permissions, questions), [permissions, questions])
  const allSessions = app?.sessions
  const sessions = useMemo(
    () => allSessions?.filter((s) => !deleting.has(s.id)),
    [allSessions, deleting]
  )
  const selectedId = app?.selectedSessionId ?? null
  const isSearching = searchText.trim().length > 0

  const { groups, archived } = useMemo(
    () => groupSessions(sessions ?? [], searchText),
    [sessions, searchText]
  )
  const hasAny = (sessions ?? []).length > 0

  const openMenuAtPointer = useCallback((e: React.MouseEvent, session: ChatSummary): void => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, session })
  }, [])

  const openMenuAtButton = useCallback((button: HTMLElement, session: ChatSummary): void => {
    const rect = button.getBoundingClientRect()
    setMenu({ x: rect.left, y: rect.bottom + 4, session })
  }, [])

  const closeMenu = useCallback(() => setMenu(null), [])
  const closeFooterMenu = useCallback(() => setFooterMenu(null), [])

  const menuEntries = (session: ChatSummary): ContextMenuEntry[] => [
    { label: 'Rename…', action: () => setRenamingId(session.id) },
    { label: session.isPinned ? 'Unpin' : 'Pin', action: () => void call('togglePin', session.id) },
    {
      label: session.isArchived ? 'Unarchive' : 'Archive',
      action: () => void call('toggleArchive', session.id)
    },
    'separator',
    {
      label: 'Delete…',
      destructive: true,
      action: () => void deleteChat(session)
    }
  ]

  const remoteOn = app?.remote?.enabled ?? false
  const footerEntries: ContextMenuEntry[] = [
    {
      label: 'Workflows…',
      disabled: !selectedId,
      action: onOpenWorkflows
    },
    {
      // The companion app is iPhone-only, so the promise only makes sense on
      // the Mac it pairs with; elsewhere it is plain remote access.
      label: `${isMac() ? 'Control from your iPhone…' : 'Remote access…'}${remoteOn ? ' (on)' : ''}`,
      action: () => openSettings('remote')
    }
  ]

  const rowProps = {
    now,
    selectedId,
    needsYou,
    menuId: menu?.session.id ?? null,
    renamingId,
    onRename: setRenamingId,
    onRenameDone: () => setRenamingId(null),
    onContextMenu: openMenuAtPointer,
    onMore: openMenuAtButton
  }

  return (
    <aside className="sidebar" style={{ width }} aria-label="Sessions">
      <div className="sidebar-top">
        <button
          type="button"
          className="sidebar-new"
          title={withShortcut('New session', 'N')}
          onClick={() => startNewSession()}
          data-testid="new-session"
        >
          <Icon name="square.and.pencil" size={15} />
          <span className="sidebar-new-label">New session</span>
          <kbd className="sidebar-kbd">{shortcutLabel('N')}</kbd>
        </button>
        <button
          type="button"
          className="sidebar-icon-btn"
          title={withShortcut('Hide sidebar', 'B')}
          aria-label="Hide sidebar"
          onClick={toggleSidebar}
        >
          <Icon name="sidebar.left" size={15} />
        </button>
      </div>

      <div className="sidebar-search">
        <MagnifyIcon size={13} />
        <input
          type="text"
          placeholder="Search sessions"
          aria-label="Search sessions"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && searchText !== '') {
              e.stopPropagation()
              setSearchText('')
            }
          }}
        />
        {searchText.length > 0 && (
          <button
            type="button"
            className="sidebar-search-clear"
            title="Clear search"
            onClick={() => setSearchText('')}
          >
            <ClearIcon size={13} />
          </button>
        )}
      </div>

      <nav className="chat-list" aria-label="Session list">
        {!hasAny && <div className="sidebar-empty">Your sessions will appear here</div>}
        {groups.map((group) => (
          <ProjectSection key={group.path} group={group} forceExpanded={isSearching} {...rowProps} />
        ))}
        {archived.length > 0 && (
          <ArchivedSection sessions={archived} forceExpanded={isSearching} {...rowProps} />
        )}
        {isSearching && groups.length === 0 && archived.length === 0 && (
          <div className="sidebar-empty">No sessions match &ldquo;{searchText.trim()}&rdquo;</div>
        )}
      </nav>

      {app?.update && <UpdatePrompt update={app.update} onOpen={() => openSettings('updates')} />}

      <div className="sidebar-footer">
        <AccountRow onOpen={() => openSettings('account')} />
        <button
          type="button"
          className="sidebar-icon-btn"
          title={withShortcut('Settings', ',')}
          aria-label="Settings"
          onClick={() => openSettings('general')}
        >
          <GearIcon size={15} />
        </button>
        <button
          type="button"
          className={'sidebar-icon-btn' + (remoteOn ? ' sidebar-icon-btn--dot' : '')}
          title="More"
          aria-label="More"
          aria-haspopup="menu"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            // Opens upward from the footer; ContextMenu clamps it on screen.
            setFooterMenu({ x: rect.left, y: rect.top - 4 })
          }}
        >
          <Icon name="ellipsis" size={15} />
        </button>
      </div>

      <SidebarResizer width={width} />

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menu.session.title}
          entries={menuEntries(menu.session)}
          onClose={closeMenu}
        />
      )}
      {footerMenu && (
        <ContextMenu
          x={footerMenu.x}
          y={footerMenu.y}
          label="More"
          above
          entries={footerEntries}
          onClose={closeFooterMenu}
        />
      )}
    </aside>
  )
}

/** The current time, refreshed every half minute: row ages ("now", "5m")
 *  are relative, and an idle app sends no state that would re-render them. */
function useClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

// ---------------------------------------------------------------- resizer

/** The sidebar's right edge. Drag to resize (220–360), double-click for the
 *  default width, or focus it and use ←/→. The width is written to storage
 *  once per drag, when the pointer lets go. */
function SidebarResizer({ width }: { width: number }): JSX.Element {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)

  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={220}
      aria-valuemax={360}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { startX: e.clientX, startWidth: width }
        document.body.classList.add('is-resizing-sidebar')
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        setSidebarWidth(drag.current.startWidth + e.clientX - drag.current.startX, false)
      }}
      onPointerUp={(e) => {
        if (!drag.current) return
        setSidebarWidth(drag.current.startWidth + e.clientX - drag.current.startX, true)
        drag.current = null
        document.body.classList.remove('is-resizing-sidebar')
      }}
      onPointerCancel={() => {
        drag.current = null
        document.body.classList.remove('is-resizing-sidebar')
      }}
      onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH, true)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          setSidebarWidth(width + (e.key === 'ArrowRight' ? 16 : -16), true)
        }
      }}
    />
  )
}

// ---------------------------------------------------------------- updates

/** The one place an update is visible without opening Settings: a single row
 *  above the footer, shown only when a newer release exists (or while one is
 *  being applied). The row opens Settings > Updates for the notes and the
 *  detail; the button applies the update straight away, which is what a user
 *  who has already decided actually wants. */
function UpdatePrompt({
  update,
  onOpen
}: {
  update: UpdateState
  onOpen: () => void
}): JSX.Element | null {
  const appBusy = isUpdateBusy(update.app)
  const cliBusy = isUpdateBusy(update.cli)
  const busy = appBusy || cliBusy
  // The app comes first: updating it restarts the whole thing, so doing the
  // CLI first would only throw that work away.
  const target = update.app.available ? 'app' : update.cli.available ? 'cli' : null
  if (!target && !busy) return null

  // One product to the user: "Spettro" is updated, whichever half moved.
  const label = busy
    ? (appBusy ? update.app.message : update.cli.message) || 'Updating…'
    : 'Update available'

  const install = (): void => {
    // A build that can't replace itself has no in-app path — send the user
    // to the pane, which offers the download instead.
    if (target === 'app' && !update.canInstallApp && !update.cli.available) onOpen()
    else void updateEverything(update)
  }

  return (
    <div className="sidebar-update">
      <button className="sidebar-update-text" onClick={onOpen} title="Open update details">
        <span className="sidebar-update-icon">
          <DownloadIcon size={13} />
        </span>
        <span className="sidebar-update-label">{label}</span>
      </button>
      {busy ? (
        <Spinner size={12} />
      ) : (
        <button className="btn btn--small btn--prominent" onClick={install}>
          Update
        </button>
      )}
    </div>
  )
}

// --------------------------------------------------------------- sections

interface RowHandlers {
  now: number
  selectedId: string | null
  /** Chats with an approval or a question waiting. */
  needsYou: Set<string>
  /** The row whose menu is open keeps its highlight while the menu has focus. */
  menuId: string | null
  renamingId: string | null
  onRename: (chatId: string) => void
  onRenameDone: () => void
  onContextMenu: (e: React.MouseEvent, session: ChatSummary) => void
  onMore: (button: HTMLElement, session: ChatSummary) => void
}

function ProjectSection({
  group,
  forceExpanded,
  ...rows
}: RowHandlers & { group: ProjectGroup; forceExpanded: boolean }): JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const isExpanded = forceExpanded || !collapsed
  const name = basename(group.path)
  // A folded group still says when one of its chats is waiting on you.
  const waiting = !isExpanded && group.sessions.some((s) => rows.needsYou.has(s.id))

  return (
    <section className="section" aria-label={name}>
      <div className="section-header">
        <button
          type="button"
          className="section-toggle"
          disabled={forceExpanded}
          title={group.path}
          aria-expanded={isExpanded}
          onClick={() => setCollapsed((c) => !c)}
        >
          <span className="section-name">{name}</span>
          {waiting && <span className="section-needs-you" role="img" aria-label="A session here needs you" />}
          <span className={`section-chevron${isExpanded ? ' section-chevron--open' : ''}`}>
            <ChevronRightIcon size={8} />
          </span>
        </button>
        <button
          type="button"
          className="section-add"
          title={`New session in ${name}`}
          aria-label={`New session in ${name}`}
          onClick={() => startNewSession(group.path)}
        >
          <PlusIcon size={11} />
        </button>
      </div>
      {isExpanded && group.sessions.map((session) => <ChatRow key={session.id} session={session} {...rows} />)}
    </section>
  )
}

function ArchivedSection({
  sessions,
  forceExpanded,
  ...rows
}: RowHandlers & { sessions: ChatSummary[]; forceExpanded: boolean }): JSX.Element {
  const [collapsed, setCollapsed] = useState(true)
  const isExpanded = forceExpanded || !collapsed
  const waiting = !isExpanded && sessions.some((s) => rows.needsYou.has(s.id))

  return (
    <section className="section section--archived" aria-label="Archived">
      <div className="section-header">
        <button
          type="button"
          className="section-toggle"
          disabled={forceExpanded}
          aria-expanded={isExpanded}
          onClick={() => setCollapsed((c) => !c)}
        >
          <ArchiveIcon size={11} />
          <span className="section-name">Archived</span>
          <span className="section-count">{sessions.length}</span>
          {waiting && <span className="section-needs-you" role="img" aria-label="A session here needs you" />}
          <span className={`section-chevron${isExpanded ? ' section-chevron--open' : ''}`}>
            <ChevronRightIcon size={8} />
          </span>
        </button>
      </div>
      {isExpanded &&
        sessions.map((session) => (
          <ChatRow key={session.id} session={session} subtitle={basename(session.projectPath)} {...rows} />
        ))}
    </section>
  )
}

// ------------------------------------------------------------------- rows

function ChatRow({
  session,
  subtitle,
  now,
  selectedId,
  needsYou,
  menuId,
  renamingId,
  onRename,
  onRenameDone,
  onContextMenu,
  onMore
}: RowHandlers & { session: ChatSummary; subtitle?: string }): JSX.Element {
  const isSelected = session.id === selectedId
  const renaming = renamingId === session.id
  const waiting = needsYou.has(session.id) && !isSelected
  const open = (): void => void call('openChat', session.id)

  // The row is a container, not a button: the title is the button (its
  // ::after stretches over the whole row, so a click anywhere opens), and the
  // "…" sits beside it as a real, separately reachable button — nested inside
  // a role=button it would be invisible to a screen reader.
  return (
    <div
      className={
        'chat-row' +
        (isSelected ? ' chat-row--selected' : '') +
        (session.id === menuId ? ' chat-row--menu' : '') +
        (session.unread && !isSelected ? ' chat-row--unread' : '') +
        (waiting ? ' chat-row--needs-you' : '')
      }
      data-testid={`sidebar-row-${session.id}`}
      onContextMenu={(e) => onContextMenu(e, session)}
    >
      {renaming ? (
        <span className="chat-row-text">
          <InlineRename chatId={session.id} title={session.title} onDone={onRenameDone} />
        </span>
      ) : (
        <button
          type="button"
          className="chat-row-open"
          aria-current={isSelected ? 'page' : undefined}
          title={session.title}
          onClick={open}
          onKeyDown={(e) => {
            if (e.key === 'F2') {
              e.preventDefault()
              onRename(session.id)
            }
          }}
        >
          <span className="chat-row-title">{session.title}</span>
          {subtitle && <span className="chat-row-subtitle">{subtitle}</span>}
        </button>
      )}
      {!renaming && (
        <span className="chat-row-trail">
          {session.isPinned && (
            <span className="chat-row-pin" aria-label="Pinned">
              <PinIcon size={9} />
            </span>
          )}
          <RowStatus session={session} isSelected={isSelected} waiting={waiting} now={now} />
          <button
            type="button"
            className="chat-row-more"
            title="More actions"
            aria-label={`More actions for ${session.title}`}
            aria-haspopup="menu"
            onClick={(e) => onMore(e.currentTarget, session)}
          >
            <Icon name="ellipsis" size={13} />
          </button>
        </span>
      )}
    </div>
  )
}

/** The row's right-hand slot. Waiting on an approval or an answer → the
 *  amber "Needs you" badge, which outranks everything: the chat is stuck
 *  until you look. Working → spinner. Finished while you were elsewhere →
 *  accent dot. Otherwise the time since it last moved, which the "…" button
 *  covers on hover. */
function RowStatus({
  session,
  isSelected,
  waiting,
  now
}: {
  session: ChatSummary
  isSelected: boolean
  waiting: boolean
  now: number
}): JSX.Element {
  if (waiting) {
    return (
      <span className="chat-row-status">
        <span className="chat-row-needs-you" title="Waiting for your approval or answer">
          Needs you
        </span>
      </span>
    )
  }
  if (session.isBusy) {
    return (
      <span className="chat-row-status" title="Working…">
        <Spinner size={11} />
      </span>
    )
  }
  return (
    <span className="chat-row-status">
      {session.unread && !isSelected && (
        <span className="chat-row-dot" role="img" aria-label="Finished while you were away" />
      )}
      <span className="chat-row-time">{relativeTime(session.updatedAt, now)}</span>
    </span>
  )
}

// ----------------------------------------------------------------- footer

/** Who is signed in, at a glance: initial, email, plan. Opens Settings on
 *  the Account pane, which is where signing in or out happens. */
function AccountRow({ onOpen }: { onOpen: () => void }): JSX.Element {
  const app = useApp()
  const account = app?.extensions.account
  const email = account?.signedIn ? account.email : (app?.subscription.email ?? null)
  const signedIn = Boolean(account?.signedIn || email)
  const plan = app?.subscription.plan ?? 'unknown'
  const initial = (email ?? '').trim().charAt(0).toUpperCase()

  return (
    <button type="button" className="account-row" onClick={onOpen} title="Account">
      <span className={'account-avatar' + (signedIn ? '' : ' account-avatar--empty')} aria-hidden>
        {signedIn && initial ? initial : <Icon name="person.crop.circle" size={14} />}
      </span>
      <span className="account-email">{signedIn ? (email ?? 'Signed in') : 'Not signed in'}</span>
      {signedIn && plan !== 'unknown' && <PlanBadge plan={plan} size={9} />}
    </button>
  )
}

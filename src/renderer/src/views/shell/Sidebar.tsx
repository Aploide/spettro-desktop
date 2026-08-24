// Port of SidebarView.swift: brand header (app icon, wordmark, plan badge,
// new-chat-in-folder button), search field, the project-grouped chat list with
// pinned-first ordering and a collapsed-by-default Archived section, and a
// footer with the active model, CLI version, remote-access toggle and the
// settings gear. Right-click on a row opens the pin/archive/close menu.

import { useMemo, useState } from 'react'
import type { ACPConfigOption } from '@shared/acp'
import type { ChatSummary } from '@shared/model'
import { isUpdateBusy, type UpdateState } from '@shared/update'
import { call, useApp, useStore } from '@renderer/state/store'
import type { SettingsPane } from './SettingsView'
import AppIcon from './AppIcon'
import PlanBadge from './PlanBadge'
import Spinner from './Spinner'
import ContextMenu, { type ContextMenuEntry } from './ContextMenu'
import { basename } from './util'
import {
  ArchiveIcon,
  ChevronRightIcon,
  ClearIcon,
  DownloadIcon,
  FlowchartIcon,
  FolderFillIcon,
  FolderPlusIcon,
  GearIcon,
  MagnifyIcon,
  PhoneIcon,
  PinIcon,
  PlusIcon
} from './icons'

interface Props {
  /** The pane argument lets the update prompt open Settings on Updates. */
  onOpenSettings: (pane?: SettingsPane) => void
  onOpenRemote: () => void
  /** Opens the workflow studio on the selected chat's project. Disabled with
   *  no chat selected: a workflow belongs to a repo, and without a chat there
   *  is no repo to belong to. */
  onOpenWorkflows: () => void
}

interface ProjectGroup {
  path: string
  sessions: ChatSummary[]
}

interface MenuState {
  x: number
  y: number
  session: ChatSummary
}

/** Stable sort lifting pinned chats without disturbing relative order. */
function pinnedFirst(sessions: ChatSummary[]): ChatSummary[] {
  return [...sessions].sort((a, b) => Number(b.isPinned) - Number(a.isPinned))
}

export default function Sidebar({ onOpenSettings, onOpenRemote, onOpenWorkflows }: Props): JSX.Element {
  const app = useApp()
  const [searchText, setSearchText] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)

  const sessions = app?.sessions
  const selectedId = app?.selectedSessionId ?? null
  const query = searchText.trim().toLowerCase()
  const isSearching = query.length > 0

  // A chat matches on its own title or on the name of the folder it runs in,
  // so searching a folder name surfaces every chat inside it.
  const { groups, archived } = useMemo(() => {
    const matches = (s: ChatSummary): boolean =>
      !query ||
      s.title.toLowerCase().includes(query) ||
      basename(s.projectPath).toLowerCase().includes(query)

    const order: string[] = []
    const buckets = new Map<string, ChatSummary[]>()
    for (const s of sessions ?? []) {
      if (s.isArchived || !matches(s)) continue
      let bucket = buckets.get(s.projectPath)
      if (!bucket) {
        bucket = []
        buckets.set(s.projectPath, bucket)
        order.push(s.projectPath)
      }
      bucket.push(s)
    }
    return {
      groups: order.map((path) => ({ path, sessions: pinnedFirst(buckets.get(path) ?? []) })),
      archived: pinnedFirst((sessions ?? []).filter((s) => s.isArchived && matches(s)))
    }
  }, [sessions, query])

  const openMenu = (e: React.MouseEvent, session: ChatSummary): void => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, session })
  }

  const newChatInPickedFolder = async (): Promise<void> => {
    const path = await call('pickFolder')
    if (path) await call('newChat', path)
  }

  const menuEntries = (session: ChatSummary): ContextMenuEntry[] => [
    { label: session.isPinned ? 'Unpin' : 'Pin', action: () => void call('togglePin', session.id) },
    {
      label: session.isArchived ? 'Unarchive' : 'Archive',
      action: () => void call('toggleArchive', session.id)
    },
    'separator',
    { label: 'Close Chat', destructive: true, action: () => void call('closeChat', session.id) }
  ]

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <AppIcon size={26} />
        <span className="sidebar-title">Spettro</span>
        <PlanBadge plan={app?.subscription.plan ?? 'unknown'} size={15} />
        <button
          className="icon-btn"
          title="New chat in a different folder…"
          onClick={() => void newChatInPickedFolder()}
        >
          <FolderPlusIcon size={16} />
        </button>
      </div>

      <div className="search">
        <MagnifyIcon size={12} />
        <input
          type="text"
          placeholder="Search"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
        />
        {searchText.length > 0 && (
          <button className="icon-btn" title="Clear search" onClick={() => setSearchText('')}>
            <ClearIcon size={13} />
          </button>
        )}
      </div>

      <div className="divider divider--faint" />

      <div className="chat-list">
        {groups.map((group) => (
          <ProjectSection
            key={group.path}
            group={group}
            selectedId={selectedId}
            forceExpanded={isSearching}
            onContextMenu={openMenu}
          />
        ))}
        {archived.length > 0 && (
          <ArchivedSection
            sessions={archived}
            selectedId={selectedId}
            forceExpanded={isSearching}
            onContextMenu={openMenu}
          />
        )}
        {isSearching && groups.length === 0 && archived.length === 0 && (
          <div className="no-matches">No chats match &ldquo;{searchText}&rdquo;</div>
        )}
      </div>

      <div className="divider divider--faint" />

      {app?.update && <UpdatePrompt update={app.update} onOpen={() => onOpenSettings('updates')} />}

      <div className="sidebar-footer">
        <FooterStatus selectedId={selectedId} agentVersion={app?.agentVersion ?? null} />
        <button
          className={`icon-btn${app?.remote?.enabled ? ' icon-btn--accent' : ''}`}
          title={app?.remote?.enabled ? 'Remote access is on' : 'Control from your iPhone'}
          onClick={onOpenRemote}
        >
          <PhoneIcon size={16} active={app?.remote?.enabled ?? false} />
        </button>
        <button
          className="icon-btn"
          title={selectedId ? 'Workflows' : 'Open a chat to work on its workflows'}
          disabled={!selectedId}
          onClick={onOpenWorkflows}
        >
          <FlowchartIcon size={16} />
        </button>
        <button className="icon-btn" title="Settings" onClick={() => onOpenSettings()}>
          <GearIcon size={16} />
        </button>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.session)} onClose={() => setMenu(null)} />}
    </div>
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

  const label = busy
    ? (appBusy ? update.app.message : update.cli.message) || 'Updating…'
    : target === 'app'
      ? `Spettro ${update.app.latest} is available`
      : `Spettro CLI ${update.cli.latest} is available`

  const install = (): void => {
    if (target === 'app') {
      // A build that can't replace itself has no in-app path — send the user
      // to the pane, which offers the download instead.
      if (update.canInstallApp) void call('installAppUpdate')
      else onOpen()
    } else if (target === 'cli') {
      void call('installCLIUpdate')
    }
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

interface SectionProps {
  selectedId: string | null
  forceExpanded: boolean
  onContextMenu: (e: React.MouseEvent, session: ChatSummary) => void
}

function ProjectSection({
  group,
  selectedId,
  forceExpanded,
  onContextMenu
}: SectionProps & { group: ProjectGroup }): JSX.Element {
  // Project sections start expanded; the Archived section starts collapsed.
  const [collapsed, setCollapsed] = useState(false)
  const isExpanded = forceExpanded || !collapsed
  const name = basename(group.path)

  return (
    <div className="section">
      <div className="section-header">
        <button
          className="section-toggle"
          disabled={forceExpanded}
          onClick={() => setCollapsed((c) => !c)}
        >
          <span className={`section-chevron${isExpanded ? ' section-chevron--open' : ''}`}>
            <ChevronRightIcon size={9} />
          </span>
          <FolderFillIcon size={12} />
          <span className="section-name">{name}</span>
        </button>
        <button
          className="icon-btn"
          title={`New chat in ${name}`}
          onClick={() => void call('newChat', group.path)}
        >
          <PlusIcon size={12} />
        </button>
      </div>
      {isExpanded &&
        group.sessions.map((session) => (
          <ChatRow
            key={session.id}
            session={session}
            isSelected={session.id === selectedId}
            onContextMenu={onContextMenu}
          />
        ))}
    </div>
  )
}

function ArchivedSection({
  sessions,
  selectedId,
  forceExpanded,
  onContextMenu
}: SectionProps & { sessions: ChatSummary[] }): JSX.Element {
  const [collapsed, setCollapsed] = useState(true)
  const isExpanded = forceExpanded || !collapsed

  return (
    <div className="section">
      <div className="section-header">
        <button
          className="section-toggle"
          disabled={forceExpanded}
          onClick={() => setCollapsed((c) => !c)}
        >
          <span className={`section-chevron${isExpanded ? ' section-chevron--open' : ''}`}>
            <ChevronRightIcon size={9} />
          </span>
          <ArchiveIcon size={12} />
          <span className="section-name">Archived</span>
        </button>
        <span className="section-count">{sessions.length}</span>
      </div>
      {isExpanded &&
        sessions.map((session) => (
          <ChatRow
            key={session.id}
            session={session}
            isSelected={session.id === selectedId}
            subtitle={basename(session.projectPath)}
            onContextMenu={onContextMenu}
          />
        ))}
    </div>
  )
}

// ------------------------------------------------------------------- rows

function ChatRow({
  session,
  isSelected,
  subtitle,
  onContextMenu
}: {
  session: ChatSummary
  isSelected: boolean
  subtitle?: string
  onContextMenu: (e: React.MouseEvent, session: ChatSummary) => void
}): JSX.Element {
  return (
    <div
      className={`chat-row${isSelected ? ' chat-row--selected' : ''}`}
      onClick={() => void call('openChat', session.id)}
      onContextMenu={(e) => onContextMenu(e, session)}
    >
      <span className="chat-row-status">
        {/* Working → spinner. Has at least one turn → accent dot. Untouched →
            nothing, so an empty chat doesn't compete for attention. */}
        {session.isBusy ? (
          <Spinner size={10} />
        ) : session.messageCount > 0 ? (
          <span className="chat-row-dot" />
        ) : null}
      </span>
      <span className="chat-row-text">
        <span className="chat-row-title-line">
          <span className="chat-row-title">{session.title}</span>
          {session.isPinned && (
            <span className="chat-row-pin">
              <PinIcon size={9} />
            </span>
          )}
        </span>
        {subtitle && <span className="chat-row-subtitle">{subtitle}</span>}
      </span>
    </div>
  )
}

// ----------------------------------------------------------------- footer

/** Active model of the selected chat (its "model" config option) over the
 *  connected CLI version — the FooterStatus/ModelLabel pair from Swift. */
function FooterStatus({
  selectedId,
  agentVersion
}: {
  selectedId: string | null
  agentVersion: string | null
}): JSX.Element {
  const chat = useStore((s) => (selectedId ? (s.chats[selectedId] ?? null) : null))
  const label = chat ? modelLabel(chat.configOptions) : null
  return (
    <div className="footer-status">
      <span className="footer-model">{label ?? 'No model'}</span>
      {agentVersion && <span className="footer-cli">CLI {agentVersion}</span>}
    </div>
  )
}

function modelLabel(options: ACPConfigOption[]): string | null {
  const opt = options.find((o) => o.id === 'model')
  if (!opt || opt.kind.type !== 'select') return null
  const value = opt.kind.currentValue
  if (value == null) return null
  const all = [...opt.kind.flat, ...opt.kind.groups.flatMap((g) => g.options)]
  return all.find((c) => c.value === value)?.name ?? value
}

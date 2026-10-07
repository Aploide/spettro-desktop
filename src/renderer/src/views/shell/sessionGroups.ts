// The sidebar's ordering, as a pure function: most recently active first —
// groups by their newest chat, chats by their own last activity — with pinned
// chats lifted to the top of their group and archived chats set apart. Ctrl/Cmd+1…9 and the quick switcher count rows in exactly
// this order, so it lives here rather than inside the component.

import type { ChatSummary } from '@shared/model'
import { basename } from './util'

export interface ProjectGroup {
  path: string
  sessions: ChatSummary[]
}

export interface SessionGroups {
  groups: ProjectGroup[]
  archived: ChatSummary[]
}

/** Stable sort lifting pinned chats without disturbing relative order. */
function pinnedFirst(sessions: ChatSummary[]): ChatSummary[] {
  return [...sessions].sort((a, b) => Number(b.isPinned) - Number(a.isPinned))
}

/** A chat matches on its own title or on its folder's name, so searching a
 *  folder surfaces every chat inside it. */
export function matchesQuery(session: ChatSummary, query: string): boolean {
  const q = query.trim().toLowerCase()
  return (
    q === '' ||
    session.title.toLowerCase().includes(q) ||
    basename(session.projectPath).toLowerCase().includes(q)
  )
}

export function groupSessions(all: ChatSummary[], query = ''): SessionGroups {
  // Recency, not creation order: the row a person just worked in is the one
  // they come back to. Ties keep the model's order (newest-created first).
  const sessions = [...all].sort((a, b) => b.updatedAt - a.updatedAt)
  const order: string[] = []
  const buckets = new Map<string, ChatSummary[]>()
  for (const s of sessions) {
    if (s.isArchived || !matchesQuery(s, query)) continue
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
    archived: pinnedFirst(sessions.filter((s) => s.isArchived && matchesQuery(s, query)))
  }
}

/** Non-archived chats top to bottom, as the sidebar shows them — none from
 *  a group folded shut, so Ctrl/Cmd+3 is the third row on screen. */
export function visibleSessionOrder(
  sessions: ChatSummary[],
  collapsedGroups: readonly string[] = []
): ChatSummary[] {
  return groupSessions(sessions)
    .groups.filter((g) => !collapsedGroups.includes(g.path))
    .flatMap((g) => g.sessions)
}

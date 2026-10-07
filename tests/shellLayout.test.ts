// The sidebar's ordering and the small helpers behind its rows. Ctrl/Cmd+1…9
// and the quick switcher count rows in groupSessions' order, so a change to
// it moves every shortcut — which a screenshot of the sidebar would never
// show.

import { describe, expect, it } from 'vitest'
import type { ChatSummary } from '@shared/model'
import { groupSessions, visibleSessionOrder } from '@renderer/views/shell/sessionGroups'
import { isBroadFolder, relativeTime } from '@renderer/views/shell/util'

const MIN = 60_000
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0)

function chat(id: string, projectPath: string, minutesAgo: number, extra?: Partial<ChatSummary>): ChatSummary {
  return {
    id,
    title: `chat ${id}`,
    projectPath,
    createdAt: NOW - minutesAgo * MIN,
    updatedAt: NOW - minutesAgo * MIN,
    isPinned: false,
    isArchived: false,
    isBusy: false,
    messageCount: 1,
    preview: '',
    unread: false,
    ...extra
  }
}

describe('groupSessions', () => {
  const sessions = [
    chat('old-a', '/w/a', 300),
    chat('new-b', '/w/b', 1),
    chat('mid-a', '/w/a', 10),
    chat('pin-a', '/w/a', 900, { isPinned: true }),
    chat('arch', '/w/b', 5, { isArchived: true })
  ]

  it('orders groups and rows by recency, pinned first within a group', () => {
    const { groups, archived } = groupSessions(sessions)
    expect(groups.map((g) => g.path)).toEqual(['/w/b', '/w/a'])
    expect(groups[1].sessions.map((s) => s.id)).toEqual(['pin-a', 'mid-a', 'old-a'])
    expect(archived.map((s) => s.id)).toEqual(['arch'])
  })

  it('matches a search on the title or the folder name', () => {
    expect(groupSessions(sessions, 'mid').groups.flatMap((g) => g.sessions.map((s) => s.id))).toEqual([
      'mid-a'
    ])
    expect(groupSessions(sessions, ' B ').groups.map((g) => g.path)).toEqual(['/w/b'])
    expect(groupSessions(sessions, 'B').archived.map((s) => s.id)).toEqual(['arch'])
  })

  it('numbers the visible rows top to bottom, archived excluded', () => {
    expect(visibleSessionOrder(sessions).map((s) => s.id)).toEqual(['new-b', 'pin-a', 'mid-a', 'old-a'])
  })

  it('skips the rows of a folded group, so Ctrl+2 is the second row on screen', () => {
    expect(visibleSessionOrder(sessions, ['/w/b']).map((s) => s.id)).toEqual(['pin-a', 'mid-a', 'old-a'])
    expect(visibleSessionOrder(sessions, ['/w/a', '/w/b'])).toEqual([])
  })
})

describe('relativeTime', () => {
  it('reads like a sidebar timestamp', () => {
    expect(relativeTime(NOW - 20_000, NOW)).toBe('now')
    expect(relativeTime(NOW - 5 * MIN, NOW)).toBe('5m')
    expect(relativeTime(NOW - 3 * 60 * MIN, NOW)).toBe('3h')
    expect(relativeTime(NOW - 2 * 24 * 60 * MIN, NOW)).toBe('2d')
    // A week and beyond is a date, with the year only when it differs.
    expect(relativeTime(NOW - 10 * 24 * 60 * MIN, NOW)).not.toMatch(/\d{4}/)
    expect(relativeTime(Date.UTC(2024, 0, 2), NOW)).toMatch(/2024/)
  })

  it('never shows a negative age for a clock that ran ahead', () => {
    expect(relativeTime(NOW + 60 * MIN, NOW)).toBe('now')
  })
})

describe('isBroadFolder', () => {
  it('flags the home folder and the filesystem root, nothing inside them', () => {
    expect(isBroadFolder('/home/me', '/home/me')).toBe(true)
    expect(isBroadFolder('/home/me/', '/home/me')).toBe(true)
    expect(isBroadFolder('/', '/home/me')).toBe(true)
    expect(isBroadFolder('C:\\', 'C:\\Users\\me')).toBe(true)
    expect(isBroadFolder('/home/me/code/app', '/home/me')).toBe(false)
    expect(isBroadFolder('/home', '/home/me')).toBe(false)
  })
})

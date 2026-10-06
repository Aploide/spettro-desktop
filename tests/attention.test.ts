// The app badge and the notifications for prompts waiting on the user
// (src/main/attention.ts), driven by the model's own events: `permissions` /
// `questions` (the queues) and `permission-ask` / `question-ask` (one just
// arrived), in the order appModel emits them.

import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ACPPermissionRequest, ACPQuestionRequest } from '@shared/acp'

const electron = vi.hoisted(() => ({
  badge: [] as number[],
  shown: [] as { title: string; body: string; closed: boolean; click: () => void }[]
}))

vi.mock('electron', () => ({
  app: { setBadgeCount: (n: number) => electron.badge.push(n), dock: undefined },
  Notification: class {
    static isSupported(): boolean {
      return true
    }
    private handlers: Record<string, () => void> = {}
    private entry: { title: string; body: string; closed: boolean; click: () => void }
    constructor(o: { title: string; body: string }) {
      this.entry = { ...o, closed: false, click: () => this.handlers['click']?.() }
    }
    on(event: string, handler: () => void): void {
      this.handlers[event] = handler
    }
    show(): void {
      electron.shown.push(this.entry)
    }
    close(): void {
      this.entry.closed = true
    }
  }
}))

import { attentionNotice, badgeCount, wireAttention } from '@main/attention'
import type { AppModel } from '@main/model/appModel'

function permission(o: Partial<ACPPermissionRequest> = {}): ACPPermissionRequest {
  return {
    id: 'p1',
    sessionId: 'acp-1',
    chatId: 'c1',
    title: 'Run npm test',
    toolKind: 'execute',
    content: { texts: [], diffs: [] },
    locations: [],
    options: [],
    ...o
  }
}

const question: ACPQuestionRequest = {
  id: 'q1',
  version: 2,
  chatId: 'c2',
  questions: [{ id: 'q-1', question: 'Which file?', options: [], multiSelect: false, allowCustomInput: true }]
}

class FakeWindow {
  focused = false
  flashing = false
  shownCount = 0
  isDestroyed = (): boolean => false
  isFocused = (): boolean => this.focused
  isMinimized = (): boolean => false
  restore = (): void => undefined
  show = (): void => void this.shownCount++
  focus = (): void => {
    this.focused = true
  }
  flashFrame = (on: boolean): void => {
    this.flashing = on
  }
  on = (): void => undefined
}

function setup(): { model: EventEmitter & { opened: string[] }; win: FakeWindow } {
  const model = Object.assign(new EventEmitter(), {
    opened: [] as string[],
    sessionById: (id: string) => ({ title: id === 'c1' ? 'Fix the bug' : 'Release notes' }),
    openChat(id: string) {
      model.opened.push(id)
    }
  })
  const win = new FakeWindow()
  wireAttention(model as unknown as AppModel, () => win as never)
  return { model, win }
}

beforeEach(() => {
  electron.badge.length = 0
  electron.shown.length = 0
})

describe('attention', () => {
  it('counts every prompt waiting', () => {
    expect(badgeCount([1, 2], [3])).toBe(3)
    const { model } = setup()
    model.emit('event', { type: 'permissions', requests: [permission()] })
    model.emit('event', { type: 'questions', requests: [question] })
    model.emit('event', { type: 'permissions', requests: [] })
    expect(electron.badge).toEqual([1, 2, 1])
  })

  it('names the chat in the notification', () => {
    expect(attentionNotice({ kind: 'permission', request: permission() }, 'Fix the bug')).toEqual({
      title: 'Spettro needs your approval in “Fix the bug”',
      body: 'Run npm test'
    })
    expect(attentionNotice({ kind: 'question', request: question }, null)).toEqual({
      title: 'Spettro has a question',
      body: 'Which file?'
    })
  })

  it('notifies only while the window is unfocused, and a click opens the chat', () => {
    const { model, win } = setup()
    win.focused = true
    model.emit('event', { type: 'permissions', requests: [permission()] })
    model.emit('permission-ask', 'p1', 'c1')
    expect(electron.shown).toEqual([])

    win.focused = false
    model.emit('event', { type: 'questions', requests: [question] })
    model.emit('question-ask', 'q1', 'c2')
    expect(electron.shown.map((n) => n.title)).toEqual(['Spettro has a question in “Release notes”'])
    expect(win.flashing).toBe(true)
    electron.shown[0].click()
    expect(win.focused).toBe(true)
    expect(model.opened).toEqual(['c2'])
  })

  it('withdraws a notification once its prompt is answered', () => {
    const { model, win } = setup()
    model.emit('event', { type: 'permissions', requests: [permission()] })
    model.emit('permission-ask', 'p1', 'c1')
    expect(electron.shown[0].closed).toBe(false)
    model.emit('event', { type: 'permissions', requests: [] })
    expect(electron.shown[0].closed).toBe(true)
    expect(win.flashing).toBe(false)
  })
})

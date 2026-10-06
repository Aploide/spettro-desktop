// Getting the user back when a chat is waiting on them.
//
// An approval or a question blocks the agent's turn until someone answers,
// and the window may be behind something else or minimised when it arrives.
// So while anything is waiting the app badge counts it (macOS dock, Linux
// launchers that take a count), and a prompt that arrives while the window
// is unfocused raises a notification — "Spettro needs your approval in
// <chat>" — that brings the window forward on that chat when clicked. A
// notification is withdrawn once its prompt is answered, from here or from
// a paired phone.

import { app, Notification, type BrowserWindow } from 'electron'
import type { ACPPermissionRequest, ACPQuestionRequest } from '../shared/acp'
import type { MainEvent } from '../shared/ipc'
import type { AppModel } from './model/appModel'

/** What the badge counts: every prompt waiting, approvals and questions
 *  alike — each is one thing the user has to do. */
export function badgeCount(permissions: unknown[], questions: unknown[]): number {
  return permissions.length + questions.length
}

export interface Notice {
  title: string
  body: string
}

/** The notification for a prompt that just arrived, named after its chat
 *  when it has one. */
export function attentionNotice(
  prompt: { kind: 'permission'; request: ACPPermissionRequest } | { kind: 'question'; request: ACPQuestionRequest },
  chatTitle: string | null
): Notice {
  const where = chatTitle && chatTitle.trim() !== '' ? ` in “${chatTitle.trim()}”` : ''
  if (prompt.kind === 'permission') {
    const { request } = prompt
    if (request.variant === 'compact') {
      return { title: `Spettro needs your decision${where}`, body: 'The conversation is almost full.' }
    }
    return { title: `Spettro needs your approval${where}`, body: request.title }
  }
  const first = prompt.request.questions[0]
  const n = prompt.request.questions.length
  return {
    title: `Spettro has ${n > 1 ? `${n} questions` : 'a question'}${where}`,
    body: first?.question ?? ''
  }
}

/** Wires the badge and the notifications to the model's prompt queue. */
export function wireAttention(model: AppModel, getWindow: () => BrowserWindow | null): void {
  let permissions: ACPPermissionRequest[] = []
  let questions: ACPQuestionRequest[] = []
  // Held so a shown notification is not collected (its click would be lost)
  // and so it can be withdrawn once answered.
  const shown = new Map<string, Notification>()
  const flashWired = new WeakSet<BrowserWindow>()

  const refresh = (): void => {
    try {
      // false (and no badge) where the platform has nowhere to put one.
      app.setBadgeCount(badgeCount(permissions, questions))
    } catch {
      // best-effort
    }
    const waiting = new Set([...permissions, ...questions].map((p) => p.id))
    for (const [id, notification] of shown) {
      if (waiting.has(id)) continue
      notification.close()
      shown.delete(id)
    }
    if (waiting.size === 0) getWindow()?.flashFrame(false)
  }

  model.on('event', (event: MainEvent) => {
    if (event.type === 'permissions') permissions = event.requests
    else if (event.type === 'questions') questions = event.requests
    else return
    refresh()
  })

  const notify = (requestId: string, chatId: string | null): void => {
    const win = getWindow()
    if (!win || win.isDestroyed() || win.isFocused()) return
    const permission = permissions.find((p) => p.id === requestId)
    const question = questions.find((q) => q.id === requestId)
    const prompt = permission
      ? { kind: 'permission' as const, request: permission }
      : question
        ? { kind: 'question' as const, request: question }
        : null
    if (!prompt) return
    const chatTitle = chatId ? (model.sessionById(chatId)?.title ?? null) : null
    const notice = attentionNotice(prompt, chatTitle)

    // The taskbar or dock asks too, quietly, for whoever has notifications
    // off; looking at the window is answer enough to stop it.
    if (process.platform === 'darwin') {
      app.dock?.bounce('informational')
    } else {
      if (!flashWired.has(win)) {
        flashWired.add(win)
        win.on('focus', () => win.flashFrame(false))
      }
      win.flashFrame(true)
    }

    if (!Notification.isSupported()) return
    const notification = new Notification({ title: notice.title, body: notice.body })
    notification.on('click', () => {
      const target = getWindow()
      if (target && !target.isDestroyed()) {
        if (target.isMinimized()) target.restore()
        target.show()
        target.focus()
      }
      if (chatId) model.openChat(chatId)
    })
    notification.on('close', () => shown.delete(requestId))
    shown.set(requestId, notification)
    notification.show()
  }

  model.on('permission-ask', (requestId: string, chatId: string | null) => notify(requestId, chatId))
  model.on('question-ask', (requestId: string, chatId: string | null) => notify(requestId, chatId))
}

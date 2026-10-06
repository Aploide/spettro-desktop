// The user-facing flows that ask before they act, and the toast every failed
// action becomes. Kept apart from the views because several of them start
// the same flow — the sidebar menu and the quick switcher both delete a
// chat, Settings and a toast both restart the engine — and the question asked
// should be the same one whichever button asked it.

import { busyGuard } from '@shared/busyGuard'
import { humanizeError, type ErrorActionKind } from '@shared/humanize'
import type { ChatSummary } from '@shared/model'
import type { UpdateState } from '@shared/update'
import { call, getState, quietCall } from '@renderer/state/store'
import { openSettings, startNewSession } from '@renderer/state/shell'
import { pendingDeletes } from '@renderer/state/pendingDeletes'
import { confirmDialog } from '@renderer/views/common/ConfirmDialog'
import { showToast } from '@renderer/views/common/Toast'

/** Calls that fail in the background or report their own failure in place;
 *  a toast for them would be noise, or a second copy. */
const QUIET_METHODS = new Set([
  'getState',
  'getChat',
  'gitStat',
  'listProjectFiles',
  'terminalWrite',
  'terminalResize',
  'terminalList',
  'terminalHasProcess',
  'checkForUpdates',
  'refreshExtensions',
  'workflowValidate',
  'accountLoginPoll',
  'selectSession',
  'openExternal'
])

/** What a failed action says, in words, with its next step when there is
 *  one this window can take. Installed as the store's failure reporter. */
export function reportActionFailure(method: string, err: unknown): void {
  if (QUIET_METHODS.has(method)) return
  const human = humanizeError(err)
  const run = errorActionRunner(human.action?.kind ?? 'none')
  showToast({
    tone: 'error',
    key: `fail:${method}`,
    title: human.known ? human.title : 'That didn’t work',
    detail: human.detail,
    action: human.action && run ? { label: human.action.label, run } : undefined
  })
}

/** The handler for an error's suggested action, when the shell can perform
 *  it without knowing what was being attempted ("Try Again" can't be
 *  replayed from here, so it has none). */
export function errorActionRunner(kind: ErrorActionKind): (() => void) | null {
  switch (kind) {
    case 'connect':
    case 'models':
      return () => openSettings('models')
    case 'update':
      return () => openSettings('updates')
    case 'reinstall':
      return () => openSettings('advanced')
    case 'restart':
      return () => void restartEngine()
    default:
      return null
  }
}

/** Delete… — asks, then hides the chat with eight seconds to Undo before
 *  main really deletes it. */
export async function deleteChat(chat: Pick<ChatSummary, 'id' | 'title' | 'isBusy' | 'projectPath'>): Promise<void> {
  const answer = await confirmDialog({
    title: 'Delete this session?',
    message: chat.isBusy
      ? `Spettro is still working in “${chat.title}”. Deleting it stops that work and removes the conversation from Spettro.`
      : `“${chat.title}” will be removed from Spettro. Files it changed in your project stay as they are.`,
    confirmLabel: 'Delete',
    destructive: true
  })
  if (answer !== 'confirm') return
  const wasSelected = getState().app?.selectedSessionId === chat.id
  if (wasSelected) startNewSession(chat.projectPath)
  pendingDeletes.schedule(chat.id, () => void call('closeChat', chat.id))
  showToast({
    title: `Deleted “${chat.title}”`,
    action: {
      label: 'Undo',
      run: () => {
        // Back where it was — and back on screen, if it was on screen.
        if (pendingDeletes.undo(chat.id) && wasSelected) void call('openChat', chat.id)
      }
    },
    durationMs: 8000,
    key: `delete:${chat.id}`
  })
}

/** Restart engine (and Reconnect): asks when it would stop running work. */
export async function restartEngine(): Promise<void> {
  const guard = busyGuard('restart', getState().app?.busyTasks ?? 0)
  if (guard) {
    const answer = await confirmDialog({
      title: guard.title,
      message: guard.message,
      confirmLabel: guard.nowLabel,
      destructive: true
    })
    if (answer !== 'confirm') return
  }
  await call('retryBootstrap')
}

/** Update Now: the CLI first, then the app (installing the app quits, which
 *  would throw the CLI's turn away). Running work gets the choice of waiting. */
export async function updateEverything(update: UpdateState): Promise<void> {
  const guard = busyGuard('update', getState().app?.busyTasks ?? 0)
  let whenIdle = false
  if (guard) {
    const answer = await confirmDialog({
      title: guard.title,
      message: guard.message,
      confirmLabel: guard.nowLabel,
      alternateLabel: guard.whenFinishedLabel ?? undefined
    })
    if (answer === 'cancel') return
    whenIdle = answer === 'alternate'
  }
  if (update.cli.available) await call('installCLIUpdate', whenIdle)
  if (update.app.available) {
    if (update.canInstallApp) await call('installAppUpdate', whenIdle)
    else if (update.app.releaseUrl) void quietCall('openExternal', update.app.releaseUrl)
  }
}

/** The engine alone (an out-of-date CLI's "Update" button): restarting onto
 *  the new one stops running work, so it asks the same question. */
export async function updateEngine(): Promise<void> {
  const update = getState().app?.update
  if (update) await updateEverything({ ...update, cli: { ...update.cli, available: true }, app: { ...update.app, available: false } })
}

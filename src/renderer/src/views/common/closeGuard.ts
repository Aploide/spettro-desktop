// "Save changes?" before a sheet with unsaved edits goes away.
//
// The Workflow Studio and the memory editor hold drafts, and their sheets
// close from several places — Escape (handled in App), their own close or
// Done button, switching Settings pane or memory scope. Each place asks
// mayClose(id) instead of closing outright; the view holding the draft
// registers what to ask with useCloseGuard. No guard registered means
// nothing to lose: close.

import { useEffect, useRef } from 'react'
import { confirmDialog } from './ConfirmDialog'

type Guard = () => Promise<boolean>

const guards = new Map<string, Guard>()

/** Whether the sheet `id` may close now (asking first if it holds edits). */
export async function mayClose(id: string): Promise<boolean> {
  const guard = guards.get(id)
  return guard ? guard() : true
}

/** Registers `guard` for sheet `id` while the calling view is mounted. The
 *  latest closure is always the one asked, so it sees current state. */
export function useCloseGuard(id: string, guard: Guard): void {
  const latest = useRef(guard)
  latest.current = guard
  useEffect(() => {
    const entry: Guard = () => latest.current()
    guards.set(id, entry)
    return () => {
      if (guards.get(id) === entry) guards.delete(id)
    }
  }, [id])
}

/**
 * The standard question: Save / Don't Save / Cancel. Resolves true when it is
 * fine to go on (saved, or discarded on purpose) and false to stay. `save`
 * resolves false when saving failed — the edits are still there, so going on
 * would lose them.
 */
export async function askToSave(what: string, save: () => Promise<boolean>): Promise<boolean> {
  const answer = await confirmDialog({
    title: `Save changes to ${what}?`,
    message: 'Your changes will be lost if you don’t save them.',
    confirmLabel: 'Save',
    alternateLabel: 'Don’t Save',
    alternateDestructive: true
  })
  if (answer === 'cancel') return false
  if (answer === 'alternate') return true
  return save()
}

// @vitest-environment jsdom
//
// WP9 review fixes: Escape closes only the topmost sheet (and stands back
// while an alert is up or a sheet opened over it), and a deleted chat's Undo
// toast leaves once the delete has really happened.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'

const calls: [string, unknown[]][] = []
vi.mock('@renderer/state/store', () => ({
  call: (method: string, ...args: unknown[]) => {
    calls.push([method, args])
    return Promise.resolve(null)
  },
  quietCall: () => Promise.resolve(null),
  getState: () => ({ app: { selectedSessionId: null } })
}))
vi.mock('@renderer/state/shell', () => ({ openSettings: vi.fn(), startNewSession: vi.fn() }))

const { useSheetEscape } = await import('@renderer/views/common/useSheetEscape')
const { ConfirmHost, confirmDialog } = await import('@renderer/views/common/ConfirmDialog')
const { currentToasts, dismissToast } = await import('@renderer/views/common/Toast')
const { deleteChat } = await import('@renderer/views/shell/actions')
const { pendingDeletes, UNDO_WINDOW_MS } = await import('@renderer/state/pendingDeletes')

afterEach(() => {
  cleanup()
  calls.length = 0
  for (const t of currentToasts()) dismissToast(t.id)
  vi.useRealTimers()
})

function Sheet({ onClose, enabled = true }: { onClose: () => void; enabled?: boolean }): JSX.Element {
  useSheetEscape(onClose, enabled)
  return <div>sheet</div>
}

describe('useSheetEscape', () => {
  it('closes the sheet and keeps Escape from reaching the window underneath', () => {
    const onClose = vi.fn()
    const below = vi.fn()
    window.addEventListener('keydown', below)
    render(<Sheet onClose={onClose} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    window.removeEventListener('keydown', below)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(below).not.toHaveBeenCalled()
  })

  it('stands back while a sheet it opened is on top', () => {
    const onClose = vi.fn()
    render(<Sheet onClose={onClose} enabled={false} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('leaves Escape to an alert on top of it', async () => {
    const onClose = vi.fn()
    render(
      <>
        <Sheet onClose={onClose} />
        <ConfirmHost />
      </>
    )
    let answer: Promise<string> = Promise.resolve('')
    act(() => {
      answer = confirmDialog({ title: 'Remove it?', confirmLabel: 'Remove', destructive: true })
    })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(await answer).toBe('cancel')
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('delete with undo', () => {
  it('takes the Undo toast down once the delete has happened', async () => {
    vi.useFakeTimers()
    render(<ConfirmHost />)
    const done = deleteChat({ id: 'c1', title: 'Old chat', isBusy: false, projectPath: '/p' })
    await act(async () => {
      await Promise.resolve()
    })
    const ok = document.querySelector<HTMLButtonElement>('[data-testid="confirm-ok"]')
    expect(ok).not.toBeNull()
    await act(async () => {
      ok!.click()
      await done
    })
    expect(pendingDeletes.isPending('c1')).toBe(true)
    expect(currentToasts().some((t) => t.key === 'delete:c1')).toBe(true)
    act(() => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS)
    })
    expect(calls).toContainEqual(['closeChat', ['c1']])
    expect(currentToasts().some((t) => t.key === 'delete:c1')).toBe(false)
  })
})

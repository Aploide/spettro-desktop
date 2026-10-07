// @vitest-environment jsdom
//
// Settings › General's theme control: a radio group that is one tab stop,
// whose arrows move the choice the way a native segmented control does, and
// whose every change goes to main as setAppearance (which persists it and
// flips nativeTheme). The checked state comes back from app-state, not from
// local component state, so a choice made elsewhere shows here too.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { EMPTY_EXTENSIONS } from '@shared/extensions'
import { EMPTY_UPDATE_STATE } from '@shared/update'

const calls: [string, unknown[]][] = []
let appearance = 'light'

vi.mock('@renderer/state/store', () => {
  const mocked = {
    call: (method: string, ...args: unknown[]) => {
      // Settings also refreshes the account on open; only the theme matters here.
      if (method === 'setAppearance') calls.push([method, args])
      return Promise.resolve(null)
    },
    useApp: () => ({
      appearance,
      extensions: EMPTY_EXTENSIONS,
      update: EMPTY_UPDATE_STATE,
      cli: null,
      agentVersion: null,
      defaultConfigOptions: [],
      notifyWhenDone: true
    }),
    useStore: <T,>(select: (s: { chats: Record<string, never> }) => T): T => select({ chats: {} })
  }
  // quietCall is call without the failure toast; to a test they are one.
  return { ...mocked, quietCall: mocked.call }
})

const { default: SettingsView } = await import('@renderer/views/shell/SettingsView')

beforeEach(() => {
  calls.length = 0
  appearance = 'light'
  cleanup()
})

describe('Settings › General › Theme', () => {
  it('opens on General and shows the stored choice as checked', () => {
    render(<SettingsView pane="general" onClose={() => undefined} />)
    const group = screen.getByRole('radiogroup', { name: 'Theme' })
    const radios = within(group).getAllByRole('radio')
    expect(group).toBeTruthy()
    expect(radios.map((r) => r.textContent)).toEqual(['System', 'Light', 'Dark'])
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    // One tab stop: only the checked radio is in the tab order.
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1])
  })

  it('sends a click to main', () => {
    render(<SettingsView pane="general" onClose={() => undefined} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(calls).toEqual([['setAppearance', ['dark']]])
  })

  it('moves the choice with the arrow keys, wrapping at the ends', () => {
    render(<SettingsView pane="general" onClose={() => undefined} />)
    const group = screen.getByRole('radiogroup', { name: 'Theme' })
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    fireEvent.keyDown(group, { key: 'ArrowLeft' })
    appearance = 'system'
    cleanup()
    render(<SettingsView pane="general" onClose={() => undefined} />)
    fireEvent.keyDown(screen.getByRole('radiogroup', { name: 'Theme' }), { key: 'ArrowLeft' })
    expect(calls).toEqual([
      ['setAppearance', ['dark']],
      ['setAppearance', ['system']],
      ['setAppearance', ['dark']]
    ])
  })
})

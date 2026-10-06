// @vitest-environment jsdom
//
// Settings as one window with a sidebar of panes: every pane in the list
// opens and draws its title (a pane that throws would blank the window), the
// sidebar marks the open one, choosing another asks the open pane first
// (Memory with unsaved edits), Enter no longer closes anything, and the
// Updates pane leads with one "up to date / Update now" row.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { EMPTY_EXTENSIONS } from '@shared/extensions'
import { EMPTY_COMPONENT_UPDATE, EMPTY_UPDATE_STATE } from '@shared/update'
import type { ACPConfigOption } from '@shared/acp'

const calls: [string, unknown[]][] = []

const PERMISSION: ACPConfigOption = {
  id: 'permission',
  name: 'Permission',
  kind: {
    type: 'select',
    currentValue: 'restricted',
    groups: [],
    flat: [
      { value: 'ask-first', name: 'Ask first', description: 'Prompt before running tools' },
      { value: 'restricted', name: 'Restricted', description: 'Allow safe actions' },
      { value: 'yolo', name: 'YOLO', description: 'Approve everything' }
    ]
  }
}

let update = EMPTY_UPDATE_STATE

vi.mock('@renderer/state/store', () => {
  const mocked = {
    call: (method: string, ...args: unknown[]) => {
      calls.push([method, args])
      return Promise.resolve(method === 'loadMemory' ? 'Prefers pnpm.' : null)
    },
    useApp: () => ({
      phase: { kind: 'ready' },
      connection: 'ok',
      appearance: 'system',
      accent: 'lilac',
      extensions: EMPTY_EXTENSIONS,
      update,
      cli: { path: '/home/me/.local/bin/spettro', version: '2.9.0', isDev: false },
      agentVersion: '2.9.0',
      agentLog: [],
      remote: null,
      selectedSessionId: null,
      sessions: [],
      lastProjectPath: '/work/acme',
      defaultProjectPath: '/work/acme',
      defaultConfigOptions: [PERMISSION],
      notifyWhenDone: true,
      busyTasks: 0
    }),
    useStore: <T,>(select: (s: { chats: Record<string, never> }) => T): T => select({ chats: {} }),
    getState: () => ({ app: null, chats: {}, permissions: [], questions: [] })
  }
  return { ...mocked, quietCall: mocked.call }
})

const { default: SettingsView, PANES } = await import('@renderer/views/shell/SettingsView')
const { ConfirmHost } = await import('@renderer/views/common/ConfirmDialog')
const shell = await import('@renderer/state/shell')

afterEach(() => {
  cleanup()
  calls.length = 0
  update = EMPTY_UPDATE_STATE
  shell.closeSettings()
})

describe('Settings', () => {
  it.each(PANES.map((p) => [p.id, p.label] as const))('opens %s', async (id, label) => {
    render(<SettingsView pane={id} onClose={() => undefined} />)
    await act(async () => undefined)
    expect(screen.getByRole('heading', { name: label })).toBeTruthy()
    expect(screen.getByRole('tab', { name: label }).getAttribute('aria-selected')).toBe('true')
  })

  it('lists every pane the plan names, in order', () => {
    expect(PANES.map((p) => p.label)).toEqual([
      'General',
      'Account',
      'Models & providers',
      'Permissions',
      'Memory',
      'Remote',
      'Updates',
      'Advanced',
      'Keyboard shortcuts',
      'About'
    ])
  })

  it('draws every sidebar glyph as an outline (a solid disc reads as selected)', () => {
    expect(PANES.filter((p) => p.icon.endsWith('.fill'))).toEqual([])
  })

  it('keeps Done neutral: the accent is the pane’s own main action', () => {
    render(<SettingsView pane="updates" onClose={() => undefined} />)
    expect(screen.getByRole('button', { name: 'Done' }).classList.contains('btn--prominent')).toBe(false)
  })

  it('opens another pane from the sidebar', async () => {
    render(<SettingsView pane="general" onClose={() => undefined} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Permissions' }))
    await act(async () => undefined)
    expect(shell.getShell().settingsPane).toBe('permissions')
  })

  it('asks before leaving Memory with unsaved edits', async () => {
    render(
      <>
        <SettingsView pane="memory" onClose={() => undefined} />
        <ConfirmHost />
      </>
    )
    await act(async () => undefined)
    const editor = screen.getByRole('textbox', { name: 'Facts about you' })
    fireEvent.change(editor, { target: { value: 'Prefers pnpm.\nWrites tests first.' } })
    fireEvent.click(screen.getByRole('tab', { name: 'General' }))
    await act(async () => undefined)
    const alert = screen.getByRole('alertdialog', { name: 'Save changes to facts about you?' })
    expect(alert).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => undefined)
    expect(shell.getShell().settingsPane).toBeNull()
    expect(calls.filter(([m]) => m === 'saveMemory')).toEqual([])
  })

  it('does not close on Enter', () => {
    const onClose = vi.fn()
    render(<SettingsView pane="general" onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('radio', { name: 'System' }), { key: 'Enter' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('changes the default permission from General', () => {
    render(<SettingsView pane="general" onClose={() => undefined} />)
    const group = screen.getByRole('radiogroup', { name: 'Default permission' })
    fireEvent.click(within(group).getByRole('radio', { name: 'Ask first' }))
    expect(calls.filter(([m]) => m === 'setDefaultOption')).toEqual([['setDefaultOption', ['permission', 'ask-first']]])
    // A segmented control like Theme's, not the platform's drop-down.
    expect(screen.queryByRole('combobox', { name: 'Default permission' })).toBeNull()
  })

  it('says Spettro is up to date in one row, and offers Update now when it isn’t', async () => {
    update = {
      ...EMPTY_UPDATE_STATE,
      app: { ...EMPTY_COMPONENT_UPDATE, current: '0.1.7', latest: '0.1.7' },
      cli: { ...EMPTY_COMPONENT_UPDATE, current: '2.9.0', latest: '2.9.0' }
    }
    const { unmount } = render(<SettingsView pane="updates" onClose={() => undefined} />)
    expect(screen.getByText('Spettro is up to date')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Update now/ })).toBeNull()
    unmount()

    update = { ...update, cli: { ...update.cli, latest: '2.9.1', available: true } }
    render(<SettingsView pane="updates" onClose={() => undefined} />)
    expect(screen.getByText('An update is available')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Update now/ }))
    await act(async () => undefined)
    expect(calls.filter(([m]) => m === 'installCLIUpdate')).toEqual([['installCLIUpdate', [false]]])
  })
})

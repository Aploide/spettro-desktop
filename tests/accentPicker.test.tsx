// @vitest-environment jsdom
//
// Settings › General › Accent: Lilac or Monochrome, a segmented control next
// to Theme. Its checked state comes from app-state (so a choice made in
// another window shows here too), every change goes to main as setAccent,
// and each choice carries a swatch of itself. The accent reaches the page as
// data-accent on <html>: applyAccent puts it there, the store does so on every
// app-state before the re-render, and anything unknown falls back to Lilac.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { EMPTY_EXTENSIONS } from '@shared/extensions'
import { EMPTY_UPDATE_STATE } from '@shared/update'
import { applyAccent, onAccentChange } from '@renderer/design/accent'

const calls: [string, unknown[]][] = []
let accent: string | undefined = 'lilac'

vi.mock('@renderer/state/store', () => {
  const mocked = {
    call: (method: string, ...args: unknown[]) => {
      if (method === 'setAccent' || method === 'setAppearance') calls.push([method, args])
      return Promise.resolve(null)
    },
    useApp: () => ({
      appearance: 'system',
      accent,
      extensions: EMPTY_EXTENSIONS,
      update: EMPTY_UPDATE_STATE,
      cli: null,
      agentVersion: null,
      defaultConfigOptions: [],
      notifyWhenDone: true
    }),
    useStore: <T,>(select: (s: { chats: Record<string, never> }) => T): T => select({ chats: {} })
  }
  return { ...mocked, quietCall: mocked.call }
})

const { default: SettingsView } = await import('@renderer/views/shell/SettingsView')

beforeEach(() => {
  calls.length = 0
  accent = 'lilac'
  cleanup()
  document.documentElement.removeAttribute('data-accent')
})

function accentGroup(): HTMLElement {
  return screen.getByRole('radiogroup', { name: 'Accent' })
}

describe('Settings › General › Accent', () => {
  it('sits in Appearance beside Theme and shows the stored choice', () => {
    render(<SettingsView pane="general" onClose={() => undefined} />)
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeTruthy()
    const radios = within(accentGroup()).getAllByRole('radio')
    expect(radios.map((r) => r.textContent)).toEqual(['Lilac', 'Monochrome'])
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1])
  })

  it('shows Monochrome checked when that is stored', () => {
    accent = 'mono'
    render(<SettingsView pane="general" onClose={() => undefined} />)
    const radios = within(accentGroup()).getAllByRole('radio')
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true'])
  })

  it('reads as Lilac before app-state says otherwise', () => {
    accent = undefined
    render(<SettingsView pane="general" onClose={() => undefined} />)
    expect(within(accentGroup()).getByRole('radio', { name: 'Lilac' }).getAttribute('aria-checked')).toBe('true')
  })

  it('gives each choice a swatch of itself, hidden from assistive tech', () => {
    render(<SettingsView pane="general" onClose={() => undefined} />)
    const lilac = within(accentGroup()).getByRole('radio', { name: 'Lilac' })
    const mono = within(accentGroup()).getByRole('radio', { name: 'Monochrome' })
    expect(lilac.querySelector('.segmented-swatch--lilac')?.getAttribute('aria-hidden')).toBe('true')
    expect(mono.querySelector('.segmented-swatch--mono')).not.toBeNull()
  })

  it('sends a click to main as setAccent, and nothing to the theme', () => {
    render(<SettingsView pane="general" onClose={() => undefined} />)
    fireEvent.click(within(accentGroup()).getByRole('radio', { name: 'Monochrome' }))
    expect(calls).toEqual([['setAccent', ['mono']]])
  })

  it('moves the choice with the arrow keys, wrapping at the ends', () => {
    render(<SettingsView pane="general" onClose={() => undefined} />)
    fireEvent.keyDown(accentGroup(), { key: 'ArrowRight' })
    fireEvent.keyDown(accentGroup(), { key: 'ArrowLeft' })
    expect(calls).toEqual([
      ['setAccent', ['mono']],
      ['setAccent', ['mono']]
    ])
  })
})

describe('applyAccent', () => {
  it('puts the accent on <html>', () => {
    expect(applyAccent('mono')).toBe('mono')
    expect(document.documentElement.getAttribute('data-accent')).toBe('mono')
    applyAccent('lilac')
    expect(document.documentElement.getAttribute('data-accent')).toBe('lilac')
  })

  it('falls back to Lilac for anything it does not know', () => {
    document.documentElement.setAttribute('data-accent', 'mono')
    expect(applyAccent('terracotta')).toBe('lilac')
    expect(document.documentElement.getAttribute('data-accent')).toBe('lilac')
    expect(applyAccent(undefined)).toBe('lilac')
  })

  it('tells observers about a change, and only about a change', async () => {
    applyAccent('lilac')
    const seen: string[] = []
    const stop = onAccentChange(() => seen.push(document.documentElement.getAttribute('data-accent')!))
    applyAccent('lilac')
    applyAccent('mono')
    await Promise.resolve()
    stop()
    applyAccent('lilac')
    await Promise.resolve()
    expect(seen).toEqual(['mono'])
  })
})

describe('the store', () => {
  it('applies the accent from every app-state, before views re-render', async () => {
    vi.resetModules()
    vi.doUnmock('@renderer/state/store')
    let listener: ((e: unknown) => void) | null = null
    ;(window as unknown as { spettro: unknown }).spettro = {
      platform: 'linux',
      accent: 'lilac',
      call: () => Promise.resolve(null),
      onEvent: (l: (e: unknown) => void) => {
        listener = l
        return () => undefined
      }
    }
    const store = await import('@renderer/state/store')
    store.initStore()
    expect(listener).not.toBeNull()
    listener!({ type: 'app-state', state: { accent: 'mono' } })
    expect(document.documentElement.getAttribute('data-accent')).toBe('mono')
    listener!({ type: 'app-state', state: { accent: 'lilac' } })
    expect(document.documentElement.getAttribute('data-accent')).toBe('lilac')
  })
})

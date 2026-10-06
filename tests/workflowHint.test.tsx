// @vitest-environment jsdom
//
// The composer's word on a message that asks for workflows. Under Ask first
// the CLI refuses every workflow (internal/agent/workflow.go), so a phrase lit
// like any other would promise a run that cannot happen: it is marked but
// muted, and the line under the field says why and offers the way out. A
// "+500k" directive lights only when it would be honoured, and the line says
// what budget it sets.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import Composer from '@renderer/views/chat/Composer'
import type { ChatDetail } from '@shared/model'
import type { ACPConfigOption } from '@shared/acp'

const calls: [string, unknown[]][] = []

vi.mock('@renderer/state/store', () => ({
  call: (method: string, ...args: unknown[]) => {
    calls.push([method, args])
    return Promise.resolve()
  },
  useApp: () => ({ phase: { kind: 'ready' } })
}))

beforeEach(() => {
  calls.length = 0
  cleanup()
})

function options(o: { permission: string; ultra: boolean }): ACPConfigOption[] {
  return [
    {
      id: 'permission',
      name: 'Permission',
      kind: {
        type: 'select',
        currentValue: o.permission,
        groups: [],
        flat: [
          { value: 'ask-first', name: 'Ask first' },
          { value: 'restricted', name: 'Restricted' },
          { value: 'yolo', name: 'YOLO' }
        ]
      }
    },
    { id: 'ultra', name: 'Ultra', kind: { type: 'boolean', currentValue: o.ultra } }
  ]
}

function chat(opts: ACPConfigOption[]): ChatDetail {
  return {
    id: 'chat-1',
    title: 't',
    projectPath: '/p',
    acpSessionId: 'acp-1',
    isPinned: false,
    isArchived: false,
    isBusy: false,
    createdAt: 0,
    items: [],
    configOptions: opts,
    commands: [],
    plan: [],
    usage: null,
    lastTurn: null,
    sessionTokens: 0
  }
}

function type(text: string): void {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } })
}

describe('under Ask first', () => {
  it('mutes the phrase and says workflows are paused, with a way out', () => {
    const { container } = render(<Composer chat={chat(options({ permission: 'ask-first', ultra: false }))} />)
    type('ultracode: review the changes')
    expect(container.querySelector('.glow--muted')?.textContent).toBe('ultracode')
    expect(screen.getByRole('status').textContent).toMatch(/paused under Ask first/)
    fireEvent.click(screen.getByText('Switch to Restricted'))
    expect(calls).toContainEqual(['setSelectOption', ['chat-1', 'permission', 'restricted']])
  })

  it('says workflows are paused when a budget is written for the standing Ultra', () => {
    // Ultra is saved but suspended under Ask first; a "+500k" aimed at it
    // would be ignored, and the line has to say so rather than stay silent.
    render(<Composer chat={chat(options({ permission: 'ask-first', ultra: true }))} />)
    type('review the changes +500k')
    expect(screen.getByRole('status').textContent).toMatch(/paused under Ask first/)
  })

  it('says nothing about a message that does not ask for workflows', () => {
    render(<Composer chat={chat(options({ permission: 'ask-first', ultra: false }))} />)
    type('fix the typo in README')
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('with workflows allowed', () => {
  it('lights the phrase at full strength and gives no warning', () => {
    const { container } = render(<Composer chat={chat(options({ permission: 'restricted', ultra: false }))} />)
    type('ultracode: review the changes')
    expect(container.querySelector('.glow:not(.glow--muted)')?.textContent).toBe('ultracode')
    expect(screen.queryByText(/paused under Ask first/)).toBeNull()
  })

  it('lights a budget directive beside the keyword and names the budget', () => {
    const { container } = render(<Composer chat={chat(options({ permission: 'restricted', ultra: false }))} />)
    type('ultracode +500k: review the changes')
    const lit = Array.from(container.querySelectorAll('.glow')).map((el) => el.textContent)
    expect(lit).toEqual(['ultracode', '+500k'])
    expect(screen.getByRole('status').textContent).toMatch(/500k tokens/)
  })

  it('honours a directive alone when Ultra is on, and ignores it when it is off', () => {
    const on = render(<Composer chat={chat(options({ permission: 'yolo', ultra: true }))} />)
    type('review the changes +1.5m')
    expect(on.container.querySelector('.glow')?.textContent).toBe('+1.5m')
    expect(screen.getByRole('status').textContent).toMatch(/1\.5m tokens/)
    cleanup()
    const off = render(<Composer chat={chat(options({ permission: 'yolo', ultra: false }))} />)
    type('review the changes +1.5m')
    expect(off.container.querySelector('.glow')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })
})

// @vitest-environment jsdom
//
// The composer toolbar's option cluster: the mode chip, the thinking chip and
// the settings button, whose popover holds everything else the CLI
// advertises. Thinking and Ultra are one control — the thinking slider, opened
// from a chip (tests/thinkingSlider.test.tsx covers the slider) — and there is
// no Ultra toggle anywhere, in the bar or the popover: only a test can show
// that something is *absent*.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react'
import ConfigBar, { nextMode } from '@renderer/views/chat/ConfigBar'
import type { ChatDetail } from '@shared/model'
import type { ACPConfigOption } from '@shared/acp'

const calls: [string, unknown[]][] = []

vi.mock('@renderer/state/store', () => {
  const mocked = {
    call: (method: string, ...args: unknown[]) => {
      calls.push([method, args])
      return Promise.resolve()
    },
    useApp: () => null
  }
  // quietCall is call without the failure toast; to a test they are one.
  return { ...mocked, quietCall: mocked.call }
})

beforeEach(() => {
  calls.length = 0
  cleanup()
})

function permission(value: string): ACPConfigOption {
  return {
    id: 'permission',
    name: 'Permission',
    kind: {
      type: 'select',
      currentValue: value,
      groups: [],
      flat: [
        { value: 'ask-first', name: 'Ask first' },
        { value: 'restricted', name: 'Restricted' },
        { value: 'yolo', name: 'YOLO' }
      ]
    }
  }
}

function ultra(on: boolean): ACPConfigOption {
  return { id: 'ultra', name: 'Ultra', kind: { type: 'boolean', currentValue: on } }
}

function chat(options: ACPConfigOption[]): ChatDetail {
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
    configOptions: options,
    commands: [],
    plan: [],
    usage: null,
    lastTurn: null,
    sessionTokens: 0
  }
}

function thinking(value: string): ACPConfigOption {
  return {
    id: 'thinking',
    name: 'Thinking',
    category: 'thought_level',
    kind: {
      type: 'select',
      currentValue: value,
      groups: [],
      flat: ['off', 'low', 'medium', 'high', 'x-high', 'max'].map((v) => ({ value: v, name: v }))
    }
  }
}

describe('thinking and Ultra', () => {
  it('are one chip, named for the level', () => {
    render(<ConfigBar chat={chat([permission('restricted'), thinking('x-high'), ultra(false)])} />)
    expect(screen.getByTestId('thinking-chip').textContent).toContain('Extra high')
  })

  it('never draw an Ultra toggle, whether Ultra is on or off', () => {
    for (const on of [false, true]) {
      cleanup()
      render(<ConfigBar chat={chat([permission('restricted'), thinking('high'), ultra(on)])} />)
      // Besides the thinking chip, the only button is the settings button,
      // which names the permission level.
      const others = screen
        .getAllByRole('button')
        .filter((b) => b.getAttribute('data-testid') !== 'thinking-chip')
      expect(others.map((b) => b.getAttribute('data-testid'))).toEqual(['session-settings'])
      expect(others[0].textContent).toBe('Restricted')
      // Nor inside the settings popover: nothing pressed, no switch, no
      // checkbox — Ultra is the slider's last stop and nothing else.
      fireEvent.click(others[0])
      expect(document.querySelector('[aria-pressed]')).toBeNull()
      expect(screen.queryByRole('switch')).toBeNull()
      expect(screen.queryByRole('checkbox')).toBeNull()
      const ultraWords = screen
        .queryAllByText(/^Ultra(code)?$/)
        .filter((n) => !n.closest('.thinking-slider, [data-testid="thinking-chip"]'))
      expect(ultraWords).toEqual([])
    }
  })

  it('show Ultra on the chip when it is on', () => {
    render(<ConfigBar chat={chat([permission('restricted'), thinking('high'), ultra(true)])} />)
    const chip = screen.getByTestId('thinking-chip')
    expect(chip.textContent).toContain('Ultra')
    expect(chip.getAttribute('title')).toMatch(/ultracode/)
  })

  it('open the slider from the chip', () => {
    render(<ConfigBar chat={chat([permission('restricted'), thinking('high'), ultra(false)])} />)
    fireEvent.click(screen.getByTestId('thinking-chip'))
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('High')
  })

  it('hand the focus back to the chip when Escape closes the slider', () => {
    // The slider takes the focus as it opens; closing must not strand a
    // keyboard user on <body>.
    render(<ConfigBar chat={chat([permission('restricted'), thinking('high'), ultra(false)])} />)
    const chip = screen.getByTestId('thinking-chip')
    fireEvent.click(chip)
    const slider = screen.getByRole('slider')
    slider.focus()
    fireEvent.keyDown(slider, { key: 'Escape' })
    expect(screen.queryByRole('slider')).toBeNull()
    expect(document.activeElement).toBe(chip)
  })
})

describe('the settings popover', () => {
  // internal/acp/config_options.go workflowSizeConfigOption: names are the
  // capitalised tiers, descriptions carry the agent guideline.
  function size(value: string, describe = true): ACPConfigOption {
    const tiers = [
      ['small', 'Small', '~5 agents per run · fan-outs up to ~5 wide'],
      ['medium', 'Medium', '~10 agents per run · fan-outs up to ~10 wide'],
      ['large', 'Large', '~30 agents per run · fan-outs up to ~30 wide'],
      ['unbounded', 'Unbounded', 'no agent guideline · fan-outs up to ~50 wide']
    ]
    return {
      id: 'workflow_size',
      name: 'Workflow size',
      description: 'How many agents a workflow run plans around (a guideline, not a cap)',
      kind: {
        type: 'select',
        currentValue: value,
        groups: [],
        flat: tiers.map(([v, name, d]) => (describe ? { value: v, name, description: d } : { value: v, name }))
      }
    }
  }

  function open(options: ACPConfigOption[]): void {
    render(<ConfigBar chat={chat(options)} />)
    fireEvent.click(screen.getByTestId('session-settings'))
  }

  function segments(): string[] {
    return Array.from(
      screen.getByRole('radiogroup', { name: 'Workflow size' }).querySelectorAll('.session-segment-hint'),
      (n) => n.textContent ?? ''
    )
  }

  it('takes the focus as it opens, onto the current choice, and gives it back on Escape', async () => {
    open([permission('restricted'), size('large')])
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    const current = screen.getByRole('radio', { checked: true, name: /Restricted/ })
    expect(document.activeElement).toBe(current)
    fireEvent.keyDown(current, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Session settings' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('session-settings'))
  })

  it('labels workflow size tiers in agents, read from the tier’s own description', () => {
    open([size('large')])
    expect(segments()).toEqual(['~5 helpers', '~10 helpers', '~30 helpers', 'No limit'])
    const on = screen.getByRole('radio', { checked: true })
    expect(on.textContent).toBe('Large~30 helpers')
  })

  it('falls back to the known tiers when the CLI gives no descriptions', () => {
    open([size('medium', false)])
    expect(segments()).toEqual(['~5 helpers', '~10 helpers', '~30 helpers', 'No limit'])
  })

  it('sets the size through the ordinary select path', () => {
    open([size('medium')])
    fireEvent.click(screen.getByRole('radio', { name: /Small/ }))
    expect(calls).toEqual([['setSelectOption', ['chat-1', 'workflow_size', 'small']]])
  })

  it('names the permission levels plainly, with the CLI’s descriptions', () => {
    open([permission('yolo')])
    const radios = screen.getAllByRole('radio').map((r) => r.querySelector('.session-settings-name')?.textContent)
    expect(radios).toEqual([
      'Ask first · Ask before acting',
      'Restricted · Act within the project',
      'Don’t ask (YOLO) · Act without asking'
    ])
    fireEvent.click(screen.getAllByRole('radio')[1])
    expect(calls).toEqual([['setSelectOption', ['chat-1', 'permission', 'restricted']]])
  })

  it('lists each choice once, as the parser hands them over (groups and their union)', () => {
    // parse.ts fills `flat` with every grouped choice as well.
    const parsed = permission('restricted')
    if (parsed.kind.type === 'select') parsed.kind.groups = [{ name: '', options: parsed.kind.flat }]
    open([parsed])
    expect(screen.getAllByRole('radio')).toHaveLength(3)
  })

  it('says the settings are shared by every session', () => {
    open([permission('restricted')])
    expect(screen.getByText('Applies to all sessions')).toBeTruthy()
  })

  it('leaves thinking to its chip — permission first, then size, no second slider', () => {
    open([size('medium'), thinking('high'), ultra(false), permission('restricted')])
    const sections = Array.from(document.querySelectorAll('.session-settings-section'))
    expect(sections).toHaveLength(2)
    expect(sections[0].getAttribute('aria-label')).toBe('Permission')
    expect(sections[1].getAttribute('aria-label')).toBe('Workflow size')
    expect(document.querySelector('.session-settings-panel [role="slider"]')).toBeNull()
  })

  it('stays data-driven — an unknown boolean renders as a switch and toggles', () => {
    open([{ id: 'auto-compact', name: 'Auto-compact', kind: { type: 'boolean', currentValue: false } }])
    fireEvent.click(screen.getByRole('switch'))
    expect(calls).toEqual([['setBoolOption', ['chat-1', 'auto-compact', true]]])
  })

  it('stays data-driven — an unknown select renders its choices', () => {
    open([
      {
        id: 'verbosity',
        name: 'Verbosity',
        kind: {
          type: 'select',
          currentValue: 'terse',
          groups: [],
          flat: [
            { value: 'terse', name: 'Terse', description: 'Short answers' },
            { value: 'chatty', name: 'Chatty' }
          ]
        }
      }
    ])
    expect(screen.getByRole('radiogroup', { name: 'Verbosity' })).toBeTruthy()
    expect(screen.getByText('Short answers')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /Chatty/ }))
    expect(calls).toEqual([['setSelectOption', ['chat-1', 'verbosity', 'chatty']]])
  })
})

describe('the rest of the bar', () => {
  function mode(value: string): ACPConfigOption {
    return {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      kind: {
        type: 'select',
        currentValue: value,
        groups: [],
        flat: [
          { value: 'plan', name: 'Plan' },
          { value: 'coding', name: 'Coding' },
          { value: 'ask', name: 'Ask' }
        ]
      }
    }
  }

  it('draws the mode as a chip in its own colour', () => {
    render(<ConfigBar chat={chat([mode('plan')])} />)
    const chip = screen.getByTestId('mode-chip')
    expect(chip.textContent).toBe('Plan')
    expect(chip.getAttribute('style')).toContain('--mode-plan')
    expect(chip.getAttribute('title')).toMatch(/Shift\+Tab/)
  })

  it('steps through the modes in the CLI’s order, wrapping', () => {
    expect(nextMode([mode('plan')])).toBe('coding')
    expect(nextMode([mode('ask')])).toBe('plan')
    expect(nextMode([])).toBeNull()
  })

  it('draws nothing at all when the agent advertises nothing', () => {
    const { container } = render(<ConfigBar chat={chat([])} />)
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('survives an ultra option with no permission chip beside it', () => {
    // Feature detection cuts both ways: a CLI that stops sending `permission`
    // must not take the whole bar down with it.
    expect(() => render(<ConfigBar chat={chat([ultra(false)])} />)).not.toThrow()
  })
})

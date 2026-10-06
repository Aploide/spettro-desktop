// @vitest-environment jsdom
//
// The config bar draws whatever the CLI advertises, with two exceptions that
// are one control: thinking and Ultra are the thinking slider, opened from a
// chip (tests/thinkingSlider.test.tsx covers the slider). There is no Ultra
// toggle anywhere — only a test can show that something is *absent*.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import ConfigBar from '@renderer/views/chat/ConfigBar'
import type { ChatDetail } from '@shared/model'
import type { ACPConfigOption } from '@shared/acp'

const calls: [string, unknown[]][] = []

vi.mock('@renderer/state/store', () => ({
  call: (method: string, ...args: unknown[]) => {
    calls.push([method, args])
    return Promise.resolve()
  },
  useApp: () => null
}))

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
      // Nothing toggles: no pressed-state button, no switch, no checkbox.
      expect(document.querySelector('[aria-pressed]')).toBeNull()
      expect(screen.queryByRole('switch')).toBeNull()
      expect(screen.queryByRole('checkbox')).toBeNull()
      // Besides the thinking chip, the only button is the permission chip.
      const others = screen
        .getAllByRole('button')
        .filter((b) => b.getAttribute('data-testid') !== 'thinking-chip')
      expect(others.map((b) => b.textContent)).toEqual(['Restricted'])
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

describe('the workflow size chip', () => {
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

  it('labels the tier in agents, read from the tier’s own description', () => {
    const { container } = render(<ConfigBar chat={chat([size('large')])} />)
    expect(container.querySelector('.config-chip-label')?.textContent).toBe('Large · ~30 agents')
  })

  it('says "No limit" for unbounded, and falls back to the known tiers', () => {
    const { container } = render(<ConfigBar chat={chat([size('unbounded')])} />)
    expect(container.querySelector('.config-chip-label')?.textContent).toBe('Unbounded · No limit')
    cleanup()
    const bare = render(<ConfigBar chat={chat([size('medium', false)])} />)
    expect(bare.container.querySelector('.config-chip-label')?.textContent).toBe('Medium · ~10 agents')
  })

  it('sets the size through the ordinary select path', () => {
    render(<ConfigBar chat={chat([size('medium')])} />)
    fireEvent.click(screen.getByText('Medium'))
    fireEvent.click(screen.getByText('Small'))
    expect(calls).toEqual([['setSelectOption', ['chat-1', 'workflow_size', 'small']]])
  })
})

describe('the rest of the bar', () => {
  it('stays data-driven — an unknown boolean still renders and still toggles', () => {
    render(
      <ConfigBar
        chat={chat([{ id: 'auto-compact', name: 'Auto-compact', kind: { type: 'boolean', currentValue: false } }])}
      />
    )
    fireEvent.click(screen.getByText('Auto-compact'))
    expect(calls).toEqual([['setBoolOption', ['chat-1', 'auto-compact', true]]])
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

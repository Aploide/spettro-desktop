// @vitest-environment jsdom
//
// The Ultra chip is locked under Ask first, where workflows cannot run
// (internal/agent/workflow.go refuses them), so the user learns about it
// before spending a click. A screenshot shows the chip looking disabled; only
// a test shows that clicking it does nothing, and that the rule is read off
// the sibling permission chip rather than remembered separately. (The
// thinking slider replaces this chip.)

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
  }
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

describe('the Ultra chip', () => {
  it('toggles on when the permission level allows workflows', () => {
    render(<ConfigBar chat={chat([permission('restricted'), ultra(false)])} />)
    fireEvent.click(screen.getByText('Ultra'))
    expect(calls).toEqual([['setBoolOption', ['chat-1', 'ultra', true]]])
  })

  it('refuses to arm under Ask first, and says why', () => {
    // A workflow runs many agents at once; per-action approval prompts would
    // flood the user, so workflows need Restricted or YOLO.
    render(<ConfigBar chat={chat([permission('ask-first'), ultra(false)])} />)
    const chip = screen.getByText('Ultra').closest('button') as HTMLButtonElement
    fireEvent.click(chip)

    expect(calls).toEqual([])
    // aria-disabled rather than `disabled` on purpose: a disabled button in
    // Chromium swallows the pointer events its own tooltip needs, which would
    // leave a dead control and no explanation — the entire reason it is still
    // on screen. So it stays focusable, carries the reason, and does not fire.
    expect(chip.getAttribute('aria-disabled')).toBe('true')
    expect(chip.disabled).toBe(false)
    expect(chip.getAttribute('title') ?? '').toMatch(/Restricted or YOLO/i)
  })

  it('is still visible when it cannot be used', () => {
    // A control that vanishes when you are not allowed to use it is a control
    // nobody ever learns exists.
    render(<ConfigBar chat={chat([permission('ask-first'), ultra(false)])} />)
    expect(screen.getByText('Ultra')).toBeTruthy()
  })

  it('can always be turned OFF, whatever the permission level is', () => {
    // The gate exists to stop workflows starting under ask-first. Someone who
    // arrived at ultra-on and then lowered their permission has to be able to
    // get out again.
    render(<ConfigBar chat={chat([permission('ask-first'), ultra(true)])} />)
    fireEvent.click(screen.getByText('Ultra'))
    expect(calls).toEqual([['setBoolOption', ['chat-1', 'ultra', false]]])
  })

  it('reads the rule off the sibling chip, not off a value of its own', () => {
    // The two chips sit in the same bar and must never disagree.
    render(<ConfigBar chat={chat([permission('yolo'), ultra(false)])} />)
    const chip = screen.getByText('Ultra').closest('button') as HTMLButtonElement
    expect(chip.getAttribute('aria-disabled')).toBe('false')
  })
})

describe('the Ultra chip’s words', () => {
  it('say what Ultra does now: ultracode, run as workflows', () => {
    // Ultra used to fan a prompt out in parallel; since the CLI's /ultra
    // switch it means ultracode, and the words must not describe the old mode.
    render(<ConfigBar chat={chat([permission('yolo'), ultra(false)])} />)
    const title = screen.getByText('Ultra').closest('button')?.getAttribute('title') ?? ''
    expect(title).toBe('Ultracode — substantial tasks run as multi-agent workflows (uses more tokens)')
  })

  it('pass on that a saved Ultra is paused under Ask first', () => {
    const suspended: ACPConfigOption = {
      ...ultra(true),
      description:
        'Ultracode: substantive tasks run as dynamic workflows (suspended under Ask first — workflows need Restricted or YOLO)'
    }
    render(<ConfigBar chat={chat([permission('ask-first'), suspended])} />)
    const title = screen.getByText('Ultra').closest('button')?.getAttribute('title') ?? ''
    expect(title).toMatch(/Paused under Ask first/)
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

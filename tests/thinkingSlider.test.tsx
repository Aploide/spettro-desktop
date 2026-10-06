// @vitest-environment jsdom
//
// The thinking slider as a user drives it: arrow keys, the Ultra stop's two
// calls in order, the Paused prompt under Ask first, the meteor — which
// must play when Ultra is reached and never merely because the slider was
// drawn with Ultra already on — and lit Ultra's smoulder, which runs only
// while someone could be looking at it.

import { describe, expect, it, vi, beforeEach, beforeAll, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import ThinkingSlider, { ThinkingChip } from '@renderer/views/chat/ThinkingSlider'
import type { ChatDetail } from '@shared/model'
import type { ACPConfigOption } from '@shared/acp'

/** Every call, and a way to hold one open so ordering can be checked. */
const calls: [string, unknown[]][] = []
let hold: { release: () => void } | null = null
let holding = false

vi.mock('@renderer/state/store', () => {
  const mocked = {
    call: (method: string, ...args: unknown[]) => {
      calls.push([method, args])
      if (!holding) return Promise.resolve()
      return new Promise<void>((resolve) => {
        hold = { release: resolve }
      })
    },
    useApp: () => null
  }
  // quietCall is call without the failure toast; to a test they are one.
  return { ...mocked, quietCall: mocked.call }
})

beforeAll(() => {
  // jsdom has no canvas; the slider keeps the meteor's timing without one.
  HTMLCanvasElement.prototype.getContext = (() => null) as never
})

beforeEach(() => {
  calls.length = 0
  hold = null
  holding = false
  cleanup()
})

function options(o: { thinking: string; ultra: boolean; permission?: string; suspended?: boolean }): ACPConfigOption[] {
  return [
    {
      id: 'permission',
      name: 'Permission',
      kind: {
        type: 'select',
        currentValue: o.permission ?? 'restricted',
        groups: [],
        flat: [
          { value: 'ask-first', name: 'Ask first' },
          { value: 'restricted', name: 'Restricted' },
          { value: 'yolo', name: 'YOLO' }
        ]
      }
    },
    {
      id: 'thinking',
      name: 'Thinking',
      kind: {
        type: 'select',
        currentValue: o.thinking,
        groups: [],
        flat: ['off', 'low', 'medium', 'high', 'x-high', 'max'].map((v) => ({ value: v, name: v }))
      }
    },
    {
      id: 'ultra',
      name: 'Ultra',
      description: o.suspended
        ? 'Ultracode: substantive tasks run as dynamic workflows (suspended under Ask first — workflows need Restricted or YOLO)'
        : 'Ultracode: substantive tasks run as dynamic workflows',
      kind: { type: 'boolean', currentValue: o.ultra }
    }
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

const slider = (): HTMLElement => screen.getByRole('slider')
const press = (key: string): void => {
  fireEvent.keyDown(slider(), { key })
}
/** Lets queued calls run to completion. */
const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

describe('the slider', () => {
  it('is a real slider: role, range and the value in words', () => {
    render(<ThinkingSlider chat={chat(options({ thinking: 'x-high', ultra: false }))} />)
    expect(slider().getAttribute('aria-valuemin')).toBe('0')
    expect(slider().getAttribute('aria-valuemax')).toBe('5')
    expect(slider().getAttribute('aria-valuenow')).toBe('3')
    expect(slider().getAttribute('aria-valuetext')).toBe('Extra high')
  })

  it('shows Ultra when ultracode is on, and Off when thinking is off', () => {
    render(<ThinkingSlider chat={chat(options({ thinking: 'high', ultra: true }))} />)
    expect(slider().getAttribute('aria-valuetext')).toBe('Ultra')
    cleanup()
    render(<ThinkingSlider chat={chat(options({ thinking: 'off', ultra: false }))} />)
    expect(slider().getAttribute('aria-valuetext')).toBe('Off')
    expect(screen.getByText('Off')).toBeTruthy()
  })

  it('rests Off short of Low, and the chip names what is off', () => {
    const { container } = render(<ThinkingSlider chat={chat(options({ thinking: 'off', ultra: false }))} />)
    // Not on the Low tick (0%): the label and the thumb agree.
    expect(container.querySelector<HTMLElement>('.thinking-thumb')?.style.left).toBe('-14px')
    expect(container.querySelector('.thinking-label--current')).toBeNull()
    cleanup()
    render(<ThinkingChip chat={chat(options({ thinking: 'off', ultra: false }))} />)
    expect(screen.getByTestId('thinking-chip').textContent).toContain('Thinking off')
    cleanup()
    render(<ThinkingChip chat={chat(options({ thinking: 'high', ultra: false }))} />)
    expect(screen.getByTestId('thinking-chip').textContent).toContain('High')
  })

  it('steps with the arrow keys and jumps with Home', async () => {
    render(<ThinkingSlider chat={chat(options({ thinking: 'medium', ultra: false }))} />)
    press('ArrowRight')
    await settle()
    expect(calls).toEqual([['setSelectOption', ['chat-1', 'thinking', 'high']]])
    calls.length = 0
    press('Home')
    await settle()
    expect(calls).toEqual([['setSelectOption', ['chat-1', 'thinking', 'low']]])
  })

  it('moves the thumb at once, before the CLI answers', () => {
    holding = true
    render(<ThinkingSlider chat={chat(options({ thinking: 'medium', ultra: false }))} />)
    press('ArrowLeft')
    expect(slider().getAttribute('aria-valuetext')).toBe('Low')
  })

  it('goes nowhere further left from Off', async () => {
    render(<ThinkingSlider chat={chat(options({ thinking: 'off', ultra: false }))} />)
    press('ArrowLeft')
    await settle()
    expect(calls).toEqual([])
    press('ArrowRight')
    await settle()
    expect(calls).toEqual([['setSelectOption', ['chat-1', 'thinking', 'low']]])
  })
})

describe('the Ultra stop', () => {
  it('sets thinking high, then — once that is answered — ultracode on', async () => {
    holding = true
    render(<ThinkingSlider chat={chat(options({ thinking: 'max', ultra: false }))} />)
    press('ArrowRight')
    await settle()
    // One call in flight; the second waits for its answer.
    expect(calls).toEqual([['setSelectOption', ['chat-1', 'thinking', 'high']]])
    holding = false
    await act(async () => hold?.release())
    await settle()
    expect(calls).toEqual([
      ['setSelectOption', ['chat-1', 'thinking', 'high']],
      ['setBoolOption', ['chat-1', 'ultra', true]]
    ])
  })

  it('turns ultracode off first when leaving, then sets the level', async () => {
    render(<ThinkingSlider chat={chat(options({ thinking: 'high', ultra: true }))} />)
    press('ArrowLeft')
    await settle()
    expect(calls).toEqual([
      ['setBoolOption', ['chat-1', 'ultra', false]],
      ['setSelectOption', ['chat-1', 'thinking', 'max']]
    ])
  })

  it('collapses moves made while one is in flight into the last', async () => {
    holding = true
    render(<ThinkingSlider chat={chat(options({ thinking: 'low', ultra: false }))} />)
    press('ArrowRight') // medium: sent, held
    press('ArrowRight') // high: queued
    press('ArrowRight') // x-high: replaces it
    holding = false
    await act(async () => hold?.release())
    await settle()
    expect(calls).toEqual([
      ['setSelectOption', ['chat-1', 'thinking', 'medium']],
      ['setSelectOption', ['chat-1', 'thinking', 'x-high']]
    ])
  })

  it('holds a burst that comes back to where it started until its calls are through', async () => {
    holding = true
    const { rerender } = render(<ThinkingSlider chat={chat(options({ thinking: 'high', ultra: true }))} />)
    press('ArrowLeft') // Max: ultracode off is sent, and held
    press('ArrowRight') // back to Ultra, where the options still are
    const flying = document.querySelector('.thinking-meteor')
    // The first call's option lands; the burst's last move is still to go.
    rerender(<ThinkingSlider chat={chat(options({ thinking: 'high', ultra: false }))} />)
    expect(slider().getAttribute('aria-valuetext')).toBe('Ultra')
    expect(document.querySelector('.thinking-meteor')).toBe(flying)
    holding = false
    await act(async () => hold?.release())
    await settle()
    rerender(<ThinkingSlider chat={chat(options({ thinking: 'high', ultra: true }))} />)
    await settle()
    expect(slider().getAttribute('aria-valuetext')).toBe('Ultra')
    expect(document.querySelector('.thinking-meteor')).toBe(flying)
  })

  it('is paused under Ask first, and offers Restricted', async () => {
    render(
      <ThinkingSlider
        chat={chat(options({ thinking: 'high', ultra: true, permission: 'ask-first', suspended: true }))}
      />
    )
    expect(screen.getByText('Ultra · Paused')).toBeTruthy()
    expect(slider().getAttribute('aria-valuetext')).toMatch(/paused/)
    fireEvent.click(screen.getByText('Switch'))
    expect(calls).toEqual([['setSelectOption', ['chat-1', 'permission', 'restricted']]])
  })

  it('lets the user keep Ask first, and stays saved', () => {
    render(
      <ThinkingSlider
        chat={chat(options({ thinking: 'high', ultra: true, permission: 'ask-first', suspended: true }))}
      />
    )
    fireEvent.click(screen.getByText('Keep Ask first'))
    expect(screen.queryByText('Switch')).toBeNull()
    expect(calls).toEqual([])
    expect(slider().getAttribute('aria-valuenow')).toBe('5')
  })
})

describe('the meteor', () => {
  const meteor = (): Element | null => document.querySelector('.thinking-meteor')

  it('plays when Ultra is reached', async () => {
    holding = true
    render(<ThinkingSlider chat={chat(options({ thinking: 'max', ultra: false }))} />)
    expect(meteor()).toBeNull()
    press('End')
    expect(meteor()).not.toBeNull()
  })

  it('plays when Ultra arrives from elsewhere (/ultra, another session)', () => {
    const { rerender } = render(
      <ThinkingSlider chat={chat(options({ thinking: 'high', ultra: false }))} />
    )
    rerender(<ThinkingSlider chat={chat(options({ thinking: 'high', ultra: true }))} />)
    expect(meteor()).not.toBeNull()
  })

  it('flies once, from where it set out, while the CLI catches up one option at a time', async () => {
    const { rerender } = render(<ThinkingSlider chat={chat(options({ thinking: 'low', ultra: false }))} />)
    press('End')
    const first = meteor()
    expect(first).not.toBeNull()
    // Both calls have returned, but only the first option update is in:
    // the CLI's ultra=true arrives a beat after its reply.
    await settle()
    rerender(<ThinkingSlider chat={chat(options({ thinking: 'high', ultra: false }))} />)
    await settle()
    expect(slider().getAttribute('aria-valuetext')).toBe('Ultra')
    expect(meteor()).toBe(first)
    rerender(<ThinkingSlider chat={chat(options({ thinking: 'high', ultra: true }))} />)
    await settle()
    expect(meteor()).toBe(first)
  })

  it('flies inside the bar, whose pill clips it', () => {
    const { rerender } = render(<ThinkingSlider chat={chat(options({ thinking: 'high', ultra: false }))} />)
    rerender(<ThinkingSlider chat={chat(options({ thinking: 'high', ultra: true }))} />)
    expect(meteor()?.parentElement?.classList.contains('thinking-bar')).toBe(true)
  })

  it('draws its first frame before the browser paints, not a frame later', () => {
    // The thumb is hidden the moment the flight starts; a first frame left
    // to the next animation frame is a blink with neither thumb nor head.
    const noop = (): void => {}
    const gradient = { addColorStop: noop }
    let drawn = 0
    const ctx = new Proxy(
      {},
      {
        get: (_, key) =>
          key === 'createLinearGradient' || key === 'createRadialGradient'
            ? () => gradient
            : key === 'fill'
              ? () => void drawn++
              : noop,
        set: () => true
      }
    )
    const getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = (() => ctx) as never
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    try {
      const { rerender } = render(<ThinkingSlider chat={chat(options({ thinking: 'high', ultra: false }))} />)
      rerender(<ThinkingSlider chat={chat(options({ thinking: 'high', ultra: true }))} />)
      expect(meteor()).not.toBeNull()
      expect(drawn).toBeGreaterThan(0)
    } finally {
      raf.mockRestore()
      HTMLCanvasElement.prototype.getContext = getContext
    }
  })

  it('leaves the stops ahead of the head unlit until the streak reaches them', () => {
    holding = true
    render(<ThinkingSlider chat={chat(options({ thinking: 'low', ultra: false }))} />)
    press('End')
    expect(meteor()).not.toBeNull()
    const passed = [...document.querySelectorAll('.thinking-tick')].map((t) =>
      t.classList.contains('thinking-tick--passed')
    )
    expect(passed).toEqual([true, false, false, false, false, false])
  })

  it('does not play for a slider drawn with Ultra already on, or re-drawn there', () => {
    const { rerender } = render(
      <ThinkingSlider chat={chat(options({ thinking: 'high', ultra: true }))} />
    )
    expect(meteor()).toBeNull()
    rerender(<ThinkingSlider chat={chat(options({ thinking: 'high', ultra: true }))} />)
    expect(meteor()).toBeNull()
  })

  it('does not play for a paused Ultra, and plays once the pause lifts', () => {
    const { rerender } = render(
      <ThinkingSlider chat={chat(options({ thinking: 'max', ultra: false, permission: 'ask-first' }))} />
    )
    rerender(
      <ThinkingSlider
        chat={chat(options({ thinking: 'high', ultra: true, permission: 'ask-first', suspended: true }))}
      />
    )
    expect(meteor()).toBeNull()
    rerender(<ThinkingSlider chat={chat(options({ thinking: 'high', ultra: true }))} />)
    expect(meteor()).not.toBeNull()
  })

  it('burns out, leaving the lit thumb', async () => {
    vi.useFakeTimers()
    try {
      const { rerender } = render(
        <ThinkingSlider chat={chat(options({ thinking: 'high', ultra: false }))} />
      )
      rerender(<ThinkingSlider chat={chat(options({ thinking: 'high', ultra: true }))} />)
      expect(meteor()).not.toBeNull()
      await act(async () => {
        vi.advanceTimersByTime(1300)
      })
      expect(meteor()).toBeNull()
      expect(document.querySelector('.thinking-slider--ultra')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('lit Ultra’s smoulder', () => {
  const embers = (): Element | null => document.querySelector('.thinking-embers')
  const lit = (): ChatDetail => chat(options({ thinking: 'high', ultra: true }))
  let reduce = false
  const listeners = new Set<() => void>()

  beforeEach(() => {
    reduce = false
    listeners.clear()
    window.matchMedia = ((query: string) => ({
      get matches() {
        return query.includes('reduced-motion') && reduce
      },
      media: query,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn)
    })) as never
  })
  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })

  it('smoulders inside the bar while Ultra is lit, and not otherwise', () => {
    render(<ThinkingSlider chat={lit()} />)
    expect(embers()?.parentElement?.classList.contains('thinking-bar')).toBe(true)
    cleanup()
    render(<ThinkingSlider chat={chat(options({ thinking: 'high', ultra: false }))} />)
    expect(embers()).toBeNull()
    cleanup()
    render(
      <ThinkingSlider
        chat={chat(options({ thinking: 'high', ultra: true, permission: 'ask-first', suspended: true }))}
      />
    )
    expect(embers()).toBeNull()
  })

  it('waits for the meteor to burn out first', async () => {
    vi.useFakeTimers()
    try {
      const { rerender } = render(<ThinkingSlider chat={chat(options({ thinking: 'high', ultra: false }))} />)
      rerender(<ThinkingSlider chat={lit()} />)
      expect(document.querySelector('.thinking-meteor')).not.toBeNull()
      expect(embers()).toBeNull()
      await act(async () => {
        vi.advanceTimersByTime(1300)
      })
      expect(document.querySelector('.thinking-meteor')).toBeNull()
      expect(embers()).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops when the popover closes', () => {
    render(<ThinkingChip chat={lit()} />)
    expect(embers()).toBeNull()
    fireEvent.click(screen.getByTestId('thinking-chip'))
    expect(embers()).not.toBeNull()
    fireEvent.click(screen.getByTestId('thinking-chip'))
    expect(embers()).toBeNull()
  })

  it('stops while the window is hidden, and comes back with it', () => {
    render(<ThinkingSlider chat={lit()} />)
    expect(embers()).not.toBeNull()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(embers()).toBeNull()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(embers()).not.toBeNull()
  })

  it('stands still under reduced motion, even turned on with the slider open', () => {
    reduce = true
    render(<ThinkingSlider chat={lit()} />)
    expect(embers()).toBeNull()
    expect(document.querySelector('.thinking-slider--ultra')).not.toBeNull()
    cleanup()
    reduce = false
    render(<ThinkingSlider chat={lit()} />)
    expect(embers()).not.toBeNull()
    reduce = true
    act(() => listeners.forEach((fn) => fn()))
    expect(embers()).toBeNull()
  })

  it('stops asking for frames once it is gone', () => {
    // A context that accepts any drawing call, so the loop really runs.
    const noop = (): void => {}
    const gradient = { addColorStop: noop }
    const ctx = new Proxy(
      {},
      {
        get: (_, key) =>
          key === 'createLinearGradient' || key === 'createRadialGradient' ? () => gradient : noop,
        set: () => true
      }
    )
    const getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = (() => ctx) as never
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 42)
    const caf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(noop)
    try {
      const { unmount } = render(<ThinkingSlider chat={lit()} />)
      expect(raf).toHaveBeenCalled()
      unmount()
      expect(caf).toHaveBeenCalledWith(42)
    } finally {
      raf.mockRestore()
      caf.mockRestore()
      HTMLCanvasElement.prototype.getContext = getContext
    }
  })
})

describe('a model that doesn’t reason', () => {
  it('disables the slider and says why', async () => {
    render(
      <ThinkingSlider chat={chat(options({ thinking: 'high', ultra: false }))} reasons={false} />
    )
    expect(slider().getAttribute('aria-disabled')).toBe('true')
    press('ArrowRight')
    await settle()
    expect(calls).toEqual([])
    expect(screen.getByText(/doesn’t think before answering/)).toBeTruthy()
  })
})

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
/** When set, answers every call: the CLI as a test scripts it. */
let answer: ((method: string, args: unknown[]) => Promise<void>) | null = null

vi.mock('@renderer/state/store', () => {
  const mocked = {
    call: (method: string, ...args: unknown[]) => {
      calls.push([method, args])
      if (answer) return answer(method, args)
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
  answer = null
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

describe('the chip, while its slider moves', () => {
  const chipLabel = (): string => screen.getByTestId('thinking-chip').textContent ?? ''

  it('names where the move is going, not the CLI’s halfway values', async () => {
    holding = true
    const { rerender } = render(<ThinkingChip chat={chat(options({ thinking: 'max', ultra: false }))} />)
    fireEvent.click(screen.getByTestId('thinking-chip'))
    press('End')
    // In the same render as the slider: lit, before the CLI has answered.
    expect(chipLabel()).toContain('Ultra')
    expect(screen.getByTestId('thinking-chip').className).toContain('thinking-chip--ultra')
    // Thinking high has landed, ultracode not yet: the chip doesn't say High.
    rerender(<ThinkingChip chat={chat(options({ thinking: 'high', ultra: false }))} />)
    expect(chipLabel()).toContain('Ultra')
    expect(chipLabel()).not.toContain('High')
    holding = false
    await act(async () => hold?.release())
    await settle()
    rerender(<ThinkingChip chat={chat(options({ thinking: 'high', ultra: true }))} />)
    await settle()
    expect(chipLabel()).toContain('Ultra')
  })

  it('says Paused at once under Ask first', () => {
    holding = true
    render(<ThinkingChip chat={chat(options({ thinking: 'max', ultra: false, permission: 'ask-first' }))} />)
    fireEvent.click(screen.getByTestId('thinking-chip'))
    press('End')
    expect(chipLabel()).toContain('Paused')
    expect(screen.getByTestId('thinking-chip').className).toContain('thinking-chip--paused')
  })

  it('goes back to the options when the slider closes mid-move', () => {
    holding = true
    render(<ThinkingChip chat={chat(options({ thinking: 'max', ultra: false }))} />)
    fireEvent.click(screen.getByTestId('thinking-chip'))
    press('End')
    expect(chipLabel()).toContain('Ultra')
    fireEvent.click(screen.getByTestId('thinking-chip'))
    expect(screen.queryByRole('slider')).toBeNull()
    expect(chipLabel()).toContain('Max')
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

describe('arriving at Ultra, frame by frame', () => {
  // What a user saw on clicking Ultra: the thumb sliding there lit, the bar
  // turning to fire, then both snapping back to Max for a short meteor; the
  // smoulder and the slides starting in the frame the meteor appeared. Each
  // of these reads the slider the way a frame would draw it.
  const meteor = (): Element | null => document.querySelector('.thinking-meteor')
  const root = (): Element => document.querySelector('.thinking-slider') as Element
  const thumbLeft = (): string =>
    (document.querySelector('.thinking-thumb') as HTMLElement).style.left
  const fillAt = (): string =>
    (document.querySelector('.thinking-fill') as HTMLElement).style.getPropertyValue('--f')
  const lit = (): boolean => root().classList.contains('thinking-slider--ultra')
  const RAIL = 300

  let rect: { mockRestore: () => void } | null = null
  beforeEach(() => {
    // A rail 300px wide at the window's left edge: Low at 0, Max at 240,
    // Ultra at 300.
    rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      const width = this.classList.contains('thinking-rail') ? RAIL : 0
      return { left: 0, top: 0, right: width, bottom: 0, width, height: 0, x: 0, y: 0, toJSON: () => ({}) }
    })
  })
  afterEach(() => {
    rect?.mockRestore()
    vi.useRealTimers()
  })

  const press = (x: number): void => {
    fireEvent.pointerDown(slider(), { button: 0, clientX: x, pointerId: 1 })
  }
  const move = (x: number): void => {
    fireEvent.pointerMove(slider(), { clientX: x, pointerId: 1 })
  }
  const release = (): void => {
    fireEvent.pointerUp(slider(), { pointerId: 1 })
  }

  it('a press on the bar’s Ultra end lights nothing and moves nothing until it lets go', async () => {
    holding = true
    render(<ThinkingSlider chat={chat(options({ thinking: 'low', ultra: false }))} />)
    press(RAIL)
    // Pressed: the words say where a release goes; the bar stays as it is.
    expect(screen.getByText('Ultra', { selector: '.thinking-value' })).toBeTruthy()
    expect(lit()).toBe(false)
    expect(thumbLeft()).toBe('0%')
    expect(fillAt()).toBe('0')
    expect(meteor()).toBeNull()
    expect(calls).toEqual([])
    release()
    // Released: the meteor sets out from Low, where the thumb stood — not
    // from Max — and the thumb and fill wait there for it.
    expect(meteor()).not.toBeNull()
    expect(lit()).toBe(true)
    expect(fillAt()).toBe('0')
    expect(thumbLeft()).toBe('0%')
    await settle()
    expect(calls).toEqual([['setSelectOption', ['chat-1', 'thinking', 'high']]])
  })

  it('a drag onto Ultra leaves the thumb on the last stop it crossed, and flies from there', () => {
    holding = true
    render(<ThinkingSlider chat={chat(options({ thinking: 'low', ultra: false }))} />)
    press(0)
    move(240) // Max
    expect(thumbLeft()).toBe('80%')
    move(RAIL) // Ultra
    expect(thumbLeft()).toBe('80%')
    expect(lit()).toBe(false)
    expect(document.querySelector('.thinking-label--current')?.textContent).toBe('Ultra')
    release()
    expect(meteor()).not.toBeNull()
    expect(fillAt()).toBe('0.8')
    expect(thumbLeft()).toBe('80%')
  })

  it('a drag off a lit Ultra and back stays on Ultra, with no meteor', () => {
    render(<ThinkingSlider chat={chat(options({ thinking: 'high', ultra: true }))} />)
    press(RAIL)
    move(240)
    expect(thumbLeft()).toBe('80%')
    move(RAIL)
    expect(thumbLeft()).toBe('100%')
    release()
    expect(meteor()).toBeNull()
    expect(calls).toEqual([])
  })

  it('never mounts the smoulder, or sends the thumb ahead, in the frame the meteor sets out', () => {
    // Every canvas that asks for a context: the smoulder asks as it mounts.
    const asked: string[] = []
    const getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
      asked.push(this.className)
      return null
    } as never
    try {
      holding = true
      render(<ThinkingSlider chat={chat(options({ thinking: 'max', ultra: false }))} />)
      press(240) // on Max, where the thumb is
      release()
      press(RAIL)
      release()
      expect(meteor()).not.toBeNull()
      expect(asked).toEqual(['thinking-meteor'])
      // The hidden thumb stays on Max until impact: sent on to Ultra, it
      // would slide there unseen (its transition started by the frame above).
      expect(thumbLeft()).toBe('80%')
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext
    }
  })

  it('lights the fill in the very frame the head lands, not a frame later', () => {
    // From impact the canvas draws its streak fading into the lit fill under
    // it; a fill still where the flight set out leaves the bar empty behind
    // the head for that frame.
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
    const frames: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb)
      return frames.length
    })
    try {
      const { rerender } = render(<ThinkingSlider chat={chat(options({ thinking: 'high', ultra: false }))} />)
      rerender(<ThinkingSlider chat={chat(options({ thinking: 'high', ultra: true }))} />)
      expect(root().classList.contains('thinking-slider--flying')).toBe(true)
      expect(fillAt()).toBe('0.4')
      // A frame just past impact (from High: lands ≈53% of the way through
      // a run of about a second), run as the browser would, outside React.
      frames[frames.length - 1](performance.now() + 700)
      expect(root().classList.contains('thinking-slider--flying')).toBe(false)
      expect(fillAt()).toBe('1')
      expect(thumbLeft()).toBe('100%')
    } finally {
      raf.mockRestore()
      HTMLCanvasElement.prototype.getContext = getContext
    }
  })

  /**
   * Low → Ultra by keyboard, with the CLI answering as `script` says, at
   * fake time. Checks, after every step, that the slider shows Ultra, that
   * the one meteor is still the one that set out (never relaunched), and
   * that nothing jumps: the fill and the hidden thumb wait at Low until
   * impact, then stand on Ultra.
   */
  async function arrive(
    script: (step: (opts: { thinking: string; ultra: boolean }, ms?: number) => Promise<void>) => Promise<void>,
    respond: (method: string, args: unknown[]) => Promise<void>
  ): Promise<{ meteors: Set<Element>; rerender: (o: { thinking: string; ultra: boolean }) => void }> {
    vi.useFakeTimers()
    answer = respond
    const { rerender: raw } = render(<ThinkingSlider chat={chat(options({ thinking: 'low', ultra: false }))} />)
    const rerender = (o: { thinking: string; ultra: boolean }): void =>
      raw(<ThinkingSlider chat={chat(options(o))} />)
    const meteors = new Set<Element>()
    let elapsed = 0
    const check = (): void => {
      const m = meteor()
      if (m) meteors.add(m)
      expect(slider().getAttribute('aria-valuetext')).toBe('Ultra')
      expect(lit()).toBe(true)
      expect(meteors.size).toBe(1)
      // Before impact (≈680ms from Low) fill and thumb wait at Low; after
      // it, they are on Ultra.
      if (elapsed < 600) {
        expect(fillAt()).toBe('0')
        expect(thumbLeft()).toBe('0%')
      } else if (elapsed > 750) {
        expect(fillAt()).toBe('1')
        expect(thumbLeft()).toBe('100%')
      }
    }
    fireEvent.keyDown(slider(), { key: 'End' })
    check()
    await script(async (o, ms = 0) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })
      elapsed += ms
      rerender(o)
      check()
    })
    // Let everything run out: the meteor burns down into the smoulder.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    elapsed += 3000
    check()
    expect(meteor()).toBeNull()
    expect(meteors.size).toBe(1)
    return { meteors, rerender }
  }

  const after = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  it('flies once when the CLI answers promptly, each option landing as its call returns', async () => {
    await arrive(
      async (step) => {
        await step({ thinking: 'high', ultra: false }, 20)
        await step({ thinking: 'high', ultra: true }, 20)
      },
      () => after(20)
    )
  })

  it('flies once when the CLI is slower than the meteor', async () => {
    await arrive(
      async (step) => {
        await step({ thinking: 'high', ultra: false }, 0)
        await step({ thinking: 'high', ultra: false }, 1100)
        await step({ thinking: 'high', ultra: true }, 0)
        await step({ thinking: 'high', ultra: true }, 1100)
      },
      () => after(1100)
    )
  })

  it('flies once when the options trail the replies', async () => {
    await arrive(
      async (step) => {
        // Both calls are answered before either option is in.
        await step({ thinking: 'low', ultra: false }, 50)
        await step({ thinking: 'high', ultra: false }, 100)
        await step({ thinking: 'high', ultra: true }, 300)
      },
      () => after(10)
    )
  })

  it('flies once when a stale option lands between the two', async () => {
    let n = 0
    await arrive(
      async (step) => {
        await step({ thinking: 'high', ultra: false }, 5)
        await step({ thinking: 'high', ultra: true }, 20)
        // Another session's echo of "thinking high", sent before ultra was
        // on, arrives after it; the second call is still out.
        await step({ thinking: 'high', ultra: false }, 80)
        await step({ thinking: 'high', ultra: true }, 200)
      },
      () => after(n++ === 0 ? 10 : 400)
    )
  })

  it('lets go where the CLI is when it refuses, without the thumb sliding back from Ultra', async () => {
    vi.useFakeTimers()
    answer = () => after(10)
    const { rerender } = render(<ThinkingSlider chat={chat(options({ thinking: 'low', ultra: false }))} />)
    fireEvent.keyDown(slider(), { key: 'End' })
    const first = meteor()
    expect(first).not.toBeNull()
    // Ultra on, the calls through — and then the refusal rolls it back, the
    // meteor still in the air.
    rerender(<ThinkingSlider chat={chat(options({ thinking: 'high', ultra: true }))} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30)
    })
    expect(meteor()).toBe(first)
    // The hidden thumb waits at Low, where the eye last saw it: when the
    // refusal brings it back it comes from there, with the fill, rather than
    // sliding back into view from Ultra, where it never was.
    expect(thumbLeft()).toBe('0%')
    rerender(<ThinkingSlider chat={chat(options({ thinking: 'high', ultra: false }))} />)
    // The preview let go with the calls: the refusal shows straight away.
    expect(slider().getAttribute('aria-valuetext')).toBe('High')
    expect(meteor()).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(slider().getAttribute('aria-valuetext')).toBe('High')
    expect(meteor()).toBeNull()
    expect(document.querySelector('.thinking-embers')).toBeNull()
    expect(thumbLeft()).toBe('40%')
    // Nothing relaunched it on the way.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(meteor()).toBeNull()
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

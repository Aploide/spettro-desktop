// @vitest-environment jsdom
//
// What a still screen costs. A lit phrase in the composer kept the renderer
// restyling it on every display frame (a main-thread CSS animation), though
// its band only moved 30 times a second. These guard the properties that
// keep an idle window idle: the band is written only when a step is due,
// stands still out of sight and under reduced motion, and nothing is left
// ticking once the phrase is gone.

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { ActivationText } from '@renderer/views/chat/ActivationGlow'
import { DRIFT_PERIOD_MS, DRIFT_STEPS, driftPosition, driftState } from '@renderer/views/chat/glowDrift'

const css = (file: string): string => readFileSync(resolve(__dirname, '../src/renderer/src', file), 'utf8')

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the lit phrase’s drift', () => {
  it('lands where the old glow-drift 7s steps(210) keyframes did', () => {
    const step = DRIFT_PERIOD_MS / DRIFT_STEPS
    expect(driftPosition(0)).toBe('0% 0')
    expect(driftPosition(step - 2)).toBe('0% 0')
    expect(driftPosition(step)).toBe(`${-200 / DRIFT_STEPS}% 0`)
    expect(driftPosition(step * 105)).toBe('-100% 0')
    // A whole sweep lands on its own start (the ramp is drawn twice).
    expect(driftPosition(DRIFT_PERIOD_MS)).toBe('0% 0')
    expect(driftPosition(DRIFT_PERIOD_MS + step * 3)).toBe(driftPosition(step * 3))
  })

  it('is no animation the main thread must restyle every frame', () => {
    const activation = css('views/chat/activation.css')
    const glow = /\n\.glow \{([^}]*)\}/.exec(activation)?.[1] ?? ''
    expect(glow).toMatch(/background-size: 200% 100%/)
    expect(glow).not.toMatch(/animation\s*:/)
    expect(activation).not.toMatch(/@keyframes glow-drift/)
  })

  it('moves 30 times a second, on time, and stops when the phrase goes', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const { container, unmount } = render(<ActivationText text="ultracode: review it" />)
    const glow = container.querySelector<HTMLElement>('.glow')!
    expect(glow.textContent).toBe('ultracode')
    expect(driftState()).toEqual({ phrases: 1, ticking: true })
    const seen = new Set<string>()
    let writes = 0
    const style = glow.style
    const set = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'backgroundPosition')
    Object.defineProperty(style, 'backgroundPosition', {
      configurable: true,
      get: () => set?.get?.call(style),
      set: (v: string) => {
        writes++
        seen.add(v)
        set?.set?.call(style, v)
      }
    })
    vi.advanceTimersByTime(1000)
    // One write per step: 30 a second, never once per display frame.
    expect(writes).toBeGreaterThanOrEqual(29)
    expect(writes).toBeLessThanOrEqual(31)
    expect(seen.size).toBeGreaterThanOrEqual(29)
    unmount()
    expect(driftState()).toEqual({ phrases: 0, ticking: false })
  })

  it('does not tick out of sight, nor under reduced motion', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    type Report = (entries: { target: Element; isIntersecting: boolean }[]) => void
    const observer: { report: Report } = { report: () => {} }
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: Report) {
          observer.report = cb
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    )
    const { container } = render(<ActivationText text="ultracode: review it" />)
    const glow = container.querySelector<HTMLElement>('.glow')!
    observer.report([{ target: glow, isIntersecting: false }])
    vi.advanceTimersByTime(200)
    expect(driftState().ticking).toBe(false)
    observer.report([{ target: glow, isIntersecting: true }])
    expect(driftState().ticking).toBe(true)
    cleanup()

    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('reduce'),
      addEventListener: () => {},
      removeEventListener: () => {}
    }))
    const still = render(<ActivationText text="ultracode: review it" />)
    vi.advanceTimersByTime(500)
    expect(driftState().ticking).toBe(false)
    expect(still.container.querySelector<HTMLElement>('.glow')!.style.backgroundPosition).toBe('')
  })

  it('leaves a muted (Ask first) phrase alone', () => {
    render(<ActivationText text="ultracode: review it" muted />)
    expect(driftState()).toEqual({ phrases: 0, ticking: false })
  })
})

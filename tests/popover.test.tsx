// @vitest-environment jsdom
//
// Where a popover opens. The composer's menus prefer to open upward, which is
// right at the bottom of a chat; the new-session composer sits mid-window,
// where the settings panel fits on neither side and used to open upward
// clipped, its last section behind a scroll.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { createRef } from 'react'
import Popover from '@renderer/views/common/Popover'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** Opens a popover whose panel is `panelH` tall under an anchor spanning
 *  `top`…`bottom` of an 840px window; returns the panel's placed style. */
function place(top: number, bottom: number, panelH: number): CSSStyleDeclaration {
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(840)
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(panelH)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(360)
  const anchorRef = createRef<HTMLButtonElement>()
  render(<button ref={anchorRef}>chip</button>)
  vi.spyOn(anchorRef.current!, 'getBoundingClientRect').mockReturnValue({
    top,
    bottom,
    left: 600,
    right: 700,
    width: 100,
    height: bottom - top,
    x: 600,
    y: top,
    toJSON: () => ({})
  })
  render(
    <Popover anchorRef={anchorRef} open onClose={() => {}} placement="up" className="probe">
      <div>panel</div>
    </Popover>
  )
  return document.querySelector<HTMLElement>('.probe')!.style
}

describe('Popover placement', () => {
  it('opens upward over a composer at the bottom of the window', () => {
    const style = place(790, 818, 500)
    expect(style.top).toBe(`${790 - 6 - 500}px`)
    expect(style.maxHeight).toBe('500px')
  })

  it('opens downward when it fits there and not above', () => {
    const style = place(200, 228, 500)
    expect(style.top).toBe(`${228 + 6}px`)
    expect(style.maxHeight).toBe('500px')
  })

  it('shows all of a panel too tall for either side, sliding it into the window', () => {
    // The new-session composer: 392px free above the chip, 392px below.
    const style = place(406, 434, 492)
    expect(style.top).toBe('8px')
    expect(style.maxHeight).toBe('492px')
  })
})

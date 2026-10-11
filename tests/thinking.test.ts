// The thinking slider's arithmetic, without a DOM: which stop a set of
// options puts the thumb on, and which calls a move sends. Both draw
// perfectly in a screenshot while being wrong — a thumb on "High" for a CLI
// running Ultra looks exactly as tidy as a correct one.
//
// Options are shaped like internal/acp/config_options.go builds them.

import { describe, expect, it } from 'vitest'
import type { ACPConfigOption } from '@shared/acp'
import {
  OFF_CAPTION,
  ULTRA,
  callsFor,
  isOff,
  modelReasons,
  previewState,
  thinkingState
} from '@renderer/views/chat/thinking'
import { meteorTiming, planMeteor } from '@renderer/views/chat/meteor'
import { planEmbers } from '@renderer/views/chat/embers'

/** thinkingConfigOption: Off, Low, Medium, High, X-High, Max. */
function thinking(value: string, values = ['off', 'low', 'medium', 'high', 'x-high', 'max']): ACPConfigOption {
  return {
    id: 'thinking',
    name: 'Thinking',
    description: 'Extended-thinking effort',
    category: 'thought_level',
    kind: {
      type: 'select',
      currentValue: value,
      groups: [],
      flat: values.map((v) => ({ value: v, name: v === 'x-high' ? 'X-High' : v }))
    }
  }
}

/** ultraConfigOption, with the note it carries when Ask first suspends it. */
function ultra(on: boolean, suspended = false): ACPConfigOption {
  return {
    id: 'ultra',
    name: 'Ultra',
    description: suspended
      ? 'Ultracode: substantive tasks run as dynamic workflows (suspended under Ask first — workflows need Restricted or YOLO)'
      : 'Ultracode: substantive tasks run as dynamic workflows',
    kind: { type: 'boolean', currentValue: on }
  }
}

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

describe('where the thumb sits', () => {
  it('is Off, Low … Max, then Ultra', () => {
    const state = thinkingState([thinking('high'), ultra(false)])
    expect(state?.stops.map((s) => s.label)).toEqual([
      'Off',
      'Low',
      'Medium',
      'High',
      'Extra high',
      'Max',
      'Ultra'
    ])
  })

  it('is Ultra whenever ultracode is on, whatever the level', () => {
    // Ultra is high + ultracode; a level set elsewhere (/thinking max) while
    // ultracode is on still reads as Ultra — that is what will run.
    for (const level of ['high', 'max', 'low', 'off']) {
      const state = thinkingState([thinking(level), ultra(true)])
      expect(state?.label).toBe('Ultra')
      expect(state?.index).toBe(6)
    }
  })

  it('is the matching level otherwise, in plain words', () => {
    const state = thinkingState([thinking('x-high'), ultra(false)])
    expect(state?.label).toBe('Extra high')
    expect(state?.index).toBe(4)
  })

  it('sits on the Off stop when thinking is off', () => {
    // The CLI's default: the slider's most common resting place.
    const state = thinkingState([thinking('off'), ultra(false)])!
    expect(state.index).toBe(0)
    expect(state.label).toBe('Off')
    expect(state.stops[0].caption).toBe(OFF_CAPTION)
    expect(isOff(state)).toBe(true)
  })

  it('keeps Off → Max order whatever order the CLI lists them in', () => {
    const state = thinkingState([thinking('low', ['max', 'off', 'low', 'high'])])
    expect(state?.stops.map((s) => s.id)).toEqual(['off', 'low', 'high', 'max'])
  })

  it('puts Off first and a level it doesn’t know after Max', () => {
    const state = thinkingState([thinking('low', ['turbo', 'off', 'low'])])
    expect(state?.stops.map((s) => s.id)).toEqual(['off', 'low', 'turbo'])
  })

  it('offers no Off stop when the CLI doesn’t list off, and leaves an off it is set to unset', () => {
    const state = thinkingState([thinking('off', ['low', 'medium', 'high', 'x-high', 'max']), ultra(false)])!
    expect(state.stops.map((s) => s.id)).toEqual(['low', 'medium', 'high', 'x-high', 'max', 'ultra'])
    expect(state.index).toBe(-1)
    expect(state.label).toBe('Off')
    expect(isOff(state)).toBe(true)
  })

  it('is a single Off stop when the CLI offers only off and no ultra', () => {
    const state = thinkingState([thinking('off', ['off'])])!
    expect(state.stops.map((s) => s.id)).toEqual(['off'])
    expect(state.index).toBe(0)
    expect(state.label).toBe('Off')
    expect(isOff(state)).toBe(true)
  })

  it('offers every level, Off included, when the CLI lists none', () => {
    // The fallback stands in for the CLI's own list, which always has Off.
    const state = thinkingState([thinking('high', [])])
    expect(state?.stops.map((s) => s.id)).toEqual(['off', 'low', 'medium', 'high', 'x-high', 'max'])
  })

  it('puts a level it doesn’t know after Max, under the CLI’s name', () => {
    const state = thinkingState([thinking('turbo', ['low', 'max', 'turbo']), ultra(false)])
    expect(state?.stops.map((s) => s.label)).toEqual(['Low', 'Max', 'turbo', 'Ultra'])
    expect(state?.label).toBe('turbo')
  })

  it('offers no Ultra stop without an ultra option, and no slider without thinking', () => {
    expect(thinkingState([thinking('high')])?.stops.some((s) => s.ultra)).toBe(false)
    expect(thinkingState([ultra(true)])).toBeNull()
  })

  it('is paused when the CLI says ultracode is suspended, or Ask first is set', () => {
    expect(thinkingState([thinking('high'), ultra(true, true)])?.paused).toBe(true)
    expect(thinkingState([permission('ask-first'), thinking('high'), ultra(true)])?.paused).toBe(true)
    expect(thinkingState([permission('restricted'), thinking('high'), ultra(true)])?.paused).toBe(false)
    // Off is never paused: there is nothing to hold back.
    expect(thinkingState([permission('ask-first'), thinking('high'), ultra(false)])?.paused).toBe(false)
    expect(thinkingState([permission('ask-first'), thinking('off'), ultra(false)])?.paused).toBe(false)
  })
})

describe('what a move sends', () => {
  const stop = (id: string) => thinkingState([thinking('high'), ultra(false)])!.stops.find((s) => s.id === id)!

  it('to Ultra: thinking high, then ultracode on — not max', () => {
    expect(callsFor(false, ULTRA)).toEqual([
      { configId: 'thinking', value: 'high' },
      { configId: 'ultra', value: true }
    ])
  })

  it('from Ultra: ultracode off first, then the level', () => {
    expect(callsFor(true, stop('max'))).toEqual([
      { configId: 'ultra', value: false },
      { configId: 'thinking', value: 'max' }
    ])
  })

  it('between levels: the level alone', () => {
    expect(callsFor(false, stop('low'))).toEqual([{ configId: 'thinking', value: 'low' }])
  })

  it('to Off: thinking off alone', () => {
    expect(callsFor(false, stop('off'))).toEqual([{ configId: 'thinking', value: 'off' }])
  })

  it('from Off to a level: the level alone', () => {
    expect(callsFor(false, stop('low'))).toEqual([{ configId: 'thinking', value: 'low' }])
  })

  it('from Ultra to Off: ultracode off first, then thinking off', () => {
    expect(callsFor(true, stop('off'))).toEqual([
      { configId: 'ultra', value: false },
      { configId: 'thinking', value: 'off' }
    ])
  })

  it('previews the move, paused at once under Ask first', () => {
    const base = thinkingState([permission('ask-first'), thinking('max'), ultra(false)])!
    const preview = previewState(base, ULTRA)
    expect(preview.index).toBe(6)
    expect(preview.ultraOn).toBe(true)
    expect(preview.paused).toBe(true)
  })

  it('previews Off from paused Ultra: index 0, neither lit nor paused', () => {
    const base = thinkingState([permission('ask-first'), thinking('high'), ultra(true, true)])!
    const preview = previewState(base, stop('off'))
    expect(preview).toMatchObject({
      index: 0,
      label: 'Off',
      thinking: 'off',
      ultraOn: false,
      paused: false
    })
  })

  it('previews Ultra from Off under Ask first: paused at once', () => {
    const base = thinkingState([permission('ask-first'), thinking('off'), ultra(false)])!
    const preview = previewState(base, ULTRA)
    expect(preview.index).toBe(6)
    expect(preview.paused).toBe(true)
    expect(preview.thinking).toBe('high')
  })

  it('isOff: the Off stop, an unset off, not Ultra', () => {
    const noOff = ['low', 'medium', 'high', 'x-high', 'max']
    expect(isOff(thinkingState([thinking('off')])!)).toBe(true)
    expect(isOff(thinkingState([thinking('off', noOff)])!)).toBe(true)
    expect(isOff(thinkingState([thinking('off'), ultra(true)])!)).toBe(false)
    expect(isOff(thinkingState([thinking('low')])!)).toBe(false)
  })
})

describe('whether the model reasons', () => {
  const model: ACPConfigOption = {
    id: 'model',
    name: 'Model',
    kind: {
      type: 'select',
      currentValue: 'openai:gpt-mini',
      groups: [],
      flat: [{ value: 'openai:gpt-mini', name: 'GPT mini' }]
    }
  }

  it('is read from the models catalog’s reasoning capability', () => {
    expect(modelReasons([model], [{ provider: 'openai', name: 'gpt-mini', reasoning: false }])).toBe(false)
    expect(modelReasons([model], [{ provider: 'openai', name: 'gpt-mini', reasoning: true }])).toBe(true)
  })

  it('counts local and Subscription models as thinking, as the CLI does', () => {
    // provider/manager.go SupportsReasoning: their entries carry no reasoning
    // flag, but the CLI sends them the level anyway.
    const pick = (value: string): ACPConfigOption => ({
      ...model,
      kind: { type: 'select', currentValue: value, groups: [], flat: [] }
    })
    expect(
      modelReasons(
        [pick('http://localhost:1234:qwen3')],
        [{ provider: 'http://localhost:1234', name: 'qwen3', reasoning: false, local: true }]
      )
    ).toBe(true)
    expect(
      modelReasons([pick('spettro:fast')], [{ provider: 'spettro', name: 'fast', reasoning: false }])
    ).toBe(true)
  })

  it('is unknown (so the slider stays usable) for a model the catalog lacks', () => {
    expect(modelReasons([model], [])).toBeNull()
  })
})

describe('the meteor', () => {
  // The bar the numbers were tuned in: 16px tall, its rail an end cap (8px)
  // in from each end.
  const body = { railLeft: 8, railWidth: 318, y: 8, height: 16, toFrac: 1 }

  it('is the same run for the same seed, so a frozen frame is reproducible', () => {
    const run = (seed: number): unknown => planMeteor({ ...body, fromFrac: 0 }, seed)
    expect(run(7)).toEqual(run(7))
    expect(run(7)).not.toEqual(run(8))
  })

  it('is quick — well under a second from Low, shorter from Max — and lands before it cools', () => {
    const low = meteorTiming(0, 1)
    const max = meteorTiming(0.8, 1)
    expect(low.totalMs).toBeGreaterThanOrEqual(600)
    expect(low.totalMs).toBeLessThanOrEqual(850)
    expect(max.totalMs).toBeLessThanOrEqual(600)
    expect(max.totalMs).toBeLessThan(low.totalMs)
    for (const t of [low, max]) {
      expect(t.lands).toBeGreaterThan(0.3)
      expect(t.lands).toBeLessThan(0.75)
    }
  })

  it('sets out from the stop the thumb was on, even for a one-step run', () => {
    // The thumb is hidden as the head appears: a head set out from anywhere
    // else (from behind Max, once, for a longer streak) is the thumb jumping,
    // with the fill's end showing ahead of the head.
    for (const fromFrac of [0, 0.2, 0.6, 0.8]) {
      expect(meteorTiming(fromFrac, 1).startFrac).toBe(fromFrac)
      const run = planMeteor({ ...body, fromFrac }, 7)
      expect(run.fromX).toBe(run.fillX)
      expect(run.fillX).toBe(8 + fromFrac * 318)
    }
    // A short run comes in streaking: it sets out faster than a long one.
    expect(planMeteor({ ...body, fromFrac: 0.8 }, 7).launch).toBeGreaterThan(
      planMeteor({ ...body, fromFrac: 0 }, 7).launch
    )
  })

  it('throws 40–120 sparks, each out before the run ends', () => {
    for (const fromFrac of [0, 0.8]) {
      const run = planMeteor({ ...body, fromFrac }, 7)
      expect(run.sparks.length).toBeGreaterThanOrEqual(40)
      expect(run.sparks.length).toBeLessThanOrEqual(120)
      for (const s of run.sparks) expect(s.born + s.life).toBeLessThanOrEqual(run.total + 1e-9)
    }
  })

  it('scatters its sparks to fit the bar: born inside it, and pulled no harder than it can hold', () => {
    const run = planMeteor({ ...body, fromFrac: 0 }, 7)
    for (const s of run.sparks) expect(Math.abs(s.y - run.y)).toBeLessThan(body.height / 2)
    // A taller bar gives them more room, in proportion.
    const tall = planMeteor({ ...body, y: 16, height: 32, fromFrac: 0 }, 7)
    expect(tall.gravity).toBeCloseTo(run.gravity * 2)
  })
})

describe('lit Ultra’s smoulder', () => {
  const bar = { fillEnd: 326, height: 16 }

  it('is the same field for the same seed', () => {
    expect(planEmbers(bar, 11)).toEqual(planEmbers(bar, 11))
  })

  it('keeps its embers on the bar: a few of them, bobbing inside its height', () => {
    const field = planEmbers(bar, 11)
    expect(field.motes.length).toBeGreaterThanOrEqual(5)
    expect(field.motes.length).toBeLessThanOrEqual(12)
    for (const m of field.motes) {
      expect(m.amp + m.size).toBeLessThan(bar.height / 2)
      // Slow: the length of the bar in no less than ten seconds.
      expect(m.speed).toBeLessThanOrEqual(bar.fillEnd / 10)
    }
  })
})

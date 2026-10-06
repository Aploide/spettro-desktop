// What the thinking slider shows, and what moving it asks the CLI to do.
//
// The slider is one control over two of the CLI's options
// (internal/acp/config_options.go): the `thinking` select (off … max) and the
// `ultra` boolean (ultracode — substantial tasks run as multi-agent
// workflows). Ultra is the stop past Max, and it means thinking *high* plus
// ultracode, not max: workflows already spend tokens by the agent, and max
// thinking on top of every member of a fan-out would burn them for nothing.
//
// Pure on purpose: the position a set of options produces and the calls a
// move makes are the two things a screenshot draws perfectly while being
// wrong, so they are tested here without a DOM.

import type { ACPConfigChoice, ACPConfigOption } from '@shared/acp'

/** The CLI's option ids. */
export const THINKING_ID = 'thinking'
export const ULTRA_ID = 'ultra'
export const PERMISSION_ID = 'permission'
/** The permission level that suspends ultracode. */
export const ASK_FIRST = 'ask-first'
/** The level the Paused prompt offers instead. */
export const RESTRICTED = 'restricted'
/** The thinking level Ultra runs at. */
export const ULTRA_THINKING = 'high'
/** The id of the Ultra stop. Not a thinking level: no CLI level uses it. */
export const ULTRA_STOP = 'ultra'

export interface ThinkingStop {
  /** The thinking level, or ULTRA_STOP. */
  id: string
  label: string
  /** One line saying what the stop buys you, under the slider. */
  caption: string
  ultra: boolean
}

/** The levels in slider order, named in plain words. "X-High" is the CLI's
 *  menu label; on a slider it reads as a typo. */
const LEVELS: Omit<ThinkingStop, 'ultra'>[] = [
  { id: 'low', label: 'Low', caption: 'Answers quickly with only a brief think' },
  { id: 'medium', label: 'Medium', caption: 'Thinks for a moment before acting' },
  { id: 'high', label: 'High', caption: 'Thinks things through — a good default for real work' },
  { id: 'x-high', label: 'Extra high', caption: 'Thinks longer on hard problems (slower, more tokens)' },
  { id: 'max', label: 'Max', caption: 'As much thinking as the model allows (slowest, most tokens)' }
]

export const ULTRA_CAPTION =
  'High thinking + ultracode — substantial tasks run as multi-agent workflows (uses more tokens)'

export const ULTRA = {
  id: ULTRA_STOP,
  label: 'Ultra',
  caption: ULTRA_CAPTION,
  ultra: true
} as const satisfies ThinkingStop

/** A CLI level that turns thinking off. Not a stop: the user asked for "low
 *  to max", so Off is only ever shown, when something else set it. */
const OFF = 'off'

export interface ThinkingState {
  stops: ThinkingStop[]
  /** The stop the thumb sits on; -1 is Off (the thumb rests at the far left). */
  index: number
  /** The value's name: a stop's label, or "Off". */
  label: string
  thinking: string | null
  ultraOn: boolean
  /** Ultra is saved but the permission level holds every workflow back. */
  paused: boolean
  askFirst: boolean
  /** Whether the permission option offers Restricted, the level that lifts
   *  the pause. */
  canRestrict: boolean
}

function choicesOf(option: ACPConfigOption | undefined): ACPConfigChoice[] {
  const kind = option?.kind
  if (kind?.type !== 'select') return []
  return kind.groups.flatMap((g) => g.options).concat(kind.flat)
}

/**
 * The slider's stops and position, from the session's options. Null when the
 * CLI advertises no thinking option: then there is nothing to slide.
 *
 * The stops follow what the CLI offers — a level it drops disappears, one it
 * adds lands after Max under its own name — but always in Low → Max order,
 * whatever order the menu came in. Ultra is offered only beside an `ultra`
 * boolean.
 */
export function thinkingState(options: ACPConfigOption[]): ThinkingState | null {
  const thinkingOption = options.find((o) => o.id === THINKING_ID)
  if (thinkingOption?.kind.type !== 'select') return null
  const ultraOption = options.find((o) => o.id === ULTRA_ID)
  const permission = options.find((o) => o.id === PERMISSION_ID)

  const offered = choicesOf(thinkingOption).filter((c) => c.value !== OFF)
  const stops: ThinkingStop[] =
    offered.length === 0
      ? LEVELS.map((l) => ({ ...l, ultra: false }))
      : [
          ...LEVELS.filter((l) => offered.some((c) => c.value === l.id)).map((l) => ({
            ...l,
            ultra: false
          })),
          ...offered
            .filter((c) => !LEVELS.some((l) => l.id === c.value))
            .map((c) => ({
              id: c.value,
              label: c.name,
              caption: c.description ?? '',
              ultra: false
            }))
        ]
  const hasUltra = ultraOption?.kind.type === 'boolean'
  if (hasUltra) stops.push({ ...ULTRA })

  const thinking = thinkingOption.kind.currentValue
  const ultraOn = ultraOption?.kind.type === 'boolean' && ultraOption.kind.currentValue
  const askFirst =
    permission?.kind.type === 'select' && permission.kind.currentValue === ASK_FIRST
  // The CLI says so in the description when Ask first suspends a saved Ultra
  // (ultraConfigOption); the permission is read too, for the moment between a
  // local change and the CLI's reply.
  const paused = ultraOn && ((ultraOption?.description ?? '').includes('suspended') || askFirst)

  const index = ultraOn
    ? stops.length - 1
    : stops.findIndex((s) => !s.ultra && s.id === thinking)
  return {
    stops,
    index,
    label: index < 0 ? 'Off' : stops[index].label,
    thinking,
    ultraOn,
    paused,
    askFirst,
    canRestrict: choicesOf(permission).some((c) => c.value === RESTRICTED)
  }
}

/** One session/set_config_option call. */
export interface ConfigCall {
  configId: string
  value: string | boolean
}

/**
 * The calls that move the CLI from `ultraOn` to `target`, in order. Sent one
 * after the other, never together: two replies racing each other would each
 * carry the other's option at its old value and walk the thumb back.
 *
 *  - To Ultra: thinking high, then ultracode on.
 *  - From Ultra: ultracode off first (so nothing runs as a workflow at the
 *    new level even for a moment), then the level.
 *  - Elsewhere: the level alone.
 */
export function callsFor(ultraOn: boolean, target: ThinkingStop): ConfigCall[] {
  if (target.ultra) {
    return [
      { configId: THINKING_ID, value: ULTRA_THINKING },
      { configId: ULTRA_ID, value: true }
    ]
  }
  if (ultraOn) {
    return [
      { configId: ULTRA_ID, value: false },
      { configId: THINKING_ID, value: target.id }
    ]
  }
  return [{ configId: THINKING_ID, value: target.id }]
}

/** The state a pending move will produce, so the thumb goes where it was put
 *  at once instead of waiting a round trip to the CLI (and stepping through
 *  "High" on its way to Ultra). */
export function previewState(state: ThinkingState, target: ThinkingStop): ThinkingState {
  const index = state.stops.findIndex((s) => s.id === target.id)
  return {
    ...state,
    index,
    label: target.label,
    thinking: target.ultra ? ULTRA_THINKING : target.id,
    ultraOn: target.ultra,
    paused: target.ultra && state.askFirst
  }
}

/**
 * Whether the session's model can think at all, from the `_spettro/models/list`
 * catalog (its `reasoning` capability). Null when the catalog doesn't know the
 * model — then the slider stays usable rather than guess.
 */
export function modelReasons(
  options: ACPConfigOption[],
  models: { provider: string; name: string; reasoning: boolean }[]
): boolean | null {
  const model = options.find((o) => o.id === 'model')
  const value = model?.kind.type === 'select' ? model.kind.currentValue : null
  if (!value) return null
  const entry = models.find((m) => `${m.provider}:${m.name}` === value)
  return entry ? entry.reasoning : null
}

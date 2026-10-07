// The composer's settings button, and the popover with everything that isn't
// a chip of its own: permission, thinking, workflow size, and whatever the CLI
// adds next.
//
// The toolbar keeps only what changes from one message to the next (mode,
// thinking, model). The rest are set once and forgotten, and six chips under
// a text field read as a control panel rather than a place to type. They are
// one click away here, in plain words, each with the CLI's own description.
//
// Data-driven like the bar it replaces: an option this file has never heard
// of renders as a generic choice list or switch, so a new CLI setting shows
// up without a desktop release. Ultra has no row: it is the thinking slider's
// last stop (thinking.ts), and a second switch for it is how the two used to
// disagree.
//
// Everything here except the mode is the user's spettro config, shared by
// every session — the CLI pushes a change to the others at once — so the
// popover says so rather than letting it look per-chat.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX, RefObject } from 'react'
import type { ACPConfigChoice, ACPConfigOption } from '@shared/acp'
import type { ChatDetail } from '@shared/model'
import { call } from '@renderer/state/store'
import { Icon } from '@renderer/design/icons'
import Popover from '@renderer/views/common/Popover'
import { MODEL_ID } from './ModelMenu'
import { THINKING_ID, ULTRA_ID } from './thinking'

export const MODE_ID = 'mode'
export const PERMISSION_ID = 'permission'
export const WORKFLOW_SIZE_ID = 'workflow_size'

/** Options with a control elsewhere: the mode chip, the model button, and
 *  the thinking chip, whose slider also holds Ultra (its last stop). */
const ELSEWHERE = new Set([MODE_ID, MODEL_ID, THINKING_ID, ULTRA_ID])
/** Shown first, in this order; anything else follows in the CLI's order. */
const ORDER = [PERMISSION_ID, WORKFLOW_SIZE_ID]

/** The permission levels in words a first-time user can act on. "YOLO" is
 *  the CLI's name and stays in brackets, so the two can be matched up. */
const PERMISSION_NAMES: Record<string, string> = {
  'ask-first': 'Ask first',
  restricted: 'Restricted',
  yolo: 'Don’t ask (YOLO)'
}

/** One line on what each level means in practice, before the CLI's own
 *  description. */
const PERMISSION_GLOSS: Record<string, string> = {
  'ask-first': 'Ask before acting',
  restricted: 'Act within the project',
  yolo: 'Act without asking'
}

/** What each level means for someone who doesn't know what a tool call or a
 *  path request is. The CLI describes them in its own terms ("Automatically
 *  approve all tool, path, and command requests"); a level this app doesn't
 *  know keeps that. */
const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  'ask-first': 'Spettro asks you before it changes a file or runs anything — safest, slowest',
  restricted: 'Spettro works in your project on its own and asks before anything risky',
  yolo: 'Spettro does everything without asking — fastest, least safe'
}

export function permissionDescription(choice: ACPConfigChoice): string | undefined {
  return PERMISSION_DESCRIPTIONS[choice.value] ?? choice.description
}

/** Workflow size, said as what it is to the user: how many helpers Ultra
 *  brings in. The CLI's ("How many agents a workflow run plans around")
 *  needs to know what an agent and a workflow run are. */
export const WORKFLOW_SIZE_DESCRIPTION = 'How big Ultra’s team of helpers can get — a guideline, not a cap'

export function permissionName(choice: ACPConfigChoice): string {
  return PERMISSION_NAMES[choice.value] ?? choice.name
}

/** The level's one-line meaning ("Ask before acting"), when it is one this
 *  app knows. */
export function permissionGloss(choice: ACPConfigChoice): string | null {
  return PERMISSION_GLOSS[choice.value] ?? null
}

/** The agent guideline of each size tier, for a CLI whose descriptions do
 *  not carry it (internal/workflow/size.go SizeTiers). */
const WORKFLOW_SIZE_AGENTS: Record<string, number> = { small: 5, medium: 10, large: 30 }

/**
 * "~10 helpers" / "No limit" for a workflow size tier. Read from the tier's own
 * description ("~10 agents per run · fan-outs up to ~20 wide") so it follows
 * the CLI if a tier is retuned; the table is only the fallback.
 */
export function workflowSizeHint(choice: ACPConfigChoice): string {
  const described = /~(\d+) agents\b/.exec(choice.description ?? '')
  if (described) return `~${described[1]} helpers`
  if (choice.value === 'unbounded' || /no agent guideline/.test(choice.description ?? '')) {
    return 'No limit'
  }
  const known = WORKFLOW_SIZE_AGENTS[choice.value]
  return known !== undefined ? `~${known} helpers` : ''
}

/** The options the popover shows, in the order it shows them. */
export function settingsOptions(options: ACPConfigOption[]): ACPConfigOption[] {
  const shown = options.filter((o) => !ELSEWHERE.has(o.id))
  const rank = (o: ACPConfigOption): number => {
    const i = ORDER.indexOf(o.id)
    return i < 0 ? ORDER.length : i
  }
  // Array.prototype.sort is stable: unknown options keep the CLI's order.
  return [...shown].sort((a, b) => rank(a) - rank(b))
}

/** Every choice once. The parser fills `flat` with the union of the groups
 *  (parse.ts parseConfigOption), so it is the groups or, when a caller built
 *  the option without any, the flat list — never both. */
export function choicesOf(option: ACPConfigOption): ACPConfigChoice[] {
  if (option.kind.type !== 'select') return []
  return option.kind.groups.length > 0
    ? option.kind.groups.flatMap((g) => g.options)
    : option.kind.flat
}

function currentChoice(option: ACPConfigOption | undefined): ACPConfigChoice | undefined {
  if (option?.kind.type !== 'select') return undefined
  const value = option.kind.currentValue
  return choicesOf(option).find((c) => c.value === value)
}

/** The settings button: a sliders glyph and the permission level, since that
 *  is the one setting a user should never have to go looking for. */
export default function SessionSettingsButton({ chat }: { chat: ChatDetail }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => {
    // Hand the focus back to the button, or Escape strands a keyboard user
    // on <body> as the popover unmounts.
    const active = document.activeElement
    if (active && active !== document.body && panelRef.current?.contains(active)) {
      anchorRef.current?.focus()
    }
    setOpen(false)
  }, [])
  // The popover is portalled to the end of <body>, so Tab from the button
  // never reaches it: opening moves the focus in, onto the current
  // permission (or the first control). After the popover's off-screen
  // measuring paint, like the model menu's search field.
  useEffect(() => {
    if (!open) return
    const id = setTimeout(() => {
      const panel = panelRef.current
      const target =
        panel?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ??
        panel?.querySelector<HTMLElement>('button, input, [tabindex="0"]')
      target?.focus()
    }, 0)
    return () => clearTimeout(id)
  }, [open])
  const options = settingsOptions(chat.configOptions)
  if (options.length === 0) return null

  const permission = currentChoice(chat.configOptions.find((o) => o.id === PERMISSION_ID))
  const yolo = permission?.value === 'yolo'
  const label = permission ? (yolo ? 'Don’t ask' : permissionName(permission)) : null

  return (
    <div className="chip-wrap">
      <button
        ref={anchorRef}
        type="button"
        className={'config-chip settings-chip' + (yolo ? ' settings-chip--warn' : '')}
        title="Session settings — permission, thinking and workflow size"
        aria-label={label ? `Session settings (permission: ${label})` : 'Session settings'}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="session-settings"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="slider.horizontal.3" size={14} />
        {label && <span className="config-chip-label">{label}</span>}
      </button>
      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={close}
        placement="up"
        className="session-settings"
      >
        <SessionSettingsPanel chat={chat} panelRef={panelRef} />
      </Popover>
    </div>
  )
}

/** The popover's body; the harness lays it out inline. */
export function SessionSettingsPanel({
  chat,
  panelRef
}: {
  chat: ChatDetail
  panelRef?: RefObject<HTMLDivElement>
}): JSX.Element {
  const options = settingsOptions(chat.configOptions)
  const set = (option: ACPConfigOption, value: string | boolean): void => {
    if (typeof value === 'boolean') void call('setBoolOption', chat.id, option.id, value)
    else void call('setSelectOption', chat.id, option.id, value)
  }

  return (
    <div className="session-settings-panel" role="dialog" aria-label="Session settings" ref={panelRef}>
      <div className="session-settings-head">
        <span className="session-settings-title">Settings</span>
        <span className="session-settings-caption">Applies to all sessions</span>
      </div>
      {options.map((option) => {
        if (option.kind.type === 'boolean') {
          const on = option.kind.currentValue
          return (
            <section className="session-settings-section" key={option.id}>
              <label className="session-switch-row">
                <span className="session-settings-texts">
                  <span className="session-settings-name">{option.name}</span>
                  {option.description && (
                    <span className="session-settings-description">{option.description}</span>
                  )}
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  className="session-switch"
                  checked={on}
                  onChange={() => set(option, !on)}
                />
              </label>
            </section>
          )
        }
        if (option.id === WORKFLOW_SIZE_ID) {
          return <SizeSection key={option.id} option={option} onSet={(v) => set(option, v)} />
        }
        return (
          <ChoiceSection
            key={option.id}
            option={option}
            name={option.id === PERMISSION_ID ? permissionName : (c) => c.name}
            gloss={option.id === PERMISSION_ID ? (c) => PERMISSION_GLOSS[c.value] ?? '' : undefined}
            describe={option.id === PERMISSION_ID ? permissionDescription : undefined}
            onSet={(v) => set(option, v)}
          />
        )
      })}
    </div>
  )
}

/** A select as a list of radio rows: name, a short gloss, the CLI's
 *  description. */
function ChoiceSection({
  option,
  name,
  gloss,
  describe = (choice) => choice.description,
  onSet
}: {
  option: ACPConfigOption
  name: (choice: ACPConfigChoice) => string
  gloss?: (choice: ACPConfigChoice) => string
  describe?: (choice: ACPConfigChoice) => string | undefined
  onSet: (value: string) => void
}): JSX.Element {
  const current = option.kind.type === 'select' ? option.kind.currentValue : null
  return (
    <section className="session-settings-section" aria-label={option.name}>
      <div className="session-settings-label">{option.name}</div>
      <div className="session-choices" role="radiogroup" aria-label={option.name}>
        {choicesOf(option).map((choice) => {
          const selected = choice.value === current
          const short = gloss?.(choice) ?? ''
          return (
            <button
              type="button"
              key={choice.value}
              role="radio"
              aria-checked={selected}
              className={'session-choice' + (selected ? ' session-choice--on' : '')}
              onClick={() => {
                if (!selected) onSet(choice.value)
              }}
            >
              <span className="session-choice-dot" aria-hidden />
              <span className="session-settings-texts">
                <span className="session-settings-name">
                  {name(choice)}
                  {short && <span className="session-settings-gloss"> · {short}</span>}
                </span>
                {describe(choice) && (
                  <span className="session-settings-description">{describe(choice)}</span>
                )}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

/** Workflow size as a segmented control: four short tiers side by side,
 *  each labelled in agents, the chosen one's description under it. */
function SizeSection({
  option,
  onSet
}: {
  option: ACPConfigOption
  onSet: (value: string) => void
}): JSX.Element {
  const current = currentChoice(option)
  return (
    <section className="session-settings-section" aria-label={option.name}>
      <div className="session-settings-label">{option.name}</div>
      <div className="session-segments" role="radiogroup" aria-label={option.name}>
        {choicesOf(option).map((choice) => {
          const selected = choice.value === current?.value
          const hint = workflowSizeHint(choice)
          return (
            <button
              type="button"
              key={choice.value}
              role="radio"
              aria-checked={selected}
              className={'session-segment' + (selected ? ' session-segment--on' : '')}
              title={choice.description}
              onClick={() => {
                if (!selected) onSet(choice.value)
              }}
            >
              <span className="session-segment-name">{choice.name}</span>
              {hint && <span className="session-segment-hint">{hint}</span>}
            </button>
          )
        })}
      </div>
      <div className="session-settings-description">{WORKFLOW_SIZE_DESCRIPTION}</div>
    </section>
  )
}

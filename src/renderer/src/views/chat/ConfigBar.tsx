// The composer toolbar's option cluster: the mode chip, the thinking chip and
// the settings button. Port of Spettro/Views/ConfigBar.swift (doc 26), which
// drew every advertised option as a chip; the CLI now sends six, and six
// chips under a text field read as a control panel. What changes from one
// message to the next stays a chip here — the mode (Plan / Coding / Ask,
// tinted with its colour) and how hard the model thinks — and the rest moves
// behind the settings button (SessionSettingsPopover.tsx), still fully
// data-driven. The model has its own button on the toolbar's right
// (ModelMenu.tsx), the way the Claude app places it.
//
// Thinking and Ultra are one control, not two: the thinking slider
// (ThinkingSlider.tsx), whose stop past Max is Ultra — thinking high plus
// ultracode, where substantial tasks run as multi-agent workflows. There is
// deliberately no Ultra toggle anywhere: a second switch for the same dial is
// how the two used to disagree. The special-casing keys off the advertised
// option ids only — if the CLI stops sending `thinking`, the bar simply stops
// drawing it.

import { useCallback, useRef, useState } from 'react'
import type { CSSProperties, JSX } from 'react'
import type { ACPConfigChoice, ACPConfigGroup, ACPConfigOption } from '@shared/acp'
import type { ChatDetail } from '@shared/model'
import { call } from '@renderer/state/store'
import { modeColor } from '@renderer/design/theme'
import Popover from '@renderer/views/common/Popover'
import { ThinkingChip } from './ThinkingSlider'
import SessionSettingsButton, { MODE_ID, choicesOf } from './SessionSettingsPopover'
import { THINKING_ID } from './thinking'

export default function ConfigBar({ chat }: { chat: ChatDetail }): JSX.Element {
  const mode = chat.configOptions.find((o) => o.id === MODE_ID)
  const hasThinking = chat.configOptions.some((o) => o.id === THINKING_ID)
  return (
    <div className="config-bar">
      {mode?.kind.type === 'select' && (
        <SelectChip
          option={mode}
          kind={mode.kind}
          onSelect={(value) => void call('setSelectOption', chat.id, mode.id, value)}
        />
      )}
      {hasThinking && <ThinkingChip chat={chat} />}
      <SessionSettingsButton chat={chat} />
    </div>
  )
}

/** The mode after the current one, for Shift+Tab in the composer: Plan →
 *  Coding → Ask → Plan, in whatever order the CLI lists them. */
export function nextMode(options: ACPConfigOption[]): string | null {
  const mode = options.find((o) => o.id === MODE_ID)
  if (mode?.kind.type !== 'select') return null
  const values = choicesOf(mode).map((c) => c.value)
  if (values.length < 2) return null
  const at = values.indexOf(mode.kind.currentValue ?? '')
  return values[(at + 1) % values.length]
}

/**
 * What each mode does, in words a non-developer can choose between. The CLI
 * describes its modes by the agent that runs them ("Planning orchestrator
 * (delegates all discovery to explore worker)"), which is accurate and means
 * nothing to the person picking one; a mode this app does not know keeps the
 * CLI's own text.
 */
export const MODE_COPY: Record<string, string> = {
  plan: 'Think it through and propose a plan before changing anything',
  coding: 'Make the changes for you',
  ask: 'Answer questions without changing any files'
}

// ---------------------------------------------------------------------------
// Select chip (SelectMenu port)
// ---------------------------------------------------------------------------

interface SelectKind {
  type: 'select'
  currentValue: string | null
  groups: ACPConfigGroup[]
  flat: ACPConfigChoice[]
}

export function SelectChip({
  option,
  kind,
  hint,
  onSelect
}: {
  option: ACPConfigOption
  kind: SelectKind
  /** A short plain-words gloss for a choice, shown after its name on the
   *  chip and in the menu. */
  hint?: (choice: ACPConfigChoice) => string
  onSelect: (value: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => setOpen(false), [])

  // Grouped options render group headers; a flat list is one unnamed group.
  const groups: ACPConfigGroup[] =
    kind.groups.length > 0 ? kind.groups : [{ name: '', options: kind.flat }]

  // The 'mode' chip is tinted with the active mode's color, so the bar
  // matches the agent that's running.
  const isMode = (option.category ?? option.id) === 'mode'
  const tint = isMode && kind.currentValue ? modeColor(kind.currentValue) : undefined
  const current = currentChoice(kind)
  const currentHint = current && hint ? hint(current) : ''
  const describe = (choice: ACPConfigChoice): string | undefined =>
    (isMode ? MODE_COPY[choice.value] : undefined) ?? choice.description
  const currentText = (current && describe(current)) ?? option.description ?? option.name

  return (
    <div className="chip-wrap">
      <button
        ref={anchorRef}
        type="button"
        className={'config-chip' + (tint ? ' config-chip--tinted' : '')}
        title={isMode ? `${currentText} (Shift+Tab switches)` : option.description ?? option.name}
        style={tint ? ({ '--chip-tint': tint } as CSSProperties) : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={isMode ? 'mode-chip' : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <CategoryIcon category={option.category ?? option.id} />
        <span className="config-chip-label">
          {currentLabel(kind)}
          {currentHint !== '' && <span className="config-chip-hint"> · {currentHint}</span>}
        </span>
        <ChevronDownIcon />
      </button>
      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={close}
        placement="up"
        className="config-menu"
      >
        {groups.map((group, gi) => (
          <div className="config-menu-group" key={gi}>
            {group.name && <div className="config-menu-group-name">{group.name}</div>}
            {group.options.map((choice) => (
              <button
                type="button"
                key={choice.value}
                className="config-menu-row"
                onClick={() => {
                  setOpen(false)
                  onSelect(choice.value)
                }}
              >
                <span className="config-menu-check">
                  {choice.value === kind.currentValue && <CheckIcon />}
                </span>
                <span className="config-menu-texts">
                  <span className="config-menu-name">
                    {choice.name}
                    {hint && hint(choice) !== '' && (
                      <span className="config-menu-hint">{hint(choice)}</span>
                    )}
                  </span>
                  {describe(choice) && (
                    <span className="config-menu-description">{describe(choice)}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        ))}
      </Popover>
    </div>
  )
}

/** ACPConfigOption.currentLabel — the display label for the current value,
 *  matched against the groups/flat choices, falling back to the raw value. */
function currentLabel(kind: SelectKind): string {
  const value = kind.currentValue
  if (value == null) return '—'
  return currentChoice(kind)?.name ?? value
}

function currentChoice(kind: SelectKind): ACPConfigChoice | undefined {
  const value = kind.currentValue
  if (value == null) return undefined
  const all = kind.groups.flatMap((g) => g.options).concat(kind.flat)
  return all.find((c) => c.value === value)
}

// ---------------------------------------------------------------------------
// Icons (symbol(for:) port + chrome)
// ---------------------------------------------------------------------------

function CategoryIcon({ category }: { category: string }): JSX.Element {
  switch (category) {
    case 'mode':
      // A dot in the mode's colour. Not the sliders glyph it used to be:
      // that is the settings button's, right beside this chip.
      return (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
          <circle cx="8" cy="8" r="3.2" fill="currentColor" />
        </svg>
      )
    case 'model':
      // cpu
      return (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
          <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
          <rect x="6.2" y="6.2" width="3.6" height="3.6" rx="0.5" stroke="currentColor" strokeWidth="1.1" />
          <path
            d="M5.5 3.5V1m5 2.5V1M5.5 15v-2.5m5 2.5v-2.5M3.5 5.5H1m2.5 5H1m14-5h-2.5m2.5 5h-2.5"
            stroke="currentColor"
            strokeWidth="1.1"
            strokeLinecap="round"
          />
        </svg>
      )
    case 'permission':
      // lock.shield
      return (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M8 1.5 13.5 3v4.5c0 3.4-2.3 5.9-5.5 7-3.2-1.1-5.5-3.6-5.5-7V3L8 1.5Z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <rect x="6" y="7" width="4" height="3.4" rx="0.8" stroke="currentColor" strokeWidth="1.1" />
          <path d="M6.8 7V5.9a1.2 1.2 0 0 1 2.4 0V7" stroke="currentColor" strokeWidth="1.1" />
        </svg>
      )
    case 'workflow_size':
      // One agent fanning out to three: how wide a workflow plans to go.
      return (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
          <circle cx="8" cy="3.2" r="1.9" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="2.8" cy="12.6" r="1.7" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="8" cy="12.6" r="1.7" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="13.2" cy="12.6" r="1.7" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 5.1v5.8M6.7 4.7 3.6 10.9M9.3 4.7l3.1 6.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
      )
    case 'thought_level':
    case 'thinking':
      // brain
      return (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M8 2.2a2.6 2.6 0 0 0-2.6 2.1 2.7 2.7 0 0 0-1.6 4.6A2.7 2.7 0 0 0 6 13.4c.8 0 1.5-.3 2-.9.5.6 1.2.9 2 .9a2.7 2.7 0 0 0 2.2-4.5 2.7 2.7 0 0 0-1.6-4.6A2.6 2.6 0 0 0 8 2.2Z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <path d="M8 3v10" stroke="currentColor" strokeWidth="1.1" />
        </svg>
      )
    default:
      // circle
      return (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      )
  }
}

function ChevronDownIcon(): JSX.Element {
  return (
    <svg className="config-chip-chevron" width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="m3 6 5 5 5-5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CheckIcon(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="m2.5 8.5 3.7 3.7 7.3-8.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

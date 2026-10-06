// Port of Spettro/Views/ConfigBar.swift (doc 26): the data-driven row of
// glass chips for the agent-advertised session config options. Selects render
// as a chip with a popover menu (grouped options get section headers);
// booleans render as a toggle chip. Fully data-driven — whatever the CLI
// advertises shows up without code changes.
//
// Thinking and Ultra are one control, not two: the thinking slider
// (ThinkingSlider.tsx), whose stop past Max is Ultra — thinking high plus
// ultracode, where substantial tasks run as multi-agent workflows. It sits
// where the thinking option comes in the CLI's order, as a chip that opens the
// slider. There is deliberately no Ultra toggle anywhere: a second switch for
// the same dial is how the two used to disagree. The special-casing keys off
// the advertised option ids only — if the CLI stops sending `thinking`, the
// bar simply stops drawing it.
//
// Workflow size is a plain select, but its tiers are labelled in agents ("~10
// agents") rather than by the tier's bare name, which says nothing on its own.

import { useCallback, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { ACPConfigChoice, ACPConfigGroup, ACPConfigOption } from '@shared/acp'
import type { ChatDetail } from '@shared/model'
import { call } from '@renderer/state/store'
import { modeColor } from '@renderer/design/theme'
import Popover from '@renderer/views/common/Popover'
import { ThinkingChip } from './ThinkingSlider'
import { THINKING_ID, ULTRA_ID } from './thinking'

/** The CLI's option ids (internal/acp/config_options.go). */
const WORKFLOW_SIZE_ID = 'workflow_size'

export default function ConfigBar({ chat }: { chat: ChatDetail }): JSX.Element {
  return (
    <div className="config-bar">
      {chat.configOptions.map((option) =>
        option.id === THINKING_ID ? (
          <ThinkingChip key={option.id} chat={chat} />
        ) : option.id === ULTRA_ID ? null : option.kind.type === 'select' ? (
          <SelectChip
            key={option.id}
            option={option}
            kind={option.kind}
            hint={option.id === WORKFLOW_SIZE_ID ? workflowSizeHint : undefined}
            onSelect={(value) => void call('setSelectOption', chat.id, option.id, value)}
          />
        ) : (
          <BooleanChip
            key={option.id}
            option={option}
            isOn={option.kind.currentValue}
            onToggle={(value) => void call('setBoolOption', chat.id, option.id, value)}
          />
        )
      )}
    </div>
  )
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

function SelectChip({
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

  return (
    <div className="chip-wrap">
      <button
        ref={anchorRef}
        type="button"
        className="config-chip"
        title={option.description ?? option.name}
        style={tint ? { color: tint } : undefined}
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
                  {choice.description && (
                    <span className="config-menu-description">{choice.description}</span>
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

/** The agent guideline of each size tier, for a CLI whose descriptions do
 *  not carry it (internal/workflow/size.go SizeTiers). */
const WORKFLOW_SIZE_AGENTS: Record<string, number> = { small: 5, medium: 10, large: 30 }

/**
 * "~10 agents" / "No limit" for a workflow size tier. Read from the tier's own
 * description ("~10 agents per run · fan-outs up to ~20 wide") so it follows
 * the CLI if a tier is retuned; the table is only the fallback.
 */
export function workflowSizeHint(choice: ACPConfigChoice): string {
  const described = /~(\d+) agents\b/.exec(choice.description ?? '')
  if (described) return `~${described[1]} agents`
  if (choice.value === 'unbounded' || /no agent guideline/.test(choice.description ?? '')) {
    return 'No limit'
  }
  const known = WORKFLOW_SIZE_AGENTS[choice.value]
  return known !== undefined ? `~${known} agents` : ''
}

// ---------------------------------------------------------------------------
// Boolean chip (BooleanChip port)
// ---------------------------------------------------------------------------

function BooleanChip({
  option,
  isOn,
  onToggle
}: {
  option: ACPConfigOption
  isOn: boolean
  onToggle: (value: boolean) => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={'config-chip' + (isOn ? ' config-chip--on' : '')}
      title={option.description ?? option.name}
      onClick={() => onToggle(!isOn)}
    >
      <BoltIcon filled={isOn} />
      <span className="config-chip-label">{option.name}</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Icons (symbol(for:) port + chrome)
// ---------------------------------------------------------------------------

function CategoryIcon({ category }: { category: string }): JSX.Element {
  switch (category) {
    case 'mode':
      // slider.horizontal.3
      return (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M1.5 4h13M1.5 8h13M1.5 12h13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="10.5" cy="4" r="1.8" fill="var(--surface-raised)" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="5" cy="8" r="1.8" fill="var(--surface-raised)" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="11.5" cy="12" r="1.8" fill="var(--surface-raised)" stroke="currentColor" strokeWidth="1.3" />
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

function BoltIcon({ filled }: { filled: boolean }): JSX.Element {
  return (
    <svg className="config-chip-bolt" width="13" height="13" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M9.2 1.5 3.5 9h3.4l-.9 5.5L11.8 7H8.4l.8-5.5Z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

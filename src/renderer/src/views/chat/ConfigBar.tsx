// Port of Spettro/Views/ConfigBar.swift (doc 26): the data-driven row of
// glass chips for the agent-advertised session config options. Selects render
// as a chip with a popover menu (grouped options get section headers);
// booleans render as a toggle chip. Fully data-driven — whatever the CLI
// advertises shows up without code changes.

import { useState } from 'react'
import type { ACPConfigChoice, ACPConfigGroup, ACPConfigOption } from '@shared/acp'
import type { ChatDetail } from '@shared/model'
import { call } from '@renderer/state/store'
import { modeColor } from '@renderer/design/theme'
import { useDismiss } from './ChatHeader'

export default function ConfigBar({ chat }: { chat: ChatDetail }): JSX.Element {
  return (
    <div className="config-bar">
      {chat.configOptions.map((option) =>
        option.kind.type === 'select' ? (
          <SelectChip
            key={option.id}
            option={option}
            kind={option.kind}
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
  onSelect
}: {
  option: ACPConfigOption
  kind: SelectKind
  onSelect: (value: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))

  // Grouped options render group headers; a flat list is one unnamed group.
  const groups: ACPConfigGroup[] =
    kind.groups.length > 0 ? kind.groups : [{ name: '', options: kind.flat }]

  // The 'mode' chip is tinted with the active mode's color, so the bar
  // matches the agent that's running.
  const isMode = (option.category ?? option.id) === 'mode'
  const tint = isMode && kind.currentValue ? modeColor(kind.currentValue) : undefined

  return (
    <div className="chip-wrap" ref={ref}>
      <button
        type="button"
        className="config-chip"
        title={option.description ?? option.name}
        style={tint ? { color: tint } : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <CategoryIcon category={option.category ?? option.id} />
        <span className="config-chip-label">{currentLabel(kind)}</span>
        <ChevronDownIcon />
      </button>
      {open && (
        <div className="popover popover--up config-menu">
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
                    <span className="config-menu-name">{choice.name}</span>
                    {choice.description && (
                      <span className="config-menu-description">{choice.description}</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** ACPConfigOption.currentLabel — the display label for the current value,
 *  matched against the groups/flat choices, falling back to the raw value. */
function currentLabel(kind: SelectKind): string {
  const value = kind.currentValue
  if (value == null) return '—'
  const all = kind.groups.flatMap((g) => g.options).concat(kind.flat)
  return all.find((c) => c.value === value)?.name ?? value
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
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
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

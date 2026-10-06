// The model button on the composer's right, and the menu it opens.
//
// The CLI advertises every model of every connected provider in one select —
// two hundred and more once a few keys are in — so a plain menu is a wall.
// This one is searchable, puts the user's favourites (starred in Manage
// models, or with F2 in the TUI: `_spettro/models/list`) first, then the
// rest under their provider, and says in words what a model can do ("Sees
// images", "Reasons") rather than in catalog flags.
//
// The rows are the model option's own choices, so anything the menu offers
// is something the CLI accepts; the catalog only adds the words. A model the
// catalog doesn't know still shows, just without them.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { JSX, KeyboardEvent, RefObject } from 'react'
import type { ACPConfigChoice, ACPConfigOption } from '@shared/acp'
import type { ModelEntry } from '@shared/extensions'
import type { ChatDetail } from '@shared/model'
import { call, useApp } from '@renderer/state/store'
import { Icon } from '@renderer/design/icons'
import Popover from '@renderer/views/common/Popover'
import ModelPickerView from '@renderer/views/providers/ModelPickerView'

export const MODEL_ID = 'model'

export interface ModelRow {
  value: string
  name: string
  /** Plain-words capabilities, joined ("Sees images · Reasons"). */
  hint: string
}

export interface ModelSection {
  title: string
  rows: ModelRow[]
}

/** What a catalog entry can do, in words: "Sees images", "Reasons", "Runs
 *  locally". Empty when the catalog doesn't say. */
export function capabilityHint(entry: ModelEntry | undefined): string {
  if (!entry) return ''
  const words: string[] = []
  if (entry.local) words.push('Runs locally')
  if (entry.vision) words.push('Sees images')
  if (entry.reasoning) words.push('Reasons')
  return words.join(' · ')
}

/**
 * The menu's sections: Favourites, then one per provider group of the model
 * option, every row filtered by `query` (name, value or provider). A
 * favourite is listed once, in Favourites. Empty sections are dropped.
 */
export function modelSections(
  option: ACPConfigOption | undefined,
  catalog: ModelEntry[],
  query: string
): ModelSection[] {
  if (option?.kind.type !== 'select') return []
  const kind = option.kind
  const groups =
    kind.groups.length > 0
      ? kind.groups
      : [{ name: '', options: kind.flat }]
  const byValue = new Map(catalog.map((m) => [`${m.provider}:${m.name}`, m]))
  const q = query.trim().toLowerCase()
  const matches = (choice: ACPConfigChoice, group: string): boolean =>
    q === '' ||
    choice.name.toLowerCase().includes(q) ||
    choice.value.toLowerCase().includes(q) ||
    group.toLowerCase().includes(q)
  const row = (choice: ACPConfigChoice, withProvider: boolean): ModelRow => {
    const entry = byValue.get(choice.value)
    const hint = capabilityHint(entry)
    const provider = withProvider ? entry?.providerName ?? '' : ''
    return {
      value: choice.value,
      name: choice.name,
      hint: [provider, hint].filter((s) => s !== '').join(' · ')
    }
  }

  const favourites: ModelRow[] = []
  const favoured = new Set<string>()
  for (const group of groups) {
    for (const choice of group.options) {
      if (!byValue.get(choice.value)?.favorite || favoured.has(choice.value)) continue
      favoured.add(choice.value)
      if (matches(choice, group.name)) favourites.push(row(choice, true))
    }
  }
  const sections: ModelSection[] = []
  if (favourites.length > 0) sections.push({ title: 'Favourites', rows: favourites })
  for (const group of groups) {
    const rows = group.options
      .filter((c) => !favoured.has(c.value) && matches(c, group.name))
      .map((c) => row(c, false))
    // The CLI's "Active" group holds a current model no key covers.
    const title = group.name === 'Active' ? 'Current model' : group.name
    if (rows.length > 0) sections.push({ title, rows })
  }
  return sections
}

/** The current model's name, from its choice (falls back to the raw id
 *  without its provider prefix). Null when no model is set — a fresh
 *  config reports ":" (config_options.go joins two empty strings). */
export function currentModelName(option: ACPConfigOption | undefined): string | null {
  if (option?.kind.type !== 'select' || !option.kind.currentValue) return null
  const value = option.kind.currentValue
  const choice = option.kind.groups
    .flatMap((g) => g.options)
    .concat(option.kind.flat)
    .find((c) => c.value === value)
  const name = choice?.name ?? value.slice(value.indexOf(':') + 1)
  return name.trim() === '' ? null : name
}

export default function ModelMenu({ chat }: { chat: ChatDetail }): JSX.Element | null {
  const app = useApp()
  const option = chat.configOptions.find((o) => o.id === MODEL_ID)
  const [open, setOpen] = useState(false)
  const [manage, setManage] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => {
    // The search field had the focus; Escape must hand it back to the
    // button rather than strand it on <body> as the popover unmounts.
    const active = document.activeElement
    if (active && active !== document.body && panelRef.current?.contains(active)) {
      anchorRef.current?.focus()
    }
    setOpen(false)
  }, [])
  const current = currentModelName(option)
  if (!option || option.kind.type !== 'select') return null
  const name = current ?? 'Choose a model'

  return (
    <div className="chip-wrap">
      <button
        ref={anchorRef}
        type="button"
        className={'config-chip model-button' + (current ? '' : ' model-button--unset')}
        title={current ? `Model: ${current}` : 'No model chosen yet'}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="model-button"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="config-chip-label">{name}</span>
        <Icon name="chevron.down" size={10} className="config-chip-chevron" />
      </button>
      <Popover anchorRef={anchorRef} open={open} onClose={close} placement="up" align="end" className="model-menu">
        <ModelMenuPanel
          panelRef={panelRef}
          option={option}
          catalog={app?.extensions?.models.models ?? []}
          onPick={(value) => {
            setOpen(false)
            anchorRef.current?.focus()
            if (value !== option.kind.currentValue) {
              void call('setSelectOption', chat.id, MODEL_ID, value)
            }
          }}
          onManage={() => {
            close()
            setManage(true)
          }}
        />
      </Popover>
      {/* Into <body>, like the popover: a window-wide sheet should not hang
          off the composer's DOM, where any stacking context or containing
          block an ancestor grows would box it in. Closing hands the focus
          back to the button that opened it. */}
      {manage &&
        createPortal(
          <ModelPickerView
            chatId={chat.id}
            onClose={() => {
              setManage(false)
              anchorRef.current?.focus()
            }}
          />,
          document.body
        )}
    </div>
  )
}

/** The menu's body: search, sections, and the way to the full list. */
export function ModelMenuPanel({
  panelRef,
  option,
  catalog,
  onPick,
  onManage
}: {
  panelRef?: RefObject<HTMLDivElement>
  option: ACPConfigOption
  catalog: ModelEntry[]
  onPick: (value: string) => void
  onManage: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const sections = useMemo(() => modelSections(option, catalog, query), [option, catalog, query])
  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections])
  const current = option.kind.type === 'select' ? option.kind.currentValue : null

  useEffect(() => {
    // After the popover's off-screen measuring paint, like the slider.
    const id = setTimeout(() => searchRef.current?.focus(), 0)
    return () => clearTimeout(id)
  }, [])
  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (flat.length === 0) return
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (i + delta + flat.length) % flat.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = flat[active]
      if (row) onPick(row.value)
    }
  }

  let index = -1
  return (
    <div className="model-menu-panel" role="dialog" aria-label="Choose a model" ref={panelRef}>
      <div className="model-menu-search">
        <Icon name="magnifyingglass" size={13} />
        <input
          ref={searchRef}
          type="text"
          placeholder="Search models"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Search models"
          aria-controls="model-menu-list"
        />
      </div>
      <div className="model-menu-list" id="model-menu-list" role="listbox" ref={listRef}>
        {flat.length === 0 && (
          <div className="model-menu-empty">
            {query.trim() === '' ? 'No models yet — connect a provider first.' : `No model matches “${query.trim()}”.`}
          </div>
        )}
        {sections.map((section) => (
          <div className="model-menu-section" key={section.title} role="group" aria-label={section.title}>
            {section.title && <div className="model-menu-heading">{section.title}</div>}
            {section.rows.map((row) => {
              index += 1
              const i = index
              return (
                <button
                  type="button"
                  key={`${section.title}:${row.value}`}
                  role="option"
                  aria-selected={row.value === current}
                  data-index={i}
                  className={'model-menu-row' + (i === active ? ' model-menu-row--active' : '')}
                  onMouseMove={() => setActive(i)}
                  onClick={() => onPick(row.value)}
                >
                  <span className="model-menu-texts">
                    <span className="model-menu-name">{row.name}</span>
                    {row.hint && <span className="model-menu-hint">{row.hint}</span>}
                  </span>
                  {row.value === current && <Icon name="checkmark" size={13} className="model-menu-check" />}
                </button>
              )
            })}
          </div>
        ))}
      </div>
      <button type="button" className="model-menu-manage" onClick={onManage}>
        Manage models…
      </button>
    </div>
  )
}

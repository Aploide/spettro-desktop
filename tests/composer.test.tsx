// @vitest-environment jsdom
//
// The composer as a user drives it: what Send does while the agent works
// (guides it — never blocked, never a second turn), Stop, Shift+Tab through
// the modes, "@" picking a file that then travels as a file, Esc closing a
// menu without interrupting the agent, the model menu's order and search,
// and the todo list above it all. These are the behaviours a screenshot of
// the composer renders perfectly while being wrong.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ACPConfigOption, ACPPlanEntry } from '@shared/acp'
import type { ModelEntry } from '@shared/extensions'
import type { ChatDetail } from '@shared/model'
import Composer from '@renderer/views/chat/Composer'
import { ModelMenuPanel, modelSections } from '@renderer/views/chat/ModelMenu'
import TodoList, { todoEntry, todoSummary } from '@renderer/views/chat/TodoList'
import { planUpdate } from './wire'

const calls: [string, unknown[]][] = []
let ready = true
const FILES = ['README.md', 'src/components/SaveButton.tsx', 'src/views/SettingsForm.tsx']

function model(
  provider: string,
  name: string,
  o: Partial<ModelEntry> = {}
): ModelEntry {
  return {
    provider,
    providerName: provider === 'anthropic' ? 'Anthropic' : provider === 'openai' ? 'OpenAI' : 'Ollama',
    name,
    displayName: name,
    vision: false,
    reasoning: false,
    toolCall: true,
    context: 0,
    local: false,
    favorite: false,
    active: false,
    ...o
  }
}

const CATALOG: ModelEntry[] = [
  model('anthropic', 'sonnet', { vision: true, reasoning: true }),
  model('anthropic', 'haiku', { vision: true }),
  model('openai', 'gpt-5', { reasoning: true, favorite: true }),
  model('ollama', 'qwen', { local: true, favorite: true })
]

vi.mock('@renderer/state/store', () => ({
  call: (method: string, ...args: unknown[]) => {
    calls.push([method, args])
    return Promise.resolve(method === 'listProjectFiles' ? FILES : null)
  },
  getState: () => ({ app: null, chats: {}, permissions: [], questions: [] }),
  useApp: () => ({
    phase: { kind: ready ? 'ready' : 'connecting' },
    extensions: { models: { models: CATALOG, activeProvider: null, activeModel: null } }
  })
}))

beforeEach(() => {
  calls.length = 0
  ready = true
  cleanup()
})

const MODE: ACPConfigOption = {
  id: 'mode',
  name: 'Mode',
  category: 'mode',
  kind: {
    type: 'select',
    currentValue: 'coding',
    groups: [],
    flat: [
      { value: 'plan', name: 'Plan' },
      { value: 'coding', name: 'Coding' },
      { value: 'ask', name: 'Ask' }
    ]
  }
}

// config_options.go modelConfigOption: grouped by provider, "provider:model".
const MODEL: ACPConfigOption = {
  id: 'model',
  name: 'Model',
  category: 'model',
  kind: {
    type: 'select',
    currentValue: 'anthropic:sonnet',
    flat: [],
    groups: [
      {
        name: 'Anthropic',
        options: [
          { value: 'anthropic:haiku', name: 'Claude Haiku' },
          { value: 'anthropic:sonnet', name: 'Claude Sonnet' }
        ]
      },
      { name: 'OpenAI', options: [{ value: 'openai:gpt-5', name: 'GPT-5' }] },
      { name: 'Ollama', options: [{ value: 'ollama:qwen', name: 'Qwen' }] }
    ]
  }
}

function chat(o: Partial<ChatDetail> = {}): ChatDetail {
  return {
    id: 'c1',
    title: 't',
    projectPath: '/proj',
    acpSessionId: 'a1',
    isPinned: false,
    isArchived: false,
    isBusy: false,
    createdAt: 0,
    items: [],
    configOptions: [MODE, MODEL],
    commands: [{ name: 'help', description: 'Show available commands' }],
    plan: [],
    usage: null,
    lastTurn: null,
    sessionTokens: 0,
    ...o
  }
}

function input(): HTMLTextAreaElement {
  return screen.getByTestId('composer-input') as HTMLTextAreaElement
}

/** Types into the field the way the DOM reports it: value, then caret. */
function type(text: string): void {
  const el = input()
  fireEvent.focus(el)
  fireEvent.change(el, { target: { value: text, selectionStart: text.length, selectionEnd: text.length } })
  el.setSelectionRange(text.length, text.length)
  fireEvent.select(el)
}

const sent = (): unknown[][] => calls.filter(([m]) => m === 'send').map(([, args]) => args)

describe('sending', () => {
  it('sends with Enter, and says what to type', () => {
    render(<Composer chat={chat()} />)
    expect(input().placeholder).toBe('Ask Spettro to build, fix, or explain…')
    type('fix the save button')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(sent()).toEqual([['c1', 'fix the save button', [], []]])
    expect(input().value).toBe('')
  })

  it('guides the agent while it works instead of refusing the message', () => {
    render(<Composer chat={chat({ isBusy: true })} />)
    // The field stays usable; with nothing typed there is only Stop.
    expect(input().disabled).toBe(false)
    expect(screen.queryByText('Guide')).toBeNull()
    type('also update ProfileForm')
    const guide = screen.getByText('Guide').closest('button') as HTMLButtonElement
    expect(guide.title).toBe('Send to guide Spettro while it works')
    fireEvent.click(guide)
    expect(sent()).toEqual([['c1', 'also update ProfileForm', [], []]])
  })

  it('stops with the stop button, which names its shortcut', () => {
    render(<Composer chat={chat({ isBusy: true })} />)
    const stop = screen.getByTestId('stop')
    expect(stop.title).toBe('Stop (Esc)')
    fireEvent.click(stop)
    expect(calls).toContainEqual(['cancel', ['c1']])
  })

  it('keeps the draft and says so while reconnecting', () => {
    ready = false
    render(<Composer chat={chat()} />)
    expect(input().placeholder).toBe('Reconnecting…')
    type('hello')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(sent()).toEqual([])
    expect(input().value).toBe('hello')
  })

  it('says only images can be attached when something else is dropped', () => {
    render(<Composer chat={chat()} />)
    const card = document.querySelector('.composer-card') as HTMLElement
    const pdf = new File(['x'], 'spec.pdf', { type: 'application/pdf' })
    fireEvent.drop(card, { dataTransfer: { files: [pdf] } })
    expect(screen.getByRole('status').textContent).toBe('Only images can be attached for now')
  })
})

describe('Shift+Tab', () => {
  it('steps to the next mode and keeps the focus in the field', () => {
    render(<Composer chat={chat()} />)
    const event = fireEvent.keyDown(input(), { key: 'Tab', shiftKey: true })
    expect(event).toBe(false) // default prevented: focus doesn't leave
    expect(calls).toContainEqual(['setSelectOption', ['c1', 'mode', 'ask']])
  })
})

describe('@-mentions', () => {
  async function openMenu(text: string): Promise<void> {
    type(text)
    // The file list arrives from main.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('lists the project’s files for "@", best match first', async () => {
    render(<Composer chat={chat()} />)
    await openMenu('look at @savebut')
    expect(calls).toContainEqual(['listProjectFiles', ['/proj']])
    const rows = screen.getAllByRole('option')
    expect(rows[0].textContent).toContain('SaveButton.tsx')
    expect(rows[0].getAttribute('aria-selected')).toBe('true')
  })

  it('inserts the chosen path and sends it as a file', async () => {
    render(<Composer chat={chat()} />)
    await openMenu('look at @savebut')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(input().value).toBe('look at @src/components/SaveButton.tsx ')
    // Enter picked the file; it did not send the message.
    expect(sent()).toEqual([])
    expect(document.querySelector('.mention-chip')?.textContent).toBe('@src/components/SaveButton.tsx')

    type(input().value + 'please')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(sent()).toEqual([
      ['c1', 'look at @src/components/SaveButton.tsx please', [], ['src/components/SaveButton.tsx']]
    ])
  })

  it('drops a mention the text no longer has', async () => {
    render(<Composer chat={chat()} />)
    await openMenu('@readme')
    fireEvent.keyDown(input(), { key: 'Tab' })
    type('never mind')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(sent()).toEqual([['c1', 'never mind', [], []]])
  })

  it('closes on Esc without the chat reading it as "interrupt"', async () => {
    let interrupted = false
    render(
      <div
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.defaultPrevented) interrupted = true
        }}
      >
        <Composer chat={chat({ isBusy: true })} />
      </div>
    )
    await openMenu('@sav')
    expect(screen.getByTestId('mention-menu')).toBeTruthy()
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(screen.queryByTestId('mention-menu')).toBeNull()
    expect(interrupted).toBe(false)
    // With no menu open, Esc is the chat's to take.
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(interrupted).toBe(true)
  })
  it('sends with Enter when "@" matches no file, rather than swallowing the key', async () => {
    render(<Composer chat={chat()} />)
    await openMenu('ping @team')
    expect(screen.getByTestId('mention-menu').textContent).toContain('No file matches')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(sent()).toEqual([['c1', 'ping @team', [], []]])
  })

  it('opens again for the next "@" after an Esc, even typed at the same spot', async () => {
    render(<Composer chat={chat()} />)
    await openMenu('@sav')
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(screen.queryByTestId('mention-menu')).toBeNull()
    type('hello')
    fireEvent.keyDown(input(), { key: 'Enter' })
    await openMenu('@sav')
    expect(screen.getByTestId('mention-menu')).toBeTruthy()
  })

  it('leaves Enter to an input method composing a word', () => {
    render(<Composer chat={chat()} />)
    type('こんにちは')
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true })
    expect(sent()).toEqual([])
  })
})

describe('the slash commands', () => {
  it('float above the card and complete with Tab', () => {
    render(<Composer chat={chat()} />)
    type('/he')
    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeTruthy()
    fireEvent.keyDown(input(), { key: 'Tab' })
    expect(input().value).toBe('/help ')
  })
})

describe('the model menu', () => {
  it('lists favourites first, then each provider, without repeating a favourite', () => {
    const sections = modelSections(MODEL, CATALOG, '')
    expect(sections.map((s) => s.title)).toEqual(['Favourites', 'Anthropic'])
    expect(sections[0].rows.map((r) => r.value)).toEqual(['openai:gpt-5', 'ollama:qwen'])
    // In words, with the provider beside a favourite (they mix providers).
    expect(sections[0].rows[0].hint).toBe('OpenAI · Reasons')
    expect(sections[0].rows[1].hint).toBe('Ollama · Runs locally')
    expect(sections[1].rows[1].hint).toBe('Sees images · Reasons')
  })

  it('filters by name, id or provider as you type, and Enter picks the first', () => {
    const picked: string[] = []
    render(<ModelMenuPanel option={MODEL} catalog={CATALOG} onPick={(v) => picked.push(v)} onManage={() => undefined} />)
    const search = screen.getByLabelText('Search models')
    fireEvent.change(search, { target: { value: 'anthropic' } })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Claude HaikuSees images',
      'Claude SonnetSees images · Reasons'
    ])
    fireEvent.change(search, { target: { value: 'hai' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(picked).toEqual(['anthropic:haiku'])
  })

  it('opens from the toolbar and switches the chat’s model', () => {
    render(<Composer chat={chat()} />)
    const button = screen.getByTestId('model-button')
    expect(button.textContent).toBe('Claude Sonnet')
    fireEvent.click(button)
    fireEvent.click(screen.getByRole('option', { name: /GPT-5/ }))
    expect(calls).toContainEqual(['setSelectOption', ['c1', 'model', 'openai:gpt-5']])
  })

  it('hands the focus back to the button when Escape closes it', async () => {
    render(<Composer chat={chat()} />)
    const button = screen.getByTestId('model-button')
    fireEvent.click(button)
    const search = screen.getByLabelText('Search models')
    search.focus()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.queryByLabelText('Search models')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('asks for a model when none is set (a fresh config reports ":")', () => {
    const unset = { ...MODEL, kind: { ...MODEL.kind, currentValue: ':' } } as ACPConfigOption
    render(<Composer chat={chat({ configOptions: [MODE, unset] })} />)
    expect(screen.getByTestId('model-button').textContent).toBe('Choose a model')
  })

  it('offers the full list behind "Manage models…"', () => {
    let managed = false
    render(<ModelMenuPanel option={MODEL} catalog={CATALOG} onPick={() => undefined} onManage={() => (managed = true)} />)
    fireEvent.click(screen.getByText('Manage models…'))
    expect(managed).toBe(true)
  })
})

describe('the todo list', () => {
  const plan = (planUpdate([
    { content: 'Find the bug', status: 'completed' },
    { content: 'Fix it', status: 'in_progress' },
    { content: 'Write the changelog', status: 'pending', blocked: true }
  ]) as unknown as { entries: ACPPlanEntry[] }).entries

  it('reads the blocked suffix as a tag, not as words of the task', () => {
    expect(todoEntry(plan[2])).toEqual({ text: 'Write the changelog', status: 'pending', blocked: true })
    expect(todoSummary(plan.map(todoEntry))).toBe('1 of 3 tasks done')
  })

  it('is open while the agent works, a line when it stops, and toggles', () => {
    const { rerender } = render(<TodoList plan={plan} busy />)
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getByText('Blocked')).toBeTruthy()
    rerender(<TodoList plan={plan} busy={false} />)
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.getByText(/Now: Fix it/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('goes away when the plan is emptied', () => {
    const { container } = render(<TodoList plan={[]} busy />)
    expect(container.innerHTML).toBe('')
  })
})

// @vitest-environment jsdom
//
// A first-time user's first minutes, as they click through them: a message
// sent with nothing connected stays in the field and the connect step opens
// (no chat named after it, no Try again that fails the same way); the error
// card offers the fix; connecting is one page whichever way is chosen (sign
// in, a local model with where to get one) instead of sheets stacked on
// sheets; the model menu with nothing in it leads to Connect; the modes and
// slash commands are described in words, with no usage syntax inviting an
// API key into the chat; the home-folder warning is answered once and a
// held-back send says why.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ACPConfigOption } from '@shared/acp'
import type { ChatDetail, ChatMessage, TranscriptItem } from '@shared/model'
import { EMPTY_EXTENSIONS } from '@shared/extensions'

const calls: [string, unknown[]][] = []
let app: Record<string, unknown> = {}

vi.mock('@renderer/state/store', () => {
  const mocked = {
    useStore: <T,>(select: (s: { permissions: never[]; questions: never[]; chats: object }) => T): T =>
      select({ permissions: [], questions: [], chats: {} }),
    call: (method: string, ...args: unknown[]) => {
      calls.push([method, args])
      return Promise.resolve(method === 'listProjectFiles' ? [] : null)
    },
    getState: () => ({ app, chats: {}, permissions: [], questions: [] }),
    useApp: () => app
  }
  return { ...mocked, quietCall: mocked.call }
})

const { default: Composer } = await import('@renderer/views/chat/Composer')
const { ModelMenuPanel } = await import('@renderer/views/chat/ModelMenu')
const { SelectChip } = await import('@renderer/views/chat/ConfigBar')
const { TranscriptItemView } = await import('@renderer/views/chat/transcript/TranscriptItemView')
const { TranscriptActionsProvider } = await import('@renderer/views/chat/transcript/TranscriptActions')
const { ConnectChooser, default: SetupAssistant, INSTALL_SLOW_MS } = await import(
  '@renderer/views/shell/OnboardingView'
)
const { default: NewSessionView } = await import('@renderer/views/shell/NewSessionView')
const { closeSettings, getShell } = await import('@renderer/state/shell')

const READY = { phase: { kind: 'ready' }, connection: 'ok', extensions: EMPTY_EXTENSIONS }

beforeEach(() => {
  calls.length = 0
  app = { ...READY }
  closeSettings()
  cleanup()
})

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
    configOptions: [],
    commands: [],
    plan: [],
    usage: null,
    lastTurn: null,
    sessionTokens: 0,
    ...o
  }
}

const input = (): HTMLTextAreaElement => screen.getByTestId('composer-input') as HTMLTextAreaElement
function typeAndEnter(text: string): void {
  fireEvent.focus(input())
  fireEvent.change(input(), { target: { value: text } })
  fireEvent.keyDown(input(), { key: 'Enter' })
}
const sent = (): string[] => calls.filter(([m]) => m === 'send' || m === 'newChat').map(([m]) => m)

describe('sending with nothing connected', () => {
  it('keeps the message, says why, and opens the connect step — no chat, no failed turn', () => {
    app = { ...READY, noModel: true }
    const onSubmit = vi.fn(() => true)
    render(<Composer chat={chat({ id: '' })} onSubmit={onSubmit} />)
    typeAndEnter('Make a simple website for my bakery')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(sent()).toEqual([])
    expect(input().value).toBe('Make a simple website for my bakery')
    expect(screen.getByTestId('no-model-bar').textContent).toContain('your message will wait here')
    expect(getShell().settingsPane).toBe('models')
  })

  it('still runs slash commands, which Spettro answers itself', () => {
    app = { ...READY, noModel: true }
    render(<Composer chat={chat({ commands: [{ name: 'help', description: 'show available commands' }] })} />)
    typeAndEnter('/help')
    expect(calls.some(([m, a]) => m === 'send' && a[1] === '/help')).toBe(true)
  })
})

describe('the error card', () => {
  const notice = (detail: string): TranscriptItem => {
    const message: ChatMessage = {
      id: 'n1',
      role: 'notice',
      text: 'No model is connected. Connect a model in Settings › Models & Providers, then try again.',
      detail,
      attachments: [],
      isStreaming: false,
      noticeIsError: true,
      timestamp: 0
    }
    return { kind: 'message', message }
  }
  const NO_ENDPOINT = 'coding agent: agent call failed: no API endpoint configured for provider ""'

  it('offers the fix instead of a Try again that fails the same way', () => {
    app = { ...READY, noModel: true }
    const retry = vi.fn()
    render(
      <TranscriptActionsProvider value={{ retry, retryNoticeId: 'n1' }}>
        <TranscriptItemView item={notice(NO_ENDPOINT)} />
      </TranscriptActionsProvider>
    )
    expect(screen.queryByRole('button', { name: /Try again/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Connect a Model…' }))
    expect(getShell().settingsPane).toBe('models')
  })

  it('goes back to Try again once a model is connected', () => {
    app = { ...READY, noModel: false }
    const retry = vi.fn()
    render(
      <TranscriptActionsProvider value={{ retry, retryNoticeId: 'n1' }}>
        <TranscriptItemView item={notice(NO_ENDPOINT)} />
      </TranscriptActionsProvider>
    )
    expect(screen.queryByRole('button', { name: /Connect a Model/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
    expect(retry).toHaveBeenCalledOnce()
  })
})

describe('connecting a model', () => {
  it('signs in on the same page, under the one icon, with what it costs beside the button', () => {
    const { container } = render(<ConnectChooser />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Spettro' }))
    expect(container.querySelector('.modal-backdrop')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Sign in to Spettro' })).toBeTruthy()
    expect(screen.getByText(/create a Spettro account/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'See plans and prices' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('heading', { name: 'Connect a model' })).toBeTruthy()
  })

  it('says where to get a model server when none is running', async () => {
    const { container } = render(<ConnectChooser />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Use a model on this computer/ }))
    })
    expect(container.querySelector('.modal-backdrop')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Get LM Studio/ }))
    expect(calls).toContainEqual(['openExternal', ['https://lmstudio.ai']])
    // The address and key are tucked away.
    expect(screen.queryByLabelText('Server address')).toBeNull()
  })
})

describe('the menus, in words', () => {
  const NO_MODELS: ACPConfigOption = {
    id: 'model',
    name: 'Model',
    kind: { type: 'select', currentValue: '', flat: [], groups: [] }
  }

  it('the model menu with nothing in it is one sentence and Connect', () => {
    const onManage = vi.fn()
    render(<ModelMenuPanel option={NO_MODELS} catalog={[]} onPick={() => undefined} onManage={onManage} />)
    expect(screen.queryByLabelText('Search models')).toBeNull()
    expect(screen.queryByText(/provider/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Connect a model…' }))
    expect(onManage).toHaveBeenCalledOnce()
  })

  it('describes the modes by what they do, not by the agent that runs them', () => {
    const MODE: ACPConfigOption = {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      kind: {
        type: 'select',
        currentValue: 'coding',
        groups: [],
        flat: [
          { value: 'plan', name: 'Plan', description: 'Planning orchestrator (delegates all discovery to explore worker)' },
          { value: 'coding', name: 'Coding', description: 'Coding orchestrator' },
          { value: 'ask', name: 'Ask', description: 'Read-only orchestrator for Q&A' }
        ]
      }
    }
    if (MODE.kind.type !== 'select') throw new Error('select')
    render(<SelectChip option={MODE} kind={MODE.kind} onSelect={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: /Coding/ }))
    expect(document.body.textContent).toContain('Answer questions without changing any files')
    expect(document.body.textContent).not.toContain('orchestrator')
  })

  it('lists slash commands without their syntax, and never the API-key form', () => {
    render(
      <Composer
        chat={chat({
          commands: [
            { name: 'models', description: 'show or set the active model', inputHint: 'provider:model [api_key]' },
            { name: 'hooks', description: 'list effective runtime hooks' },
            { name: 'mode', description: 'switch agent mode', inputHint: 'plan|coding|ask|...' }
          ]
        })}
      />
    )
    fireEvent.focus(input())
    fireEvent.change(input(), { target: { value: '/' } })
    const palette = screen.getByRole('listbox', { name: 'Commands' })
    expect(palette.textContent).not.toContain('api_key')
    expect(palette.textContent).not.toContain('plan|coding')
    expect(palette.textContent).toContain('Switch between Plan, Coding and Ask')
    // Developer commands come after the everyday ones.
    const names = [...palette.querySelectorAll('.command-name')].map((n) => n.textContent)
    expect(names).toEqual(['/models', '/mode', '/hooks'])
    // /models runs as it is, rather than waiting for "provider:model [api_key]".
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(calls.some(([m, a]) => m === 'send' && a[1] === '/models')).toBe(true)
  })
})

describe('starting in the home folder', () => {
  const HOME = { ...READY, homePath: '/home/anna', defaultProjectPath: '/home/anna', recentProjects: [], missingProjects: [] }

  it('says why a send is held back, and puts the focus on the answer', () => {
    app = { ...HOME, approvedBroadFolders: [] }
    render(<NewSessionView />)
    typeAndEnter('Make a simple website for my bakery')
    expect(sent()).toEqual([])
    expect(screen.getByRole('alert').textContent).toContain('Choose where Spettro should work first.')
    expect(document.activeElement?.textContent).toBe('Choose Folder…')
    // Continue is remembered for the folder, not just this screen.
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(calls).toContainEqual(['approveBroadFolder', ['/home/anna']])
  })

  it('doesn’t ask again for a folder already approved, and offers ways to start something new', () => {
    app = { ...HOME, approvedBroadFolders: ['/home/anna'] }
    render(<NewSessionView />)
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Build a simple website' })).toBeTruthy()
  })

  it('makes a new project folder from a name', async () => {
    app = { ...HOME, approvedBroadFolders: [] }
    render(<NewSessionView />)
    fireEvent.click(screen.getByRole('button', { name: 'New Project…' }))
    fireEvent.change(screen.getByLabelText('Name your project'), { target: { value: 'Bakery website' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    expect(calls).toContainEqual(['createProjectFolder', ['Bakery website']])
  })
})

describe('installing', () => {
  it('stops promising "a few seconds" once a phase has stalled', () => {
    vi.useFakeTimers()
    try {
      app = { ...READY, phase: { kind: 'installing' }, install: { stage: 'checking', failure: null }, installLog: [] }
      render(<SetupAssistant step="install" />)
      expect(screen.getByText('This takes a few seconds.')).toBeTruthy()
      act(() => {
        vi.advanceTimersByTime(INSTALL_SLOW_MS)
      })
      expect(screen.getByText(/taking longer than usual/)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})

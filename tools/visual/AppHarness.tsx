// The whole app, offscreen, without a CLI behind it.
//
// The other harness pages mount one view each. This one mounts the real
// <App/> — sidebar, chat, composer, sheets, settings, onboarding — so a
// redesign of any of them can be photographed in both schemes. It stands in
// for the preload bridge: `call` answers from a canned table shaped exactly
// like the main process's DTOs, and the events the main process would push
// (app-state, chat-reset, permissions, questions) are fed through the real
// store reducer. Nothing about the views is faked.
//
//   app.html?mode=welcome | welcome-empty | welcome-folders | chat | chat-one |
//                 busy | sidebar-many | sidebar-menu | collapsed | switcher |
//                 permission-bash | permission-diff | question | settings |
//                 onboarding | installing | install-failed | gate | failure |
//                 reconnecting

import './appPrelude'
import { createRoot } from 'react-dom/client'
import App from '@renderer/App'
import type { ACPConfigOption, ACPPermissionRequest, ACPQuestionRequest } from '@shared/acp'
import type { MainEvent } from '@shared/ipc'
import { EMPTY_EXTENSIONS, type ExtensionsState } from '@shared/extensions'
import type {
  AppStateDTO,
  ChatDetail,
  ChatSummary,
  GitStat,
  Phase,
  ToolCallItem,
  TranscriptItem
} from '@shared/model'
import { EMPTY_UPDATE_STATE } from '@shared/update'

const MODE = new URLSearchParams(location.search).get('mode') ?? 'welcome'

const PROJECT = '/home/carlo/code/acme-web'
const NOW = Date.now()
const MIN = 60_000

// ---------------------------------------------------------------- transcript

let seq = 0

function tool(partial: Partial<ToolCallItem> & { title: string }): TranscriptItem {
  seq += 1
  return {
    kind: 'tool',
    tool: {
      id: `call_${seq}`,
      status: 'completed',
      output: '',
      diffs: [],
      locations: [],
      timestamp: NOW - 20 * MIN + seq * 1000,
      ...partial
    }
  }
}

function say(
  role: 'user' | 'assistant' | 'reasoning' | 'notice',
  text: string,
  o?: { streaming?: boolean; error?: boolean }
): TranscriptItem {
  seq += 1
  return {
    kind: 'message',
    message: {
      id: `msg_${seq}`,
      role,
      text,
      attachments: [],
      isStreaming: o?.streaming ?? false,
      noticeIsError: o?.error,
      timestamp: NOW - 20 * MIN + seq * 1000
    }
  }
}

const OLD_BUTTON = `export function SaveButton({ onSave }: Props) {
  return (
    <button className="btn" onClick={onSave}>
      Save
    </button>
  )
}
`

const NEW_BUTTON = `export function SaveButton({ onSave, saving }: Props) {
  return (
    <button className="btn" onClick={onSave} disabled={saving}>
      {saving ? 'Saving…' : 'Save'}
    </button>
  )
}
`

const ANSWER = `The double submit came from the button staying enabled while the request was in flight. I've made \`SaveButton\` take a \`saving\` flag and disable itself until the save settles:

\`\`\`tsx
<SaveButton onSave={save} saving={status === 'saving'} />
\`\`\`

- **Root cause:** \`onSave\` fired once per click with no guard.
- **Fix:** the button is disabled and relabelled *Saving…* while pending.
- **Tests:** \`npm test\` passes (42 tests).`

function transcript(busy: boolean): TranscriptItem[] {
  seq = 0
  const items: TranscriptItem[] = [
    say('user', 'The settings form saves twice when I click Save quickly. Can you fix it?'),
    say(
      'reasoning',
      'The form likely calls onSave on every click without guarding an in-flight request. Look at SaveButton and where the form wires it.'
    ),
    tool({
      title: 'file-read {"path":"src/components/SaveButton.tsx"}',
      kind: 'read',
      argsJSON: JSON.stringify({ path: `${PROJECT}/src/components/SaveButton.tsx` }),
      output: OLD_BUTTON
    }),
    tool({
      title: 'grep {"pattern":"SaveButton"}',
      kind: 'search',
      argsJSON: JSON.stringify({ pattern: 'SaveButton', path: 'src' }),
      output: 'src/components/SaveButton.tsx:1\nsrc/views/SettingsForm.tsx:3\nsrc/views/SettingsForm.tsx:58'
    }),
    tool({
      title: 'agent explore: find every caller of SaveButton and how it handles errors',
      kind: 'think',
      argsJSON: JSON.stringify({
        agent: 'explore',
        task: 'find every caller of SaveButton and how it handles errors'
      }),
      output: JSON.stringify({
        agent: 'explore',
        status: 'ok',
        summary: 'Two callers: **SettingsForm** (awaits the save) and **ProfileForm** (fire-and-forget).'
      })
    }),
    tool({
      title: 'file-edit {"path":"src/components/SaveButton.tsx"}',
      kind: 'edit',
      argsJSON: JSON.stringify({ path: `${PROJECT}/src/components/SaveButton.tsx` }),
      diffs: [{ path: `${PROJECT}/src/components/SaveButton.tsx`, oldText: OLD_BUTTON, newText: NEW_BUTTON }]
    }),
    tool({
      title: 'bash {"command":"npm test"}',
      kind: 'execute',
      argsJSON: JSON.stringify({ command: 'npm test' }),
      output: ' ✓ src/components/SaveButton.test.tsx (6 tests) 41ms\n ✓ src/views/SettingsForm.test.tsx (36 tests) 212ms\n\n Test Files  2 passed (2)\n      Tests  42 passed (42)'
    })
  ]
  if (busy) {
    items.push(
      tool({
        title: 'bash {"command":"npm run lint"}',
        kind: 'execute',
        status: 'in_progress',
        argsJSON: JSON.stringify({ command: 'npm run lint' })
      })
    )
  } else {
    items.push(say('assistant', ANSWER))
  }
  return items
}

// ------------------------------------------------------------------ options

function select(
  id: string,
  name: string,
  current: string,
  flat: { value: string; name: string; description?: string }[]
): ACPConfigOption {
  return {
    id,
    name,
    category: id,
    kind: { type: 'select', currentValue: current, groups: [], flat }
  }
}

const OPTIONS: ACPConfigOption[] = [
  select('mode', 'Mode', 'coding', [
    { value: 'plan', name: 'Plan' },
    { value: 'coding', name: 'Coding' },
    { value: 'ask', name: 'Ask' }
  ]),
  select('model', 'Model', 'anthropic:sonnet', [{ value: 'anthropic:sonnet', name: 'Claude Sonnet' }]),
  select('permission', 'Permission', 'restricted', [
    { value: 'ask-first', name: 'Ask first' },
    { value: 'restricted', name: 'Restricted' },
    { value: 'yolo', name: 'YOLO' }
  ]),
  select('thinking', 'Thinking', 'high', [
    { value: 'low', name: 'Low' },
    { value: 'high', name: 'High' }
  ]),
  { id: 'ultra', name: 'Ultra', kind: { type: 'boolean', currentValue: false } }
]

const BUSY = MODE === 'busy'

const CHAT: ChatDetail = {
  id: 'c1',
  title: 'Fix double submit on Save',
  projectPath: PROJECT,
  acpSessionId: 'acp-1',
  isPinned: false,
  isArchived: false,
  isBusy: BUSY,
  createdAt: NOW - 25 * MIN,
  items: transcript(BUSY),
  configOptions: OPTIONS,
  commands: [
    { name: 'help', description: 'Show available commands' },
    { name: 'compact', description: 'Summarise the conversation to free up context' }
  ],
  plan: [
    { content: 'Find where the double submit comes from', status: 'completed' },
    { content: 'Disable SaveButton while saving', status: 'completed' },
    { content: 'Run the tests and lint', status: BUSY ? 'in_progress' : 'completed' }
  ],
  usage: { used: 38_400, size: 200_000, tokensUsed: 51_200 }
}

function summary(
  id: string,
  title: string,
  projectPath: string,
  minutesAgo: number,
  extra?: Partial<ChatSummary>
): ChatSummary {
  return {
    id,
    title,
    projectPath,
    createdAt: NOW - (minutesAgo + 5) * MIN,
    updatedAt: NOW - minutesAgo * MIN,
    isPinned: false,
    isArchived: false,
    isBusy: false,
    messageCount: 4,
    preview: '',
    unread: false,
    ...extra
  }
}

const GATEWAY = '/home/carlo/code/api-gateway'
const DOTFILES = '/home/carlo/code/dotfiles'
const HOME = '/home/carlo'

const FEW_SESSIONS: ChatSummary[] = [
  summary('c1', CHAT.title, PROJECT, 2, { isBusy: BUSY }),
  summary('c2', 'Add dark mode to the marketing site', PROJECT, 45, { isPinned: true }),
  summary('c3', 'Why is the checkout test flaky?', PROJECT, 180),
  summary('c4', 'Migrate the API client to fetch', GATEWAY, 60 * 26),
  summary('c5', 'Write release notes for 2.4', GATEWAY, 60 * 50)
]

/** Twenty chats across three projects: pinned, archived, one working, two
 *  finished while the user was elsewhere — every state a row can be in. */
const MANY_SESSIONS: ChatSummary[] = [
  summary('c1', CHAT.title, PROJECT, 1),
  summary('m2', 'Refactor the checkout flow into steps', PROJECT, 3, { isBusy: true }),
  summary('m3', 'Add dark mode to the marketing site', PROJECT, 45, { isPinned: true }),
  summary('m4', 'Why is the checkout test flaky?', PROJECT, 12, { unread: true }),
  summary('m5', 'Upgrade to React 19 and fix the warnings it prints', PROJECT, 60 * 5),
  summary('m6', 'Explain how the cart state is persisted', PROJECT, 60 * 30),
  summary('m7', 'Lighthouse score on the product page', PROJECT, 60 * 24 * 3),
  summary('m8', 'Migrate the API client to fetch', GATEWAY, 25, { unread: true }),
  summary('m9', 'Write release notes for 2.4', GATEWAY, 60 * 50),
  summary('m10', 'Rate limiting for the public endpoints', GATEWAY, 60 * 3, { isPinned: true }),
  summary('m11', 'Why does /health return 503 on cold start?', GATEWAY, 60 * 24 * 2),
  summary('m12', 'Add OpenTelemetry tracing', GATEWAY, 60 * 24 * 9),
  summary('m13', 'Split the auth middleware', GATEWAY, 60 * 24 * 40),
  summary('m14', 'Set up the new laptop', DOTFILES, 60 * 24 * 4),
  summary('m15', 'Make the prompt show the git branch', DOTFILES, 60 * 24 * 6),
  summary('m16', 'Tmux config for split panes', DOTFILES, 60 * 24 * 20),
  summary('m17', 'Clean up old zsh aliases', DOTFILES, 60 * 24 * 60),
  summary('m18', 'Prototype a GraphQL gateway', GATEWAY, 60 * 24 * 90, { isArchived: true }),
  summary('m19', 'Try Bun for the build', PROJECT, 60 * 24 * 120, { isArchived: true }),
  summary('m20', 'Old Vim setup', DOTFILES, 60 * 24 * 400, { isArchived: true })
]

function sessionsFor(mode: string): ChatSummary[] {
  switch (mode) {
    case 'welcome-empty':
      return []
    case 'chat-one':
      return [summary('c1', CHAT.title, PROJECT, 2)]
    case 'sidebar-many':
    case 'sidebar-menu':
    case 'switcher':
      return MANY_SESSIONS
    default:
      return FEW_SESSIONS
  }
}

const SESSIONS = sessionsFor(MODE)
const NO_SELECTION = MODE === 'welcome' || MODE === 'welcome-empty' || MODE === 'welcome-folders'

// --------------------------------------------------------------- extensions

const EXTENSIONS: ExtensionsState = {
  ...EMPTY_EXTENSIONS,
  account: {
    ...EMPTY_EXTENSIONS.account,
    signedIn: true,
    email: 'carlo@example.com',
    plan: 'pro',
    planStatus: 'active',
    creditLimit: 100,
    remainingCredits: 72,
    modelCount: 12
  },
  providers: {
    ...EMPTY_EXTENSIONS.providers,
    providers: [
      { id: 'anthropic', name: 'Anthropic', envKey: 'ANTHROPIC_API_KEY', connected: true, suggested: true, modelCount: 6 },
      { id: 'openai', name: 'OpenAI', envKey: 'OPENAI_API_KEY', connected: false, suggested: true, modelCount: 0 }
    ]
  },
  models: {
    models: [
      {
        provider: 'anthropic',
        providerName: 'Anthropic',
        name: 'sonnet',
        displayName: 'Claude Sonnet',
        vision: true,
        reasoning: true,
        toolCall: true,
        context: 200_000,
        local: false,
        favorite: true,
        active: true
      }
    ],
    activeProvider: 'anthropic',
    activeModel: 'sonnet'
  }
}

/** The provider gate: nothing connected, nothing signed in. */
const GATE_EXTENSIONS: ExtensionsState = {
  ...EMPTY_EXTENSIONS,
  providers: {
    ...EMPTY_EXTENSIONS.providers,
    providers: EXTENSIONS.providers.providers.map((p) => ({ ...p, connected: false, modelCount: 0 }))
  }
}

// -------------------------------------------------------------------- state

function phaseFor(mode: string): Phase {
  switch (mode) {
    case 'onboarding':
    case 'install-failed':
      return { kind: 'needsSetup' }
    case 'installing':
      return { kind: 'installing' }
    case 'gate':
      return { kind: 'needsProvider' }
    case 'failure':
      return {
        kind: 'failed',
        message: 'The Spettro agent exited unexpectedly (exit code 1).'
      }
    case 'reconnecting':
      return { kind: 'connecting' }
    default:
      return { kind: 'ready' }
  }
}

const INSTALL_LOG = [
  'Downloading and running the Spettro installer…',
  'Detecting platform: linux-x64',
  'Downloading spettro 2.9.0…',
  '######################################################### 100.0%',
  'Verifying checksum…'
]

const app: AppStateDTO = {
  phase: phaseFor(MODE),
  cli: { path: '/home/carlo/.local/bin/spettro', version: '2.9.0', isDev: false },
  agentVersion: '2.9.0',
  selectedSessionId: NO_SELECTION ? null : 'c1',
  sessions: SESSIONS,
  banner: null,
  installLog:
    MODE === 'installing'
      ? INSTALL_LOG
      : MODE === 'install-failed'
        ? [...INSTALL_LOG.slice(0, 3), 'curl: (6) Could not resolve host: spettro.app', 'Installation did not complete.']
        : [],
  agentLog:
    MODE === 'failure'
      ? [
          'spettro 2.9.0 starting in ACP mode',
          'loading config from /home/carlo/.spettro/config.toml',
          'error: provider "anthropic": invalid api key (401)',
          'agent exited with status 1'
        ]
      : [],
  subscription: { plan: 'pro', email: 'carlo@example.com' },
  extensions: MODE === 'gate' ? GATE_EXTENSIONS : EXTENSIONS,
  update: EMPTY_UPDATE_STATE,
  remote: null,
  // A first run starts in the home folder, which is exactly the case the
  // new-session view warns about.
  lastProjectPath: MODE === 'welcome-empty' ? null : PROJECT,
  defaultProjectPath: MODE === 'welcome-empty' ? HOME : PROJECT,
  recentProjects:
    MODE === 'welcome-empty'
      ? []
      : [PROJECT, GATEWAY, DOTFILES, '/home/carlo/code/old-prototype'],
  missingProjects: MODE === 'welcome-empty' ? [] : ['/home/carlo/code/old-prototype'],
  homePath: HOME,
  appearance: 'system'
}

// ----------------------------------------------------------- sheets' input

const PERMISSION_BASH: ACPPermissionRequest = {
  id: 'perm-1',
  sessionId: 'acp-1',
  title: 'bash {"command":"npm run lint -- --fix"}',
  toolKind: 'execute',
  rawInput: { command: 'npm run lint -- --fix' },
  options: [
    { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'always', name: 'Always allow `npm` commands', kind: 'allow_always' },
    { optionId: 'reject', name: 'Deny', kind: 'reject_once' }
  ]
}

const PERMISSION_DIFF: ACPPermissionRequest = {
  id: 'perm-2',
  sessionId: 'acp-1',
  title: 'file-edit {"path":"src/components/SaveButton.tsx"}',
  toolKind: 'edit',
  rawInput: { path: `${PROJECT}/src/components/SaveButton.tsx`, old_text: OLD_BUTTON, new_text: NEW_BUTTON },
  options: [
    { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'always', name: 'Always allow edits in this project', kind: 'allow_always' },
    { optionId: 'reject', name: 'Deny', kind: 'reject_once' }
  ]
}

const QUESTION: ACPQuestionRequest = {
  id: 'q-1',
  version: 1,
  sessionId: 'acp-1',
  context: 'Two components call SaveButton and they handle failures differently.',
  questions: [
    {
      id: 'scope',
      header: 'Scope',
      question: 'Should ProfileForm get the same fix?',
      multiSelect: false,
      allowCustomInput: true,
      options: [
        {
          id: 'both',
          label: 'Fix both forms',
          description: 'ProfileForm also awaits the save and shows the disabled state.',
          isRecommended: true
        },
        { id: 'settings', label: 'Only SettingsForm', description: 'Leave ProfileForm as it is.' }
      ]
    }
  ]
}

// ------------------------------------------------------------------- bridge

const GIT: GitStat = {
  branch: 'fix/double-submit',
  files: [{ path: 'src/components/SaveButton.tsx', added: 3, removed: 2 }]
}

const ANSWERS: Record<string, unknown> = {
  getState: app,
  getChat: CHAT,
  gitStat: GIT,
  terminalList: [],
  loadMemory: '- Prefers small, focused commits.\n- Uses pnpm in this repo.\n'
}

// Several views subscribe (the store, the terminal drawer, …), so this keeps
// every listener and broadcasts, the way ipcRenderer does.
const listeners = new Set<(event: MainEvent) => void>()
function push(event: MainEvent): void {
  listeners.forEach((l) => l(event))
}
;(window as unknown as { spettro: unknown }).spettro = {
  platform: 'linux',
  onEvent: (handler: (event: MainEvent) => void) => {
    listeners.add(handler)
    return () => listeners.delete(handler)
  },
  call: (method: string) => Promise.resolve(ANSWERS[method] ?? null)
}

/** Feeds the events the main process would push once the app has mounted
 *  (the store subscribes in App's first effect). */
function pushEvents(): void {
  if (listeners.size === 0) {
    setTimeout(pushEvents, 20)
    return
  }
  push({ type: 'app-state', state: app })
  if (app.selectedSessionId) push({ type: 'chat-reset', chat: CHAT })
  if (MODE === 'permission-bash') push({ type: 'permissions', requests: [PERMISSION_BASH] })
  if (MODE === 'permission-diff') push({ type: 'permissions', requests: [PERMISSION_DIFF] })
  if (MODE === 'question') push({ type: 'questions', requests: [QUESTION] })
  // Settings, the switcher and the menus are renderer-local state behind a
  // shortcut or a click; press it the way a user would rather than adding a
  // prop the app would never use.
  const press = (key: string): void => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true }))
  }
  const click = (selector: string): void => {
    document.querySelector<HTMLElement>(selector)?.click()
  }
  if (MODE === 'settings') setTimeout(() => press(','), 60)
  if (MODE === 'switcher') setTimeout(() => press('k'), 60)
  if (MODE === 'welcome-folders') setTimeout(() => click('[data-testid="project-chip"]'), 60)
  if (MODE === 'sidebar-menu') {
    // A right-click near the row's end: the "…" button only exists on hover,
    // which an offscreen page never has, and both open the same menu.
    setTimeout(() => {
      const row = document.querySelector('[data-testid="sidebar-row-m4"]')
      const r = row?.getBoundingClientRect()
      if (!row || !r) return
      row.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: r.right - 24, clientY: r.bottom - 4 })
      )
    }, 60)
  }
}

// No harness stylesheet: App brings theme.css and its own chrome, and the
// page is the window — nothing around it to style.
createRoot(document.getElementById('root') as HTMLElement).render(<App />)
pushEvents()

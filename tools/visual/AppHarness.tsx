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
//                 chat-tools | chat-error | chat-steering |
//                 busy | guide | ultra | model-menu | session-settings | slash |
//                 mention | sidebar-many | sidebar-menu | collapsed | switcher |
//                 permission-bash | permission-diff | permission-compact |
//                 permission-orphan | permission-denied | question |
//                 question-multi | settings |
//                 settings-<general|account|models|permissions|memory|remote|
//                   updates|advanced|shortcuts|about> |
//                 onboarding | installing | install-failed | gate | gate-keys |
//                 failure | reconnecting | confirm-delete | deleted-undo |
//                 no-model | error-toast

import './appPrelude'
import { createRoot } from 'react-dom/client'
import App from '@renderer/App'
import type { ACPConfigOption, ACPPermissionRequest, ACPQuestionRequest } from '@shared/acp'
import type { MainEvent } from '@shared/ipc'
import { EMPTY_EXTENSIONS, type ExtensionsState, type ModelEntry } from '@shared/extensions'
import type {
  AppStateDTO,
  ChatDetail,
  InstallState,
  RemoteHostState,
  ChatMessage,
  SteeringState,
  ChatSummary,
  GitStat,
  Phase,
  ToolCallItem,
  TranscriptItem
} from '@shared/model'
import { EMPTY_COMPONENT_UPDATE, EMPTY_UPDATE_STATE, type UpdateState } from '@shared/update'
import { showToast } from '@renderer/views/common/Toast'

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
  o?: { streaming?: boolean; error?: boolean; detail?: string; thoughtFor?: number; steering?: SteeringState }
): TranscriptItem {
  seq += 1
  const timestamp = NOW - 20 * MIN + seq * 1000
  const message: ChatMessage = {
    id: `msg_${seq}`,
    role,
    text,
    attachments: [],
    isStreaming: o?.streaming ?? false,
    noticeIsError: o?.error,
    timestamp
  }
  if (o?.thoughtFor !== undefined) {
    message.startedAt = timestamp
    message.endedAt = timestamp + o.thoughtFor * 1000
  }
  if (o?.steering) message.steering = o.steering
  if (o?.detail) message.detail = o.detail
  // The harness's errors are all a turn failing, the kind Try again answers.
  if (o?.error) message.endsTurn = true
  return { kind: 'message', message }
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

const SETTINGS_FORM = `import { SaveButton } from '../components/SaveButton'

export function SettingsForm({ settings, onSave }: Props) {
  const [status, setStatus] = useState<'idle' | 'saving'>('idle')
  const save = async () => {
    setStatus('saving')
    await onSave(settings)
    setStatus('idle')
  }
  return <SaveButton onSave={save} />
}
`

/** The start of the turn every chat scene shares: the ask, the thinking,
 *  the look-around (two reads and a search, which fold into one line), a
 *  delegation and the edit it led to. */
function opening(): TranscriptItem[] {
  return [
    say('user', 'The settings form saves twice when I click Save quickly. Can you fix it?'),
    say(
      'reasoning',
      'The form likely calls onSave on every click without guarding an in-flight request. Look at SaveButton and where the form wires it.',
      { thoughtFor: 8 }
    ),
    tool({
      title: 'file-read {"path":"src/components/SaveButton.tsx"}',
      kind: 'read',
      argsJSON: JSON.stringify({ path: `${PROJECT}/src/components/SaveButton.tsx` }),
      output: OLD_BUTTON
    }),
    tool({
      title: 'file-read {"path":"src/views/SettingsForm.tsx"}',
      kind: 'read',
      argsJSON: JSON.stringify({ path: `${PROJECT}/src/views/SettingsForm.tsx` }),
      output: SETTINGS_FORM
    }),
    tool({
      title: 'grep {"pattern":"SaveButton"}',
      kind: 'search',
      argsJSON: JSON.stringify({ pattern: 'SaveButton', path: `${PROJECT}/src` }),
      output: 'src/components/SaveButton.tsx:1\nsrc/views/SettingsForm.tsx:1\nsrc/views/SettingsForm.tsx:11'
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
      diffs: [{ path: `${PROJECT}/src/components/SaveButton.tsx`, oldText: OLD_BUTTON, newText: NEW_BUTTON }],
      locations: [{ path: `${PROJECT}/src/components/SaveButton.tsx`, line: 1 }]
    })
  ]
}

const TEST_OUTPUT = ' ✓ src/components/SaveButton.test.tsx (6 tests) 41ms\n ✓ src/views/SettingsForm.test.tsx (36 tests) 212ms\n\n Test Files  2 passed (2)\n      Tests  42 passed (42)'

function transcript(mode: string): TranscriptItem[] {
  seq = 0
  const items = opening()
  switch (mode) {
    case 'busy':
      items.push(
        tool({
          title: 'bash {"command":"npm test"}',
          kind: 'execute',
          argsJSON: JSON.stringify({ command: 'npm test' }),
          output: TEST_OUTPUT
        }),
        tool({
          title: 'bash {"command":"npm run lint"}',
          kind: 'execute',
          status: 'in_progress',
          argsJSON: JSON.stringify({ command: 'npm run lint' })
        })
      )
      return items
    case 'permission-bash':
    case 'permission-denied':
      // The command the approval is about, its card waiting on the answer.
      items.push(
        tool({
          id: 'call_lint',
          title: 'Run npm run lint -- --fix',
          kind: 'execute',
          status: 'pending',
          argsJSON: JSON.stringify({ command: 'npm run lint -- --fix' })
        })
      )
      return items
    case 'permission-diff':
      items.splice(items.length - 1, 1)
      items.push(
        tool({
          id: 'call_edit',
          title: 'Edit SaveButton.tsx',
          kind: 'edit',
          status: 'pending',
          argsJSON: JSON.stringify({ path: `${PROJECT}/src/components/SaveButton.tsx` }),
          locations: [{ path: `${PROJECT}/src/components/SaveButton.tsx` }]
        })
      )
      return items
    case 'chat-steering':
      // A message sent while the agent works: queued for its next step.
      items.push(
        tool({
          title: 'bash {"command":"npm test"}',
          kind: 'execute',
          status: 'in_progress',
          argsJSON: JSON.stringify({ command: 'npm test' })
        }),
        say('user', 'Also make ProfileForm await the save the same way.', { steering: 'queued' })
      )
      return items
    case 'chat-error':
      // A command that failed, then a turn the provider ended.
      items.push(
        tool({
          title: 'bash {"command":"npm test"}',
          kind: 'execute',
          status: 'failed',
          argsJSON: JSON.stringify({ command: 'npm test' }),
          output:
            ' ✓ src/components/SaveButton.test.tsx (6 tests) 41ms\n ✗ src/views/SettingsForm.test.tsx > saves once\n   Expected onSave to be called 1 time, but it was called 2 times\n\n Test Files  1 failed | 1 passed (2)\n[exit status 1]'
        }),
        say('notice', 'Interrupted'),
        say('user', 'Keep going — fix the failing test too.'),
        // As main files it: the sentence (shared/humanize.ts), with the
        // provider's own words behind "Show details".
        say(
          'notice',
          'The model provider is overloaded. It’s turning requests away right now. Nothing was lost — try again in a moment.',
          { error: true, detail: 'anthropic: POST /v1/messages: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }
        )
      )
      return items
    default:
      items.push(
        tool({
          title: 'bash {"command":"npm test"}',
          kind: 'execute',
          argsJSON: JSON.stringify({ command: 'npm test' }),
          output: TEST_OUTPUT
        }),
        say('assistant', ANSWER)
      )
      return items
  }
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

/** The thinking slider, opened over the composer: at High, or with Ultra
 *  saved under Ask first (paused, offering Restricted). */
const THINKING_PAUSED = MODE === 'thinking-paused'
/** Ultra lit: the toolbar's thinking chip wears it. */
const ULTRA_LIT = MODE === 'ultra'

/** The model option as the CLI groups it (config_options.go
 *  modelConfigOption): one group per connected provider, `provider:model`
 *  values. */
const MODEL_OPTION: ACPConfigOption = {
  id: 'model',
  name: 'Model',
  description: 'Active model for this session',
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
          { value: 'anthropic:opus', name: 'Claude Opus' },
          { value: 'anthropic:sonnet', name: 'Claude Sonnet' }
        ]
      },
      {
        name: 'OpenAI',
        options: [
          { value: 'openai:gpt-5', name: 'GPT-5' },
          { value: 'openai:gpt-5-mini', name: 'GPT-5 mini' },
          { value: 'openai:gpt-4.1', name: 'GPT-4.1' }
        ]
      },
      {
        name: 'Ollama',
        options: [
          { value: 'ollama:qwen3-coder', name: 'qwen3-coder:30b' },
          { value: 'ollama:llama3.2', name: 'llama3.2:3b' }
        ]
      }
    ]
  }
}

const OPTIONS: ACPConfigOption[] = [
  select('mode', 'Mode', 'coding', [
    { value: 'plan', name: 'Plan' },
    { value: 'coding', name: 'Coding' },
    { value: 'ask', name: 'Ask' }
  ]),
  MODEL_OPTION,
  {
    ...select('permission', 'Permission', THINKING_PAUSED ? 'ask-first' : 'restricted', [
      { value: 'ask-first', name: 'Ask first', description: 'Prompt before running tools, edits, or commands' },
      { value: 'restricted', name: 'Restricted', description: 'Allow safe actions; prompt for sensitive ones' },
      { value: 'yolo', name: 'YOLO', description: 'Automatically approve all tool, path, and command requests' }
    ]),
    category: undefined,
    description: 'How Spettro requests approval for actions'
  },
  // config_options.go thinkingConfigOption / ultraConfigOption.
  select('thinking', 'Thinking', 'high', [
    { value: 'off', name: 'Off' },
    { value: 'low', name: 'Low' },
    { value: 'medium', name: 'Medium' },
    { value: 'high', name: 'High' },
    { value: 'x-high', name: 'X-High' },
    { value: 'max', name: 'Max' }
  ]),
  {
    id: 'ultra',
    name: 'Ultra',
    description: THINKING_PAUSED
      ? 'Ultracode: substantive tasks run as dynamic workflows (suspended under Ask first — workflows need Restricted or YOLO)'
      : 'Ultracode: substantive tasks run as dynamic workflows',
    kind: { type: 'boolean', currentValue: THINKING_PAUSED || ULTRA_LIT }
  },
  {
    id: 'workflow_size',
    name: 'Workflow size',
    description: 'How many agents a workflow run plans around (a guideline, not a cap)',
    kind: {
      type: 'select',
      currentValue: 'medium',
      groups: [],
      flat: [
        { value: 'small', name: 'Small', description: '~5 agents per run · fan-outs up to ~3 wide' },
        { value: 'medium', name: 'Medium', description: '~10 agents per run · fan-outs up to ~6 wide' },
        { value: 'large', name: 'Large', description: '~30 agents per run · fan-outs up to ~16 wide' },
        { value: 'unbounded', name: 'Unbounded', description: 'no agent guideline · fan-outs up to ~64 wide' }
      ]
    }
  }
]

/** Modes whose turn is waiting on an approval or an answer. */
const PROMPTED = MODE.startsWith('permission-') || MODE.startsWith('question')
const BUSY = MODE === 'busy' || MODE === 'chat-steering' || MODE === 'guide' || PROMPTED

const CHAT: ChatDetail = {
  id: 'c1',
  title: 'Fix double submit on Save',
  projectPath: PROJECT,
  acpSessionId: 'acp-1',
  isPinned: false,
  isArchived: false,
  isBusy: BUSY,
  createdAt: NOW - 25 * MIN,
  items: transcript(MODE),
  configOptions: OPTIONS,
  // A slice of what the CLI advertises (internal/acp/commands.go).
  commands: [
    { name: 'help', description: 'Show available commands' },
    { name: 'mode', description: 'Switch the agent mode', inputHint: '<plan|coding|ask>' },
    { name: 'models', description: 'List and pick models' },
    { name: 'thinking', description: 'Set the thinking level', inputHint: '<off|low|medium|high|x-high|max>' },
    { name: 'ultra', description: 'Turn ultracode on or off', inputHint: '<on|off>' },
    { name: 'compact', description: 'Summarise the conversation to free up context' },
    { name: 'diff', description: 'Show the uncommitted changes' },
    { name: 'memory', description: 'Show or edit what Spettro remembers' }
  ],
  // planEntriesFromTodos (content.go): dependency order, "(blocked)" folded
  // into the text of a pending task whose prerequisites aren't done.
  plan: BUSY
    ? [
        { content: 'Find where the double submit comes from', status: 'completed' },
        { content: 'Disable SaveButton while saving', status: 'completed' },
        { content: 'Run the tests and lint', status: 'in_progress' },
        { content: 'Apply the same fix to ProfileForm', status: 'pending' },
        { content: 'Update the changelog (blocked)', status: 'pending' }
      ]
    : [
        { content: 'Find where the double submit comes from', status: 'completed' },
        { content: 'Disable SaveButton while saving', status: 'completed' },
        { content: 'Run the tests and lint', status: 'completed' }
      ],
  usage: { used: 38_400, size: 200_000, tokensUsed: 51_200 },
  lastTurn: null,
  sessionTokens: 51_200
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
const NO_SELECTION =
  MODE === 'welcome' || MODE === 'welcome-empty' || MODE === 'welcome-folders' || MODE === 'no-model'

// --------------------------------------------------------------- extensions

function catalog(
  provider: string,
  providerName: string,
  name: string,
  displayName: string,
  o: { vision?: boolean; reasoning?: boolean; local?: boolean; favorite?: boolean; active?: boolean }
): ModelEntry {
  return {
    provider,
    providerName,
    name,
    displayName,
    vision: o.vision ?? false,
    reasoning: o.reasoning ?? false,
    toolCall: true,
    context: o.local ? 32_000 : 200_000,
    local: o.local ?? false,
    favorite: o.favorite ?? false,
    active: o.active ?? false
  }
}

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
      catalog('anthropic', 'Anthropic', 'sonnet', 'Claude Sonnet', { vision: true, reasoning: true, favorite: true, active: true }),
      catalog('anthropic', 'Anthropic', 'opus', 'Claude Opus', { vision: true, reasoning: true }),
      catalog('anthropic', 'Anthropic', 'haiku', 'Claude Haiku', { vision: true }),
      catalog('openai', 'OpenAI', 'gpt-5', 'GPT-5', { vision: true, reasoning: true, favorite: true }),
      catalog('openai', 'OpenAI', 'gpt-5-mini', 'GPT-5 mini', { reasoning: true }),
      catalog('openai', 'OpenAI', 'gpt-4.1', 'GPT-4.1', { vision: true }),
      catalog('ollama', 'Ollama', 'qwen3-coder', 'qwen3-coder:30b', { local: true, favorite: true }),
      catalog('ollama', 'Ollama', 'llama3.2', 'llama3.2:3b', { local: true })
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
    case 'gate-keys':
      return { kind: 'needsProvider' }
    case 'failure':
      return {
        kind: 'failed',
        message: 'The Spettro agent exited unexpectedly (exit code 1).'
      }
    default:
      // Reconnecting keeps the shell: the phase stays ready and
      // `connection` says the engine is restarting underneath.
      return { kind: 'ready' }
  }
}

function installFor(mode: string): InstallState {
  if (mode === 'installing') return { stage: 'downloading', failure: null }
  if (mode === 'install-failed') return { stage: 'failed', failure: { kind: 'failed' } }
  return { stage: 'idle', failure: null }
}

/** Settings › Updates: the engine has a release waiting, the app doesn't. */
const UPDATES: UpdateState = {
  app: { ...EMPTY_COMPONENT_UPDATE, current: '0.1.7', latest: '0.1.7', checkedAt: NOW - 20 * MIN },
  cli: {
    ...EMPTY_COMPONENT_UPDATE,
    current: '2.9.0',
    latest: '2.9.1',
    available: true,
    releaseUrl: 'https://github.com/aploide/spettro/releases/tag/v2.9.1',
    releaseNotes:
      '## What’s new\n\n- **Faster startup** on large repositories.\n- Workflows resume after a crash.\n- Fixed `/compact` losing the last message.',
    checkedAt: NOW - 20 * MIN
  },
  canInstallApp: false
}

/** Settings › Remote: sharing on, one phone paired and connected. */
const REMOTE: RemoteHostState = {
  enabled: true,
  port: 47321,
  hostId: 'host-1',
  hostName: 'carlo-desktop',
  pairingOpen: false,
  pairingURL: null,
  pairingQR: null,
  pairingExpiresAt: null,
  pairingExpired: false,
  devices: [
    {
      deviceId: 'd1',
      name: 'Carlo’s iPhone',
      platform: 'iOS 19',
      pairedAt: NOW - 3 * 24 * 60 * MIN,
      lastSeenAt: NOW - 2 * MIN,
      revoked: false
    },
    {
      deviceId: 'd2',
      name: 'iPad',
      platform: 'iPadOS 19',
      pairedAt: NOW - 30 * 24 * 60 * MIN,
      lastSeenAt: NOW - 26 * 60 * MIN,
      revoked: false
    }
  ],
  connectedDeviceIds: ['d1']
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
  connection: MODE === 'reconnecting' ? 'reconnecting' : 'ok',
  cli: { path: '/home/carlo/.local/bin/spettro', version: '2.9.0', isDev: false },
  agentVersion: '2.9.0',
  selectedSessionId: NO_SELECTION ? null : 'c1',
  sessions: SESSIONS,
  banner: null,
  bannerNonce: 0,
  install: installFor(MODE),
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
  // Nothing can run a model in the no-model scene — not signed in either.
  subscription:
    MODE === 'no-model' ? { plan: 'unknown', email: null } : { plan: 'pro', email: 'carlo@example.com' },
  extensions: MODE === 'gate' || MODE === 'gate-keys' || MODE === 'no-model' ? GATE_EXTENSIONS : EXTENSIONS,
  update: MODE === 'settings-updates' ? UPDATES : { ...EMPTY_UPDATE_STATE, app: { ...EMPTY_COMPONENT_UPDATE, current: '0.1.7' } },
  remote: MODE.startsWith('settings') ? REMOTE : null,
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
  appearance: 'system',
  noModel: MODE === 'no-model',
  providerSetupSkipped: MODE === 'no-model',
  notifyWhenDone: true,
  defaultConfigOptions: OPTIONS,
  busyTasks: BUSY ? 1 : 0
}

// ----------------------------------------------------------- sheets' input

// Shaped as permission.go requestApproval sends them, after adoptPermission:
// an attached request gets its card's title and kind.
const PERMISSION_BASH: ACPPermissionRequest = {
  id: 'perm-1',
  sessionId: 'acp-1',
  chatId: 'c1',
  toolCallId: 'call_lint',
  title: 'Run npm run lint -- --fix',
  toolKind: 'execute',
  // approvalContent: the whole command, fenced, then the reason.
  content: {
    texts: ['```sh\nnpm run lint -- --fix\n```', 'Fixes the lint errors the edit introduced.'],
    diffs: []
  },
  locations: [],
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'allow-always', name: 'Always allow this command', kind: 'allow_always' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
  ]
}

/** A second approval queued behind the first ("1 of 2"). */
const PERMISSION_QUEUED: ACPPermissionRequest = {
  ...PERMISSION_BASH,
  id: 'perm-1b',
  toolCallId: 'perm-4',
  title: 'Run npm test',
  content: { texts: ['```sh\nnpm test\n```'], diffs: [] }
}

// A file write: no "Always allow" (permission.go remembersApproval).
const PERMISSION_DIFF: ACPPermissionRequest = {
  id: 'perm-2',
  sessionId: 'acp-1',
  chatId: 'c1',
  toolCallId: 'call_edit',
  title: 'Edit SaveButton.tsx',
  toolKind: 'edit',
  content: {
    texts: [],
    diffs: [
      {
        type: 'diff',
        path: `${PROJECT}/src/components/SaveButton.tsx`,
        oldText: OLD_BUTTON,
        newText: NEW_BUTTON
      }
    ]
  },
  locations: [{ path: `${PROJECT}/src/components/SaveButton.tsx` }],
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
  ]
}

// compaction.go askCompactPermission.
const PERMISSION_COMPACT: ACPPermissionRequest = {
  id: 'perm-3',
  sessionId: 'acp-1',
  chatId: 'c1',
  toolCallId: 'compact-1',
  title: 'Context nearly full (~182000/200000 tokens). Compact conversation history now?',
  toolKind: 'think',
  content: { texts: [], diffs: [] },
  locations: [],
  options: [
    { optionId: 'compact', name: 'Compact now', kind: 'allow_once' },
    { optionId: 'continue', name: 'Continue without compacting', kind: 'reject_once' }
  ],
  variant: 'compact'
}

/** An approval whose session no chat claims: the modal fallback. A network
 *  approval, as permission.go sends it with no card open. */
const PERMISSION_ORPHAN: ACPPermissionRequest = {
  id: 'perm-5',
  sessionId: 'acp-gone',
  chatId: null,
  toolCallId: 'perm-1',
  title: 'Fetch https://registry.npmjs.org/react',
  toolKind: 'fetch',
  rawInput: { command: 'network web-fetch https://registry.npmjs.org/react', reason: '' },
  content: { texts: ['```\nnetwork web-fetch https://registry.npmjs.org/react\n```'], diffs: [] },
  locations: [],
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'allow-always', name: 'Always allow this URL', kind: 'allow_always' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
  ]
}

const QUESTION: ACPQuestionRequest = {
  id: 'q-1',
  version: 2,
  sessionId: 'acp-1',
  chatId: 'c1',
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
          isRecommended: true,
          preview: "<SaveButton onSave={async () => {\n  await saveProfile(values)\n}} />"
        },
        { id: 'settings', label: 'Only SettingsForm', description: 'Leave ProfileForm as it is.' }
      ]
    }
  ]
}

/** Three questions, the second a multi-select: the step indicator. */
const QUESTION_MULTI: ACPQuestionRequest = {
  ...QUESTION,
  id: 'q-2',
  questions: [
    ...QUESTION.questions,
    {
      id: 'tests',
      header: 'Tests',
      question: 'Which tests should cover it?',
      multiSelect: true,
      allowCustomInput: true,
      options: [
        { id: 'unit', label: 'Unit tests for SaveButton', isRecommended: true },
        { id: 'form', label: 'Form tests for both callers' },
        { id: 'e2e', label: 'One end-to-end save', description: 'Slower, but catches the double request.' }
      ]
    },
    {
      id: 'ship',
      header: 'Release',
      question: 'Ship it in 2.4 or hold for 2.5?',
      multiSelect: false,
      allowCustomInput: false,
      options: [
        { id: '24', label: 'Ship in 2.4', isRecommended: true },
        { id: '25', label: 'Hold for 2.5' }
      ]
    }
  ]
}

/** Prompts waiting in chats other than the selected one: their rows say
 *  "Needs you". */
const BACKGROUND_PROMPTS: ACPPermissionRequest[] = [
  { ...PERMISSION_BASH, id: 'perm-bg-1', chatId: 'm4', sessionId: 'acp-m4' },
  { ...PERMISSION_DIFF, id: 'perm-bg-2', chatId: 'm11', sessionId: 'acp-m11' }
]

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
  loadMemory: '- Prefers small, focused commits.\n- Uses pnpm in this repo.\n',
  listProjectFiles: [
    'package.json',
    'README.md',
    'src/App.tsx',
    'src/components/SaveButton.tsx',
    'src/components/SaveButton.test.tsx',
    'src/components/Button.tsx',
    'src/views/SettingsForm.tsx',
    'src/views/SettingsForm.test.tsx',
    'src/views/ProfileForm.tsx',
    'src/lib/api.ts',
    'src/lib/settings.ts'
  ]
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
  const permissions: Record<string, ACPPermissionRequest[]> = {
    'permission-bash': [PERMISSION_BASH, PERMISSION_QUEUED],
    'permission-denied': [PERMISSION_BASH],
    'permission-diff': [PERMISSION_DIFF],
    'permission-compact': [PERMISSION_COMPACT],
    'permission-orphan': [PERMISSION_ORPHAN],
    'sidebar-many': BACKGROUND_PROMPTS,
    collapsed: [{ ...PERMISSION_BASH, id: 'perm-bg-3', chatId: 'c3', sessionId: 'acp-c3' }]
  }
  if (permissions[MODE]) push({ type: 'permissions', requests: permissions[MODE] })
  if (MODE === 'question') push({ type: 'questions', requests: [QUESTION] })
  if (MODE === 'question-multi') push({ type: 'questions', requests: [QUESTION_MULTI] })
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
  // One scene per pane: Settings opened the way a user does, then the pane
  // chosen in its sidebar.
  if (MODE.startsWith('settings-')) {
    setTimeout(() => press(','), 60)
    setTimeout(() => click(`[data-testid="settings-pane-${MODE.slice('settings-'.length)}"]`), 140)
  }
  // Delete… from a row's menu: the alert asking first.
  if (MODE === 'confirm-delete' || MODE === 'deleted-undo') {
    setTimeout(() => {
      const row = document.querySelector('[data-testid="sidebar-row-c3"]')
      const r = row?.getBoundingClientRect()
      if (!row || !r) return
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.right - 24, clientY: r.bottom - 4 }))
    }, 60)
    setTimeout(() => {
      const item = [...document.querySelectorAll<HTMLElement>('.ctx-item')].find((el) => el.textContent === 'Delete…')
      item?.click()
    }, 140)
    if (MODE === 'deleted-undo') setTimeout(() => click('[data-testid="confirm-ok"]'), 260)
  }
  // A failed action, said in words: the toast the call wrapper raises.
  if (MODE === 'error-toast') {
    setTimeout(
      () =>
        showToast({
          tone: 'error',
          title: 'Your API key was rejected',
          detail: 'Check the key in Settings › Models & Providers, or connect another provider.',
          action: { label: 'Open Models & Providers', run: () => undefined }
        }),
      60
    )
  }
  // Setup's "Use my own API key": the provider list with its key links.
  if (MODE === 'gate-keys') {
    setTimeout(() => {
      const alt = [...document.querySelectorAll<HTMLElement>('.setup-alt')][0]
      alt?.click()
    }, 60)
    setTimeout(() => {
      const connect = [...document.querySelectorAll<HTMLElement>('.prov-row .btn')].find((b) => b.textContent === 'Connect')
      connect?.click()
    }, 140)
  }
  // The engine restarting under a chat with a half-written message: the
  // header pill, the field still holding the text, Send waiting.
  if (MODE === 'reconnecting') {
    setTimeout(() => {
      const el = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')
      if (!el) return
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(el, 'Also add a test for the disabled state')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, 60)
  }
  // Denied once the card has armed: the request leaves the queue the way
  // main would take it off, and the "what instead?" field is what's left.
  if (MODE === 'permission-denied') {
    setTimeout(() => {
      click('[data-testid="permission-deny"]')
      push({ type: 'permissions', requests: [] })
    }, 850)
  }
  // The second question, with a pick made, the way a user gets there.
  if (MODE === 'question-multi') {
    setTimeout(() => {
      click('[data-testid="question-option-both"]')
      click('[data-testid="question-submit"]')
    }, 850)
    setTimeout(() => {
      click('[data-testid="question-option-unit"]')
      click('[data-testid="question-option-e2e"]')
      click('[data-testid="question-option-other"]')
    }, 900)
  }
  if (MODE === 'switcher') setTimeout(() => press('k'), 60)
  if (MODE === 'welcome-folders') setTimeout(() => click('[data-testid="project-chip"]'), 60)
  // The tool rows open the way a reader opens them: the folded reads, the
  // edit's diff and the command's output.
  if (MODE === 'chat-tools') {
    setTimeout(() => {
      click('.tr-tool-group > .tr-tool-header')
      click('button[aria-label^="Edit SaveButton.tsx"]')
      click('button[aria-label^="Bash npm test"]')
    }, 60)
  }
  if (MODE === 'chat-error') {
    setTimeout(() => {
      click('button[aria-label^="Bash npm test"]')
      click('.tr-error-details .disclosure-toggle')
    }, 60)
  }
  // The composer, driven the way a user drives it: typed into (through the
  // value setter React listens behind), keys pressed, buttons clicked.
  const type = (text: string): void => {
    const el = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')
    if (!el) return
    el.focus()
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(el, text)
    el.setSelectionRange(text.length, text.length)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const key = (k: string): void => {
    document
      .querySelector('[data-testid="composer-input"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
  }
  // The menus open only while the field has the focus, which an offscreen
  // page gets once the capture turns focus emulation on, just after load.
  const focused = (then: () => void, waited = 0): void => {
    if (document.hasFocus() || waited > 2000) then()
    else setTimeout(() => focused(then, waited + 25), 25)
  }
  if (MODE === 'guide') setTimeout(() => type('Also make ProfileForm await the save the same way.'), 60)
  if (MODE === 'slash') focused(() => setTimeout(() => type('/'), 60))
  if (MODE === 'mention') {
    // One file chosen (now a chip), and the menu open for a second.
    focused(() => {
      setTimeout(() => type('Compare @savebut'), 60)
      setTimeout(() => key('Enter'), 260)
      setTimeout(() => {
        const el = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')
        if (el) type(el.value + 'with @sett')
      }, 420)
    })
  }
  if (MODE === 'model-menu') setTimeout(() => click('[data-testid="model-button"]'), 60)
  if (MODE === 'session-settings') setTimeout(() => click('[data-testid="session-settings"]'), 60)
  if (MODE === 'thinking' || MODE === 'thinking-paused') {
    setTimeout(() => click('[data-testid="thinking-chip"]'), 60)
  }
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

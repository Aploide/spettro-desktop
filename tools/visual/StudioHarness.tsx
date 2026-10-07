// Shoots the workflow studio without a running CLI behind it.
//
// The studio talks to the main process for everything — list, read, validate,
// run — so rendering it offscreen means standing in for that channel. This
// stubs `window.spettro` with canned answers shaped exactly like the CLI's
// (including a broken script and a compile error, which are the states worth
// looking at) and mounts the real component. Nothing about the view is faked.

import './accentPrelude'
import { useEffect } from 'react'
import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'
import WorkflowStudio from '@renderer/views/workflows/WorkflowStudio'
import { initStore } from '@renderer/state/store'
import { SCENES } from './fixtures'
import '@renderer/design/theme.css'
import '@renderer/design/shell.css'
import '@renderer/design/form.css'
import '@renderer/views/chat/transcript/transcript.css'
import './harness.css'

const SCRIPT = `export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [
    { title: 'Review', detail: 'one agent per dimension' },
    { title: 'Verify', detail: 'adversarial refutation' },
  ],
}

phase('Review')
const DIMENSIONS = ['bugs', 'perf', 'a11y']
const found = await parallel(
  DIMENSIONS.map((d) => () =>
    agent(\`Review the diff for \${d} problems\`, { label: 'review:' + d, schema: FINDINGS })
  )
)

phase('Verify')
const confirmed = await pipeline(
  found.filter(Boolean).flatMap((r) => r.findings),
  (f) => agent(\`Try to refute: \${f.title}\`, { schema: VERDICT })
)
return confirmed.filter((v) => v && !v.refuted)
`

const WORKFLOWS = [
  {
    name: 'review-changes',
    path: '/home/carlo/proj/.spettro/workflows/review-changes.js',
    scope: 'project',
    description: 'Review changed files across dimensions, verify each finding',
    whenToUse: 'before opening a PR',
    phases: [
      { title: 'Review', detail: 'one agent per dimension' },
      { title: 'Verify', detail: 'adversarial refutation' }
    ],
    error: null
  },
  {
    name: 'audit-deps',
    path: '/home/carlo/proj/.spettro/workflows/audit-deps.js',
    scope: 'project',
    description: 'One agent per dependency, then a synthesis pass',
    whenToUse: '',
    phases: [{ title: 'Audit', detail: '' }, { title: 'Synthesize', detail: '' }],
    error: null
  },
  {
    name: 'release-notes',
    path: '/home/carlo/.spettro/workflows/release-notes.js',
    scope: 'global',
    description: 'Draft release notes from the commit range',
    whenToUse: '',
    phases: [{ title: 'Read', detail: '' }],
    error: null
  },
  {
    name: 'half-written',
    path: '/home/carlo/proj/.spettro/workflows/half-written.js',
    scope: 'project',
    description: '',
    whenToUse: '',
    phases: [],
    error: 'SyntaxError: Unexpected end of input (line 12)'
  }
]

// The scratch chat the studio mirrors while a test run is going. Reuses the
// mid-run workflow fixture so the run pane shows a real phase tree.
const RUN_CHAT = {
  id: 'scratch-1',
  title: 'Workflow · review-changes',
  projectPath: '/home/carlo/proj',
  acpSessionId: 'acp-1',
  isPinned: false,
  isArchived: false,
  isBusy: true,
  createdAt: Date.now(),
  items: SCENES.find((s) => s.id === 'workflow-running')!.items,
  configOptions: [],
  commands: [],
  plan: [],
  usage: null,
  lastTurn: null,
  sessionTokens: 0
}

const MODE = new URLSearchParams(location.search).get('mode') ?? 'editing'

const ANSWERS: Record<string, unknown> = {
  workflowList: {
    workflows: WORKFLOWS,
    searchPaths: ['/home/carlo/proj/.spettro/workflows', '/home/carlo/.spettro/workflows'],
    cwd: '/home/carlo/proj'
  },
  workflowRead: { ...WORKFLOWS[0], script: SCRIPT },
  workflowValidate:
    MODE === 'broken'
      ? {
          ok: false,
          error: "SyntaxError: Unexpected token '}' (line 18)",
          name: 'review-changes',
          description: '',
          whenToUse: '',
          phases: []
        }
      : {
          ok: true,
          error: null,
          name: 'review-changes',
          description: 'Review changed files across dimensions, verify each finding',
          whenToUse: 'before opening a PR',
          phases: [
            { title: 'Review', detail: 'one agent per dimension' },
            { title: 'Verify', detail: 'adversarial refutation' }
          ]
        },
  // _spettro/workflow/runs with what main reads from each run's folder.
  workflowRuns: [
    { runId: 'wf-7c1e', dir: '/home/carlo/.spettro/sessions/s-41/workflows/wf-7c1e', modifiedAt: Date.now() - 4 * 60_000, name: 'review-changes', finished: true },
    { runId: 'wf-5a90', dir: '/home/carlo/.spettro/sessions/s-41/workflows/wf-5a90', modifiedAt: Date.now() - 3 * 3_600_000, name: 'audit-deps', finished: false },
    { runId: 'wf-2b44', dir: '/home/carlo/.spettro/sessions/s-38/workflows/wf-2b44', modifiedAt: Date.now() - 2 * 86_400_000, name: 'review-changes', finished: true }
  ],
  workflowRun: 'scratch-1',
  workflowDiscardRun: undefined,
  cancel: undefined
}

// Stand in for the preload bridge. The store reads chats out of `chat-reset`
// events, so the run chat is pushed through the real reducer rather than
// injected — the run pane then reads it exactly as it would in the app.
let push: ((event: unknown) => void) | null = null
;(window as unknown as { spettro: unknown }).spettro = {
  onEvent: (handler: (event: unknown) => void) => {
    push = handler
  },
  call: (method: string) => Promise.resolve(ANSWERS[method] ?? null)
}

initStore()
push?.({ type: 'chat-reset', chat: RUN_CHAT })

function Harness(): JSX.Element {
  // The studio opens on its empty state, and the states worth photographing
  // are the ones behind a click. Rather than add a prop the app would never
  // use, the harness clicks the first row the way a user would.
  useEffect(() => {
    if (MODE === 'empty') return
    const timer = setTimeout(() => {
      const row = document.querySelector<HTMLButtonElement>('.wfs-row-open')
      row?.click()
      if (MODE === 'running') {
        // Run only becomes available once the debounced compile has come
        // back, so this waits past VALIDATE_DEBOUNCE_MS rather than racing it.
        setTimeout(() => {
          document.querySelectorAll<HTMLButtonElement>('.wfs-btn').forEach((b) => {
            if (b.textContent === 'Run') b.click()
          })
        }, 700)
      }
    }, 120)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div className="hz-root hz-root--studio">
      <div className="hz-studio-frame">
        <WorkflowStudio chatId="chat-1" onClose={() => undefined} />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<Harness />)

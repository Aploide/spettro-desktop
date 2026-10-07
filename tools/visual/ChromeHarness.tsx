// The chat chrome: the composer toolbar's chips, the thinking slider and the
// activation glow. (The whole composer — menus open, busy, the todo list —
// is photographed in the real app: app:busy, app:guide, app:slash,
// app:mention, app:model-menu, app:session-settings.)
//
// All are states that only exist while someone is interacting — a stop just
// reached, a phrase mid-typing — so none shows up in the transcript scenes.
// They are also the things most recently reported as looking wrong, which is
// reason enough to be able to photograph them.
//
// Pick the page with `?mode=`:
//   (none)    the toolbar chips and the composer's glow
//   thinking  the slider in every state it can be in, and its chip
//   meteor    the meteor frozen at points of its flight, from Max and from
//             Low; `&meteorProgress=0.3` (and `&meteorFrom=<stop>`) freezes
//             one frame instead
//   smoulder  lit Ultra at rest, frozen at moments of its idle fire;
//             `&idleTime=1.5` freezes one frame instead

import './accentPrelude'
import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'
import ConfigBar from '@renderer/views/chat/ConfigBar'
import ModelMenu from '@renderer/views/chat/ModelMenu'
import ThinkingSlider, { ThinkingChip } from '@renderer/views/chat/ThinkingSlider'
import {
  ActivationText,
  ActivationTextarea,
  WorkflowHint
} from '@renderer/views/chat/ActivationGlow'
import type { ACPConfigOption } from '@shared/acp'
import type { ChatDetail } from '@shared/model'
import '@renderer/design/theme.css'
import '@renderer/views/chat/chat.css'
import '@renderer/views/chat/transcript/transcript.css'
import './harness.css'

const PARAMS = new URLSearchParams(window.location.search)
const MODE = PARAMS.get('mode') ?? ''

;(window as unknown as { spettro: unknown }).spettro = {
  onEvent: () => undefined,
  call: () => Promise.resolve(null)
}

interface Options {
  permission: string
  ultra: boolean
  size?: string
  thinking?: string
}

function options(o: Options): ACPConfigOption[] {
  return [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      kind: {
        type: 'select',
        currentValue: 'coding',
        groups: [],
        flat: [{ value: 'coding', name: 'Coding' }]
      }
    },
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      kind: {
        type: 'select',
        currentValue: 'x',
        groups: [],
        flat: [
          { value: 'x', name: 'SuperSmart' },
          { value: 'quick', name: 'QuickChat' }
        ]
      }
    },
    {
      id: 'permission',
      name: 'Permission',
      category: 'permission',
      kind: {
        type: 'select',
        currentValue: o.permission,
        groups: [],
        flat: [
          { value: 'ask-first', name: 'Ask first' },
          { value: 'restricted', name: 'Restricted' },
          { value: 'yolo', name: 'YOLO' }
        ]
      }
    },
    {
      // config_options.go thinkingConfigOption.
      id: 'thinking',
      name: 'Thinking',
      description: 'Extended-thinking effort',
      category: 'thought_level',
      kind: {
        type: 'select',
        currentValue: o.thinking ?? 'high',
        groups: [],
        flat: [
          { value: 'off', name: 'Off' },
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
          { value: 'x-high', name: 'X-High' },
          { value: 'max', name: 'Max' }
        ]
      }
    },
    {
      id: 'ultra',
      name: 'Ultra',
      // config_options.go ultraConfigOption: the note comes with Ask first.
      description:
        o.ultra && o.permission === 'ask-first'
          ? 'Ultracode: substantive tasks run as dynamic workflows (suspended under Ask first — workflows need Restricted or YOLO)'
          : 'Ultracode: substantive tasks run as dynamic workflows',
      kind: { type: 'boolean', currentValue: o.ultra }
    },
    {
      id: 'workflow_size',
      name: 'Workflow size',
      description: 'How many agents a workflow run plans around (a guideline, not a cap)',
      kind: {
        type: 'select',
        currentValue: o.size ?? 'medium',
        groups: [],
        flat: [
          { value: 'small', name: 'Small', description: '~5 agents per run · fan-outs up to ~5 wide' },
          { value: 'medium', name: 'Medium', description: '~10 agents per run · fan-outs up to ~10 wide' },
          { value: 'large', name: 'Large', description: '~30 agents per run · fan-outs up to ~30 wide' },
          { value: 'unbounded', name: 'Unbounded', description: 'no agent guideline · fan-outs up to ~50 wide' }
        ]
      }
    }
  ]
}

function chat(opts: ACPConfigOption[]): ChatDetail {
  return {
    id: 'c1',
    title: 't',
    projectPath: '/p',
    acpSessionId: 'a',
    isPinned: false,
    isArchived: false,
    isBusy: false,
    createdAt: 0,
    items: [],
    configOptions: opts,
    commands: [],
    plan: [],
    usage: null,
    lastTurn: null,
    sessionTokens: 0
  }
}

const PHRASES = [
  'ultracode: review the pending changes',
  'use a workflow to modernise these handlers',
  'fan this out across sub-agents',
  'can you orchestrate this with subagents please',
  'use a workflow to port the handlers +1.5m',
  'check our deploy workflow and .github/workflows — neither should light up'
]

function Row({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div className="hz-chrome-row">
      <div className="hz-chrome-label">{label}</div>
      {children}
    </div>
  )
}

/** The composer's toolbar as it sits in the card: chips left, model right. */
function Toolbar({ o }: { o: Options }): JSX.Element {
  const c = chat(options(o))
  return (
    <div className="composer-card hz-composer">
      <div className="composer-toolbar">
        <ConfigBar chat={c} />
        <div className="composer-toolbar-spacer" />
        <ModelMenu chat={c} />
      </div>
    </div>
  )
}

function Harness(): JSX.Element {
  if (MODE === 'thinking') return <ThinkingPage />
  if (MODE === 'meteor') return <MeteorPage />
  if (MODE === 'smoulder') return <SmoulderPage />
  return (
    <div className="hz-root hz-root--chrome">
      <Row label="Mode · thinking High · settings (Restricted) … model">
        <Toolbar o={{ permission: 'restricted', ultra: false }} />
      </Row>
      <Row label="Ultra lit · Don’t ask (YOLO) is called out">
        <Toolbar o={{ permission: 'yolo', ultra: true, size: 'large' }} />
      </Row>
      <Row label="Ultra paused (Ask first)">
        <Toolbar o={{ permission: 'ask-first', ultra: true, size: 'unbounded' }} />
      </Row>

      <Row label="Composer — an @-mentioned file is a chip in the text">
        <div className="composer-card hz-composer">
          <ActivationTextarea
            className="composer-input"
            rows={1}
            value={'Compare @src/components/SaveButton.tsx with @src/views/SettingsForm.tsx and use a workflow'}
            onChange={() => undefined}
            mentions={['src/components/SaveButton.tsx', 'src/views/SettingsForm.tsx']}
          />
        </div>
      </Row>

      <Row label="Composer — the phrase lights as it is typed">
        <div className="composer-card hz-composer">
          <ActivationTextarea
            className="composer-input"
            rows={2}
            value={'ultracode: review the pending changes and use a workflow for the port'}
            onChange={() => undefined}
          />
        </div>
      </Row>

      <Row label="Composer — a budget directive beside the keyword, and what it sets">
        <div>
          <div className="composer-card hz-composer">
            <ActivationTextarea
              className="composer-input"
              rows={2}
              value={'ultracode +500k: review the pending changes'}
              onChange={() => undefined}
              budgets
            />
          </div>
          <WorkflowHint pausedByAskFirst={false} budgetTokens={500_000} />
        </div>
      </Row>

      <Row label="Composer — Ask first: the phrase is muted and the line says why">
        <div>
          <div className="composer-card hz-composer">
            <ActivationTextarea
              className="composer-input"
              rows={2}
              value={'ultracode: review the pending changes'}
              onChange={() => undefined}
              muted
            />
          </div>
          <WorkflowHint pausedByAskFirst budgetTokens={null} onSwitchPermission={() => undefined} />
        </div>
      </Row>

      <Row label="Sent messages — what armed the turn stays lit in it">
        <div className="hz-bubbles">
          {PHRASES.map((text) => (
            <div className="tr-user-row" key={text}>
              <div className="tr-user-stack">
                <div className="tr-user-bubble">
                  <ActivationText text={text} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </Row>
    </div>
  )
}


/** The slider as the popover shows it: same panel, laid inline. */
function Panel({
  label,
  o,
  reasons,
  meteorProgress,
  meteorFrom,
  idleTime
}: {
  label: string
  o: Options
  reasons?: boolean
  meteorProgress?: number
  meteorFrom?: number
  idleTime?: number
}): JSX.Element {
  return (
    <div className="hz-chrome-row">
      <div className="hz-chrome-label">{label}</div>
      <div className="popover thinking-popover hz-popover">
        <ThinkingSlider
          chat={chat(options(o))}
          reasons={reasons}
          meteorProgress={meteorProgress}
          meteorFrom={meteorFrom}
          idleTime={idleTime}
        />
      </div>
    </div>
  )
}

/** Just the thinking and ultra options: the chip alone in its bar. (Paused
 *  still shows — the CLI's description says "suspended".) */
function only(o: Options): ACPConfigOption[] {
  return options(o).filter((op) => op.id === 'thinking' || op.id === 'ultra')
}

function ThinkingPage(): JSX.Element {
  return (
    <div className="hz-root hz-root--chrome">
      <div className="hz-panels">
        <Panel label="High" o={{ permission: 'yolo', ultra: false }} />
        <Panel label="Ultra, settled (lit)" o={{ permission: 'yolo', ultra: true }} idleTime={1.2} />
        <Panel label="Ultra paused — Ask first" o={{ permission: 'ask-first', ultra: true }} />
        <Panel label="Extra high" o={{ permission: 'yolo', ultra: false, thinking: 'x-high' }} />
        <Panel label="Off (set elsewhere)" o={{ permission: 'yolo', ultra: false, thinking: 'off' }} />
        <Panel
          label="A model that doesn’t reason"
          o={{ permission: 'yolo', ultra: false }}
          reasons={false}
        />
      </div>
      <Row label="The chip: High · Ultra lit · Ultra paused · Off">
        <div className="hz-bar hz-chips">
          <ThinkingChip chat={chat(only({ permission: 'yolo', ultra: false }))} />
          <ThinkingChip chat={chat(only({ permission: 'yolo', ultra: true }))} />
          <ThinkingChip chat={chat(only({ permission: 'ask-first', ultra: true }))} />
          <ThinkingChip chat={chat(only({ permission: 'yolo', ultra: false, thinking: 'off' }))} />
        </div>
      </Row>
    </div>
  )
}

// Through the flight, the impact (from Max at ~0.4, from Low at ~0.57) and
// the cooling.
const FRAMES = [0.05, 0.15, 0.25, 0.35, 0.44, 0.5, 0.55, 0.6, 0.66, 0.75, 0.85, 0.95]

function MeteorPage(): JSX.Element {
  const lit = { permission: 'yolo', ultra: true }
  const single = PARAMS.get('meteorProgress')
  if (single !== null) {
    const from = PARAMS.get('meteorFrom')
    return (
      <div className="hz-root hz-root--chrome">
        <Panel
          label={`Meteor at ${single}`}
          o={lit}
          meteorProgress={Number(single)}
          meteorFrom={from === null ? undefined : Number(from)}
        />
      </div>
    )
  }
  return (
    <div className="hz-root hz-root--chrome">
      <div className="hz-panels">
        {FRAMES.map((p) => (
          <Panel key={p} label={`From Max · ${p}`} o={lit} meteorProgress={p} />
        ))}
      </div>
      <div className="hz-panels">
        {FRAMES.map((p) => (
          <Panel key={p} label={`From Low · ${p}`} o={lit} meteorProgress={p} meteorFrom={0} />
        ))}
      </div>
    </div>
  )
}

// Lit Ultra at rest, a few seconds of its smoulder: the heat waves running
// along the bar and the embers drifting with them.
const IDLE_FRAMES = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]

function SmoulderPage(): JSX.Element {
  const lit = { permission: 'yolo', ultra: true }
  const single = PARAMS.get('idleTime')
  if (single !== null) {
    return (
      <div className="hz-root hz-root--chrome">
        <Panel label={`Smoulder at ${single}s`} o={lit} idleTime={Number(single)} />
      </div>
    )
  }
  return (
    <div className="hz-root hz-root--chrome">
      <div className="hz-panels">
        {IDLE_FRAMES.map((t) => (
          <Panel key={t} label={`Smoulder · ${t}s`} o={lit} idleTime={t} />
        ))}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<Harness />)

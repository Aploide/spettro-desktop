// The chat chrome: the config bar and the activation glow.
//
// Both are states that only exist while someone is interacting — a chip that
// has been armed, a phrase mid-typing — so neither shows up in the transcript
// scenes. They are also the two things most recently reported as looking
// wrong, which is reason enough to be able to photograph them.

import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'
import ConfigBar from '@renderer/views/chat/ConfigBar'
import { ActivationText, ActivationTextarea } from '@renderer/views/chat/ActivationGlow'
import type { ACPConfigOption } from '@shared/acp'
import type { ChatDetail } from '@shared/model'
import '@renderer/design/theme.css'
import '@renderer/views/chat/chat.css'
import '@renderer/views/chat/transcript/transcript.css'
import './harness.css'

;(window as unknown as { spettro: unknown }).spettro = {
  onEvent: () => undefined,
  call: () => Promise.resolve(null)
}

function options(o: { permission: string; ultra: boolean }): ACPConfigOption[] {
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
        flat: [{ value: 'x', name: 'SuperSmart' }]
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
          { value: 'yolo', name: 'YOLO' },
          { value: 'ask-first', name: 'Ask first' }
        ]
      }
    },
    {
      id: 'thinking',
      name: 'Thinking',
      category: 'thinking',
      kind: {
        type: 'select',
        currentValue: 'high',
        groups: [],
        flat: [{ value: 'high', name: 'High' }]
      }
    },
    { id: 'ultra', name: 'Ultra', kind: { type: 'boolean', currentValue: o.ultra } }
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
    usage: null
  }
}

const PHRASES = [
  'ultracode: review the pending changes',
  'use a workflow to modernise these handlers',
  'fan this out across sub-agents',
  'can you orchestrate this with subagents please',
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

function Harness(): JSX.Element {
  return (
    <div className="hz-root hz-root--chrome">
      <Row label="Ultra armed">
        <div className="hz-bar">
          <ConfigBar chat={chat(options({ permission: 'yolo', ultra: true }))} />
        </div>
      </Row>
      <Row label="Ultra off">
        <div className="hz-bar">
          <ConfigBar chat={chat(options({ permission: 'yolo', ultra: false }))} />
        </div>
      </Row>
      <Row label="Ultra locked (Ask first)">
        <div className="hz-bar">
          <ConfigBar chat={chat(options({ permission: 'ask-first', ultra: false }))} />
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

createRoot(document.getElementById('root') as HTMLElement).render(<Harness />)

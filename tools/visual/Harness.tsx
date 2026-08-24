// The visual harness: renders every orchestration scene at once, offscreen,
// so a screenshot can be taken and looked at.
//
// It exists because these views are almost impossible to review by reading
// the code — the whole point of the workflow card and the swarm card is what
// they look like when twenty rows land at once, half of them still moving.
// The harness mounts them against fixtures shaped exactly like the CLI's wire
// output (fixtures.ts) so every state, including the ones that need a real
// provider and ten minutes of waiting to reach, is one build away.

import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { groupTranscript, activeRuns } from '@renderer/views/chat/transcript/orchestration'
import { WorkflowCard } from '@renderer/views/chat/transcript/WorkflowCard'
import { SwarmCard } from '@renderer/views/chat/transcript/SwarmCard'
import OrchestrationPanel from '@renderer/views/chat/OrchestrationPanel'
import TranscriptItemView from '@renderer/views/chat/transcript/TranscriptItemView'
import { SubAgentCallView } from '@renderer/views/chat/transcript/ToolCallView'
import { subAgentCall } from '@renderer/views/chat/transcript/toolPresentation'
import { SCENES, type Scene } from './fixtures'
import { LIVE_SCENE } from './fixtures.live'
import '@renderer/design/theme.css'
import '@renderer/views/chat/chat.css'
import '@renderer/views/chat/transcript/transcript.css'
import './harness.css'

function SceneView({ scene }: { scene: Scene }): JSX.Element {
  const rows = groupTranscript(scene.items)
  const live = activeRuns(rows)
  return (
    <section className="hz-scene" id={scene.id}>
      <header className="hz-scene-head">
        <h2>{scene.title}</h2>
        <p>{scene.note}</p>
        <code>
          {scene.items.length} items → {rows.length} rows · {live.length} live
        </code>
      </header>
      <div className="hz-scene-body">
        <div className="hz-transcript">
          <div className="chat-transcript-inner">
            {rows.map((row) => {
              if (row.kind === 'run') {
                return row.run.kind === 'workflow' ? (
                  <WorkflowCard key={row.id} run={row.run} />
                ) : (
                  <SwarmCard key={row.id} run={row.run} />
                )
              }
              if (row.kind === 'agent') {
                const call = subAgentCall(row.member.tool)
                if (!call) return null
                return (
                  <SubAgentCallView
                    key={row.id}
                    tool={row.member.tool}
                    call={call}
                    children={row.member.children}
                  />
                )
              }
              return <TranscriptItemView key={row.id} item={row.item} />
            })}
          </div>
        </div>
        {live.length > 0 && (
          <aside className="hz-panel">
            <OrchestrationPanel runs={live} onClose={() => undefined} />
          </aside>
        )}
      </div>
    </section>
  )
}

const only = new URLSearchParams(location.search).get('scene')
const ALL = [LIVE_SCENE, ...SCENES]
const scenes = only ? ALL.filter((s) => s.id === only) : ALL

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="hz-root">
    {scenes.map((s) => (
      <SceneView key={s.id} scene={s} />
    ))}
  </div>
)

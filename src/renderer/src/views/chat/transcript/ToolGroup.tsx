// The folded "Read 5 files" line (see toolGroups.ts for when calls fold).
// It reads like one more tool row — same dot, same weight — and opens to the
// rows it stands for, each still expandable on its own.

import { useState } from 'react'
import type { JSX } from 'react'
import { Icon } from '@renderer/design/icons'
import { ToolRow, ToolStatusGlyph } from './ToolCallView'
import { groupSummary, type ToolGroupRow } from './toolGroups'
import './transcript.css'

export function ToolGroup({ group }: { group: ToolGroupRow }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className={`tr-tool tr-tool-group${expanded ? ' tr-tool--expanded' : ''}`}>
      <button
        className="tr-tool-header"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
      >
        <ToolStatusGlyph status="completed" />
        <span className="tr-tool-verb">{groupSummary(group.tools)}</span>
        <span className="tr-tool-spacer" />
        <span className={`tr-chevron${expanded ? ' tr-chevron--open' : ''}`}>
          <Icon name="chevron.right" size={8} />
        </span>
      </button>
      {expanded && (
        <div className="tr-tool-panel tr-group-rows">
          {group.tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} />
          ))}
        </div>
      )}
    </div>
  )
}

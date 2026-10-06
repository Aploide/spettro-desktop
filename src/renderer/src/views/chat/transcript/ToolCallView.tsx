// Port of spettro-apple/Spettro/Views/ToolCallView.swift, redrawn after the
// Claude Code tab.
//
// One tool call is one quiet line: a status dot, a bold verb ("Read",
// "Bash"), the argument in mono (the file's name, the command), and a muted
// note at the right edge ("+12 −3", "42 lines", "exit 1"). Opening it shows
// what the call did in an indented panel under a thin rule: a real unified
// diff for an edit, `$ command` and its output for a shell call, the images
// a tool returned, and the file locations it touched. `agent` calls render as
// the sub-agent card instead.

import { useState } from 'react'
import type { JSX } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@renderer/design/icons'
import { useStore } from '@renderer/state/store'
import type { ToolCallItem, ToolDiff } from '@shared/model'
import type { ACPToolImage } from '@shared/acp'
import {
  diffOf,
  diffStat,
  displayName,
  parsedTitle,
  rowArgument,
  rowMeta,
  shortPath,
  subAgentCall,
  subAgentResult,
  type SubAgentCall
} from './toolPresentation'
import { diffLineCount, type DiffLine } from './unifiedDiff'
import { MarkdownText } from './MarkdownText'
import './transcript.css'
import './orchestration.css'

export function ToolCallView({ tool }: { tool: ToolCallItem }): JSX.Element {
  const call = subAgentCall(tool)
  if (call) return <SubAgentCallView tool={tool} call={call} />
  return <ToolRow tool={tool} />
}

/** True while the CLI is waiting on the user to approve this call. */
function useAwaitingApproval(toolId: string): boolean {
  return useStore((s) => s.permissions.some((p) => p.toolCallId === toolId))
}

// ---------------------------------------------------------------------------
// The standard row
// ---------------------------------------------------------------------------

export function ToolRow({ tool }: { tool: ToolCallItem }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const awaiting = useAwaitingApproval(tool.id)
  const command = shellCommand(tool)
  const images = tool.images ?? []
  const hasDetail =
    tool.output.trim() !== '' ||
    tool.diffs.length > 0 ||
    images.length > 0 ||
    command !== null ||
    tool.locations.length > 0
  const stat = diffStat(tool)
  const meta = rowMeta(tool)
  const argument = rowArgument(tool)
  const verb = displayName(tool)
  // The visible spans run together ("Editx.ts+1−1"); read it as a sentence.
  const spoken = [
    `${verb} ${argument}`.trim(),
    awaiting ? 'needs approval' : STATUS_WORDS[tool.status],
    stat && (stat.added > 0 || stat.removed > 0)
      ? `${stat.added} added, ${stat.removed} removed`
      : null,
    meta
  ]
    .filter((part) => part)
    .join(', ')

  return (
    <div className={`tr-tool${expanded ? ' tr-tool--expanded' : ''}`}>
      <button
        className="tr-tool-header"
        type="button"
        title={tool.title}
        aria-label={spoken}
        aria-expanded={hasDetail ? expanded : undefined}
        onClick={() => {
          if (hasDetail) setExpanded((e) => !e)
        }}
      >
        <ToolStatusGlyph status={tool.status} awaiting={awaiting} />
        <span className="tr-tool-verb">{verb}</span>
        {argument !== '' && <span className="tr-tool-arg">{argument}</span>}
        <span className="tr-tool-spacer" />
        {awaiting && <span className="tr-tool-meta tr-tool-meta--waiting">Needs approval</span>}
        {stat && (stat.added > 0 || stat.removed > 0) && (
          <DiffStatLabel added={stat.added} removed={stat.removed} />
        )}
        {meta && (
          <span
            className={`tr-tool-meta${tool.status === 'failed' ? ' tr-tool-meta--failed' : ''}`}
          >
            {meta}
          </span>
        )}
        {hasDetail && (
          <span className={`tr-chevron${expanded ? ' tr-chevron--open' : ''}`}>
            <Icon name="chevron.right" size={8} />
          </span>
        )}
      </button>
      {expanded && hasDetail && <ToolPanel tool={tool} command={command} />}
    </div>
  )
}

/** A row's status as its spoken label says it; done goes unsaid. */
const STATUS_WORDS: Record<ToolCallItem['status'], string | null> = {
  pending: 'not started',
  in_progress: 'running',
  completed: null,
  failed: 'failed',
  unknown: null
}

/** The command a shell call ran, for the panel's `$ …` line. */
function shellCommand(tool: ToolCallItem): string | null {
  if (tool.kind !== 'execute') return null
  const { args } = parsedTitle(tool)
  const command = args?.['command'] ?? args?.['cmd']
  return typeof command === 'string' && command.trim() !== '' ? command.trim() : null
}

/**
 * The leading status mark: a hollow dot not yet started, a pulsing accent dot
 * while it runs, a green dot done, a red cross failed — and amber while the
 * CLI is waiting for the user to approve it, which is the one state that is
 * the reader's move rather than the agent's.
 */
export function ToolStatusGlyph({
  status,
  awaiting = false
}: {
  status: ToolCallItem['status']
  awaiting?: boolean
}): JSX.Element {
  if (awaiting) {
    return <span className="tr-glyph tr-glyph--awaiting" role="img" aria-label="Needs approval" />
  }
  switch (status) {
    case 'pending':
    case 'unknown':
      return <span className="tr-glyph tr-glyph--pending" role="img" aria-label="Not started" />
    case 'in_progress':
      return <span className="tr-glyph tr-glyph--running" role="img" aria-label="Running" />
    case 'failed':
      return (
        <span className="tr-glyph tr-glyph--failed" role="img" aria-label="Failed">
          <Icon name="xmark" size={10} />
        </span>
      )
    default:
      return <span className="tr-glyph tr-glyph--done" role="img" aria-label="Done" />
  }
}

// ---------------------------------------------------------------------------
// The +N −N label (shared with the chat header's git stat)
// ---------------------------------------------------------------------------

export function DiffStatLabel({ added, removed }: { added: number; removed: number }): JSX.Element {
  return (
    <span className="tr-diffstat">
      {added > 0 && <span className="tr-diffstat-added">+{added}</span>}
      {removed > 0 && <span className="tr-diffstat-removed">−{removed}</span>}
    </span>
  )
}

// ---------------------------------------------------------------------------
// The expanded panel
// ---------------------------------------------------------------------------

/** Output lines shown before "Show more". */
const OUTPUT_LINES = 30

function ToolPanel({ tool, command }: { tool: ToolCallItem; command: string | null }): JSX.Element {
  const images = tool.images ?? []
  const output = tool.output.replace(/\s+$/, '')
  // An edit's text is a one-line receipt of what its diff already shows.
  const showOutput = output !== '' && (tool.diffs.length === 0 || tool.status === 'failed')
  // A diff already names its file, with every line numbered.
  const diffPaths = new Set(tool.diffs.map((d) => d.path))
  const locations = tool.locations.filter((loc) => !diffPaths.has(loc.path))
  return (
    <div className="tr-tool-panel">
      {locations.length > 0 && (
        <div className="tr-locations">
          {locations.map((loc, i) => (
            <span className="tr-location" key={i} title={loc.path}>
              {shortPath(loc.path)}
              {loc.line != null && <span className="tr-location-line">:{loc.line}</span>}
            </span>
          ))}
        </div>
      )}
      {tool.diffs.map((diff, i) => (
        <DiffView key={i} diff={diff} />
      ))}
      {(command !== null || showOutput) && (
        <OutputBlock command={command} output={showOutput ? output : ''} />
      )}
      {images.length > 0 && <ImageThumbs images={images} />}
    </div>
  )
}

/** A shell call's `$ command` and its output, or any tool's output, held to
 *  OUTPUT_LINES until asked for the rest. */
function OutputBlock({ command, output }: { command: string | null; output: string }): JSX.Element {
  const [all, setAll] = useState(false)
  const lines = output === '' ? [] : output.split('\n')
  const hidden = all ? 0 : Math.max(0, lines.length - OUTPUT_LINES)
  const shown = hidden > 0 ? lines.slice(0, OUTPUT_LINES).join('\n') : output
  return (
    <div className="tr-output">
      {command !== null && (
        <div className="tr-output-command">
          <span className="tr-output-prompt">$</span>
          <span>{command}</span>
        </div>
      )}
      {shown !== '' && <pre className="tr-output-text">{shown}</pre>}
      {hidden > 0 && (
        <button type="button" className="tr-more" onClick={() => setAll(true)}>
          Show {hidden} more line{hidden === 1 ? '' : 's'}
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

/** Diff lines drawn before "Show all": enough for any edit worth reading in
 *  place, few enough that a rewritten file can't stall the transcript. */
const MAX_DIFF_LINES = 400

function DiffView({ diff }: { diff: ToolDiff }): JSX.Element {
  const [all, setAll] = useState(false)
  const unified = diffOf(diff)
  const total = diffLineCount(unified)
  let budget = all ? Infinity : MAX_DIFF_LINES
  const created = diff.oldText === null

  return (
    <div className="tr-diff">
      <div className="tr-diff-head">
        <span className="tr-diff-path" title={diff.path}>
          {shortPath(diff.path)}
        </span>
        {created && <span className="tr-diff-tag">New file</span>}
        <DiffStatLabel added={unified.added} removed={unified.removed} />
      </div>
      <div className="tr-diff-body" role="group" aria-label={`Changes to ${shortPath(diff.path)}`}>
        <div className="tr-diff-rows">
        {unified.hunks.length === 0 && <div className="tr-diff-empty">No changes</div>}
        {unified.hunks.map((hunk, h) => {
          if (budget <= 0) return null
          const lines = hunk.lines.slice(0, budget)
          budget -= lines.length
          return (
            <div className="tr-hunk" key={h}>
              {h > 0 && (
                <div className="tr-hunk-gap">
                  @@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
                </div>
              )}
              {lines.map((line, i) => (
                <DiffRow key={i} line={line} />
              ))}
            </div>
          )
        })}
        </div>
      </div>
      {!all && total > MAX_DIFF_LINES && (
        <button type="button" className="tr-more" onClick={() => setAll(true)}>
          Show all {total} lines
        </button>
      )}
    </div>
  )
}

function DiffRow({ line }: { line: DiffLine }): JSX.Element {
  const sign = line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '
  return (
    <div className={`tr-diff-line tr-diff-line--${line.kind}`}>
      <span className="tr-diff-no" aria-hidden="true">
        {line.oldNo ?? ''}
      </span>
      <span className="tr-diff-no" aria-hidden="true">
        {line.newNo ?? ''}
      </span>
      <span className="tr-diff-sign" aria-hidden="true">
        {sign}
      </span>
      {/* The colour and sign are visual; a screen reader hears the word. */}
      {line.kind !== 'context' && (
        <span className="tr-sr">{line.kind === 'added' ? 'Added: ' : 'Removed: '}</span>
      )}
      <span className="tr-diff-text">
        {line.text === '' ? ' ' : line.text}
        {line.noNewline && line.kind !== 'context' && (
          <span className="tr-diff-eof"> No newline at end of file</span>
        )}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Images a tool returned
// ---------------------------------------------------------------------------

function ImageThumbs({ images }: { images: ACPToolImage[] }): JSX.Element {
  const [open, setOpen] = useState<number | null>(null)
  const src = (img: ACPToolImage): string => `data:${img.mimeType};base64,${img.data}`
  return (
    <div className="tr-thumbs">
      {images.map((img, i) => (
        <button
          type="button"
          className="tr-thumb"
          key={i}
          onClick={() => setOpen(i)}
          title="Open full size"
        >
          <img src={src(img)} alt={`Image ${i + 1} from the tool`} />
        </button>
      ))}
      {open !== null &&
        images[open] &&
        createPortal(
          <div
            className="tr-lightbox"
            role="dialog"
            aria-label="Image"
            tabIndex={-1}
            ref={(el) => el?.focus()}
            onClick={() => setOpen(null)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setOpen(null)
              }
            }}
          >
            <img src={src(images[open])} alt={`Image ${open + 1} from the tool, full size`} />
          </div>,
          document.body
        )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-agent calls
// ---------------------------------------------------------------------------

/**
 * A delegation: another agent was handed a task. A neutral card with a thin
 * rail in the agent colour, headed "Agent · <name>" with the task on one
 * muted line; opening it lists the tools that agent ran and the summary it
 * reported back.
 */
export function SubAgentCallView({
  tool,
  call,
  children
}: {
  tool: ToolCallItem
  call: SubAgentCall
  /** The sub-agent's own tool calls, when the caller has folded them in
   *  (ChatView does the grouping); they render above the summary. */
  children?: ToolCallItem[]
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const awaiting = useAwaitingApproval(tool.id)
  const result = subAgentResult(tool)
  const failed = tool.status === 'failed' || result?.status === 'error'
  const hasSummary = result !== null && result.summary !== ''
  const nested = children ?? []
  const hasBody = hasSummary || nested.length > 0
  const hasTask = call.task != null && call.task !== ''

  return (
    <div className={`tr-agent${expanded ? ' tr-agent--expanded' : ''}`}>
      <button
        className="tr-agent-header"
        type="button"
        title={tool.title}
        aria-expanded={hasBody ? expanded : undefined}
        onClick={() => {
          if (hasBody) setExpanded((e) => !e)
        }}
      >
        <ToolStatusGlyph status={failed ? 'failed' : tool.status} awaiting={awaiting} />
        <span className="tr-agent-main">
          <span className="tr-agent-titlerow">
            <span className="tr-agent-kind">Agent</span>
            <span className="tr-agent-sep" aria-hidden="true">
              ·
            </span>
            <span className="tr-agent-name">{call.agent}</span>
            {nested.length > 0 && (
              <span className="tr-agent-count">
                {nested.length} tool call{nested.length === 1 ? '' : 's'}
              </span>
            )}
          </span>
          {hasTask && (
            <span className={`tr-agent-task${expanded ? '' : ' tr-agent-task--clamped'}`}>
              {call.task}
            </span>
          )}
        </span>
        {hasBody && (
          <span className={`tr-chevron${expanded ? ' tr-chevron--open' : ''}`}>
            <Icon name="chevron.right" size={8} />
          </span>
        )}
      </button>
      {expanded && hasBody && (
        <div className="tr-agent-body">
          {nested.length > 0 && (
            <div className="tr-agent-tools">
              {nested.map((child) => (
                <ToolRow key={child.id} tool={child} />
              ))}
            </div>
          )}
          {hasSummary && (
            <div className="tr-agent-summary">
              <MarkdownText source={result.summary} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// The icon registry moved to design/icons.tsx; re-exported so the many views
// that import it from here keep working.
export { Icon, type IconName } from '@renderer/design/icons'

// The workflow studio: write a workflow, find out whether it compiles, run it,
// watch it, keep it.
//
// Until the CLI grew `_spettro/workflow/*` none of that was reachable from a
// GUI. A workflow could only be run by typing "/workflows run <name>" into the
// composer and hoping the name was right — you could not see what a repo had,
// read a script, or learn about a typo before a model had already spent a turn
// discovering it. This screen is what that surface was added for.
//
// Three decisions shape it:
//
//   * Scripts are saved into the repo, at <project>/.spettro/workflows, not
//     into app storage. A workflow automates a codebase, so it belongs beside
//     that codebase — versioned with it, and picked up by the TUI and by
//     whoever clones the project next. The app never invents the path; the CLI
//     derives it from the chat's session.
//   * Runs happen in a scratch chat. Iterating on a script means running it
//     repeatedly and throwing most of the results away, which is not something
//     to do to somebody's conversation.
//   * Validation is continuous and never blocking. An editor that only checks
//     on save teaches you about your typo at the worst moment; one that treats
//     a mid-keystroke script as an error is just noise. So the compile runs
//     debounced, and "does not compile yet" is a quiet state, not an alarm.
//
// Closing with unsaved edits (Escape, the close button) asks "Save changes?",
// and deleting a workflow asks first — it's a file in the repo.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type {
  WorkflowInfo,
  WorkflowList,
  WorkflowScope,
  WorkflowValidation
} from '@shared/extensions'
import { EMPTY_WORKFLOW_LIST } from '@shared/extensions'
import { humanizeError } from '@shared/humanize'
import { call, quietCall, useChat } from '@renderer/state/store'
import { confirmDialog } from '@renderer/views/common/ConfirmDialog'
import { askToSave, mayClose, useCloseGuard } from '@renderer/views/common/closeGuard'
import { groupTranscript } from '@renderer/views/chat/transcript/orchestration'
import { groupToolRuns } from '@renderer/views/chat/transcript/toolGroups'
import { TranscriptRowView } from '@renderer/views/chat/transcript/TranscriptItemView'
import { Icon } from '@renderer/views/chat/transcript/ToolCallView'
import { SpettroSpinner } from '@renderer/views/chat/transcript/RunTicker'
import Popover from '@renderer/views/common/Popover'
import { basename } from '@renderer/views/shell/util'
import ScriptEditor from './ScriptEditor'
import './workflows.css'

/** How long the editor sits still before the script is compiled. Long enough
 *  that typing a word does not fire three times, short enough that the verdict
 *  feels attached to what you just typed. */
const VALIDATE_DEBOUNCE_MS = 400

const STARTER_SCRIPT = `export const meta = {
  name: 'new-workflow',
  description: 'What this workflow is for',
  phases: [{ title: 'Work', detail: 'one agent per unit' }],
}

phase('Work')
const items = ['first', 'second']
const results = await parallel(
  items.map((item) => () => agent(\`Do the thing for \${item}\`, { label: item }))
)
return results
`

/** An unsaved draft has no name on disk yet; this is what the list calls it. */
const DRAFT = '(new workflow)'

interface Draft {
  /** The saved name this draft came from, or '' for a brand-new script. */
  name: string
  scope: WorkflowScope
  script: string
  dirty: boolean
}

export default function WorkflowStudio({
  chatId,
  onClose
}: {
  chatId: string
  onClose: () => void
}): JSX.Element {
  const [list, setList] = useState<WorkflowList>(EMPTY_WORKFLOW_LIST)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [validation, setValidation] = useState<WorkflowValidation | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [runChatId, setRunChatId] = useState<string | null>(null)
  // Set when the CLI is too old to serve `_spettro/workflow/*` at all. That is
  // a different thing from "this project has no workflows", and showing the
  // empty state for it would invite the user to write one into a CLI that
  // cannot save it.
  const [unsupported, setUnsupported] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setList(await quietCall('workflowList', chatId))
      setUnsupported(null)
    } catch (err) {
      const message = messageOf(err)
      if (isUnsupported(message)) setUnsupported(message)
      else setError(message)
    }
  }, [chatId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // The scratch chat outlives this component only by accident, so it is torn
  // down on unmount — closing the studio must not leave a fan-out running
  // against a session nobody is watching.
  const runRef = useRef<string | null>(null)
  runRef.current = runChatId
  useEffect(
    () => () => {
      if (runRef.current) void call('workflowDiscardRun', runRef.current)
    },
    []
  )

  // Compile whatever is in the editor, debounced. The request is fired against
  // a captured script and its result discarded if the text moved on, so a slow
  // round trip can never overwrite the verdict for newer text.
  const script = draft?.script ?? null
  useEffect(() => {
    if (script === null) {
      setValidation(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void quietCall('workflowValidate', chatId, script)
        .then((result) => {
          if (!cancelled) setValidation(result)
        })
        .catch(() => undefined)
    }, VALIDATE_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [script, chatId])

  const open = useCallback(
    async (info: WorkflowInfo) => {
      // Opening another one replaces the draft: unsaved edits are asked about
      // first, exactly as closing would.
      if (!(await mayClose('workflows'))) return
      setError(null)
      setBusy(`Opening ${info.name}…`)
      try {
        const source = await call('workflowRead', chatId, info.name)
        if (source) {
          setDraft({ name: source.name, scope: source.scope, script: source.script, dirty: false })
        }
      } finally {
        setBusy(null)
      }
    },
    [chatId]
  )

  const newDraft = useCallback(async () => {
    if (!(await mayClose('workflows'))) return
    setError(null)
    setDraft({ name: '', scope: 'project', script: STARTER_SCRIPT, dirty: true })
  }, [])

  /** Resolves true once the draft is on disk (false: it isn't, and why is
   *  on screen), so "Save changes?" knows whether closing is safe. */
  const save = useCallback(async (): Promise<boolean> => {
    if (!draft) return true
    // The header's own name is the default, so a script you have only ever
    // named inside meta does not need naming twice.
    const name = draft.name || validation?.name || ''
    if (name === '') {
      setError('Give the workflow a name — in meta.name, or by saving it as one.')
      return false
    }
    setError(null)
    setBusy(`Saving ${name}…`)
    try {
      const saved = await quietCall('workflowWrite', chatId, name, draft.scope, draft.script)
      if (saved) {
        setDraft({ name: saved.name, scope: saved.scope, script: draft.script, dirty: false })
        await refresh()
        return true
      }
      return false
    } catch (err) {
      setError(messageOf(err))
      return false
    } finally {
      setBusy(null)
    }
  }, [chatId, draft, validation, refresh])

  // Escape (App) and the close button both ask before edits are lost.
  useCloseGuard('workflows', async () =>
    draft?.dirty ? askToSave(`“${draft.name || validation?.name || 'the new workflow'}”`, save) : true
  )
  const close = async (): Promise<void> => {
    if (await mayClose('workflows')) onClose()
  }

  const remove = useCallback(
    async (info: WorkflowInfo) => {
      const answer = await confirmDialog({
        title: `Delete the workflow “${info.name}”?`,
        message:
          info.scope === 'global'
            ? 'It’s removed from every project on this computer.'
            : 'Its file is removed from this project.',
        confirmLabel: 'Delete',
        destructive: true
      })
      if (answer !== 'confirm') return
      setError(null)
      setBusy(`Deleting ${info.name}…`)
      try {
        await quietCall('workflowDelete', chatId, info.name, info.scope)
        if (draft?.name === info.name) setDraft(null)
        await refresh()
      } catch (err) {
        setError(messageOf(err))
      } finally {
        setBusy(null)
      }
    },
    [chatId, draft, refresh]
  )

  // Running executes what is on disk, so an edited script is saved first —
  // otherwise "Run" would quietly test the previous version and the result
  // would be about code the user is no longer looking at.
  const run = useCallback(async () => {
    if (!draft) return
    setError(null)
    const name = draft.name || validation?.name || ''
    if (name === '') {
      setError('Save the workflow before running it.')
      return
    }
    if (draft.dirty) {
      setBusy('Saving before the run…')
      try {
        await quietCall('workflowWrite', chatId, name, draft.scope, draft.script)
        setDraft({ ...draft, name, dirty: false })
        await refresh()
      } catch (err) {
        setError(messageOf(err))
        setBusy(null)
        return
      }
    }
    setBusy(null)
    if (runChatId) await call('workflowDiscardRun', runChatId)
    setRunChatId(await call('workflowRun', chatId, name))
  }, [chatId, draft, validation, runChatId, refresh])

  const canRun = draft !== null && validation?.ok === true && busy === null

  if (unsupported !== null) {
    return (
      <div className="wfs">
        <header className="wfs-head">
          <Icon name="flowchart" size={15} />
          <h2>Workflows</h2>
          <span className="wfs-spacer" />
          <button type="button" className="btn btn--prominent" onClick={() => void close()}>
            Done
          </button>
        </header>
        <div className="wfs-body">
          <section className="wfs-main wfs-main--empty">
            <Icon name="arrow.counterclockwise" size={34} />
            <h3>The CLI is too old for this</h3>
            <p>{unsupported}</p>
            <p className="wfs-paths">
              Workflow authoring needs Spettro CLI extensions v4. Settings &rsaquo; Updates will
              bring it up to date.
            </p>
          </section>
        </div>
      </div>
    )
  }

  return (
    <div className="wfs">
      <header className="wfs-head">
        <Icon name="flowchart" size={15} />
        <h2>Workflows</h2>
        {/* The project by name, as the sidebar says it; the path is a hover
            away for whoever needs it. */}
        {list.cwd !== '' && (
          <span className="wfs-cwd" title={list.cwd}>
            {basename(list.cwd)}
          </span>
        )}
        <span className="wfs-spacer" />
        {busy && (
          <span className="wfs-busy">
            <SpettroSpinner size={11} /> {busy}
          </span>
        )}
        <button type="button" className="btn btn--prominent" onClick={() => void close()}>
          Done
        </button>
      </header>

      <div className="wfs-body">
        <WorkflowList
          list={list}
          draft={draft}
          onOpen={open}
          onNew={() => void newDraft()}
          onDelete={remove}
        />

        {draft === null ? (
          <EmptyState searchPaths={list.searchPaths} />
        ) : (
          <section className="wfs-main">
            <EditorHeader
              draft={draft}
              validation={validation}
              canRun={canRun}
              onScope={(scope) => setDraft({ ...draft, scope, dirty: true })}
              onSave={save}
              onRun={run}
            />
            {error && (
              <div className="wfs-error" role="alert">
                {error}
              </div>
            )}
            <ScriptEditor
              value={draft.script}
              onChange={(script) => setDraft({ ...draft, script, dirty: true })}
            />
            <Verdict validation={validation} />
            {runChatId && <RunPane chatId={runChatId} />}
          </section>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

function WorkflowList({
  list,
  draft,
  onOpen,
  onNew,
  onDelete
}: {
  list: WorkflowList
  draft: Draft | null
  onOpen: (info: WorkflowInfo) => void
  onNew: () => void
  onDelete: (info: WorkflowInfo) => void
}): JSX.Element {
  return (
    <aside className="wfs-list">
      <button className="btn wfs-new" type="button" onClick={onNew}>
        <Icon name="plus" size={11} />
        New workflow
      </button>
      {draft !== null && draft.name === '' && (
        <div className="wfs-row wfs-row--active wfs-row--draft">
          <span className="wfs-row-name">{DRAFT}</span>
        </div>
      )}
      {list.workflows.map((info) => (
        <div
          key={`${info.scope}:${info.name}`}
          className={'wfs-row' + (draft?.name === info.name ? ' wfs-row--active' : '')}
        >
          <button className="wfs-row-open" type="button" onClick={() => onOpen(info)}>
            <span className="wfs-row-name">{info.name}</span>
            {info.scope === 'global' && <span className="wfs-pill">All projects</span>}
            {/* A script that does not compile is still listed — hiding it just
                moves the discovery to whoever runs it next. */}
            {info.error && (
              <span className="wfs-pill wfs-pill--bad" title={info.error}>
                Broken
              </span>
            )}
            {info.description && <span className="wfs-row-desc">{info.description}</span>}
            {info.phases.length > 0 && (
              <span className="wfs-row-phases">
                {info.phases.map((p) => p.title).join(' → ')}
              </span>
            )}
          </button>
          <button
            className="wfs-row-delete"
            type="button"
            title={`Delete ${info.name}`}
            aria-label={`Delete ${info.name}`}
            onClick={() => onDelete(info)}
          >
            <Icon name="trash" size={12} />
          </button>
        </div>
      ))}
      {list.workflows.length === 0 && draft === null && (
        <p className="wfs-list-empty">No saved workflows in this project yet.</p>
      )}
    </aside>
  )
}

/** Nothing open. It explains rather than offers: "New workflow" is already
 *  at the top of the list, and two of the same button on one screen asks the
 *  reader which one to press. */
function EmptyState({ searchPaths }: { searchPaths: string[] }): JSX.Element {
  return (
    <section className="wfs-main wfs-main--empty">
      <Icon name="flowchart" size={40} />
      <h3>Write a workflow</h3>
      <p>
        A workflow is a saved recipe that runs several agents in a fixed order — the same steps
        every time, for jobs too big for one.
      </p>
      {searchPaths.length > 0 && (
        <p className="wfs-paths" title={searchPaths[0]}>
          Saved in this project&rsquo;s <code>.spettro/workflows</code> folder, so it&rsquo;s
          versioned with the code.
        </p>
      )}
      <p className="wfs-paths">Choose one on the left, or start a new one there.</p>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Editor chrome
// ---------------------------------------------------------------------------

function EditorHeader({
  draft,
  validation,
  canRun,
  onScope,
  onSave,
  onRun
}: {
  draft: Draft
  validation: WorkflowValidation | null
  canRun: boolean
  onScope: (scope: WorkflowScope) => void
  onSave: () => void
  onRun: () => void
}): JSX.Element {
  const name = draft.name || validation?.name || DRAFT
  return (
    <div className="wfs-editor-head">
      <span className="wfs-editor-name">{name}</span>
      {draft.dirty && <span className="wfs-pill">Unsaved</span>}
      <span className="wfs-spacer" />
      <ScopeMenu scope={draft.scope} onScope={onScope} />
      <button className="wfs-btn" type="button" onClick={onSave} disabled={!draft.dirty}>
        Save
      </button>
      <button
        className="wfs-btn wfs-btn--primary"
        type="button"
        onClick={onRun}
        disabled={!canRun}
        title={canRun ? 'Run in a scratch session' : 'The script has to compile first'}
      >
        Run
      </button>
    </div>
  )
}

const SCOPES: { value: WorkflowScope; name: string; description: string }[] = [
  { value: 'project', name: 'This project', description: 'Saved with the code, for everyone who works on it' },
  { value: 'global', name: 'Every project', description: 'Saved on this computer, for all your projects' }
]

/** Where Save puts the script, as the composer's chips choose things: a
 *  button naming the choice, and a menu that says what each one means. */
function ScopeMenu({
  scope,
  onScope
}: {
  scope: WorkflowScope
  onScope: (scope: WorkflowScope) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => setOpen(false), [])
  const current = SCOPES.find((s) => s.value === scope) ?? SCOPES[0]
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="wfs-scope"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Save to {current.name.toLowerCase()}
        <Icon name="chevron.down" size={8} />
      </button>
      <Popover anchorRef={anchorRef} open={open} onClose={close} align="end" className="config-menu">
        <div className="config-menu-group" role="menu" aria-label="Save to">
          {SCOPES.map((choice) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={choice.value === scope}
              key={choice.value}
              className="config-menu-row"
              onClick={() => {
                setOpen(false)
                if (choice.value !== scope) onScope(choice.value)
              }}
            >
              <span className="config-menu-check">
                {choice.value === scope && <Icon name="checkmark" size={12} />}
              </span>
              <span className="config-menu-texts">
                <span className="config-menu-name">{choice.name}</span>
                <span className="config-menu-description">{choice.description}</span>
              </span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  )
}

/** The compile verdict. A script that does not compile *yet* is the normal
 *  state of an editor with a cursor in it, so this stays quiet until there is
 *  something to say, and says it without shouting. */
function Verdict({ validation }: { validation: WorkflowValidation | null }): JSX.Element | null {
  if (validation === null) return null
  if (!validation.ok) {
    return (
      <div className="wfs-verdict wfs-verdict--bad">
        <Icon name="exclamationmark.triangle.fill" size={11} />
        <span>{validation.error ?? 'This script does not compile yet.'}</span>
      </div>
    )
  }
  return (
    <div className="wfs-verdict">
      <span className="tr-status-dot" />
      <span className="wfs-verdict-name">{validation.name || 'unnamed'}</span>
      {validation.description && <span>{validation.description}</span>}
      {validation.phases.length > 0 && (
        <span className="wfs-verdict-phases">
          {validation.phases.map((p) => p.title).join(' → ')}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** The scratch chat's transcript, folded exactly the way the real one is — so
 *  a test run draws the same phase tree, from the same code, as a run started
 *  from the composer. */
function RunPane({ chatId }: { chatId: string }): JSX.Element {
  const chat = useChat(chatId)
  const items = chat?.items
  const rows = useMemo(() => (items ? groupToolRuns(groupTranscript(items)) : []), [items])
  return (
    <section className="wfs-run">
      <header className="wfs-run-head">
        <span>Test run</span>
        {chat?.isBusy && <SpettroSpinner size={11} />}
        <span className="wfs-spacer" />
        <button className="wfs-btn" type="button" onClick={() => void call('cancel', chatId)}>
          Stop
        </button>
      </header>
      <div className="wfs-run-body">
        {rows.map((row) => (
          <TranscriptRowView row={row} key={row.id} />
        ))}
      </div>
    </section>
  )
}

function messageOf(err: unknown): string {
  const human = humanizeError(err)
  // The unsupported check reads the raw text, so it is kept for that.
  if (isUnsupported(human.raw)) return human.raw
  return human.known ? `${human.title}. ${human.detail}` : human.detail
}

/** The main process raises UnsupportedExtensionError when the CLI answers a
 *  `_spettro/*` call with "method not found". Electron flattens errors across
 *  the IPC boundary to their message, so the name is matched in the text —
 *  ugly, but the alternative is a second error channel for one case. */
function isUnsupported(message: string): boolean {
  return message.includes('UnsupportedExtensionError') || message.includes("doesn't support")
}

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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type {
  WorkflowInfo,
  WorkflowList,
  WorkflowScope,
  WorkflowValidation
} from '@shared/extensions'
import { EMPTY_WORKFLOW_LIST } from '@shared/extensions'
import { call, useChat } from '@renderer/state/store'
import { groupTranscript } from '@renderer/views/chat/transcript/orchestration'
import { TranscriptRowView } from '@renderer/views/chat/transcript/TranscriptItemView'
import { Icon } from '@renderer/views/chat/transcript/ToolCallView'
import { SpettroSpinner } from '@renderer/views/chat/transcript/RunTicker'
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

  const refresh = useCallback(async () => {
    setList(await call('workflowList', chatId))
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
      void call('workflowValidate', chatId, script).then((result) => {
        if (!cancelled) setValidation(result)
      })
    }, VALIDATE_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [script, chatId])

  const open = useCallback(
    async (info: WorkflowInfo) => {
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

  const newDraft = useCallback(() => {
    setError(null)
    setDraft({ name: '', scope: 'project', script: STARTER_SCRIPT, dirty: true })
  }, [])

  const save = useCallback(async () => {
    if (!draft) return
    // The header's own name is the default, so a script you have only ever
    // named inside meta does not need naming twice.
    const name = draft.name || validation?.name || ''
    if (name === '') {
      setError('Give the workflow a name — in meta.name, or by saving it as one.')
      return
    }
    setError(null)
    setBusy(`Saving ${name}…`)
    try {
      const saved = await call('workflowWrite', chatId, name, draft.scope, draft.script)
      if (saved) {
        setDraft({ name: saved.name, scope: saved.scope, script: draft.script, dirty: false })
        await refresh()
      }
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }, [chatId, draft, validation, refresh])

  const remove = useCallback(
    async (info: WorkflowInfo) => {
      setError(null)
      setBusy(`Deleting ${info.name}…`)
      try {
        await call('workflowDelete', chatId, info.name, info.scope)
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
        await call('workflowWrite', chatId, name, draft.scope, draft.script)
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

  return (
    <div className="wfs">
      <header className="wfs-head">
        <Icon name="flowchart" size={15} />
        <h2>Workflows</h2>
        <span className="wfs-cwd" title={list.cwd}>
          {list.cwd}
        </span>
        <span className="wfs-spacer" />
        {busy && (
          <span className="wfs-busy">
            <SpettroSpinner size={11} /> {busy}
          </span>
        )}
        <button className="icon-btn" onClick={onClose} title="Close" aria-label="Close workflows">
          <Icon name="xmark.circle.fill" size={15} />
        </button>
      </header>

      <div className="wfs-body">
        <WorkflowList
          list={list}
          draft={draft}
          onOpen={open}
          onNew={newDraft}
          onDelete={remove}
        />

        {draft === null ? (
          <EmptyState searchPaths={list.searchPaths} onNew={newDraft} />
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
      <button className="wfs-new" type="button" onClick={onNew}>
        + New workflow
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
            {info.scope === 'global' && <span className="wfs-pill">global</span>}
            {/* A script that does not compile is still listed — hiding it just
                moves the discovery to whoever runs it next. */}
            {info.error && (
              <span className="wfs-pill wfs-pill--bad" title={info.error}>
                broken
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

function EmptyState({
  searchPaths,
  onNew
}: {
  searchPaths: string[]
  onNew: () => void
}): JSX.Element {
  return (
    <section className="wfs-main wfs-main--empty">
      <Icon name="flowchart" size={40} />
      <h3>Write a workflow</h3>
      <p>
        A workflow decides in ordinary control flow — not by asking a model — which sub-agents run,
        in what order, and how their results combine.
      </p>
      {searchPaths.length > 0 && (
        <p className="wfs-paths">
          Saved to <code>{searchPaths[0]}</code>, so it is versioned with the project.
        </p>
      )}
      <button className="wfs-new" type="button" onClick={onNew}>
        + New workflow
      </button>
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
      {draft.dirty && <span className="wfs-pill">unsaved</span>}
      <span className="wfs-spacer" />
      <label className="wfs-scope">
        <span>Save to</span>
        <select
          value={draft.scope}
          onChange={(e) => onScope(e.target.value as WorkflowScope)}
        >
          <option value="project">this project</option>
          <option value="global">every project</option>
        </select>
      </label>
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
  const rows = useMemo(() => (items ? groupTranscript(items) : []), [items])
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
  if (err instanceof Error) return err.message
  return String(err)
}

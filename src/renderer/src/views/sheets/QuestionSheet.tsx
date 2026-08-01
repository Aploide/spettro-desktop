// Port of Spettro/Views/QuestionSheet.swift (doc 33-question-sheet.md).
// The ask-user form: up to four related questions the agent puts to the user
// together, each single- or multi-select, each optionally taking the user's
// own words. One page per question with its own selection, free text and
// note, a tab strip across the top, and a review page that sends the form.
//
// Nothing is preselected — the recommended option is marked, never chosen for
// the user. Questions left alone are simply absent from the reply.
//
// Desktop layout note: where the Mac sheet expands an option's preview under
// its row, here previews get a persistent pane on the right (mono box) that
// tracks the focused/hovered option — same content, side-by-side.
//
// Keyboard: Enter -> primary action (Next / Review / Send answers),
// Esc -> Decline. Ported from .defaultAction / .cancelAction.

import { useEffect, useRef, useState } from 'react'
import type { ACPQuestion, ACPQuestionAnswer, ACPQuestionOption, ACPQuestionRequest } from '@shared/acp'
import { call } from '@renderer/state/store'
import './sheets.css'

interface Draft {
  selected: string[]
  custom: string
  note: string
  noteVisible: boolean
  /** Option whose preview the right-hand pane shows (hover/selection). */
  focused: string | null
}

function makeDrafts(request: ACPQuestionRequest): Draft[] {
  return request.questions.map(() => ({
    selected: [],
    custom: '',
    note: '',
    noteVisible: false,
    focused: null
  }))
}

function answered(draft: Draft): boolean {
  return draft.selected.length > 0 || draft.custom.trim().length > 0
}

/** One ACPQuestionAnswer per ANSWERED question; skipped questions are absent.
 *  Selections come out in option order, never the order they were ticked, so
 *  the same set of boxes always produces the same answer. */
function buildAnswers(questions: ACPQuestion[], drafts: Draft[]): ACPQuestionAnswer[] {
  const out: ACPQuestionAnswer[] = []
  questions.forEach((question, index) => {
    const draft = drafts[index]
    const optionIds = question.options.filter((o) => draft.selected.includes(o.id)).map((o) => o.id)
    const custom = draft.custom.trim()
    if (optionIds.length === 0 && custom.length === 0) return // unanswered — omitted
    const note = draft.note.trim()
    if (optionIds.length > 0) {
      // kind is "option" whenever anything was picked. The desktop DTO has no
      // text field beside a selection, so words typed next to a multi-select
      // choice travel in notes (single-select custom text replaces the pick).
      const notes = [custom, note].filter((s) => s.length > 0).join('\n')
      out.push({
        questionId: question.id,
        kind: 'option',
        optionId: optionIds.length === 1 ? optionIds[0] : undefined,
        optionIds,
        notes: notes.length > 0 ? notes : undefined
      })
    } else {
      out.push({
        questionId: question.id,
        kind: 'custom',
        text: custom,
        notes: note.length > 0 ? note : undefined
      })
    }
  })
  return out
}

// --- tiny SF Symbol stand-ins -------------------------------------------

const QuestionBubbleIcon = (): JSX.Element => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 12a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-2.9-.36-4.15-1L3.5 20.5l1-4.35A8.5 8.5 0 1 1 21 12z" />
    <path d="M10.2 9.4a2.3 2.3 0 1 1 3.2 2.1c-.8.35-1.15.8-1.15 1.6" />
    <circle cx="12.25" cy="15.9" r="0.4" fill="currentColor" stroke="none" />
  </svg>
)

const CheckCircleIcon = ({ filled }: { filled: boolean }): JSX.Element =>
  filled ? (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.4 14.2L6.8 12.4l1.4-1.4 2.4 2.4 5.2-5.2 1.4 1.4-6.6 6.6z" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="9" />
    </svg>
  )

const RadioIcon = ({ selected }: { selected: boolean }): JSX.Element =>
  selected ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="9" />
    </svg>
  )

const CheckboxIcon = ({ selected }: { selected: boolean }): JSX.Element =>
  selected ? (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm5.6 13.2l6.6-6.6-1.4-1.4-5.2 5.2-2.4-2.4-1.4 1.4 3.8 3.8z" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  )

const PaperplaneIcon = (): JSX.Element => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 3L10.5 13.5M21 3l-6.8 18-3.7-7.5L3 9.8 21 3z" />
  </svg>
)

const ChevronRightIcon = (): JSX.Element => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 5l7 7-7 7" />
  </svg>
)

const WarningIcon = (): JSX.Element => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3L1.8 20.2h20.4L12 3z" />
    <path d="M12 10v4.5" />
    <circle cx="12" cy="17.4" r="0.4" fill="currentColor" stroke="none" />
  </svg>
)

const NoteIcon = (): JSX.Element => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-2.9-.36-4.15-1L3.5 20l1-4.35A8.5 8.5 0 1 1 21 11.5z" />
    <path d="M8 10h8M8 13.5h5" />
  </svg>
)

// ------------------------------------------------------------------------

export default function QuestionSheet({ request }: { request: ACPQuestionRequest }): JSX.Element {
  const [drafts, setDrafts] = useState<Draft[]>(() => makeDrafts(request))
  /** The active tab; `questions.length` is the review page. */
  const [tab, setTab] = useState(0)
  const doneRef = useRef<string | null>(null)

  const questions = request.questions
  const count = questions.length

  // A new queue head gets a fresh form (the parent renders the first pending).
  useEffect(() => {
    setDrafts(makeDrafts(request))
    setTab(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.id])

  const isReviewing = tab >= count
  const hasAnyAnswer = drafts.some(answered)
  const isComplete = drafts.every(answered)
  /** The last page's action is to send; every earlier one moves forward. */
  const isSubmitting = isReviewing || count === 1
  /** A form of one single-select question answers itself on pick. */
  const isSinglePage = count === 1 && !questions[0].multiSelect

  const deliver = (answers: ACPQuestionAnswer[] | null): void => {
    if (doneRef.current === request.id) return
    doneRef.current = request.id
    void call('answerQuestion', request.id, answers)
  }

  const submit = (fromDrafts: Draft[] = drafts): void => {
    deliver(buildAnswers(questions, fromDrafts))
  }

  const decline = (): void => deliver(null)

  const primaryTitle = isSubmitting ? 'Send answers' : tab === count - 1 ? 'Review' : 'Next'
  const primaryDisabled = isSubmitting && !hasAnyAnswer

  const primaryAction = (): void => {
    if (isSubmitting) {
      if (hasAnyAnswer) submit()
    } else {
      setTab(tab + 1)
    }
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        decline()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        primaryAction()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const patchDraft = (index: number, patch: Partial<Draft>): void => {
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)))
  }

  const choose = (option: ACPQuestionOption, index: number, multiSelect: boolean): void => {
    if (multiSelect) {
      const current = drafts[index]
      const selected = current.selected.includes(option.id)
        ? current.selected.filter((id) => id !== option.id)
        : [...current.selected, option.id]
      patchDraft(index, { selected, focused: option.id })
      return
    }
    const next = drafts.map((d, i) =>
      i === index ? { ...d, selected: [option.id], custom: '', focused: option.id } : d
    )
    setDrafts(next)
    // Picking the answer to the only single-select question submits — unless
    // a note is open: someone writing one has more to say.
    if (isSinglePage && !drafts[index].noteVisible) submit(next)
  }

  const setCustom = (index: number, text: string): void => {
    // On a single-select question the user's own words replace the pick
    // rather than sitting beside it.
    const clears = text.trim().length > 0 && !questions[index].multiSelect
    patchDraft(index, clears ? { custom: text, selected: [] } : { custom: text })
  }

  const summary = (index: number): string | null => {
    const draft = drafts[index]
    const parts = questions[index].options
      .filter((o) => draft.selected.includes(o.id))
      .map((o) => o.label)
    const custom = draft.custom.trim()
    if (custom.length > 0) parts.push(`“${custom}”`)
    return parts.length > 0 ? parts.join(', ') : null
  }

  // --- render helpers ----------------------------------------------------

  const renderQuestion = (index: number): JSX.Element => {
    const question = questions[index]
    const draft = drafts[index]
    const previewOptions = question.options.filter((o) => o.preview !== undefined && o.preview !== null)
    const hasPreviews = previewOptions.length > 0
    // The pane follows the focused option, falling back to the selection,
    // then the first option that has a preview at all.
    const focusedOption =
      (draft.focused !== null ? question.options.find((o) => o.id === draft.focused) : undefined) ??
      question.options.find((o) => draft.selected.includes(o.id)) ??
      previewOptions[0]

    const optionList = (
      <div className="qs-options">
        {question.options.map((option) => {
          const isSelected = draft.selected.includes(option.id)
          return (
            <button
              key={option.id}
              className={`qs-option ${isSelected ? 'qs-option--selected' : ''}`}
              onClick={() => choose(option, index, question.multiSelect)}
              onMouseEnter={() => patchDraft(index, { focused: option.id })}
            >
              {question.multiSelect ? <CheckboxIcon selected={isSelected} /> : <RadioIcon selected={isSelected} />}
              <span>
                <span className="qs-option-label">
                  {option.label}
                  {option.isRecommended === true && <span className="qs-badge">Recommended</span>}
                </span>
                {option.description !== undefined && <span className="qs-option-desc" style={{ display: 'block' }}>{option.description}</span>}
              </span>
            </button>
          )
        })}
      </div>
    )

    return (
      <div className="qs-page">
        {question.question.length > 0 && <div className="qs-question">{question.question}</div>}
        {question.multiSelect && <div className="qs-caption">Pick as many as apply.</div>}

        {hasPreviews ? (
          <div className="qs-split">
            {optionList}
            <div className="qs-preview-pane">
              {focusedOption !== undefined && focusedOption.preview !== undefined ? (
                <>
                  <div className="qs-preview-title">{focusedOption.label}</div>
                  <pre className="mono">{focusedOption.preview}</pre>
                </>
              ) : (
                <div className="qs-preview-empty">No preview for this option.</div>
              )}
            </div>
          </div>
        ) : (
          optionList
        )}

        {question.allowCustomInput && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-xs)' }}>
            {question.options.length > 0 && <span className="qs-field-label">Or answer in your own words</span>}
            <input
              className="qs-input"
              type="text"
              placeholder="Type your own answer"
              value={draft.custom}
              onChange={(e) => setCustom(index, e.target.value)}
            />
          </div>
        )}

        {draft.noteVisible ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-xs)' }}>
            <span className="qs-field-label">Note (sent alongside your answer)</span>
            <input
              className="qs-input"
              type="text"
              placeholder="Anything the agent should know about this answer"
              value={draft.note}
              onChange={(e) => patchDraft(index, { note: e.target.value })}
            />
          </div>
        ) : (
          <button className="qs-add-note" onClick={() => patchDraft(index, { noteVisible: true })}>
            <NoteIcon /> Add a note
          </button>
        )}
      </div>
    )
  }

  const renderReview = (): JSX.Element => (
    <div className="qs-page">
      <div className="qs-question">Review your answers</div>
      {questions.map((question, index) => {
        const s = summary(index)
        const note = drafts[index].note.trim()
        return (
          <button key={question.id} className="qs-review-row" onClick={() => setTab(index)}>
            <span style={{ minWidth: 0 }}>
              <span className="qs-review-header" style={{ display: 'block' }}>{question.header ?? `Question ${index + 1}`}</span>
              {s !== null ? (
                <span className="qs-review-answer" style={{ display: 'block' }}>{s}</span>
              ) : (
                <span className="qs-review-answer qs-review-answer--missing" style={{ display: 'block' }}>Not answered</span>
              )}
              {note.length > 0 && <span className="qs-review-note" style={{ display: 'block' }}>Note: {note}</span>}
            </span>
            <span className="qs-review-chevron"><ChevronRightIcon /></span>
          </button>
        )
      })}
      {!isComplete && (
        <div className="qs-warning">
          <WarningIcon />
          <span>
            Questions you left alone are sent as unanswered — the agent is told nobody answered
            them, not that you had no preference.
          </span>
        </div>
      )}
    </div>
  )

  return (
    <div className="sheet-backdrop" role="presentation">
      <div className="sheet-card sheet-card--question" role="dialog" aria-modal="true" aria-label="Spettro has a question">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-xs)' }}>
          <div className="sheet-header">
            <QuestionBubbleIcon />
            <span className="sheet-headline">
              {count > 1 ? `Spettro has ${count} questions` : 'Spettro has a question'}
            </span>
          </div>
          {request.context !== undefined && <div className="sheet-context">{request.context}</div>}
        </div>

        {count > 1 && (
          <div className="qs-tabstrip">
            {questions.map((question, index) => {
              const done = answered(drafts[index])
              return (
                <button
                  key={question.id}
                  className={`qs-chip ${tab === index ? 'qs-chip--active' : ''} ${done ? 'qs-chip--done' : ''}`}
                  onClick={() => setTab(index)}
                >
                  <CheckCircleIcon filled={done} />
                  {question.header ?? `Question ${index + 1}`}
                </button>
              )
            })}
            <button className={`qs-chip ${isReviewing ? 'qs-chip--active' : ''}`} onClick={() => setTab(count)}>
              <PaperplaneIcon />
              Review
            </button>
          </div>
        )}

        <div className="qs-body">{isReviewing ? renderReview() : renderQuestion(tab)}</div>

        <div className="qs-footer">
          <button className="sheet-btn sheet-btn--subtle" onClick={decline}>
            Decline
          </button>
          <span className="qs-spacer" />
          {count > 1 && (
            <button className="sheet-btn sheet-btn--subtle" disabled={tab === 0} onClick={() => setTab(Math.max(tab - 1, 0))}>
              Back
            </button>
          )}
          <button className="sheet-btn sheet-btn--prominent" disabled={primaryDisabled} onClick={primaryAction}>
            {primaryTitle}
          </button>
        </div>
      </div>
    </div>
  )
}

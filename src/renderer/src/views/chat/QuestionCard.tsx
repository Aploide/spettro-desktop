// The agent's questions, inline above the composer of the chat that asked,
// one at a time ("Question 2 of 3"). Each is a list of large option rows —
// radio or checkbox, a "Recommended" pill, the option's description, and its
// preview behind a disclosure — plus "Other…", which opens a field for the
// user's own words. Workflow consent (header "Workflow", the CLI's "Run it" /
// "Save it, don't run" / "Don't run it") comes through here as well.
//
// Nothing is preselected: the recommended option is marked, never chosen for
// the user, and a question left alone is simply absent from the reply.
//
// Keys follow the approval card's safety catch (promptKeys.ts). In the
// "Other…" field Enter is a newline and Ctrl/Cmd+Enter sends; Esc never
// throws typed answers away without asking.
//
// A question whose chat is unknown shows the same card in a modal sheet
// (`presentation="sheet"`, from App).

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { ACPQuestion, ACPQuestionAnswer, ACPQuestionOption, ACPQuestionRequest } from '@shared/acp'
import { call } from '@renderer/state/store'
import { Icon } from '@renderer/design/icons'
import { withShortcut } from '@renderer/views/shell/util'
import { inComposer, keyIsForCard, keysLive, useActiveElement, useArmed } from './promptKeys'
import './prompts.css'

interface Draft {
  selected: string[]
  /** "Other…" is chosen and its field open. */
  other: boolean
  custom: string
}

const EMPTY: Draft = { selected: [], other: false, custom: '' }

function answered(draft: Draft): boolean {
  return draft.selected.length > 0 || (draft.other && draft.custom.trim() !== '')
}

function touched(draft: Draft): boolean {
  return draft.selected.length > 0 || draft.custom.trim() !== ''
}

/**
 * One answer per answered question; skipped ones are absent. Picks come out
 * in option order, never the order they were ticked. On a multi-select
 * question the user's own words travel beside the picks as notes (the DTO
 * has no text field next to a selection); alone, they are a custom answer.
 */
export function buildAnswers(questions: ACPQuestion[], drafts: Draft[]): ACPQuestionAnswer[] {
  const out: ACPQuestionAnswer[] = []
  questions.forEach((question, index) => {
    const draft = drafts[index] ?? EMPTY
    const optionIds = question.options.filter((o) => draft.selected.includes(o.id)).map((o) => o.id)
    const custom = draft.other ? draft.custom.trim() : ''
    if (optionIds.length > 0) {
      out.push({
        questionId: question.id,
        kind: 'option',
        optionId: optionIds.length === 1 ? optionIds[0] : undefined,
        optionIds,
        notes: custom !== '' ? custom : undefined
      })
    } else if (custom !== '') {
      out.push({ questionId: question.id, kind: 'custom', text: custom })
    }
  })
  return out
}

export interface QuestionCardProps {
  request: ACPQuestionRequest
  /** Where this form stands in the chat's queue. */
  position?: number
  total?: number
  presentation?: 'inline' | 'sheet'
}

export default function QuestionCard({
  request,
  position = 1,
  total = 1,
  presentation = 'inline'
}: QuestionCardProps): JSX.Element {
  const questions = request.questions
  const count = questions.length
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(() => EMPTY))
  const [step, setStep] = useState(0)
  const [previews, setPreviews] = useState<Set<string>>(() => new Set())
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const cardRef = useRef<HTMLElement>(null)
  const otherRef = useRef<HTMLTextAreaElement>(null)
  const { armed, armedRef } = useArmed()
  const active = useActiveElement()
  const doneRef = useRef(false)

  const question = questions[Math.min(step, count - 1)]
  const draft = drafts[step] ?? EMPTY
  const isLast = step >= count - 1
  const anyAnswer = drafts.some(answered)
  const dirty = drafts.some(touched)
  const unanswered = drafts.filter((d) => !answered(d)).length

  const deliver = (answers: ACPQuestionAnswer[] | null): void => {
    if (!armedRef.current || doneRef.current) return
    doneRef.current = true
    void call('answerQuestion', request.id, answers)
  }

  const send = (): void => {
    if (anyAnswer) deliver(buildAnswers(questions, drafts))
  }

  const primary = (): void => {
    if (isLast) send()
    else setStep(step + 1)
  }

  /** Esc: leave at once when there is nothing to lose, ask otherwise. */
  const escape = (): void => {
    if (confirmDiscard) setConfirmDiscard(false)
    else if (dirty) setConfirmDiscard(true)
    else deliver(null)
  }

  /** Updates this step's draft from its latest value, so two quick picks
   *  in one frame both count. */
  const patch = (next: (d: Draft) => Partial<Draft>): void => {
    setDrafts((prev) => prev.map((d, i) => (i === step ? { ...d, ...next(d) } : d)))
  }

  const pick = (option: ACPQuestionOption): void => {
    if (!armedRef.current) return
    if (question.multiSelect) {
      patch((d) => ({
        selected: d.selected.includes(option.id)
          ? d.selected.filter((id) => id !== option.id)
          : [...d.selected, option.id]
      }))
    } else {
      // One answer: a pick replaces the user's own words, and the reverse.
      patch(() => ({ selected: [option.id], other: false }))
    }
  }

  const pickOther = (): void => {
    if (!armedRef.current) return
    if (question.multiSelect) patch((d) => ({ other: !d.other }))
    else patch(() => ({ other: true, selected: [] }))
  }

  // The field opens focused, ready for the words.
  const otherOpen = draft.other
  useEffect(() => {
    if (otherOpen) otherRef.current?.focus()
  }, [otherOpen, step])

  // Auto-grow with the answer, like the composer; the CSS max-height stops it
  // and it scrolls inside from there.
  const custom = draft.custom
  useLayoutEffect(() => {
    const el = otherRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`
  }, [custom, otherOpen, step])

  // Rows the digits reach: the options, then "Other…".
  const rowCount = question.options.length + (question.allowCustomInput ? 1 : 0)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!keyIsForCard(event, cardRef.current, armedRef.current)) return
      const inField = event.target instanceof HTMLTextAreaElement
      if (event.key === 'Escape') {
        event.preventDefault()
        escape()
        return
      }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        primary()
        return
      }
      if (inField || confirmDiscard || event.ctrlKey || event.metaKey || event.altKey) return
      const n = Number(event.key)
      if (Number.isInteger(n) && n >= 1 && n <= rowCount) {
        event.preventDefault()
        if (n <= question.options.length) pick(question.options[n - 1])
        else pickOther()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  // As a modal it is the only thing to answer: it takes the focus, so its
  // keys work (once armed) without a click first.
  useEffect(() => {
    if (presentation === 'sheet') cardRef.current?.focus()
  }, [presentation])

  const live = keysLive(cardRef.current, active, armed)
  const headlineId = `question-head-${request.id}`
  const workflow = questions.some((q) => q.header?.toLowerCase() === 'workflow')
  const primaryLabel = isLast ? (count > 1 ? 'Send answers' : 'Send answer') : 'Next'

  return (
    <section
      ref={cardRef}
      className={
        'prompt-card prompt-card--question' +
        (presentation === 'sheet' ? ' prompt-card--sheet' : '') +
        (armed ? ' prompt-card--armed' : '')
      }
      role={presentation === 'sheet' ? 'dialog' : 'group'}
      aria-modal={presentation === 'sheet' ? true : undefined}
      aria-labelledby={headlineId}
      tabIndex={-1}
      data-testid="question-card"
    >
      <header className="prompt-head">
        <span className="prompt-icon prompt-icon--info">
          <Icon name={workflow ? 'flowchart' : 'questionmark.bubble'} size={14} />
        </span>
        <h2 className="prompt-title" id={headlineId}>
          {count > 1 ? `Spettro has ${count} questions` : 'Spettro has a question'}
        </h2>
        {count > 1 && (
          <span className="prompt-step" aria-live="polite">
            Question {step + 1} of {count}
          </span>
        )}
        {total > 1 && (
          <span className="prompt-queue" title={`${total - position} more waiting after this one`}>
            {position} of {total}
          </span>
        )}
      </header>

      <div className="prompt-body">
        {request.context && step === 0 && <p className="prompt-note">{request.context}</p>}
        {question.header && <div className="prompt-eyebrow">{question.header}</div>}
        {question.question !== '' && <p className="prompt-question">{question.question}</p>}
        {question.multiSelect && <p className="prompt-caption">Choose all that apply.</p>}

        <div
          className="prompt-options"
          role={question.multiSelect ? 'group' : 'radiogroup'}
          aria-label={question.question || question.header || 'Options'}
        >
          {question.options.map((option, i) => {
            const selected = draft.selected.includes(option.id)
            const previewOpen = previews.has(`${question.id}/${option.id}`)
            return (
              <div
                key={option.id}
                className={'prompt-option' + (selected ? ' prompt-option--selected' : '')}
              >
                <button
                  type="button"
                  className="prompt-option-main"
                  role={question.multiSelect ? 'checkbox' : 'radio'}
                  aria-checked={selected}
                  data-testid={`question-option-${option.id}`}
                  onClick={() => pick(option)}
                >
                  <span
                    className={
                      'prompt-mark' + (question.multiSelect ? ' prompt-mark--check' : ' prompt-mark--radio')
                    }
                    aria-hidden="true"
                  >
                    {selected && question.multiSelect && <Icon name="checkmark" size={11} />}
                  </span>
                  <span className="prompt-option-text">
                    <span className="prompt-option-label">
                      {option.label}
                      {option.isRecommended && <span className="prompt-pill">Recommended</span>}
                    </span>
                    {option.description && (
                      <span className="prompt-option-desc">{option.description}</span>
                    )}
                  </span>
                  {live && <kbd className="prompt-kbd prompt-option-kbd">{i + 1}</kbd>}
                </button>
                {option.preview && (
                  <>
                    <button
                      type="button"
                      className="prompt-preview-toggle"
                      aria-expanded={previewOpen}
                      onClick={() =>
                        setPreviews((prev) => {
                          const next = new Set(prev)
                          const key = `${question.id}/${option.id}`
                          if (next.has(key)) next.delete(key)
                          else next.add(key)
                          return next
                        })
                      }
                    >
                      <Icon name={previewOpen ? 'chevron.down' : 'chevron.right'} size={9} />
                      Preview
                    </button>
                    {previewOpen && <pre className="prompt-code prompt-preview">{option.preview}</pre>}
                  </>
                )}
              </div>
            )
          })}

          {question.allowCustomInput && (
            <div className={'prompt-option' + (draft.other ? ' prompt-option--selected' : '')}>
              <button
                type="button"
                className="prompt-option-main"
                role={question.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={draft.other}
                data-testid="question-option-other"
                onClick={pickOther}
              >
                <span
                  className={
                    'prompt-mark' + (question.multiSelect ? ' prompt-mark--check' : ' prompt-mark--radio')
                  }
                  aria-hidden="true"
                >
                  {draft.other && question.multiSelect && <Icon name="checkmark" size={11} />}
                </span>
                <span className="prompt-option-text">
                  <span className="prompt-option-label">
                    {question.options.length > 0 ? 'Other…' : 'Your answer…'}
                  </span>
                </span>
                {live && (
                  <kbd className="prompt-kbd prompt-option-kbd">{question.options.length + 1}</kbd>
                )}
              </button>
              {draft.other && (
                <textarea
                  ref={otherRef}
                  className="prompt-field"
                  rows={2}
                  placeholder="Type your answer"
                  aria-label="Your own answer"
                  value={draft.custom}
                  onChange={(e) => {
                    const custom = e.target.value
                    patch(() => ({ custom }))
                  }}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {confirmDiscard ? (
        <footer className="prompt-actions prompt-actions--confirm" role="alert">
          <span className="prompt-confirm-text">Discard your answers?</span>
          <span className="prompt-actions-spacer" />
          <button type="button" className="prompt-btn" onClick={() => setConfirmDiscard(false)}>
            Keep editing
          </button>
          <button
            type="button"
            className="prompt-btn prompt-btn--danger"
            data-testid="question-discard"
            onClick={() => deliver(null)}
          >
            Discard
          </button>
        </footer>
      ) : (
        <footer className="prompt-actions">
          <button
            type="button"
            className="prompt-link"
            data-testid="question-skip"
            onClick={() => deliver(null)}
          >
            Skip all
          </button>
          <span className="prompt-actions-spacer" />
          {isLast && count > 1 && unanswered > 0 && anyAnswer && (
            <span className="prompt-hint">
              {unanswered === 1 ? '1 question' : `${unanswered} questions`} will be sent as skipped
            </span>
          )}
          {!live && armed && inComposer(active) && (
            <span className="prompt-hint">
              Press <kbd className="prompt-kbd">Tab</kbd> to answer
            </span>
          )}
          {step > 0 && (
            <button type="button" className="prompt-btn" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          <button
            type="button"
            className="prompt-btn prompt-btn--primary"
            disabled={isLast && !anyAnswer}
            data-testid="question-submit"
            title={withShortcut(primaryLabel, 'Enter')}
            onClick={primary}
          >
            {primaryLabel}
          </button>
        </footer>
      )}
    </section>
  )
}

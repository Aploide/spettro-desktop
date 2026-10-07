// An approval, inline above the composer of the chat that asked — the way
// the Claude app's Code tab asks — rather than a modal over the whole
// window. It says what will happen in a sentence, shows the command or the
// change itself, and offers the same three buttons in the same order every
// time: Allow once, Always allow, Deny.
//
// It can't be approved by accident (see promptKeys.ts): it ignores keys and
// clicks for its first 600 ms, hears 1/2/3 and Esc only while focus is on it
// or nowhere in particular, and Enter never approves anything.
//
// A request whose chat is unknown (chatId null) still has to be answerable,
// so App shows the same card in a modal sheet (`presentation="sheet"`).

import { useEffect, useRef } from 'react'
import type { JSX } from 'react'
import type { ACPPermissionRequest } from '@shared/acp'
import { call } from '@renderer/state/store'
import { Icon } from '@renderer/design/icons'
import { DiffView } from './transcript/ToolCallView'
import {
  compactDetail,
  denyOption,
  orderedOptions,
  permissionBody,
  permissionHeadline,
  permissionIcon,
  type CardOption
} from './prompts'
import { inComposer, keyIsForCard, keysLive, useActiveElement, useArmed } from './promptKeys'
import './prompts.css'

/** Diff lines shown before "Show full diff": a glance, not a review. */
const PREVIEW_DIFF_LINES = 30

export interface PermissionCardProps {
  request: ACPPermissionRequest
  /** Where this request stands in the chat's queue ("1 of 3"). */
  position?: number
  total?: number
  /** After the user denied it (not after a compaction choice): the chat
   *  offers to take their reason as the next message. */
  onDenied?: (request: ACPPermissionRequest) => void
  presentation?: 'inline' | 'sheet'
}

export default function PermissionCard({
  request,
  position = 1,
  total = 1,
  onDenied,
  presentation = 'inline'
}: PermissionCardProps): JSX.Element {
  const cardRef = useRef<HTMLElement>(null)
  const { armed, armedRef } = useArmed()
  const active = useActiveElement()
  // One answer per request, however fast the keys are pressed.
  const answeredRef = useRef(false)

  const options = orderedOptions(request)
  const compact = request.variant === 'compact'

  const choose = (choice: CardOption): void => {
    if (!armedRef.current || answeredRef.current) return
    answeredRef.current = true
    void call('resolvePermission', request.id, choice.option.optionId)
    if (choice.role === 'reject' && !compact) onDenied?.(request)
  }

  const deny = (): void => {
    if (!armedRef.current || answeredRef.current) return
    const reject = denyOption(request)
    if (reject) {
      const choice = options.find((o) => o.option === reject)
      if (choice) choose(choice)
      return
    }
    // Nothing to deny with: dismissing answers "cancelled", which the CLI
    // takes as a no.
    answeredRef.current = true
    void call('dismissPermission', request.id)
    if (!compact) onDenied?.(request)
  }

  // The window hears the keys, so the card answers when focus is on the
  // page rather than on it; keyIsForCard keeps them away from fields.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!keyIsForCard(event, cardRef.current, armedRef.current)) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key === 'Escape') {
        event.preventDefault()
        deny()
        return
      }
      const n = Number(event.key)
      if (Number.isInteger(n) && n >= 1 && n <= options.length) {
        event.preventDefault()
        choose(options[n - 1])
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
  const body = permissionBody(request)
  const headline = permissionHeadline(request)
  const headlineId = `perm-head-${request.id}`

  return (
    <section
      ref={cardRef}
      className={
        'prompt-card prompt-card--permission' +
        (presentation === 'sheet' ? ' prompt-card--sheet' : '') +
        (armed ? ' prompt-card--armed' : '')
      }
      role={presentation === 'sheet' ? 'alertdialog' : 'group'}
      aria-modal={presentation === 'sheet' ? true : undefined}
      aria-labelledby={headlineId}
      tabIndex={-1}
      data-testid="permission-card"
      // Enter never approves — not even on a focused Allow button. Space and
      // the digits do; both take a deliberate press.
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !(event.target instanceof HTMLTextAreaElement)) {
          event.preventDefault()
        }
      }}
    >
      <header className="prompt-head">
        <span className={'prompt-icon' + (compact ? ' prompt-icon--info' : '')}>
          <Icon name={permissionIcon(request)} size={14} />
        </span>
        <h2 className="prompt-title" id={headlineId}>
          {headline}
        </h2>
        {total > 1 && (
          <span className="prompt-queue" title={`${total - position} more waiting after this one`}>
            {position} of {total}
          </span>
        )}
      </header>

      <div className="prompt-body">
        {compact ? (
          <p className="prompt-note">{compactDetail(request)}</p>
        ) : (
          <>
            {headline === 'Spettro needs your approval' && request.title !== '' && (
              <p className="prompt-subject">{request.title}</p>
            )}
            {body.map((block, i) =>
              block.type === 'code' ? (
                <pre
                  key={i}
                  className={'prompt-code' + (block.lang === 'sh' ? ' prompt-code--shell' : '')}
                  aria-label={block.lang === 'sh' ? 'Command' : undefined}
                >
                  {block.text}
                </pre>
              ) : (
                <p key={i} className="prompt-note">
                  {block.text}
                </p>
              )
            )}
            {request.content.diffs.map((diff, i) => (
              <DiffView
                key={`${diff.path}-${i}`}
                diff={{ path: diff.path, oldText: diff.oldText ?? null, newText: diff.newText }}
                maxLines={PREVIEW_DIFF_LINES}
                moreLabel="Show full diff"
              />
            ))}
          </>
        )}
      </div>

      <footer className="prompt-actions">
        {options.map((choice, i) => (
          <div className="prompt-choice" key={choice.option.optionId}>
            <button
              type="button"
              className={
                'prompt-btn' +
                (i === 0 && choice.role !== 'reject' ? ' prompt-btn--primary' : '') +
                (choice.role === 'reject' ? ' prompt-btn--deny' : '')
              }
              aria-disabled={!armed || undefined}
              aria-keyshortcuts={String(i + 1)}
              data-testid={`permission-${choice.role === 'reject' ? 'deny' : choice.role.replace('_', '-')}`}
              title={choice.caption ?? undefined}
              onClick={() => choose(choice)}
            >
              <span>{choice.label}</span>
              {live && <kbd className="prompt-kbd">{i + 1}</kbd>}
            </button>
            {choice.caption && <span className="prompt-choice-caption">{choice.caption}</span>}
          </div>
        ))}
        <span className="prompt-actions-spacer" />
        {!live && armed && inComposer(active) && (
          <span className="prompt-hint">
            Press <kbd className="prompt-kbd">Tab</kbd> to review
          </span>
        )}
        {live && (
          <span className="prompt-hint">
            <kbd className="prompt-kbd">Esc</kbd> {compact ? 'continues' : 'denies'}
          </span>
        )}
      </footer>
    </section>
  )
}

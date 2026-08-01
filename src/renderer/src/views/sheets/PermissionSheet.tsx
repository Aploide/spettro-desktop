// Port of Spettro/Views/PermissionSheet.swift (doc 30-permission-sheet.md).
// The modal approval prompt shown when the agent asks the user to authorize
// something mid-turn. The options come straight from the ACP request, so
// every permission kind renders the same way. The parent presents the FIRST
// element of the pending-permission queue; resolving removes it and the next
// queued request (if any) becomes the presented sheet.
//
// Keyboard (Swift .defaultAction / .cancelAction, ported to Ctrl):
//   Enter / Ctrl+Enter  -> first allow_* option
//   Esc                 -> first reject_* option; with none, dismiss (cancelled)
//   Ctrl+Shift+A        -> first allow_always option (desktop addition that
//                          resolves the once/always Return ambiguity doc 30 notes)

import { useEffect, useRef } from 'react'
import type { ACPPermissionRequest } from '@shared/acp'
import { call } from '@renderer/state/store'
import './sheets.css'

// SF Symbol stand-ins (terminal / questionmark.bubble / lock.shield).
function KindIcon({ kind }: { kind?: string }): JSX.Element {
  switch (kind) {
    case 'execute': // "terminal"
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
          <path d="M6.5 9l3.5 3-3.5 3M12.5 15.5H17" />
        </svg>
      )
    case 'think': // "questionmark.bubble"
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 12a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-2.9-.36-4.15-1L3.5 20.5l1-4.35A8.5 8.5 0 1 1 21 12z" />
          <path d="M10.2 9.4a2.3 2.3 0 1 1 3.2 2.1c-.8.35-1.15.8-1.15 1.6" />
          <circle cx="12.25" cy="15.9" r="0.4" fill="currentColor" stroke="none" />
        </svg>
      )
    default: // "lock.shield"
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 2.5l7.5 3v6c0 5-3.2 8.6-7.5 10-4.3-1.4-7.5-5-7.5-10v-6l7.5-3z" />
          <rect x="9.2" y="10.3" width="5.6" height="4.6" rx="1" />
          <path d="M10.3 10.3V9a1.7 1.7 0 0 1 3.4 0v1.3" />
        </svg>
      )
  }
}

const ALLOW_KINDS = new Set(['allow_once', 'allow_always'])
const REJECT_KINDS = new Set(['reject_once', 'reject_always'])

/** The command block is shown only when rawInput is a JSON object with a
 *  string `command` field — mirrors `commandText` in the Swift sheet. */
function commandText(request: ACPPermissionRequest): string | null {
  const raw = request.rawInput
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return null
  const command = raw['command']
  return typeof command === 'string' ? command : null
}

export default function PermissionSheet({ request }: { request: ACPPermissionRequest }): JSX.Element {
  // Guard against double-resolution (Enter mashing while the queue advances).
  const resolvedRef = useRef<string | null>(null)

  const resolve = (optionId: string): void => {
    if (resolvedRef.current === request.id) return
    resolvedRef.current = request.id
    void call('resolvePermission', request.id, optionId)
  }

  const dismiss = (): void => {
    if (resolvedRef.current === request.id) return
    resolvedRef.current = request.id
    void call('dismissPermission', request.id)
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Ctrl+Shift+A -> allow_always (⌘⇧A on the Mac keyboard idiom).
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
        const always = request.options.find((o) => o.kind === 'allow_always')
        if (always) {
          e.preventDefault()
          resolve(always.optionId)
        }
        return
      }
      if (e.key === 'Enter') {
        // .defaultAction — the first allow-kind option.
        const allow = request.options.find((o) => ALLOW_KINDS.has(o.kind ?? ''))
        if (allow) {
          e.preventDefault()
          resolve(allow.optionId)
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        // .cancelAction — the first reject-kind option; without one the sheet
        // goes away without a choice (cancelled outcome).
        const reject = request.options.find((o) => REJECT_KINDS.has(o.kind ?? ''))
        if (reject) resolve(reject.optionId)
        else dismiss()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // Re-bind per request so the guard + option list track the queue head.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.id])

  const command = commandText(request)

  return (
    <div className="sheet-backdrop" role="presentation">
      <div className="sheet-card sheet-card--permission" role="alertdialog" aria-modal="true" aria-label="Spettro needs your approval">
        <div className="sheet-header">
          <KindIcon kind={request.toolKind} />
          <span className="sheet-headline">Spettro needs your approval</span>
        </div>

        <div className="perm-title">{request.title}</div>

        {command !== null && (
          <div className="perm-command">
            <pre className="mono">{command}</pre>
          </div>
        )}

        <div className="sheet-btn-row">
          {request.options.map((option) => {
            const isAllow = ALLOW_KINDS.has(option.kind ?? '')
            return (
              <button
                key={option.optionId}
                className={`sheet-btn ${isAllow ? 'sheet-btn--prominent' : 'sheet-btn--subtle'}`}
                onClick={() => resolve(option.optionId)}
              >
                {option.name}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

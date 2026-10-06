// What the inline approval and question cards say, worked out from the
// request alone so it can be tested without drawing anything.
//
// The CLI describes an approval in pieces (internal/acp/permission.go
// approvalContent): the whole command or URL in a fenced block, a plain
// reason line, sometimes a second fenced block listing what "Always allow"
// would remember — and a diff block for a file change. The options come with
// ACP kinds; the card puts them in one fixed order whatever order they
// arrive in, so "1" is always Allow once and the destructive choice never
// lands under the cursor where Allow was a moment ago.

import type { ACPPermissionOption, ACPPermissionRequest, ACPQuestionRequest } from '@shared/acp'
import { baseName } from './transcript/toolPresentation'

/** How long a fresh card ignores its keys and clicks: long enough that an
 *  Enter, a digit or a click aimed at whatever was there a moment ago can't
 *  land on it. */
export const ARM_DELAY_MS = 600

// ---------------------------------------------------------------- options

export type OptionRole = 'allow_once' | 'allow_always' | 'reject' | 'other'

export interface CardOption {
  option: ACPPermissionOption
  role: OptionRole
  /** The button's own words. */
  label: string
  /** The CLI's scope for "Always allow" ("Always allow this command"), shown
   *  under the button; null when it would only repeat the label. */
  caption: string | null
}

/** The option's role from its ACP kind, else from its name: an agent that
 *  leaves the kind out still says "Deny" or "Always allow". */
export function optionRole(option: ACPPermissionOption): OptionRole {
  switch (option.kind) {
    case 'allow_once':
      return 'allow_once'
    case 'allow_always':
      return 'allow_always'
    case 'reject_once':
    case 'reject_always':
      return 'reject'
  }
  const name = option.name.toLowerCase()
  if (/\b(always|remember)\b/.test(name)) return 'allow_always'
  if (/\b(deny|reject|decline|no|don't|cancel)\b/.test(name)) return 'reject'
  if (/\b(allow|approve|yes|ok|run)\b/.test(name)) return 'allow_once'
  return 'other'
}

const ROLE_ORDER: Record<OptionRole, number> = { allow_once: 0, allow_always: 1, reject: 2, other: 3 }

/**
 * The card's buttons, in the one order they always take: Allow once,
 * Always allow, Deny, then anything else the agent offered. The compaction
 * prompt keeps the CLI's own words ("Compact now" / "Continue without
 * compacting"); every tool approval gets the standard ones.
 */
export function orderedOptions(request: ACPPermissionRequest): CardOption[] {
  const compact = request.variant === 'compact'
  return request.options
    .map((option, index) => ({ option, index, role: optionRole(option) }))
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.index - b.index)
    .map(({ option, role }) => {
      if (compact || role === 'other') return { option, role, label: option.name, caption: null }
      if (role === 'allow_always') {
        const scoped = option.name.trim() !== '' && !/^always allow$/i.test(option.name.trim())
        return { option, role, label: 'Always allow', caption: scoped ? option.name : null }
      }
      return { option, role, label: role === 'allow_once' ? 'Allow once' : 'Deny', caption: null }
    })
}

/** The choice Esc makes: the first reject-kind option, or null when the
 *  agent offered none (the card is then dismissed, which the CLI also reads
 *  as a denial). */
export function denyOption(request: ACPPermissionRequest): ACPPermissionOption | null {
  return orderedOptions(request).find((o) => o.role === 'reject')?.option ?? null
}

// --------------------------------------------------------------- headline

/** The file an approval is about, by name: the diff's path, else the first
 *  location. */
function fileName(request: ACPPermissionRequest): string | null {
  const path = request.content.diffs[0]?.path ?? request.locations[0]?.path
  return path ? baseName(path) : null
}

/** One sentence saying what is being asked, by kind. Kinds the card has no
 *  sentence for fall back to the request's own title. */
export function permissionHeadline(request: ACPPermissionRequest): string {
  if (request.variant === 'compact') return 'This conversation is almost full'
  const file = fileName(request)
  switch (request.toolKind) {
    case 'execute':
      return 'Spettro wants to run a command'
    case 'edit':
      return file ? `Spettro wants to edit ${file}` : 'Spettro wants to edit a file'
    case 'delete':
      return file ? `Spettro wants to delete ${file}` : 'Spettro wants to delete a file'
    case 'move':
      return file ? `Spettro wants to move ${file}` : 'Spettro wants to move a file'
    case 'read':
      return file ? `Spettro wants to read ${file}` : 'Spettro wants to read a file'
    case 'fetch':
      return 'Spettro wants to open a web page'
    case 'search':
      return 'Spettro wants to search'
    default:
      return 'Spettro needs your approval'
  }
}

/** The headline's icon (design/icons names). */
export function permissionIcon(request: ACPPermissionRequest): string {
  if (request.variant === 'compact') return 'arrow.down.circle.fill'
  switch (request.toolKind) {
    case 'execute':
      return 'terminal'
    case 'edit':
      return 'pencil'
    case 'delete':
      return 'trash'
    case 'move':
      return 'arrow.right.doc.on.clipboard'
    case 'read':
      return 'doc.text'
    case 'fetch':
      return 'globe'
    case 'search':
      return 'magnifyingglass'
    default:
      return 'lock.shield'
  }
}

// ------------------------------------------------------------------- body

export type BodyBlock =
  | { type: 'code'; lang: string; text: string }
  | { type: 'note'; text: string }

/** A whole-text fenced block: ```lang\n…\n```, any fence length of three or
 *  more (approvalTextBlock lengthens it past the longest run inside). */
const FENCED = /^(`{3,})([^\n`]*)\n([\s\S]*?)\n\1(?:\n\n([\s\S]+))?$/

/**
 * The approval's text content as the card draws it: fenced blocks as code,
 * everything else as notes, in the CLI's order. A text the CLI clipped ends
 * its fence with a "[truncated: …]" note, which comes out as a note of its
 * own. With no text at all, the command from rawInput stands in — that is all
 * an older CLI sent.
 */
export function permissionBody(request: ACPPermissionRequest): BodyBlock[] {
  const out: BodyBlock[] = []
  for (const raw of request.content.texts) {
    const text = raw.replace(/\s+$/, '')
    if (text === '') continue
    const m = FENCED.exec(text)
    if (m) {
      out.push({ type: 'code', lang: m[2].trim(), text: m[3] })
      if (m[4]) out.push({ type: 'note', text: m[4].trim() })
    } else {
      out.push({ type: 'note', text })
    }
  }
  if (out.length === 0 && request.content.diffs.length === 0 && request.variant !== 'compact') {
    const command = commandOf(request)
    if (command !== null) out.push({ type: 'code', lang: 'sh', text: command })
  }
  return out
}

/** rawInput.command, when the request carries one. */
function commandOf(request: ACPPermissionRequest): string | null {
  const raw = request.rawInput
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return null
  const command = raw['command']
  return typeof command === 'string' && command.trim() !== '' ? command : null
}

/**
 * The compaction prompt's title is the CLI's whole question ("Context
 * nearly full (~182000/200000 tokens). Compact conversation history now?",
 * compaction.go); the card already asks it, so only the numbers are kept,
 * as words.
 */
export function compactDetail(request: ACPPermissionRequest): string {
  const m = /~?(\d+)\s*\/\s*(\d+)\s*tokens/.exec(request.title)
  const lead = m
    ? `About ${tokens(Number(m[1]))} of ${tokens(Number(m[2]))} tokens are in use. `
    : ''
  return (
    lead +
    'Compacting replaces older messages with a summary so Spettro can keep going; ' +
    'continuing without it may run out of room.'
  )
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

// ------------------------------------------------------------------ focus

/**
 * Whether keyboard focus is somewhere typing happens — a text field, the
 * terminal, anything editable. A card's keys stay off while it is: the
 * digits, Esc and Enter typed there belong to what is being typed.
 */
export function isTypingTarget(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false
  if (el.closest('.xterm')) return true
  if (el.isContentEditable) return true
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true
  if (el instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(el.type)
  }
  return false
}

// -------------------------------------------------------------- the queue

export interface ChatPrompts {
  permissions: ACPPermissionRequest[]
  questions: ACPQuestionRequest[]
}

/** The prompts one chat is waiting on, oldest first. */
export function promptsFor(
  chatId: string,
  permissions: ACPPermissionRequest[],
  questions: ACPQuestionRequest[]
): ChatPrompts {
  return {
    permissions: permissions.filter((p) => p.chatId === chatId),
    questions: questions.filter((q) => q.chatId === chatId)
  }
}

/** Chats with something waiting on the user, by id. */
export function chatsNeedingYou(
  permissions: ACPPermissionRequest[],
  questions: ACPQuestionRequest[]
): Set<string> {
  const out = new Set<string>()
  for (const p of permissions) if (p.chatId) out.add(p.chatId)
  for (const q of questions) if (q.chatId) out.add(q.chatId)
  return out
}

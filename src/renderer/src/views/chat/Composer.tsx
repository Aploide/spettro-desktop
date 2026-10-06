// Port of Platforms/macOS/Views/ComposerView.swift (docs 25 + 14), reshaped
// after the Claude app's composer: one raised card holding the text, the
// attachments and a toolbar — attach, mode and thinking, settings on the
// left; the model and the send button on the right.
//
// The field never locks. While the agent works, what you type goes to it as
// guidance it reads at its next step (steering — the button says "Guide"),
// and Stop (or Esc) interrupts. A field that greys out while the agent runs
// is a field that loses the thought you had while watching it.
//
// "/" opens the slash commands and "@" the project's files, both as a menu
// floating above the card and driven by the same keys (↑/↓, Tab or Enter,
// Esc to dismiss). A chosen file stays in the text as "@path", drawn as a
// chip, and goes to the agent as a file it must read (promptBlocks.ts).
//
// It also serves the new-session view, where no chat exists yet: there it is
// handed a draft (see draftChat) and an `onSubmit`, and the caller creates the
// chat with the first message.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { ActivationTextarea, WorkflowHint } from './ActivationGlow'
import type { ACPCommand, ACPConfigOption } from '@shared/acp'
import { workflowRequested } from '@shared/workflowActivation'
import { budgetDirectivesLive, parseBudgetDirective } from '@shared/workflowBudget'
import type { ChatDetail } from '@shared/model'
import { call, useApp } from '@renderer/state/store'
import { FOCUS_COMPOSER_EVENT } from '@renderer/state/shell'
import { Icon } from '@renderer/design/icons'
import ConfigBar, { nextMode } from './ConfigBar'
import ModelMenu from './ModelMenu'
import MentionMenu from './MentionMenu'
import TodoList from './TodoList'
import { MODE_ID } from './SessionSettingsPopover'
import { insertMention, liveMentions, mentionAt, projectFiles, rankFiles } from './mentions'

// ImageAttachment.swift downsampling constants: longest edge kept after
// downsampling (`maxDimension`) and the JPEG re-encode quality
// (`kCGImageDestinationLossyCompressionQuality`).
const MAX_DIMENSION = 1568
const JPEG_QUALITY = 0.85

/** How long the "only images" hint stays up. */
const HINT_MS = 4000

const IMAGES_ONLY_HINT = 'Only images can be attached for now'

interface PendingAttachment {
  id: string
  /** base64 JPEG, already downsampled. */
  data: string
  mimeType: string
  width: number
  height: number
}

/** Text to put in the composer from outside (a starter prompt). The nonce
 *  makes every click a new seed, so choosing the same prompt twice — after
 *  editing or clearing the first — still fills the field. */
export interface PromptSeed {
  text: string
  nonce: number
}

export type SubmitAttachment = { data: string; mimeType: string }

interface ComposerProps {
  chat: ChatDetail
  promptSeed?: PromptSeed | null
  /** New-session mode: there is no chat to send to yet, so the message goes
   *  to the caller instead of `send`. Returning false keeps it in the field. */
  onSubmit?: (
    text: string,
    attachments: SubmitAttachment[],
    mentions: string[]
  ) => boolean | void
}

/** The stand-in a chat-less composer renders against: nothing is busy, no
 *  options or commands are known yet, and the id is never sent anywhere
 *  (onSubmit takes the message instead). */
export function draftChat(projectPath: string): ChatDetail {
  return {
    id: '',
    title: '',
    projectPath,
    acpSessionId: null,
    isPinned: false,
    isArchived: false,
    isBusy: false,
    createdAt: 0,
    items: [],
    configOptions: [],
    commands: [],
    plan: [],
    usage: null,
    lastTurn: null,
    sessionTokens: 0
  }
}

export default function Composer({ chat, promptSeed, onSubmit }: ComposerProps): JSX.Element {
  const app = useApp()
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [mentions, setMentions] = useState<string[]>([])
  const [commandIndex, setCommandIndex] = useState(0)
  const [focused, setFocused] = useState(false)
  const [caret, setCaret] = useState(0)
  const [mentionIndex, setMentionIndex] = useState(0)
  // Esc closes a menu without clearing what was typed; it stays closed for
  // that "@" (by its position) or that exact "/" text.
  const [mentionDismissed, setMentionDismissed] = useState<number | null>(null)
  const [paletteDismissed, setPaletteDismissed] = useState<string | null>(null)
  const [files, setFiles] = useState<{ path: string; list: string[] } | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const ready = app?.phase.kind === 'ready'
  const busy = chat.isBusy && !onSubmit
  const gate = workflowGate(chat.configOptions)
  const requested = workflowRequested(draft)
  const budgets = budgetDirectivesLive(draft, gate.ultraOn && !gate.askFirst)
  const budget = budgets ? parseBudgetDirective(draft) : null
  // The message asks for workflows (or carries a budget for the standing
  // Ultra) while Ask first means none will run. The budget is looked for
  // directly: `budget` above is null under Ask first, since no directive
  // there would be honoured.
  const pausedByAskFirst =
    gate.askFirst && (requested || (gate.ultraOn && parseBudgetDirective(draft) !== null))

  const mention = focused ? mentionAt(draft, caret) : null
  const mentionVisible = mention !== null && mention.start !== mentionDismissed
  const projectPath = chat.projectPath
  const filesHere = files?.path === projectPath ? files.list : null
  const ranked = useMemo(
    () => (mentionVisible && filesHere ? rankFiles(filesHere, mention.query) : []),
    [mentionVisible, filesHere, mention?.query]
  )

  const matching = matchingCommands(draft, chat.commands)
  const paletteVisible =
    matching.length > 0 && focused && !mentionVisible && paletteDismissed !== draft

  const hasContent = draft.trim().length > 0 || attachments.length > 0
  // Non-empty text OR at least one image, app connected. Busy is fine: the
  // message then guides the running turn. There is deliberately no check on
  // acpSessionId — fresh chats get one lazily.
  const canSend = hasContent && ready

  // Auto-focus on appear / chat switch.
  useEffect(() => {
    textareaRef.current?.focus()
  }, [chat.id])

  useEffect(() => {
    if (!promptSeed) return
    setDraft(promptSeed.text)
    const el = textareaRef.current
    if (!el) return
    el.focus()
    // Caret at the end, ready to add detail to the starter prompt.
    requestAnimationFrame(() => {
      el.setSelectionRange(el.value.length, el.value.length)
      setCaret(el.value.length)
    })
  }, [promptSeed])

  // Ctrl/Cmd+L and New session ask for the composer by event.
  useEffect(() => {
    const focus = (): void => textareaRef.current?.focus()
    window.addEventListener(FOCUS_COMPOSER_EVENT, focus)
    return () => window.removeEventListener(FOCUS_COMPOSER_EVENT, focus)
  }, [])

  // The project's files, the first time an "@" asks for them.
  const wantFiles = mentionVisible && filesHere === null
  useEffect(() => {
    if (!wantFiles || !projectPath) return
    let live = true
    void projectFiles(projectPath, (path) => call('listProjectFiles', path)).then((list) => {
      if (live) setFiles({ path: projectPath, list })
    })
    return () => {
      live = false
    }
  }, [wantFiles, projectPath])

  useEffect(() => {
    if (!hint) return
    const id = setTimeout(() => setHint(null), HINT_MS)
    return () => clearTimeout(id)
  }, [hint])

  // Auto-grow: 1–12 lines; the CSS max-height stops it and scrolls.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft])

  const addAttachment = useCallback(async (blob: Blob): Promise<void> => {
    const attachment = await attachmentFrom(blob)
    // Failures are silent and local, per the spec: no thumbnail, no error.
    if (attachment) setAttachments((prev) => [...prev, attachment])
  }, [])

  const syncCaret = (): void => {
    const el = textareaRef.current
    if (el) setCaret(el.selectionStart ?? el.value.length)
  }

  const putCaret = (at: number): void => {
    setCaret(at)
    requestAnimationFrame(() => textareaRef.current?.setSelectionRange(at, at))
  }

  const send = (): void => {
    let text = draft
    // Return on the palette: commands with no input hint run immediately;
    // ones with a hint complete to "/name " so the user can type arguments.
    if (paletteVisible && matching[commandIndex]) {
      const command = matching[commandIndex]
      if (command.inputHint) {
        setDraft('/' + command.name + ' ')
        putCaret(command.name.length + 2)
        return
      }
      text = '/' + command.name
    }
    const trimmed = text.trim()
    if (!((trimmed.length > 0 || attachments.length > 0) && ready)) return
    const toSend = attachments.map((a) => ({ data: a.data, mimeType: a.mimeType }))
    const mentioned = liveMentions(trimmed, mentions)
    if (onSubmit) {
      // The caller may decline (a folder it wants confirmed first); the
      // message then stays put rather than vanishing.
      if (onSubmit(trimmed, toSend, mentioned) === false) return
    } else {
      void call('send', chat.id, trimmed, toSend, mentioned)
    }
    setDraft('')
    setAttachments([])
    setMentions([])
    setCaret(0)
  }

  const pickMention = (path: string): void => {
    if (!mention) return
    const next = insertMention(draft, mention.start, caret, path)
    setDraft(next.text)
    setMentions((prev) => (prev.includes(path) ? prev : [...prev, path]))
    setMentionIndex(0)
    putCaret(next.caret)
  }

  const acceptCommand = (index = commandIndex): void => {
    const command = matching[index]
    if (!command) return
    setDraft('/' + command.name + ' ')
    putCaret(command.name.length + 2)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const menu = mentionVisible ? ranked.length : paletteVisible ? matching.length : 0
    if (mentionVisible || paletteVisible) {
      const move = (delta: number): void => {
        if (menu === 0) return
        if (mentionVisible) setMentionIndex((i) => (i + delta + menu) % menu)
        else setCommandIndex((i) => (i + delta + menu) % menu)
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        move(e.key === 'ArrowUp' ? -1 : 1)
        return
      }
      if (e.key === 'Escape') {
        // Close the menu, and only that: the chat must not read this Esc as
        // "interrupt the agent".
        e.preventDefault()
        if (mentionVisible && mention) setMentionDismissed(mention.start)
        else setPaletteDismissed(draft)
        return
      }
      if (mentionVisible && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
        e.preventDefault()
        const path = ranked[Math.min(mentionIndex, ranked.length - 1)]
        if (path) pickMention(path)
        return
      }
      if (paletteVisible && e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault()
        acceptCommand()
        return
      }
    }
    // Shift+Tab steps through the modes (Plan → Coding → Ask), as in the
    // Claude app; the field keeps the focus.
    if (e.key === 'Tab' && e.shiftKey && !onSubmit) {
      const next = nextMode(chat.configOptions)
      if (next) {
        e.preventDefault()
        void call('setSelectOption', chat.id, MODE_ID, next)
      }
      return
    }
    // Enter sends, Shift+Enter inserts a newline; Ctrl/Cmd+Enter also sends.
    if (e.key === 'Enter' && (!e.shiftKey || e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      send()
    }
  }

  // Paste: only intercept when the clipboard actually holds an image — text
  // paste keeps flowing through the textarea's own handling. A file that
  // isn't one (a PDF) gets the hint instead of vanishing without a word.
  const onPaste = (e: React.ClipboardEvent): void => {
    const items = Array.from(e.clipboardData.items)
    const fileItems = items.filter((item) => item.kind === 'file')
    const images = fileItems.filter((item) => item.type.startsWith('image/'))
    if (images.length === 0) {
      const hasText = items.some((item) => item.kind === 'string')
      if (fileItems.length > 0 && !hasText) {
        e.preventDefault()
        setHint(IMAGES_ONLY_HINT)
      }
      return
    }
    e.preventDefault()
    for (const item of images) {
      const file = item.getAsFile()
      if (file) void addAttachment(file)
    }
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    let refused = false
    for (const file of Array.from(e.dataTransfer.files)) {
      if (file.type.startsWith('image/')) void addAttachment(file)
      else refused = true
    }
    if (refused) setHint(IMAGES_ONLY_HINT)
  }

  const onFilesPicked = (e: React.ChangeEvent<HTMLInputElement>): void => {
    for (const file of Array.from(e.target.files ?? [])) void addAttachment(file)
    e.target.value = ''
  }

  // The new-session view names the folder right under the field, so there
  // the placeholder says what to type instead of where.
  const placeholder = !ready
    ? 'Reconnecting…'
    : onSubmit
      ? 'Describe a task, or ask about your code…'
      : 'Ask Spettro to build, fix, or explain…'

  return (
    <div className="composer-outer">
      <div className="composer-column">
        {!onSubmit && <TodoList plan={chat.plan} busy={chat.isBusy} />}

        <div className="composer-anchor">
          {mentionVisible && (
            <MentionMenu
              files={ranked}
              selected={Math.min(mentionIndex, Math.max(0, ranked.length - 1))}
              loading={filesHere === null && projectPath !== ''}
              query={mention.query}
              onPick={pickMention}
              onHover={setMentionIndex}
            />
          )}
          {paletteVisible && (
            <div className="composer-menu command-palette" role="listbox" aria-label="Commands">
              {matching.map((command, index) => (
                <button
                  type="button"
                  key={command.name}
                  role="option"
                  aria-selected={index === commandIndex}
                  className={
                    'composer-menu-row command-row' +
                    (index === commandIndex ? ' composer-menu-row--selected' : '')
                  }
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => setCommandIndex(index)}
                  onClick={() => {
                    setCommandIndex(index)
                    acceptCommand(index)
                  }}
                >
                  <span className="command-name">/{command.name}</span>
                  {command.inputHint && <span className="command-hint">{command.inputHint}</span>}
                  {command.description && (
                    <span className="command-description">{command.description}</span>
                  )}
                </button>
              ))}
            </div>
          )}

          <div
            className={'composer-card' + (focused ? ' composer-card--focused' : '')}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
          >
            {attachments.length > 0 && (
              <div className="attachments-row">
                {attachments.map((attachment, i) => (
                  <div className="attachment-thumb" key={attachment.id}>
                    <img
                      src={`data:${attachment.mimeType};base64,${attachment.data}`}
                      alt={`Attached image ${i + 1}`}
                      className="attachment-thumb-img"
                    />
                    <button
                      type="button"
                      className="attachment-remove"
                      title="Remove"
                      aria-label={`Remove image ${i + 1}`}
                      onClick={() =>
                        setAttachments((prev) => prev.filter((a) => a.id !== attachment.id))
                      }
                    >
                      <Icon name="xmark" size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Not a plain textarea: a phrase like "ultracode" or "use a workflow"
                arms multi-agent orchestration for the turn, and the input has to
                say so while it is being typed rather than after the fact. */}
            <ActivationTextarea
              textareaRef={textareaRef}
              className="composer-input"
              rows={1}
              value={draft}
              placeholder={placeholder}
              label="Message"
              testId="composer-input"
              onChange={(next) => {
                setDraft(next)
                setCommandIndex(0)
                setMentionIndex(0)
                syncCaret()
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onSelect={syncCaret}
              onClick={syncCaret}
              onFocus={() => {
                setFocused(true)
                syncCaret()
              }}
              onBlur={() => setFocused(false)}
              budgets={budgets}
              muted={gate.askFirst}
              mentions={mentions}
            />

            <div className="composer-toolbar">
              <button
                type="button"
                className="composer-tool"
                title="Attach images"
                aria-label="Attach images"
                onClick={() => fileInputRef.current?.click()}
              >
                <Icon name="paperclip" size={15} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={onFilesPicked}
              />

              {!onSubmit && <ConfigBar chat={chat} />}

              <div className="composer-toolbar-spacer" />

              {!onSubmit && <ModelMenu chat={chat} />}

              {busy && (
                <button
                  type="button"
                  className="composer-send composer-send--stop"
                  title="Stop (Esc)"
                  aria-label="Stop"
                  data-testid="stop"
                  onClick={() => void call('cancel', chat.id)}
                >
                  <Icon name="stop.fill" size={12} />
                </button>
              )}
              {busy ? (
                hasContent && (
                  <button
                    type="button"
                    className="composer-send composer-send--guide"
                    title="Send to guide Spettro while it works"
                    disabled={!canSend}
                    data-testid="send"
                    onClick={send}
                  >
                    <Icon name="arrow.up" size={13} />
                    <span>Guide</span>
                  </button>
                )
              ) : (
                <button
                  type="button"
                  className="composer-send"
                  title="Send (Enter)"
                  aria-label="Send"
                  disabled={!canSend}
                  data-testid="send"
                  onClick={send}
                >
                  <Icon name="arrow.up" size={15} />
                </button>
              )}
            </div>
          </div>
        </div>

        {hint ? (
          <div className="composer-hint" role="status">
            <Icon name="info.circle.fill" size={12} />
            <span>{hint}</span>
          </div>
        ) : (
          <WorkflowHint
            pausedByAskFirst={pausedByAskFirst}
            budgetTokens={budget}
            onSwitchPermission={
              gate.canRestrict && !onSubmit
                ? () => void call('setSelectOption', chat.id, 'permission', 'restricted')
                : undefined
            }
          />
        )}
      </div>
    </div>
  )
}

/**
 * What the session's options say about workflows: whether Ultra is on, and
 * whether the "Ask first" permission level is holding every workflow back
 * (the CLI refuses them there — internal/agent/workflow.go). `canRestrict` is
 * whether the permission option offers the level that lifts it.
 */
function workflowGate(options: ACPConfigOption[]): {
  ultraOn: boolean
  askFirst: boolean
  canRestrict: boolean
} {
  const ultra = options.find((o) => o.id === 'ultra')
  const permission = options.find((o) => o.id === 'permission')
  const kind = permission?.kind
  const choices =
    kind?.type === 'select' ? kind.groups.flatMap((g) => g.options).concat(kind.flat) : []
  return {
    ultraOn: ultra?.kind.type === 'boolean' && ultra.kind.currentValue,
    askFirst: kind?.type === 'select' && kind.currentValue === 'ask-first',
    canRestrict: choices.some((c) => c.value === 'restricted')
  }
}

// ---------------------------------------------------------------------------
// Slash-command matching (ComposerView.matchingCommands)
// ---------------------------------------------------------------------------

function matchingCommands(draft: string, commands: ACPCommand[]): ACPCommand[] {
  if (!draft.startsWith('/') || draft.includes('\n')) return []
  // Once the command word is complete and a space follows (arguments stage),
  // hide the palette so Return sends instead of re-completing.
  const spaceIndex = draft.indexOf(' ')
  if (spaceIndex >= 0) {
    const word = draft.slice(0, spaceIndex).toLowerCase()
    if (commands.some((c) => '/' + c.name.toLowerCase() === word)) return []
  }
  const q = (draft.split(' ', 1)[0] || '/').toLowerCase()
  const matches = commands.filter(
    (c) =>
      q === '/' ||
      ('/' + c.name.toLowerCase()).startsWith(q) ||
      (c.description ?? '').toLowerCase().includes(q.slice(1))
  )
  return matches.slice(0, 8)
}

// ---------------------------------------------------------------------------
// Image pipeline (ImageAttachment.from(data:) port)
// ---------------------------------------------------------------------------

/**
 * Downsample to a longest edge of MAX_DIMENSION (1568 px — a cap, not a
 * target) and re-encode as JPEG at quality 0.85. createImageBitmap applies the
 * EXIF orientation, mirroring kCGImageSourceCreateThumbnailWithTransform.
 * Returns null (silently) for anything the browser can't decode.
 */
async function attachmentFrom(blob: Blob): Promise<PendingAttachment | null> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob)
  } catch {
    return null
  }
  try {
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    // JPEG has no alpha channel: matte transparency onto white.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(bitmap, 0, 0, width, height)
    const dataURL = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
    const comma = dataURL.indexOf(',')
    if (comma < 0) return null
    return {
      id: crypto.randomUUID(),
      data: dataURL.slice(comma + 1),
      mimeType: 'image/jpeg',
      width,
      height
    }
  } catch {
    return null
  } finally {
    bitmap.close()
  }
}

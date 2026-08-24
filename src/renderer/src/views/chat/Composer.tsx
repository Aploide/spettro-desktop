// Port of Platforms/macOS/Views/ComposerView.swift (docs 25 + 14): the growing
// text field with slash-command palette, image attachments, config bar, and
// the send/stop + terminal buttons.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ActivationTextarea } from './ActivationGlow'
import type { ACPCommand } from '@shared/acp'
import type { ChatDetail } from '@shared/model'
import { call, useApp } from '@renderer/state/store'
import ConfigBar from './ConfigBar'
import { projectName } from './ChatHeader'

// ImageAttachment.swift downsampling constants: longest edge kept after
// downsampling (`maxDimension`) and the JPEG re-encode quality
// (`kCGImageDestinationLossyCompressionQuality`).
const MAX_DIMENSION = 1568
const JPEG_QUALITY = 0.85

interface PendingAttachment {
  id: string
  /** base64 JPEG, already downsampled. */
  data: string
  mimeType: string
  width: number
  height: number
}

interface ComposerProps {
  chat: ChatDetail
  terminalVisible: boolean
  onToggleTerminal: () => void
}

export default function Composer({ chat, terminalVisible, onToggleTerminal }: ComposerProps): JSX.Element {
  const app = useApp()
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [commandIndex, setCommandIndex] = useState(0)
  const [focused, setFocused] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const ready = app?.phase.kind === 'ready'
  const matching = matchingCommands(draft, chat.commands)
  const paletteVisible = matching.length > 0 && focused

  // Non-empty text OR at least one image, agent idle, app connected. There is
  // deliberately no check on acpSessionId — fresh chats get one lazily.
  const canSend =
    (draft.trim().length > 0 || attachments.length > 0) && !chat.isBusy && ready

  // Auto-focus on appear / chat switch.
  useEffect(() => {
    textareaRef.current?.focus()
  }, [chat.id])

  // Auto-grow: 2–12 lines (lineLimit(2...12) on the vertical TextField).
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 12 * 20)}px`
  }, [draft])

  const addAttachment = useCallback(async (blob: Blob): Promise<void> => {
    const attachment = await attachmentFrom(blob)
    // Failures are silent and local, per the spec: no thumbnail, no error.
    if (attachment) setAttachments((prev) => [...prev, attachment])
  }, [])

  const send = (): void => {
    let text = draft
    // Return on the palette: commands with no input hint run immediately;
    // ones with a hint complete to "/name " so the user can type arguments.
    if (paletteVisible && matching[commandIndex]) {
      const command = matching[commandIndex]
      if (command.inputHint) {
        setDraft('/' + command.name + ' ')
        return
      }
      text = '/' + command.name
    }
    const trimmed = text.trim()
    if (!((trimmed.length > 0 || attachments.length > 0) && !chat.isBusy && ready)) return
    const toSend = attachments.map((a) => ({ data: a.data, mimeType: a.mimeType }))
    setDraft('')
    setAttachments([])
    void call('send', chat.id, trimmed, toSend)
  }

  const moveCommand = (delta: number): void => {
    const count = matching.length
    if (count === 0) return
    setCommandIndex((i) => (i + delta + count) % count)
  }

  const acceptCommand = (): void => {
    const command = matching[commandIndex]
    if (command) setDraft('/' + command.name + ' ')
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (paletteVisible) {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        moveCommand(-1)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        moveCommand(1)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        acceptCommand()
        return
      }
    }
    // Enter sends, Shift+Enter inserts a newline; Ctrl/Cmd+Enter also sends.
    if (e.key === 'Enter' && (!e.shiftKey || e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      send()
    }
  }

  // Paste: only intercept when the clipboard actually holds an image — text
  // paste keeps flowing through the textarea's own handling.
  const onPaste = (e: React.ClipboardEvent): void => {
    const images = Array.from(e.clipboardData.items).filter(
      (item) => item.kind === 'file' && item.type.startsWith('image/')
    )
    if (images.length === 0) return
    e.preventDefault()
    for (const item of images) {
      const file = item.getAsFile()
      if (file) void addAttachment(file)
    }
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    for (const file of Array.from(e.dataTransfer.files)) {
      if (file.type.startsWith('image/')) void addAttachment(file)
    }
  }

  const onFilesPicked = (e: React.ChangeEvent<HTMLInputElement>): void => {
    for (const file of Array.from(e.target.files ?? [])) void addAttachment(file)
    e.target.value = ''
  }

  const placeholder = ready
    ? `Message Spettro — working in ${projectName(chat.projectPath)}`
    : 'Connecting…'

  return (
    <div className="composer-outer">
      <div
        className={'composer-card' + (focused ? ' composer-card--focused' : '')}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      >
        {paletteVisible && (
          <div className="command-palette">
            {matching.map((command, index) => (
              <button
                type="button"
                key={command.name}
                className={
                  'command-row' + (index === commandIndex ? ' command-row--selected' : '')
                }
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setDraft('/' + command.name + ' ')
                  setCommandIndex(index)
                }}
              >
                <span className="command-name">/{command.name}</span>
                {command.inputHint && <span className="command-hint">{command.inputHint}</span>}
                <span className="command-spacer" />
                {command.description && (
                  <span className="command-description">{command.description}</span>
                )}
              </button>
            ))}
            <div className="command-palette-divider" />
          </div>
        )}

        {attachments.length > 0 && (
          <div className="attachments-row">
            {attachments.map((attachment) => (
              <div className="attachment-thumb" key={attachment.id}>
                <img
                  src={`data:${attachment.mimeType};base64,${attachment.data}`}
                  alt=""
                  className="attachment-thumb-img"
                />
                <button
                  type="button"
                  className="attachment-remove"
                  title="Remove"
                  onClick={() =>
                    setAttachments((prev) => prev.filter((a) => a.id !== attachment.id))
                  }
                >
                  <XMarkCircleIcon />
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
          rows={2}
          value={draft}
          placeholder={placeholder}
          onChange={(next) => {
            setDraft(next)
            setCommandIndex(0)
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />

        <div className="composer-options-row">
          <button
            type="button"
            className="icon-btn"
            title="Attach an image"
            onClick={() => fileInputRef.current?.click()}
          >
            <PlusIcon />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={onFilesPicked}
          />

          <ConfigBar chat={chat} />

          <div className="composer-options-spacer" />

          <button
            type="button"
            className={'icon-btn' + (terminalVisible ? ' icon-btn--accent' : '')}
            title={terminalVisible ? 'Hide terminal' : 'Show terminal'}
            onClick={onToggleTerminal}
          >
            <TerminalIcon />
          </button>

          {chat.isBusy ? (
            <button
              type="button"
              className="icon-btn"
              title="Stop"
              onClick={() => void call('cancel', chat.id)}
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="button"
              className={'icon-btn send-btn' + (canSend ? ' send-btn--active' : '')}
              title="Send"
              disabled={!canSend}
              onClick={send}
            >
              <ArrowUpIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  )
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

// ---------------------------------------------------------------------------
// Icons (SF Symbol stand-ins)
// ---------------------------------------------------------------------------

function PlusIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 2.5v11M2.5 8h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function TerminalIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="m4.5 6 2 2-2 2M8 10.5h3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ArrowUpIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 13V3.5M3.5 8 8 3.5 12.5 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function StopIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
      <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" />
    </svg>
  )
}

function XMarkCircleIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="7" fill="rgba(0, 0, 0, 0.6)" />
      <path d="m5.6 5.6 4.8 4.8m0-4.8-4.8 4.8" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

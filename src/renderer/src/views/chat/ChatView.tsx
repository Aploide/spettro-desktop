// Port of Platforms/macOS/Views/ChatView.swift (doc 22): the detail column —
// header, scrolling transcript, composer, config bar, terminal drawer.
//
// Two things here are not in the Swift original, and both exist because a
// a multi-agent workflow is not one tool call but a hundred. The
// transcript is folded first (`groupTranscript`), so a run renders as the one
// card that owns its members instead of a wall of interleaved rows; and while
// a run is in flight the column can split, docking a live panel on the right.
//
// The panel is a *column*, not an overlay: it shares the row with the
// transcript and stops above the divider, so it can never sit on top of the
// composer or the terminal drawer, and the transcript's centred measure
// simply narrows around it.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { call, ensureChatLoaded, useChat } from '@renderer/state/store'
import { setTerminalVisible, useShell } from '@renderer/state/shell'
import TerminalDrawer from '@renderer/views/terminal/TerminalDrawer'
import { TranscriptRowView } from './transcript/TranscriptItemView'
import { activeRuns, groupTranscript } from './transcript/orchestration'
import { RunTicker } from './transcript/RunTicker'
import { Icon } from './transcript/ToolCallView'
import OrchestrationPanel from './OrchestrationPanel'
import ChatHeader, { projectName } from './ChatHeader'
import Composer, { type PromptSeed } from './Composer'
import StarterPrompts from './StarterPrompts'
import './chat.css'

/** UserDefaults key `spettro.orchestrationPanelVisible` — global, like the
 *  terminal drawer. Unlike the drawer it defaults to *shown*: the panel costs
 *  nothing until a run starts (it collapses itself to zero width when there is
 *  nothing live), so the discoverable default is the one that eventually
 *  reveals the feature. */
const PANEL_VISIBLE_KEY = 'spettro.orchestrationPanelVisible'

/** How close to the bottom (px) still counts as "pinned to the tail". */
const PIN_THRESHOLD = 64

export default function ChatView({ chatId }: { chatId: string }): JSX.Element {
  const chat = useChat(chatId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const manualPauseRef = useRef(false)
  const scrollTowardLatestRef = useRef(false)
  const touchYRef = useRef<number | null>(null)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const [promptSeed, setPromptSeed] = useState<PromptSeed | null>(null)
  // Global (Ctrl+` and the header toggle both flip it), not per chat.
  const terminalVisible = useShell((s) => s.terminalVisible)
  const [panelVisible, setPanelVisible] = useState(
    () => localStorage.getItem(PANEL_VISIBLE_KEY) !== '0'
  )

  useEffect(() => {
    void ensureChatLoaded(chatId)
    void call('openChat', chatId)
  }, [chatId])

  useEffect(() => {
    localStorage.setItem(PANEL_VISIBLE_KEY, panelVisible ? '1' : '0')
  }, [panelVisible])

  // The fold is pure and depends only on the items array, so it is safe to
  // memo on identity: the store replaces `items` whenever anything in the
  // transcript changes, and never mutates it in place.
  const items = chat?.items
  const rows = useMemo(() => (items ? groupTranscript(items) : []), [items])
  const live = useMemo(() => activeRuns(rows), [rows])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  const jumpToLatest = useCallback(() => {
    manualPauseRef.current = false
    scrollTowardLatestRef.current = false
    pinnedRef.current = true
    setShowJumpToLatest(false)
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [])

  // On appear / chat switch: jump to the bottom without animation (the Swift
  // view defers one run-loop turn; useLayoutEffect after render is the analog).
  const loaded = chat != null
  useLayoutEffect(() => {
    manualPauseRef.current = false
    scrollTowardLatestRef.current = false
    pinnedRef.current = true
    setShowJumpToLatest(false)
    scrollToBottom()
  }, [chatId, loaded, scrollToBottom])

  // Pin to the tail on new items and on streaming growth. `lastItemText` is
  // the same cheap signal ChatView.swift uses: the last message's text length,
  // falling back to the item count. Unlike the Mac app we release the pin
  // while the user has scrolled up, and re-engage it when they return.
  //
  // These deliberately watch `chat.items`, not `rows`. Folding *shrinks* the
  // rendered row count while a fan-out streams — twenty members and their
  // tool calls all land inside one card — so a row-count signal would go
  // quiet at exactly the moment the transcript is growing fastest, and the
  // tail would slide out from under a pinned reader.
  const itemCount = chat?.items.length ?? 0
  const lastItem = chat?.items[itemCount - 1]
  const lastItemText = lastItem?.kind === 'message' ? lastItem.message.text.length : itemCount
  useEffect(() => {
    if (pinnedRef.current) scrollToBottom()
  }, [itemCount, lastItemText, scrollToBottom])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const isAtLatest = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD
    if (manualPauseRef.current && !(scrollTowardLatestRef.current && isAtLatest)) {
      pinnedRef.current = false
      setShowJumpToLatest(true)
      return
    }
    if (isAtLatest) {
      manualPauseRef.current = false
      scrollTowardLatestRef.current = false
    }
    pinnedRef.current = isAtLatest
    setShowJumpToLatest(!isAtLatest)
  }, [])

  // A deliberate upward gesture opts out of follow mode immediately, even
  // when the reader is still within the tail threshold. New streamed tokens
  // must not pull the conversation out from under someone who is reading.
  const pauseFollowing = useCallback((deltaY: number) => {
    if (deltaY <= 0) {
      manualPauseRef.current = true
      scrollTowardLatestRef.current = false
      pinnedRef.current = false
      setShowJumpToLatest(true)
    } else {
      scrollTowardLatestRef.current = true
    }
  }, [])

  const onTouchStart = (event: React.TouchEvent<HTMLDivElement>): void => {
    touchYRef.current = event.touches[0]?.clientY ?? null
  }

  const onTouchMove = (event: React.TouchEvent<HTMLDivElement>): void => {
    const nextY = event.touches[0]?.clientY
    if (nextY === undefined || touchYRef.current === null) return
    pauseFollowing(touchYRef.current - nextY)
    touchYRef.current = nextY
  }

  if (!chat) return <div className="chat-view" />

  const showReopen = !panelVisible && live.length > 0

  return (
    <div className="chat-view">
      <ChatHeader chat={chat} />

      <div className="chat-body">
        <div
          className="chat-transcript"
          ref={scrollRef}
          onScroll={onScroll}
          onWheel={(event) => pauseFollowing(event.deltaY)}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={() => {
            touchYRef.current = null
          }}
          tabIndex={0}
          aria-label="Conversation"
        >
          <div className="chat-transcript-inner">
            {chat.items.length === 0 && (
              <WelcomeBanner
                projectPath={chat.projectPath}
                onPrompt={(text) => setPromptSeed({ text, nonce: Date.now() })}
              />
            )}
            {rows.map((row) => (
              <TranscriptRowView row={row} key={row.id} />
            ))}
            {(chat.isBusy || showReopen) && (
              <div className="chat-run-ticker">
                <RunTicker chat={chat} />
                {showReopen && (
                  <ReopenPanelChip count={live.length} onShow={() => setPanelVisible(true)} />
                )}
              </div>
            )}
            <div className="chat-bottom-anchor" />
          </div>
        </div>
        {chat.isBusy && showJumpToLatest && (
          <button
            type="button"
            className="chat-jump-latest"
            onClick={jumpToLatest}
            aria-label="Jump to latest message"
          >
            <Icon name="chevron.down" size={13} />
            <span>Latest message</span>
          </button>
        )}

        {/* Kept mounted and collapsed by :empty rather than unmounted: the
            panel holds a just-finished run for a beat before letting it go,
            and that settle only renders if the column is still there. */}
        <aside className="chat-orchestration">
          {panelVisible && (
            <OrchestrationPanel runs={live} onClose={() => setPanelVisible(false)} />
          )}
        </aside>
      </div>

      <div className="chat-divider" />

      <Composer chat={chat} promptSeed={promptSeed} />

      <TerminalDrawer
        projectPath={chat.projectPath}
        visible={terminalVisible}
        onClose={() => setTerminalVisible(false)}
      />
    </div>
  )
}

/**
 * The way back in after the user has hidden the panel.
 *
 * Hiding it is a setting, so a new run must not override it — but a fan-out
 * the user cannot see is worse than a column they closed. This sits with the
 * run ticker at the tail of the transcript, where the eye already is while
 * something is running, and says how many runs are live so the offer is worth
 * taking.
 */
function ReopenPanelChip({ count, onShow }: { count: number; onShow: () => void }): JSX.Element {
  return (
    <button
      className="chat-live-chip"
      type="button"
      onClick={onShow}
      title="Show the live orchestration panel"
    >
      <Icon name="sidebar.right" size={12} />
      <span>
        {count} run{count === 1 ? '' : 's'} live
      </span>
    </button>
  )
}

/** Empty-state banner shown until the first prompt is sent (doc 22): a
 *  greeting, the folder this session works in, and a few ways to start. */
function WelcomeBanner({
  projectPath,
  onPrompt
}: {
  projectPath: string
  onPrompt: (prompt: string) => void
}): JSX.Element {
  return (
    <div className="chat-welcome">
      <div className="chat-welcome-title">What should we build?</div>
      <div className="chat-welcome-sub">Working in {projectName(projectPath)}</div>
      <StarterPrompts onPrompt={onPrompt} />
    </div>
  )
}

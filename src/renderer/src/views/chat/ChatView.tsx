// Port of Platforms/macOS/Views/ChatView.swift (doc 22): the detail column —
// header, scrolling transcript, composer, config bar, terminal drawer.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { transcriptItemId } from '@shared/model'
import { call, ensureChatLoaded, useChat } from '@renderer/state/store'
import TerminalDrawer from '@renderer/views/terminal/TerminalDrawer'
import TranscriptItemView from './transcript/TranscriptItemView'
import { RunTicker } from './transcript/RunTicker'
import ChatHeader, { projectName } from './ChatHeader'
import AppIcon from '@renderer/views/shell/AppIcon'
import Composer from './Composer'
import './chat.css'

/** UserDefaults key `spettro.terminalDrawerVisible` — global, not per project. */
const TERMINAL_VISIBLE_KEY = 'spettro.terminalDrawerVisible'

/** How close to the bottom (px) still counts as "pinned to the tail". */
const PIN_THRESHOLD = 64

export default function ChatView({ chatId }: { chatId: string }): JSX.Element {
  const chat = useChat(chatId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [terminalVisible, setTerminalVisible] = useState(
    () => localStorage.getItem(TERMINAL_VISIBLE_KEY) === '1'
  )

  useEffect(() => {
    void ensureChatLoaded(chatId)
    void call('openChat', chatId)
  }, [chatId])

  useEffect(() => {
    localStorage.setItem(TERMINAL_VISIBLE_KEY, terminalVisible ? '1' : '0')
  }, [terminalVisible])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  // On appear / chat switch: jump to the bottom without animation (the Swift
  // view defers one run-loop turn; useLayoutEffect after render is the analog).
  const loaded = chat != null
  useLayoutEffect(() => {
    pinnedRef.current = true
    scrollToBottom()
  }, [chatId, loaded, scrollToBottom])

  // Pin to the tail on new items and on streaming growth. `lastItemText` is
  // the same cheap signal ChatView.swift uses: the last message's text length,
  // falling back to the item count. Unlike the Mac app we release the pin
  // while the user has scrolled up, and re-engage it when they return.
  const itemCount = chat?.items.length ?? 0
  const lastItem = chat?.items[itemCount - 1]
  const lastItemText = lastItem?.kind === 'message' ? lastItem.message.text.length : itemCount
  useEffect(() => {
    if (pinnedRef.current) scrollToBottom()
  }, [itemCount, lastItemText, scrollToBottom])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD
  }, [])

  if (!chat) return <div className="chat-view" />

  return (
    <div className="chat-view">
      <ChatHeader chat={chat} />

      <div className="chat-transcript" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-transcript-inner">
          {chat.items.length === 0 && <WelcomeBanner projectPath={chat.projectPath} />}
          {chat.items.map((item) => (
            <TranscriptItemView item={item} key={transcriptItemId(item)} />
          ))}
          {chat.isBusy && (
            <div className="chat-run-ticker">
              <RunTicker chat={chat} />
            </div>
          )}
          <div className="chat-bottom-anchor" />
        </div>
      </div>

      <div className="chat-divider" />

      <Composer
        chat={chat}
        terminalVisible={terminalVisible}
        onToggleTerminal={() => setTerminalVisible((v) => !v)}
      />

      <TerminalDrawer
        projectPath={chat.projectPath}
        visible={terminalVisible}
        onClose={() => setTerminalVisible(false)}
      />
    </div>
  )
}

/** Empty-state banner shown until the first prompt is sent (doc 22). */
function WelcomeBanner({ projectPath }: { projectPath: string }): JSX.Element {
  return (
    <div className="chat-welcome">
      <AppIcon size={104} />
      <div className="chat-welcome-title">How can I help?</div>
      <div className="chat-welcome-sub">Working in {projectName(projectPath)}</div>
    </div>
  )
}

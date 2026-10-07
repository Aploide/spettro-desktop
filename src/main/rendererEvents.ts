// The model's event stream on its way to the window: what the renderer
// needs, at most once a frame.
//
// The model speaks in fine-grained events — one chat-item per streamed chunk,
// a chat-meta per chat for every config change the CLI fans out, an app-state
// per persist — and each one crossing to the renderer is a structured clone
// of its payload plus a synchronous React commit there. At 500 agent updates
// a second that is hundreds of whole-item copies and commits a second, and a
// single slider release was 40-odd messages. So, between model and window:
//
// - chat-item upserts are kept per item and chat-meta patches merged per
//   chat, and go out together every FRAME_MS — an item sent then is its
//   newest state, and a new item keeps its place relative to the others;
// - chat-config-value (one option's value) likewise, per chat and option,
//   sent after the frame's chat-meta: a whole option set arriving later
//   supersedes the values queued before it;
// - app-state is sent once per flush, the newest, and only when it differs
//   from the last one sent: the model announces one with every persist (a
//   config reply, every live chat's config update), and most change nothing
//   the renderer shows — while each one sent re-renders the whole app;
// - chat-item and chat-meta for a chat the renderer has never loaded are
//   dropped: its store ignores them (it has nothing to upsert into), and it
//   gets the whole chat, current, when it opens it;
// - a chat-reset for a chat the renderer already holds is dropped: its copy
//   has been kept current by the upserts and patches (the transcript only
//   ever grows or changes in place), and the reset would be the whole chat
//   copied across again on every switch;
// - everything else (permissions, questions, chat-removed, …) goes at once,
//   after whatever is queued, so the order the renderer sees is the model's.
//
// The record of what the renderer holds is forgotten whenever the page
// (re)loads: a reloaded window starts with an empty store.

import type { MainEvent } from '../shared/ipc'
import { transcriptItemId } from '../shared/model'

type ChatItemEvent = Extract<MainEvent, { type: 'chat-item' }>
type ChatMetaEvent = Extract<MainEvent, { type: 'chat-meta' }>
type AppStateEvent = Extract<MainEvent, { type: 'app-state' }>
type ConfigValueEvent = Extract<MainEvent, { type: 'chat-config-value' }>

/** One frame at 60 Hz: as late as an update may land and still feel live. */
export const FRAME_MS = 16

export class RendererEventQueue {
  private readonly items = new Map<string, ChatItemEvent>()
  private readonly metas = new Map<string, ChatMetaEvent['meta']>()
  /** Per chat, per option id. */
  private readonly values = new Map<string, Map<string, ConfigValueEvent>>()
  private appState: AppStateEvent | null = null
  /** The last app-state sent, as JSON: a string, so a state object changed
   *  in place since can't make a new one look the same. */
  private sentAppState: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Chats whose detail the renderer holds (sent by chat-reset or getChat). */
  private readonly loaded = new Set<string>()

  constructor(
    private readonly send: (event: MainEvent) => void,
    private readonly frameMs = FRAME_MS
  ) {}

  push(event: MainEvent): void {
    switch (event.type) {
      case 'chat-item': {
        if (!this.loaded.has(event.chatId)) return
        // Map.set on a known key keeps its place: a new item stays after the
        // ones created before it, however often it changes afterwards.
        this.items.set(`${event.chatId}\u0000${transcriptItemId(event.item)}`, event)
        this.schedule()
        return
      }
      case 'chat-meta': {
        if (!this.loaded.has(event.chatId)) return
        const pending = this.metas.get(event.chatId)
        this.metas.set(event.chatId, pending ? { ...pending, ...event.meta } : event.meta)
        // A whole option set supersedes single values queued before it.
        if (event.meta.configOptions) this.values.delete(event.chatId)
        this.schedule()
        return
      }
      case 'chat-config-value': {
        if (!this.loaded.has(event.chatId)) return
        let byId = this.values.get(event.chatId)
        if (!byId) this.values.set(event.chatId, (byId = new Map()))
        byId.set(event.configId, event)
        this.schedule()
        return
      }
      case 'app-state':
        this.appState = event
        // A banner is in one snapshot only (the model clears it right after
        // sending): coalesced with the next, it would never be seen.
        if (event.state.banner) this.flush()
        else this.schedule()
        return
      case 'chat-reset':
        if (this.loaded.has(event.chat.id)) return
        this.flush()
        this.loaded.add(event.chat.id)
        this.send(event)
        return
      case 'chat-removed':
        this.flush()
        this.loaded.delete(event.chatId)
        this.send(event)
        return
      default:
        this.flush()
        this.send(event)
    }
  }

  /** The renderer is being handed this chat's detail directly (getChat). */
  markLoaded(chatId: string): void {
    this.flush()
    this.loaded.add(chatId)
  }

  /** Sends everything queued, now. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.items.size > 0) {
      const items = [...this.items.values()]
      this.items.clear()
      for (const event of items) this.send(event)
    }
    if (this.metas.size > 0) {
      const metas = [...this.metas.entries()]
      this.metas.clear()
      for (const [chatId, meta] of metas) this.send({ type: 'chat-meta', chatId, meta })
    }
    if (this.values.size > 0) {
      const values = [...this.values.values()]
      this.values.clear()
      for (const byId of values) for (const event of byId.values()) this.send(event)
    }
    if (this.appState) {
      const event = this.appState
      this.appState = null
      const json = JSON.stringify(event.state)
      if (json !== this.sentAppState) {
        this.sentAppState = json
        this.send(event)
      }
    }
  }

  /** The page is (re)loading: its store starts empty, and nothing queued
   *  for the old one applies. */
  reset(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.items.clear()
    this.metas.clear()
    this.values.clear()
    this.appState = null
    this.sentAppState = null
    this.loaded.clear()
  }

  dispose(): void {
    this.reset()
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.frameMs)
  }
}

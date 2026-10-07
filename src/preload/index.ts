import { contextBridge, ipcRenderer } from 'electron'
import {
  ACCENT_ARG,
  EVENT_CHANNEL,
  INVOKE_CHANNEL,
  type MainEvent,
  type SpettroBridge
} from '../shared/ipc'
import { DEFAULT_ACCENT, isAccent, type Accent } from '../shared/model'

/** The accent main launched this window with. Put on <html> here, before any
 *  page script runs, so the first frame is already in it (theme.css keys the
 *  accent tokens on data-accent); the renderer keeps it in step from then on. */
function launchAccent(): Accent {
  const arg = process.argv.find((a) => a.startsWith(ACCENT_ARG))
  const value = arg?.slice(ACCENT_ARG.length)
  return isAccent(value) ? value : DEFAULT_ACCENT
}

/** Just enough of the DOM for that: preload is built against Node's types. */
interface PageElement {
  setAttribute(name: string, value: string): void
}
interface PageDocument {
  documentElement: PageElement | null
}
interface PageGlobals {
  document?: PageDocument
  MutationObserver?: new (callback: () => void) => {
    observe(target: PageDocument, options: { childList: boolean }): void
    disconnect(): void
  }
}

/** Preload runs before the HTML is parsed, when the document has no <html>
 *  element yet, so a plain setAttribute here would land nowhere. Watch the
 *  document instead and mark <html> the moment the parser creates it: still
 *  before any page script or paint. */
function markAccent(accent: Accent): void {
  const page = globalThis as PageGlobals
  const doc = page.document
  if (!doc) return
  const mark = (): boolean => {
    if (!doc.documentElement) return false
    doc.documentElement.setAttribute('data-accent', accent)
    return true
  }
  if (mark() || !page.MutationObserver) return
  const observer = new page.MutationObserver(() => {
    if (mark()) observer.disconnect()
  })
  observer.observe(doc, { childList: true })
}

const accent = launchAccent()
markAccent(accent)

/** The page's event listeners, each with the kinds it asked for (null: all).
 *  One IPC listener feeds them, and an event crosses the context bridge —
 *  a full copy of it — only to the listeners that want it: the terminal
 *  never pays for a chat's transcript, nor the store for terminal output. */
interface Subscription {
  listener: (event: MainEvent) => void
  types: ReadonlySet<string> | null
}
const subscriptions = new Set<Subscription>()

ipcRenderer.on(EVENT_CHANNEL, (_e: Electron.IpcRendererEvent, event: MainEvent) => {
  for (const sub of subscriptions) {
    if (sub.types && !sub.types.has(event.type)) continue
    try {
      sub.listener(event)
    } catch (err) {
      // One listener's failure must not keep the event from the rest.
      console.error(err)
    }
  }
})

const bridge: SpettroBridge = {
  call: ((method: string, ...args: unknown[]) =>
    ipcRenderer.invoke(INVOKE_CHANNEL, method, ...args)) as SpettroBridge['call'],
  onEvent(listener: (event: MainEvent) => void, types?: readonly MainEvent['type'][]) {
    const sub: Subscription = { listener, types: types ? new Set(types) : null }
    subscriptions.add(sub)
    return () => {
      subscriptions.delete(sub)
    }
  },
  platform: process.platform,
  accent
}

contextBridge.exposeInMainWorld('spettro', bridge)

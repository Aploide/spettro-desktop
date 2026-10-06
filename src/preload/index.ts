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

const bridge: SpettroBridge = {
  call: ((method: string, ...args: unknown[]) =>
    ipcRenderer.invoke(INVOKE_CHANNEL, method, ...args)) as SpettroBridge['call'],
  onEvent(listener: (event: MainEvent) => void) {
    const handler = (_e: Electron.IpcRendererEvent, event: MainEvent): void => listener(event)
    ipcRenderer.on(EVENT_CHANNEL, handler)
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, handler)
  },
  platform: process.platform,
  accent
}

contextBridge.exposeInMainWorld('spettro', bridge)

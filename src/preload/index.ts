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
interface PageRoot {
  document?: { documentElement?: { setAttribute(name: string, value: string): void } | null }
}

const accent = launchAccent()
;(globalThis as PageRoot).document?.documentElement?.setAttribute('data-accent', accent)

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

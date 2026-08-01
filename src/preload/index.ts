import { contextBridge, ipcRenderer } from 'electron'
import { EVENT_CHANNEL, INVOKE_CHANNEL, type MainEvent, type SpettroBridge } from '../shared/ipc'

const bridge: SpettroBridge = {
  call: ((method: string, ...args: unknown[]) =>
    ipcRenderer.invoke(INVOKE_CHANNEL, method, ...args)) as SpettroBridge['call'],
  onEvent(listener: (event: MainEvent) => void) {
    const handler = (_e: Electron.IpcRendererEvent, event: MainEvent): void => listener(event)
    ipcRenderer.on(EVENT_CHANNEL, handler)
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, handler)
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('spettro', bridge)

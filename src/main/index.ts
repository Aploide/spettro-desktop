// Main-process entry: window creation, model construction, IPC registration,
// and event-push wiring (the port of SpettroApp.swift's app wiring).

import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { EVENT_CHANNEL, type MainEvent } from '../shared/ipc'
import { registerIpc, type IpcHandle } from './ipc'
import { AppModel } from './model/appModel'
import { buildRemoteBridge } from './model/remoteBridge'
import { RemoteHost } from './remote/host'
import { TerminalManager } from './terminal/panels'

let mainWindow: BrowserWindow | null = null
let model: AppModel | null = null
let terminals: TerminalManager | null = null
let remoteHost: RemoteHost | null = null
let ipcHandle: IpcHandle | null = null
let didShutdown = false

/** The app icon, for the window and the Linux taskbar (Windows takes it from
 *  the packaged exe). Bundled as an extra resource; falls back to the repo
 *  copy when running from source. */
function iconPath(): string {
  const packaged = join(process.resourcesPath, 'icon.png')
  if (existsSync(packaged)) return packaged
  return join(__dirname, '../../build/icon.png')
}

/** The window's own fill, painted before the renderer's first frame. It must
 *  be theme.css's --canvas for the active scheme, or the window flashes a
 *  different colour while the page loads. */
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#262624' : '#faf9f5'
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'Spettro',
    icon: iconPath(),
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** Pushes one MainEvent to the window (used by the terminal manager; the
 *  model's own events are forwarded by registerIpc). */
function pushToWindow(event: MainEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(EVENT_CHANNEL, event)
  }
}

app.whenReady().then(() => {
  const userDataDir = app.getPath('userData')
  model = new AppModel({
    userDataDir,
    appVersion: app.getVersion(),
    // A dev run has no installer to replace, and quitting is how the update
    // hands the machine over to the one it downloaded.
    isPackaged: app.isPackaged,
    quit: () => app.quit(),
    applyAppearance: (mode) => {
      nativeTheme.themeSource = mode
    }
  })

  // The stored appearance is applied before the window exists, so the first
  // frame — the window background included — is already in the right scheme.
  // From then on nativeTheme drives prefers-color-scheme in the renderer, and
  // `updated` (a user choice, or the OS flipping under 'system') keeps the
  // native background in step with the page.
  nativeTheme.themeSource = model.appearance
  nativeTheme.on('updated', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(windowBackground())
  })
  createWindow()

  terminals = new TerminalManager(pushToWindow)
  remoteHost = new RemoteHost(buildRemoteBridge(model), {
    dataDir: userDataDir,
    onStateChanged: (state) => model?.setRemoteState(state)
  })
  model.setRemoteState(remoteHost.getState())
  ipcHandle = registerIpc(model, terminals, remoteHost, getMainWindow)

  // Kick the model off once the window exists; events emitted from here on
  // are forwarded to the renderer by registerIpc.
  void model.bootstrap()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

function shutdownAll(): void {
  if (didShutdown) return
  didShutdown = true
  try {
    // Stops the agent and tells attached devices the disconnect is
    // deliberate (host/state with shuttingDown: true, per doc 34) — the
    // bridge relays that emission before the host itself goes down.
    model?.shutdown()
  } catch {
    // best-effort
  }
  try {
    remoteHost?.shutdown()
  } catch {
    // best-effort
  }
  try {
    terminals?.disposeAll()
  } catch {
    // best-effort
  }
  ipcHandle?.shutdown()
}

app.on('before-quit', shutdownAll)

app.on('window-all-closed', () => {
  app.quit()
})

app.on('quit', shutdownAll)

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

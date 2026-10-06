// Main-process entry: window creation, model construction, IPC registration,
// and event-push wiring (the port of SpettroApp.swift's app wiring).

import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { busyGuard } from '../shared/busyGuard'
import { EVENT_CHANNEL, type MainEvent } from '../shared/ipc'
import { wireAttention } from './attention'
import { registerIpc, type IpcHandle } from './ipc'
import { installAppMenu } from './menu'
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
/** Set once quitting has been decided (nothing running, Quit now, the work
 *  finished, or an update handing over) — from then on nothing asks. */
let quitApproved = false
/** The quit question is on screen; a second Ctrl+Q doesn't stack another. */
let askingQuit = false

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

  // Closing the window is quitting (window-all-closed quits), and by the
  // time before-quit runs the window — and the work in it — is gone. So the
  // question is asked here, before anything closes.
  mainWindow.on('close', (event) => {
    if (quitApproved || !shouldAskBeforeQuit()) return
    event.preventDefault()
    void askBeforeQuit()
  })

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
    // The update already asked (or waited) before getting this far.
    quit: () => {
      quitApproved = true
      app.quit()
    },
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
  installAppMenu((command) => pushToWindow({ type: 'menu', command }))

  terminals = new TerminalManager(pushToWindow)
  remoteHost = new RemoteHost(buildRemoteBridge(model), {
    dataDir: userDataDir,
    onStateChanged: (state) => model?.setRemoteState(state)
  })
  model.setRemoteState(remoteHost.getState())
  ipcHandle = registerIpc(model, terminals, remoteHost, getMainWindow)
  // The app badge and notifications for approvals and questions waiting.
  wireAttention(model, getMainWindow)

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

/** True when quitting now would stop something the user started. */
function shouldAskBeforeQuit(): boolean {
  return busyGuard('quit', model?.busyCount() ?? 0, terminals?.runningCount() ?? 0) !== null
}

/** "Spettro is working on 2 tasks — Quit when finished / Quit now / Cancel".
 *  Waiting keeps the window open with a note, and quits on its own once the
 *  last turn ends. */
async function askBeforeQuit(): Promise<void> {
  const guard = busyGuard('quit', model?.busyCount() ?? 0, terminals?.runningCount() ?? 0)
  if (!guard) {
    quitApproved = true
    app.quit()
    return
  }
  if (askingQuit) return
  askingQuit = true
  const buttons = [...(guard.whenFinishedLabel ? [guard.whenFinishedLabel] : []), guard.nowLabel, 'Cancel']
  const win = getMainWindow()
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    message: guard.title,
    detail: guard.message,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true
  }
  try {
    const { response } = win && !win.isDestroyed()
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options)
    const choice = buttons[response]
    if (choice === guard.nowLabel) {
      quitApproved = true
      app.quit()
    } else if (choice === guard.whenFinishedLabel && model) {
      model.notify('Spettro will quit when it finishes working.')
      // A second Ctrl+Q while waiting asks again (so Quit now stays one
      // keystroke away) instead of being swallowed.
      askingQuit = false
      await model.waitForIdle()
      quitApproved = true
      app.quit()
    }
  } finally {
    askingQuit = false
  }
}

app.on('before-quit', (event) => {
  // Ctrl+Q / the menu's Quit: ask first, the same as closing the window.
  if (!quitApproved && shouldAskBeforeQuit()) {
    event.preventDefault()
    void askBeforeQuit()
    return
  }
  quitApproved = true
  shutdownAll()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('quit', shutdownAll)

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

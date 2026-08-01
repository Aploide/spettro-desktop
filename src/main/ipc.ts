// The RendererApi implementation — routes every `spettro:invoke` call to the
// AppModel (and the terminal / remote-host managers), and forwards the
// model's MainEvent stream to the window on `spettro:event`.

import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { EVENT_CHANNEL, INVOKE_CHANNEL, type MainEvent, type RendererApi } from '../shared/ipc'
import type { AppModel } from './model/appModel'
import { gitStat } from './model/gitStat'
import { loadMemory, saveMemory } from './model/memoryStore'
import type { RemoteHost } from './remote/host'
import type { TerminalManager } from './terminal/panels'

export interface IpcHandle {
  /** Removes the invoke handler, detaches from the model, and disposes any
   *  terminals created through the renderer. */
  shutdown(): void
}

export function registerIpc(
  model: AppModel,
  terminals: TerminalManager,
  remoteHost: RemoteHost,
  getWindow: () => BrowserWindow | null
): IpcHandle {
  const termIds = new Set<string>()

  /** Keep AppStateDTO.remote in sync after direct remote-host calls; the
   *  host also pushes through onStateChanged, but a synchronous refresh
   *  makes the invoke's own app-state echo immediate. */
  const refreshRemoteState = (): void => {
    model.setRemoteState(remoteHost.getState())
  }

  const api: RendererApi = {
    // -- Bootstrap / state --------------------------------------------------
    getState: async () => model.getState(),
    getChat: async (chatId) => model.getChatDetail(chatId),

    // -- Lifecycle ----------------------------------------------------------
    retryBootstrap: async () => model.retryBootstrap(),
    installCLI: async () => model.installCLI(),
    useExplicitCLIPath: async (path) => model.useExplicitPath(path),
    chooseProject: async (path) => model.chooseProject(path),
    pickFolder: async () => {
      const win = getWindow()
      const options: Electron.OpenDialogOptions = {
        properties: ['openDirectory', 'createDirectory']
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0]
    },

    // -- Sessions -----------------------------------------------------------
    newChat: async (projectPath) => model.newChat(projectPath ?? model.defaultProjectPath).id,
    openChat: async (chatId) => model.openChat(chatId),
    closeChat: async (chatId) => model.closeChat(chatId),
    togglePin: async (chatId) => model.togglePin(chatId),
    toggleArchive: async (chatId) => model.toggleArchive(chatId),
    selectSession: async (chatId) => model.selectSession(chatId),

    // -- Prompting ----------------------------------------------------------
    send: async (chatId, text, attachments) => model.send(chatId, text, attachments, null),
    cancel: async (chatId) => model.cancel(chatId),

    // -- Config -------------------------------------------------------------
    setSelectOption: (chatId, configId, value) => model.setConfigValue(chatId, configId, value),
    setBoolOption: (chatId, configId, value) => model.setConfigValue(chatId, configId, value),

    // -- Permissions / questions --------------------------------------------
    resolvePermission: async (requestId, optionId) => model.resolvePermission(requestId, optionId),
    dismissPermission: async (requestId) => model.dismissPermission(requestId),
    answerQuestion: async (requestId, answers) => model.answerQuestion(requestId, answers),

    // -- Memory -------------------------------------------------------------
    loadMemory: async (scope, projectPath) =>
      loadMemory(scope, projectPath ?? model.memoryProjectPath()),
    saveMemory: async (scope, content, projectPath) =>
      saveMemory(content, scope, projectPath ?? model.memoryProjectPath()),

    // -- Terminal drawer ----------------------------------------------------
    terminalCreate: async (projectPath) => {
      const id = terminals.create(projectPath)
      termIds.add(id)
      return id
    },
    terminalWrite: async (termId, data) => terminals.write(termId, data),
    terminalResize: async (termId, cols, rows) => terminals.resize(termId, cols, rows),
    terminalDispose: async (termId) => {
      termIds.delete(termId)
      terminals.dispose(termId)
    },
    terminalList: async (projectPath) => terminals.list(projectPath),

    // -- Remote host --------------------------------------------------------
    remoteSetEnabled: async (enabled) => {
      await remoteHost.setEnabled(enabled)
      refreshRemoteState()
    },
    remoteOpenPairing: async () => {
      await remoteHost.openPairing()
      refreshRemoteState()
    },
    remoteClosePairing: async () => {
      remoteHost.closePairing()
      refreshRemoteState()
    },
    remoteRevokeDevice: async (deviceId) => {
      remoteHost.revokeDevice(deviceId)
      refreshRemoteState()
    },
    remoteRenameHost: async (name) => {
      remoteHost.renameHost(name)
      refreshRemoteState()
    },

    // -- Misc ---------------------------------------------------------------
    openExternal: async (url) => {
      await shell.openExternal(url)
    },
    showItemInFolder: async (path) => {
      shell.showItemInFolder(path)
    },
    gitStat: (projectPath) => gitStat(projectPath)
  }

  ipcMain.handle(INVOKE_CHANNEL, (_event, method: string, ...args: unknown[]) => {
    const fn = (api as unknown as Record<string, (...a: unknown[]) => unknown>)[method]
    if (typeof fn !== 'function') {
      throw new Error(`Unknown renderer API method: ${method}`)
    }
    return fn(...args)
  })

  const onEvent = (event: MainEvent): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(EVENT_CHANNEL, event)
    }
  }
  model.on('event', onEvent)

  return {
    shutdown: () => {
      model.off('event', onEvent)
      ipcMain.removeHandler(INVOKE_CHANNEL)
      for (const id of termIds) {
        try {
          terminals.dispose(id)
        } catch {
          // already gone
        }
      }
      termIds.clear()
    }
  }
}

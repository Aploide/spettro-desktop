// Shared test setup.
//
// `electron` has no implementation outside a running Electron process, and
// several main-process modules import it at load time for `app.getPath`.
// Rather than let that surface as an opaque module-resolution error in an
// unrelated test, it is stubbed here with the small surface the model layer
// actually touches.

import { vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/spettro-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false
  },
  ipcMain: { handle: () => undefined, on: () => undefined },
  shell: { openExternal: () => Promise.resolve() },
  nativeTheme: { themeSource: 'dark' }
}))

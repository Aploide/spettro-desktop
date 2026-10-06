// The application menu: File, Edit, View, Window, Help (plus the app menu on
// macOS). On Linux and Windows it stays hidden until Alt, as the window has
// always had it; what it adds there is a place where every command and its
// shortcut can be found, Help › Keyboard Shortcuts, and About.
//
// Items post a `menu` event to the renderer, which owns the actions. The
// shortcuts beside them come from shared/shortcuts.ts and are shown, not
// registered (`registerAccelerator: false`): a registered accelerator fires
// before the page sees the key, which would take Ctrl+N, Ctrl+K and Ctrl+L
// away from a shell running in the terminal drawer. The renderer already
// handles every one of them, and stands back while the terminal has focus.

import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { acceleratorFor, shortcutFor, type MenuCommand } from '../shared/shortcuts'

const WEBSITE = 'https://spettro.app'
const ISSUES = 'https://github.com/aploide/spettro-desktop/issues'

export function installAppMenu(send: (command: MenuCommand) => void): void {
  const mac = process.platform === 'darwin'

  const item = (label: string, command: MenuCommand): MenuItemConstructorOptions => {
    const shortcut = shortcutFor(command)
    const accelerator = shortcut ? acceleratorFor(shortcut) : undefined
    return {
      label,
      click: () => send(command),
      ...(accelerator ? { accelerator, registerAccelerator: false } : {})
    }
  }

  // Off the Mac, Chromium already handles the editing keys in every field,
  // and xterm needs Ctrl+C to reach the shell: the items are listed, not
  // bound. On the Mac the Edit menu is what makes ⌘C work at all.
  const edit = (role: MenuItemConstructorOptions['role'], label: string, accelerator: string): MenuItemConstructorOptions =>
    mac ? { role } : { role, label, accelerator, registerAccelerator: false }

  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              item('About Spettro', 'about'),
              { type: 'separator' },
              item('Settings…', 'settings'),
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          } as MenuItemConstructorOptions
        ]
      : []),
    {
      label: 'File',
      submenu: [
        item('New Session', 'new-session'),
        item('Open Folder…', 'open-folder'),
        { type: 'separator' },
        ...(mac ? [] : [item('Settings…', 'settings'), { type: 'separator' } as MenuItemConstructorOptions]),
        // Ctrl+W deletes a word in a shell; only the Mac binds it here.
        mac ? { role: 'close' } : { role: 'close', label: 'Close Window', accelerator: 'Ctrl+W', registerAccelerator: false },
        ...(mac ? [] : [{ role: 'quit', label: 'Quit Spettro' } as MenuItemConstructorOptions])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        edit('undo', 'Undo', 'CmdOrCtrl+Z'),
        edit('redo', 'Redo', 'CmdOrCtrl+Shift+Z'),
        { type: 'separator' },
        edit('cut', 'Cut', 'CmdOrCtrl+X'),
        edit('copy', 'Copy', 'CmdOrCtrl+C'),
        edit('paste', 'Paste', 'CmdOrCtrl+V'),
        edit('selectAll', 'Select All', 'CmdOrCtrl+A')
      ]
    },
    {
      label: 'View',
      submenu: [
        item('Show or Hide Sidebar', 'toggle-sidebar'),
        item('Show or Hide Terminal', 'toggle-terminal'),
        item('Find a Session…', 'quick-switcher'),
        item('Go to Message Field', 'focus-composer'),
        { type: 'separator' },
        item('Workflows…', 'workflows'),
        item('Remote Access…', 'remote'),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as MenuItemConstructorOptions])
      ]
    },
    {
      label: 'Window',
      // Ctrl+M is Return to a shell, so off the Mac it isn't bound.
      submenu: mac
        ? [{ role: 'minimize' }, { role: 'zoom' }]
        : [{ role: 'minimize', accelerator: 'Ctrl+M', registerAccelerator: false }]
    },
    {
      role: 'help',
      submenu: [
        item('Keyboard Shortcuts', 'shortcuts'),
        { type: 'separator' },
        { label: 'Spettro Website', click: () => void shell.openExternal(WEBSITE) },
        { label: 'Report a Problem…', click: () => void shell.openExternal(ISSUES) },
        ...(mac ? [] : [{ type: 'separator' } as MenuItemConstructorOptions, item('About Spettro', 'about')])
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

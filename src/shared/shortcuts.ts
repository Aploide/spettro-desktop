// Every keyboard shortcut, written down once.
//
// The application menu (main/menu.ts) shows them beside its items, Settings ›
// Keyboard Shortcuts lists them, and tooltips quote them — all from this
// table, so the three can't drift apart. The keys themselves are handled in
// the renderer (App.tsx, the composer, the prompt cards): the menu registers
// none of them, because a menu accelerator fires before the page sees the key
// and would take Ctrl+N away from a shell running in the terminal.

/** What a menu item asks the window to do. */
export type MenuCommand =
  | 'new-session'
  | 'open-folder'
  | 'settings'
  | 'toggle-sidebar'
  | 'toggle-terminal'
  | 'quick-switcher'
  | 'focus-composer'
  | 'workflows'
  | 'remote'
  | 'shortcuts'
  | 'about'

export interface Shortcut {
  label: string
  /** The key as written: "N", ",", "`", "Enter", "1–9". */
  key: string
  /** Cmd on macOS, Ctrl elsewhere. */
  mod?: boolean
  shift?: boolean
  /** Ctrl on every platform (the terminal toggle, as editors have it). */
  ctrl?: boolean
  group: 'Sessions' | 'Window' | 'Writing' | 'Approvals and questions'
  /** The menu item this is, when it has one. */
  command?: MenuCommand
}

export const SHORTCUTS: Shortcut[] = [
  { group: 'Sessions', label: 'New session', key: 'N', mod: true, command: 'new-session' },
  { group: 'Sessions', label: 'Find a session', key: 'K', mod: true, command: 'quick-switcher' },
  { group: 'Sessions', label: 'Go to session 1 to 9', key: '1–9', mod: true },
  { group: 'Sessions', label: 'Rename the session (in the sidebar)', key: 'F2' },
  { group: 'Window', label: 'Show or hide the sidebar', key: 'B', mod: true, command: 'toggle-sidebar' },
  { group: 'Window', label: 'Show or hide the terminal', key: '`', ctrl: true, command: 'toggle-terminal' },
  { group: 'Window', label: 'Settings', key: ',', mod: true, command: 'settings' },
  { group: 'Window', label: 'Workflows', key: 'W', mod: true, shift: true, command: 'workflows' },
  { group: 'Window', label: 'Remote access', key: 'R', mod: true, shift: true, command: 'remote' },
  { group: 'Writing', label: 'Go to the message field', key: 'L', mod: true, command: 'focus-composer' },
  { group: 'Writing', label: 'Send', key: 'Enter' },
  { group: 'Writing', label: 'New line', key: 'Enter', shift: true },
  { group: 'Writing', label: 'Stop Spettro', key: 'Esc' },
  { group: 'Writing', label: 'Next mode (Plan, Coding, Ask)', key: 'Tab', shift: true },
  { group: 'Writing', label: 'Commands', key: '/' },
  { group: 'Writing', label: 'Mention a file', key: '@' },
  { group: 'Approvals and questions', label: 'Allow once · Always allow · Deny', key: '1 · 2 · 3' },
  { group: 'Approvals and questions', label: 'Deny, or skip a question', key: 'Esc' },
  { group: 'Approvals and questions', label: 'Send an answer you typed', key: 'Enter', mod: true }
]

/** "⇧⌘R" on a Mac, "Ctrl+Shift+R" elsewhere. */
export function shortcutText(s: Pick<Shortcut, 'key' | 'mod' | 'shift' | 'ctrl'>, mac: boolean): string {
  if (mac) {
    return `${s.ctrl ? '⌃' : ''}${s.shift ? '⇧' : ''}${s.mod ? '⌘' : ''}${s.key}`
  }
  const parts: string[] = []
  if (s.mod || s.ctrl) parts.push('Ctrl')
  if (s.shift) parts.push('Shift')
  parts.push(s.key)
  return parts.join('+')
}

/** The Electron accelerator for a menu item's shortcut, or undefined when the
 *  key can't be written as one ("1–9"). */
export function acceleratorFor(s: Shortcut): string | undefined {
  if (!/^[A-Z0-9,`]$/.test(s.key)) return undefined
  const parts: string[] = []
  if (s.ctrl) parts.push('Ctrl')
  else if (s.mod) parts.push('CmdOrCtrl')
  if (s.shift) parts.push('Shift')
  parts.push(s.key)
  return parts.join('+')
}

export function shortcutFor(command: MenuCommand): Shortcut | undefined {
  return SHORTCUTS.find((s) => s.command === command)
}

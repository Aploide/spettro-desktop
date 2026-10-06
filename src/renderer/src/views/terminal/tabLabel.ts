// What a terminal tab is called.
//
// Shells announce a window title (an OSC escape) on every prompt, and the
// usual one is `user@host:/the/whole/path` — clipped mid-path in a tab, and
// the same for every tab in the project. The tab keeps the folder's name for
// the shell itself and names only what is running in it ("npm test",
// "vim notes.md"); the full title stays in the tab's tooltip.

const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'tcsh',
  'csh',
  'nu',
  'pwsh',
  'powershell',
  'cmd'
])

export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** True for a title that only says "a shell, somewhere": the prompt's own. */
function isShellTitle(title: string): boolean {
  // user@host:~/path, user@host: /path
  if (/^[^\s@]+@[^\s:]+:/.test(title)) return true
  // a bare path: ~/proj, /tmp/x, C:\Users\me
  if (/^(~|\/|[A-Za-z]:\\)/.test(title)) return true
  // the shell's own name, as a login shell (-zsh) or with its path
  const first = basename(title.split(/\s+/)[0]).replace(/^-/, '').replace(/\.exe$/i, '')
  return SHELLS.has(first.toLowerCase()) || /^windows powershell$/i.test(title)
}

/** The tab's label: the folder's name, or the command running in it. */
export function terminalTabLabel(shellTitle: string, projectPath: string): string {
  const title = shellTitle.trim()
  if (title === '' || isShellTitle(title)) return basename(projectPath)
  return title
}

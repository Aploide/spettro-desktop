// JS-side helpers for the design system (companion to theme.css).
// Port of Theme.modeColor from Theme.swift.

/** The accent as text (darker than the fill on light), since a mode tint is
 *  mostly a chip's label colour. */
const ACCENT = 'var(--accent-text)'

/** Per-agent-mode tint, matching modeColor() in the TUI's styles.go. Accepts a
 *  manifest color name ("green", "cyan", …) or a mode id ("plan", "coding").
 *  Returns a `var(--mode-*)` reference rather than a colour, so the value
 *  follows the scheme: theme.css holds a tuned light and dark value for each,
 *  and an inline style built from this re-tints itself on a theme switch.
 *  Anything unrecognised gets `fallback`. */
export function modeColor(name: string, fallback: string = ACCENT): string {
  switch (name.toLowerCase()) {
    case 'blue':
    case 'green':
    case 'cyan':
    case 'yellow':
    case 'magenta':
    case 'purple':
    case 'red':
      return `var(--mode-${name.toLowerCase()})`
    case 'plan':
      return 'var(--mode-plan)'
    case 'planning':
      return 'var(--mode-blue)'
    case 'coding':
    case 'code':
      return 'var(--mode-coding)'
    case 'chat':
    case 'ask':
      return 'var(--mode-ask)'
    default:
      return fallback
  }
}

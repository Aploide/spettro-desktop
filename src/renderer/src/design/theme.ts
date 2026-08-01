// JS-side helpers for the design system (companion to theme.css).
// Port of Theme.modeColor from Theme.swift.

const ACCENT = 'var(--accent)'

/** Per-agent-mode tint, matching modeColor() in the TUI's styles.go. Accepts a
 *  manifest color name ("green", "cyan", …) or a mode id ("plan", "coding"). */
export function modeColor(name: string): string {
  switch (name.toLowerCase()) {
    case 'blue':
      return '#a78bfa'
    case 'green':
      return '#34d399'
    case 'cyan':
      return '#60a5fa'
    case 'yellow':
      return '#f59e0b'
    case 'magenta':
      return '#c084fc'
    case 'purple':
      return '#bd93f9'
    case 'red':
      return '#ef4444'
    case 'plan':
      return '#bd93f9'
    case 'planning':
      return '#a78bfa'
    case 'coding':
    case 'code':
      return '#34d399'
    case 'chat':
    case 'ask':
      return '#60a5fa'
    default:
      return ACCENT
  }
}

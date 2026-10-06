// The app's one icon set: inline SVG stand-ins for the SF Symbols the Swift
// views use, all drawn on a 16-unit grid at a 1.5 stroke (heavier only where a
// glyph is a chevron or a mark that must read at 8px) and painted in
// currentColor, so the surrounding text style tints them.
//
// `Icon` looks a glyph up by its SF Symbol name. The named components below
// are the shell's and the provider views' existing API (FolderIcon, KeyIcon,
// …), now thin wrappers over the same registry; their old modules re-export
// them so no import had to change. Knock-out details (the x in
// xmark.circle.fill) are stroked in var(--canvas), which re-colours itself
// with the theme.

import type { CSSProperties, JSX, ReactNode } from 'react'

export type IconName =
  | 'doc.text'
  | 'pencil'
  | 'trash'
  | 'arrow.right.doc.on.clipboard'
  | 'magnifyingglass'
  | 'terminal'
  | 'brain'
  | 'flame'
  | 'globe'
  | 'arrow.triangle.2.circlepath'
  | 'wrench.and.screwdriver'
  | 'person.crop.circle.badge.plus'
  | 'xmark.circle.fill'
  | 'chevron.right'
  | 'chevron.down'
  | 'info.circle.fill'
  | 'exclamationmark.triangle.fill'
  | 'flowchart'
  | 'bolt'
  | 'checkmark.circle.fill'
  | 'arrow.triangle.branch'
  | 'arrow.counterclockwise'
  | 'sidebar.right'
  | 'sidebar.left'
  | 'ellipsis'
  | 'square.and.pencil'
  | 'folder'
  | 'folder.fill'
  | 'folder.badge.plus'
  | 'pin.fill'
  | 'archivebox.fill'
  | 'gearshape'
  | 'iphone'
  | 'iphone.radiowaves'
  | 'plus'
  | 'arrow.down.circle.fill'
  | 'exclamationmark.triangle'
  | 'checkmark.seal.fill'
  | 'checkmark'
  | 'key'
  | 'person.crop.circle'
  | 'desktopcomputer'
  | 'star'
  | 'star.fill'
  | 'pause.circle.fill'
  | 'stop.circle.fill'
  | 'circle.dashed'
  | 'arrow.down'

/** gearshape: eight teeth round a ring, computed once. */
const GEAR_TEETH = Array.from({ length: 8 }, (_, i) => {
  const a = (i * Math.PI) / 4
  return (
    <line
      key={i}
      x1={8 + 4.7 * Math.cos(a)}
      y1={8 + 4.7 * Math.sin(a)}
      x2={8 + 6.8 * Math.cos(a)}
      y2={8 + 6.8 * Math.sin(a)}
    />
  )
})

const STROKE_ICONS: Record<string, ReactNode> = {
  'doc.text': (
    <>
      <path d="M4.5 1.5H9l3 3v9.5a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5z" />
      <path d="M9 1.5V5h3.5" />
      <path d="M5.8 8.5h4.4M5.8 11h4.4" />
    </>
  ),
  pencil: (
    <>
      <path d="M2.5 13.5l.8-3.2 8-8a1.1 1.1 0 0 1 1.55 0l.85.85a1.1 1.1 0 0 1 0 1.55l-8 8-3.2.8z" />
      <path d="M10.4 3.4l2.2 2.2" />
    </>
  ),
  trash: (
    <>
      <path d="M2.5 4h11" />
      <path d="M5.5 4V2.5h5V4" />
      <path d="M3.8 4l.65 9a1 1 0 0 0 1 .9h5.1a1 1 0 0 0 1-.9l.65-9" />
      <path d="M6.5 6.5v5M9.5 6.5v5" />
    </>
  ),
  'arrow.right.doc.on.clipboard': (
    <>
      <path d="M3 2.5h6.5v11H3z" />
      <path d="M8 8h6M11.5 5.5L14 8l-2.5 2.5" />
    </>
  ),
  magnifyingglass: (
    <>
      <circle cx="6.5" cy="6.5" r="4.5" />
      <path d="M9.8 9.8L14 14" />
    </>
  ),
  terminal: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4 6l2.5 2L4 10" />
      <path d="M8 10.5h4" />
    </>
  ),
  brain: (
    <>
      <path d="M8 2.5a3 3 0 0 0-3 3 2.5 2.5 0 0 0-1.4 4.4A2.5 2.5 0 0 0 6 13.5c.8 0 1.5-.35 2-.9.5.55 1.2.9 2 .9a2.5 2.5 0 0 0 2.4-3.6A2.5 2.5 0 0 0 11 5.5a3 3 0 0 0-3-3z" />
      <path d="M8 3.5v9" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="6" />
      <ellipse cx="8" cy="8" rx="2.6" ry="6" />
      <path d="M2 8h12" />
    </>
  ),
  'arrow.triangle.2.circlepath': (
    <>
      <path d="M12.7 6.3A5 5 0 0 0 4 4.5" />
      <path d="M3.6 2v3h3" />
      <path d="M3.3 9.7A5 5 0 0 0 12 11.5" />
      <path d="M12.4 14v-3h-3" />
    </>
  ),
  'wrench.and.screwdriver': (
    <>
      <path d="M13.6 4.4a3.8 3.8 0 0 1-5 4.8l-4.1 4.1a1.35 1.35 0 0 1-1.9-1.9l4.1-4.1a3.8 3.8 0 0 1 4.8-5L9.2 4.6l2.2 2.2 2.2-2.4z" />
    </>
  ),
  'person.crop.circle.badge.plus': (
    <>
      <circle cx="7.2" cy="7.2" r="5.7" />
      <circle cx="7.2" cy="5.8" r="1.8" />
      <path d="M3.9 11.3a4 4 0 0 1 6.6 0" />
      <path d="M12.7 10.8v3.4M11 12.5h3.4" />
    </>
  ),
  'chevron.right': <path d="M5.5 3l5 5-5 5" strokeWidth="2.4" />,
  'chevron.down': <path d="M3 5.5l5 5 5-5" strokeWidth="2.4" />,
  // A workflow is a plan drawn before the run: one root fanning into phases.
  // A root that fans out into two: the shape of a phase that dispatches and a
  // phase that collects. Drawn on a wider, flatter grid than the first attempt
  // — squat 5x3 nodes with a full-width bus — because the earlier 4.4x3.2
  // boxes with a 1-unit radius rendered as three rounded blobs the moment the
  // glyph was used above ~20px.
  flowchart: (
    <>
      <rect x="5.5" y="1.4" width="5" height="3" rx="0.8" />
      <rect x="1.1" y="11.6" width="5" height="3" rx="0.8" />
      <rect x="9.9" y="11.6" width="5" height="3" rx="0.8" />
      <path d="M8 4.4v3.2" />
      <path d="M3.6 11.6V7.6h8.8v4" />
    </>
  ),
  // Ultra, the stop past Max on the thinking slider: a flame with its hot
  // inner tongue.
  flame: (
    <>
      <path d="M8 1.5c.5 2.4 4.3 4.2 4.3 8.2A4.3 4.3 0 0 1 8 14.5a4.3 4.3 0 0 1-4.3-4.8c.1-1.6.9-2.8 1.8-3.5.1 1.3.6 2.2 1.5 2.6C6.9 6.3 7.2 3.8 8 1.5z" />
      <path d="M8 14.5c-1.2 0-2-.9-2-2.1 0-1.4 1.1-2.1 2-3.4.9 1.3 2 2 2 3.4 0 1.2-.8 2.1-2 2.1z" />
    </>
  ),
  // Ultra: substantial tasks run as multi-agent workflows.
  bolt: <path d="M9.3 1.5L3.6 9.3h3.5l-.4 5.2 5.7-7.8H8.9z" />,
  // A git branch: one line splitting off another.
  'arrow.triangle.branch': (
    <>
      <circle cx="4.4" cy="3.4" r="1.8" />
      <circle cx="4.4" cy="12.6" r="1.8" />
      <circle cx="11.6" cy="3.4" r="1.8" />
      <path d="M4.4 5.2v5.6" />
      <path d="M11.6 5.2v1.5a3.4 3.4 0 0 1-3.4 3.4H4.4" />
    </>
  ),
  // A workflow member the CLI reports in a state it does not name: not yet
  // running, so it must not read as a spinner or a finished dot.
  'circle.dashed': <circle cx="8" cy="8" r="5.6" strokeDasharray="2.2 2.2" />,
  // "Continued below": the run went on in a card further down.
  'arrow.down': <path d="M8 2.75v10.5M3.75 9 8 13.25 12.25 9" />,
  // Replayed from the resume journal rather than re-run.
  'arrow.counterclockwise': (
    <>
      <path d="M2.7 9.4A5.5 5.5 0 1 0 4.1 4.1" />
      <path d="M7.1 3.9L4.1 4.1 4.4 1.1" />
    </>
  ),
  'sidebar.right': (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M10.3 2.5v11" />
    </>
  ),
  'sidebar.left': (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M5.7 2.5v11" />
    </>
  ),
  // Dots are filled discs, so they stay round at any stroke weight.
  ellipsis: (
    <>
      <circle cx="3.5" cy="8" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="1.15" fill="currentColor" stroke="none" />
    </>
  ),
  // New session: a page with a pen over its corner.
  'square.and.pencil': (
    <>
      <path d="M13 9v3.5a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1H7" />
      <path d="M12.1 1.9a1.2 1.2 0 0 1 1.7 1.7L8.4 9l-2.3.6.6-2.3z" />
    </>
  ),
  // ---- shell + provider glyphs (formerly shell/icons.tsx, providers/icons.tsx)
  folder: (
    <path d="M1.75 4.25c0-.55.45-1 1-1h3.1c.3 0 .58.13.77.36l.97 1.14h5.66c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z" />
  ),
  'folder.badge.plus': (
    <>
      <path d="M14.25 7v4.75c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1v-7.5c0-.55.45-1 1-1h3.1c.3 0 .58.13.77.36l.97 1.14h5.66" />
      <path d="M12.75 1.5v4M10.75 3.5h4" />
    </>
  ),
  gearshape: (
    <>
      {GEAR_TEETH}
      <circle cx="8" cy="8" r="4" />
      <circle cx="8" cy="8" r="1.4" />
    </>
  ),
  iphone: (
    <>
      <rect x="5.25" y="2" width="5.5" height="12" rx="1.4" />
      <path d="M7.2 12.2h1.6" />
    </>
  ),
  'iphone.radiowaves': (
    <>
      <rect x="5.25" y="2" width="5.5" height="12" rx="1.4" />
      <path d="M7.2 12.2h1.6" />
      <path d="M3 5.4a6 6 0 0 0 0 5.2M13 5.4a6 6 0 0 1 0 5.2" />
    </>
  ),
  plus: <path d="M8 2.75v10.5M2.75 8h10.5" strokeWidth="1.8" />,
  'exclamationmark.triangle': (
    <>
      <path d="M8 1.9L15 13.6c.3.5-.05 1.15-.65 1.15H1.65c-.6 0-.95-.65-.65-1.15z" />
      <path d="M8 6v4" />
      <circle cx="8" cy="12.4" r="0.8" fill="currentColor" stroke="none" />
    </>
  ),
  checkmark: <path d="M3.2 8.4 6.4 11.6 12.8 4.6" strokeWidth="1.8" />,
  key: (
    <>
      <circle cx="5.2" cy="5.2" r="2.9" />
      <circle cx="5.2" cy="5.2" r="0.85" fill="currentColor" stroke="none" />
      <path d="M7.4 7.4 13.4 13.4M11.5 11.5l-1.5 1.5M13 10l-1.5 1.5" />
    </>
  ),
  'person.crop.circle': (
    <>
      <circle cx="8" cy="8" r="6.6" />
      <circle cx="8" cy="6.3" r="2.3" />
      <path d="M3.6 13.2a4.9 4.9 0 0 1 8.8 0" />
    </>
  ),
  desktopcomputer: (
    <>
      <rect x="1.6" y="2.2" width="12.8" height="9" rx="1.2" />
      <path d="M6 13.6h4M8 11.2v2.4" />
    </>
  ),
  star: <path d="M8 1.9l1.85 3.9 4.15.6-3 3 .7 4.3L8 11.7l-3.7 2 .7-4.3-3-3 4.15-.6z" />,
  'star.fill': (
    <path
      d="M8 1.9l1.85 3.9 4.15.6-3 3 .7 4.3L8 11.7l-3.7 2 .7-4.3-3-3 4.15-.6z"
      fill="currentColor"
    />
  )
}

const FILLED_ICONS: Record<string, ReactNode> = {
  'checkmark.circle.fill': (
    <>
      <circle cx="8" cy="8" r="7" fill="currentColor" stroke="none" />
      <path d="M4.9 8.2l2.1 2.2 4.1-4.6" stroke="var(--canvas)" strokeWidth="1.7" />
    </>
  ),
  // A run waiting at a checkpoint: alive, idle, not hung.
  'pause.circle.fill': (
    <>
      <circle cx="8" cy="8" r="7" fill="currentColor" stroke="none" />
      <path d="M6.4 5.4v5.2M9.6 5.4v5.2" stroke="var(--canvas)" strokeWidth="1.6" />
    </>
  ),
  // A run ended on purpose: neither a tick nor a cross.
  'stop.circle.fill': (
    <>
      <circle cx="8" cy="8" r="7" fill="currentColor" stroke="none" />
      <rect x="5.6" y="5.6" width="4.8" height="4.8" rx="0.8" fill="var(--canvas)" stroke="none" />
    </>
  ),
  'xmark.circle.fill': (
    <>
      <circle cx="8" cy="8" r="7" fill="currentColor" stroke="none" />
      <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="var(--canvas)" strokeWidth="1.6" />
    </>
  ),
  'info.circle.fill': (
    <>
      <circle cx="8" cy="8" r="7" fill="currentColor" stroke="none" />
      <path d="M8 7.2v3.8" stroke="var(--canvas)" strokeWidth="1.6" />
      <circle cx="8" cy="4.6" r="1" fill="var(--canvas)" stroke="none" />
    </>
  ),
  'exclamationmark.triangle.fill': (
    <>
      <path
        d="M8 1.8l6.9 11.6a.9.9 0 0 1-.78 1.35H1.88a.9.9 0 0 1-.78-1.35z"
        fill="currentColor"
        stroke="none"
      />
      <path d="M8 6v4" stroke="var(--canvas)" strokeWidth="1.5" />
      <circle cx="8" cy="12.2" r=".9" fill="var(--canvas)" stroke="none" />
    </>
  ),
  'folder.fill': (
    <path
      d="M1.75 4.25c0-.55.45-1 1-1h3.1c.3 0 .58.13.77.36l.97 1.14h5.66c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z"
      fill="currentColor"
    />
  ),
  'pin.fill': (
    <path
      d="M9.6 1.2l5.2 5.2-2.5.7-2.1 2.1-.4 3.4-2.6-2.6-4 4-.9-.9 4-4L3.7 6.5l3.4-.4 2.1-2.1z"
      fill="currentColor"
    />
  ),
  'archivebox.fill': (
    <>
      <rect x="1.5" y="2.5" width="13" height="3" rx="0.75" fill="currentColor" />
      <path d="M2.5 6.5h11v6c0 .55-.45 1-1 1h-9c-.55 0-1-.45-1-1z" fill="currentColor" />
      <path d="M6 9h4" stroke="var(--canvas)" strokeWidth="1.4" />
    </>
  ),
  'arrow.down.circle.fill': (
    <>
      <circle cx="8" cy="8" r="6.75" fill="currentColor" />
      <path d="M8 4.5v6.5M5.2 8.6L8 11.4l2.8-2.8" stroke="var(--canvas)" strokeWidth="1.5" />
    </>
  ),
  'checkmark.seal.fill': (
    <path
      d="M8 .8a7.2 7.2 0 1 0 0 14.4A7.2 7.2 0 0 0 8 .8zm-.9 10.6L3.9 8.2l1.2-1.2 2 2 4-4 1.2 1.2z"
      fill="currentColor"
    />
  )
}

export function Icon({
  name,
  size = 12,
  className,
  style
}: {
  name: IconName | string
  size?: number
  className?: string
  style?: CSSProperties
}): JSX.Element {
  const filled = FILLED_ICONS[name]
  const children = filled ?? STROKE_ICONS[name] ?? STROKE_ICONS['wrench.and.screwdriver']
  return (
    <svg
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={strokeFor(size)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/**
 * Stroke width in viewBox units for a given rendered size.
 *
 * These glyphs live at 8–14px, where a flat 1.5 is right. The same 1.5 on a
 * 40px empty-state icon is a 3.75px stroke — heavy enough that the shapes
 * close up and the icon reads as a blob rather than a diagram. Past the row
 * sizes the stroke thins toward a constant *rendered* weight, so a glyph looks
 * like itself at any size; below that nothing changes, because every icon in
 * the transcript was drawn against 1.5 and should stay exactly as it is.
 */
function strokeFor(size: number): number {
  if (size <= 16) return 1.5
  return Math.max(0.9, (1.5 * 16) / size)
}

// ---------------------------------------------------------------------------
// Named glyphs (the shell and provider views' API)
// ---------------------------------------------------------------------------

interface IconProps {
  size?: number
}

/** Rows lay these out in flex containers; a glyph must never be squeezed. */
const NO_SHRINK: CSSProperties = { flex: 'none' }

function named(name: IconName, defaultSize: number) {
  return function NamedIcon({ size = defaultSize }: IconProps): JSX.Element {
    return <Icon name={name} size={size} style={NO_SHRINK} />
  }
}

// Shell (sidebar, picker, onboarding): 14px by default.
export const FolderIcon = named('folder', 14)
export const FolderFillIcon = named('folder.fill', 14)
export const FolderPlusIcon = named('folder.badge.plus', 14)
export const MagnifyIcon = named('magnifyingglass', 14)
export const ClearIcon = named('xmark.circle.fill', 14)
export const ChevronRightIcon = named('chevron.right', 14)
export const PinIcon = named('pin.fill', 14)
export const ArchiveIcon = named('archivebox.fill', 14)
export const GearIcon = named('gearshape', 14)
export const PlusIcon = named('plus', 14)
export const DownloadIcon = named('arrow.down.circle.fill', 14)
export const WarningIcon = named('exclamationmark.triangle', 14)
export const FlowchartIcon = named('flowchart', 14)

/** iphone.gen3, with radio waves while remote access is on. */
export function PhoneIcon({ size = 14, active = false }: IconProps & { active?: boolean }): JSX.Element {
  return <Icon name={active ? 'iphone.radiowaves' : 'iphone'} size={size} style={NO_SHRINK} />
}

// Providers and account: 16px by default.
export const CheckSealIcon = named('checkmark.seal.fill', 16)
export const KeyIcon = named('key', 16)
export const PersonIcon = named('person.crop.circle', 16)
export const DesktopIcon = named('desktopcomputer', 16)
export const WarningTriangleIcon = named('exclamationmark.triangle.fill', 16)
export const CheckIcon = named('checkmark', 16)
export const SearchIcon = named('magnifyingglass', 16)

/** star / star.fill — the TUI's favorite marker (its F2 cycle). */
export function StarIcon({ size = 16, filled = false }: IconProps & { filled?: boolean }): JSX.Element {
  return <Icon name={filled ? 'star.fill' : 'star'} size={size} style={NO_SHRINK} />
}

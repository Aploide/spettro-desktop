// Inline 16px stroke icons resembling the SF Symbols the Swift views use.
// Everything draws in currentColor so the surrounding text style tints it.

interface IconProps {
  size?: number
}

function Svg({
  size = 14,
  children,
  filled = false
}: IconProps & { children: React.ReactNode; filled?: boolean }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: 'none' }}
    >
      {children}
    </svg>
  )
}

/** folder */
export function FolderIcon({ size }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M1.75 4.25c0-.55.45-1 1-1h3.1c.3 0 .58.13.77.36l.97 1.14h5.66c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z" />
    </Svg>
  )
}

/** folder.fill */
export function FolderFillIcon({ size }: IconProps): JSX.Element {
  return (
    <Svg size={size} filled>
      <path d="M1.75 4.25c0-.55.45-1 1-1h3.1c.3 0 .58.13.77.36l.97 1.14h5.66c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z" />
    </Svg>
  )
}

/** folder.badge.plus */
export function FolderPlusIcon({ size }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M14.25 7v4.75c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1v-7.5c0-.55.45-1 1-1h3.1c.3 0 .58.13.77.36l.97 1.14h5.66" />
      <path d="M12.75 1.5v4M10.75 3.5h4" />
    </Svg>
  )
}

/** magnifyingglass */
export function MagnifyIcon({ size }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <circle cx="6.75" cy="6.75" r="4.25" />
      <path d="M10 10l3.5 3.5" />
    </Svg>
  )
}

/** xmark.circle.fill — the x knocks out in the surface color. */
export function ClearIcon({ size }: IconProps): JSX.Element {
  return (
    <Svg size={size} filled>
      <circle cx="8" cy="8" r="6.5" />
      <path
        d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"
        stroke="var(--canvas)"
        strokeWidth={1.5}
        strokeLinecap="round"
      />
    </Svg>
  )
}

/** chevron.right */
export function ChevronRightIcon({ size }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M5.5 3l5 5-5 5" strokeWidth={2} />
    </Svg>
  )
}

/** pin.fill */
export function PinIcon({ size }: IconProps): JSX.Element {
  return (
    <Svg size={size} filled>
      <path d="M9.6 1.2l5.2 5.2-2.5.7-2.1 2.1-.4 3.4-2.6-2.6-4 4-.9-.9 4-4L3.7 6.5l3.4-.4 2.1-2.1z" />
    </Svg>
  )
}

/** archivebox.fill */
export function ArchiveIcon({ size }: IconProps): JSX.Element {
  return (
    <Svg size={size} filled>
      <rect x="1.5" y="2.5" width="13" height="3" rx="0.75" />
      <path d="M2.5 6.5h11v6c0 .55-.45 1-1 1h-9c-.55 0-1-.45-1-1z" />
      <path d="M6 9h4" stroke="var(--canvas)" strokeWidth={1.4} strokeLinecap="round" />
    </Svg>
  )
}

/** gearshape */
export function GearIcon({ size }: IconProps): JSX.Element {
  const teeth: JSX.Element[] = []
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4
    teeth.push(
      <line
        key={i}
        x1={8 + 4.7 * Math.cos(a)}
        y1={8 + 4.7 * Math.sin(a)}
        x2={8 + 6.8 * Math.cos(a)}
        y2={8 + 6.8 * Math.sin(a)}
      />
    )
  }
  return (
    <Svg size={size}>
      {teeth}
      <circle cx="8" cy="8" r="4" />
      <circle cx="8" cy="8" r="1.4" />
    </Svg>
  )
}

/** iphone.gen3 / iphone.gen3.radiowaves.left.and.right */
export function PhoneIcon({ size, active = false }: IconProps & { active?: boolean }): JSX.Element {
  return (
    <Svg size={size}>
      <rect x="5.25" y="2" width="5.5" height="12" rx="1.4" />
      <path d="M7.2 12.2h1.6" />
      {active && <path d="M3 5.4a6 6 0 0 0 0 5.2M13 5.4a6 6 0 0 1 0 5.2" />}
    </Svg>
  )
}

/** plus */
export function PlusIcon({ size }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M8 2.75v10.5M2.75 8h10.5" strokeWidth={1.8} />
    </Svg>
  )
}

/** arrow.down.circle.fill — the arrow knocks out in the surface color. */
export function DownloadIcon({ size }: IconProps): JSX.Element {
  return (
    <Svg size={size} filled>
      <circle cx="8" cy="8" r="6.75" />
      <path
        d="M8 4.5v6.5M5.2 8.6L8 11.4l2.8-2.8"
        stroke="var(--canvas)"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

/** exclamationmark.triangle */
export function WarningIcon({ size }: IconProps): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M8 1.9L15 13.6c.3.5-.05 1.15-.65 1.15H1.65c-.6 0-.95-.65-.65-1.15z" strokeWidth={1.2} />
      <path d="M8 6v4" strokeWidth={1.4} />
      <circle cx="8" cy="12.4" r="0.8" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/** The workflow mark: a root that branches into two, then rejoins — the shape
 *  of a phase that fans out and a phase that collects. Matches the `flowchart`
 *  glyph the workflow card wears, so the sidebar button and the card the
 *  button leads to are recognisably the same thing. */
export function FlowchartIcon({ size }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="6.2" y="1.4" width="3.6" height="3" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1.4" y="11.6" width="3.6" height="3" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="11" y="11.6" width="3.6" height="3" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 4.4v2.4M3.2 11.6V9.2a1 1 0 0 1 1-1h7.6a1 1 0 0 1 1 1v2.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

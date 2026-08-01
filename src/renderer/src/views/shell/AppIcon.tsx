// Port of AppIconImage.swift. Electron has no NSApp.applicationIconImage to
// read, so this renders the mark the Swift view falls back to when the icon
// catalog is missing: a continuous-corner rounded rect filled with the accent
// gradient and a light-weight eye glyph.

export default function AppIcon({ size = 26 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 104 104" aria-label="Spettro" style={{ flex: 'none' }}>
      <defs>
        <linearGradient id="spettro-appicon-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#7789dd" />
          <stop offset="100%" stopColor="#4f61ba" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="100" height="100" rx="23" fill="url(#spettro-appicon-gradient)" />
      <path
        d="M14 52c10-17 26-26 38-26s28 9 38 26c-10 17-26 26-38 26s-28-9-38-26z"
        fill="none"
        stroke="rgba(255,255,255,0.95)"
        strokeWidth="4.5"
        strokeLinejoin="round"
      />
      <circle cx="52" cy="52" r="12.5" fill="none" stroke="rgba(255,255,255,0.95)" strokeWidth="4.5" />
    </svg>
  )
}

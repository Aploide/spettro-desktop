// Port of AppIconImage.swift. Electron has no NSApp.applicationIconImage to
// read, so the app's own icon art — the same asset the macOS target ships as
// its mac-idiom AppIcon — is bundled and drawn directly.

import appIcon from '../../assets/app-icon.png'

export default function AppIcon({ size = 26 }: { size?: number }): JSX.Element {
  return (
    <img
      src={appIcon}
      width={size}
      height={size}
      alt="Spettro"
      draggable={false}
      style={{ flex: 'none', borderRadius: size * 0.22 }}
    />
  )
}

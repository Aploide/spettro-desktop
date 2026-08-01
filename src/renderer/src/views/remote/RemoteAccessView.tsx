// Remote Access settings — port of RemoteAccessView.swift.
//
// One switch, one QR code, and the list of phones already allowed in. The
// flow is deliberately two-tiered: turning sharing ON is the everyday action
// (the phone is already paired and just needs the host listening); showing a
// QR is the once-ever action. Collapsing them into one button would put a
// pairing code on screen for no reason.

import { useEffect, useRef, useState } from 'react'
import type { PairedDeviceDTO, RemoteHostState } from '@shared/model'
import { PAIRING_WINDOW_MS } from '@shared/remote'
import { call, useApp } from '../../state/store'
import './remote.css'

export interface RemoteAccessViewProps {
  onClose?: () => void
}

export default function RemoteAccessView({ onClose }: RemoteAccessViewProps): JSX.Element {
  const app = useApp()
  const remote = app?.remote ?? null

  // Drives the countdown and "last seen" labels without making the whole view
  // time-dependent elsewhere.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  // The DTO carries no expiry, but the window is always 5 minutes: pin the
  // deadline locally when a pairing QR appears.
  const deadlineRef = useRef<number | null>(null)
  const pairingOpen = remote?.pairingQR != null
  useEffect(() => {
    if (pairingOpen) deadlineRef.current = Date.now() + PAIRING_WINDOW_MS
    else deadlineRef.current = null
  }, [pairingOpen, remote?.pairingURL])

  if (!remote) {
    return (
      <div className="remote">
        <Header onClose={onClose} />
        <div className="remote__divider" />
        <p className="remote__muted">Remote access is not available yet.</p>
      </div>
    )
  }

  return (
    <div className="remote">
      <Header onClose={onClose} />
      <div className="remote__divider" />
      <SwitchRow remote={remote} />
      {remote.pairingQR != null ? (
        <PairingPanel remote={remote} now={now} deadline={deadlineRef.current} />
      ) : (
        <PairedDevices remote={remote} now={now} />
      )}
      <div className="remote__spacer" />
      <footer className="remote__footer">
        <LockIcon />
        <span>
          Paired devices see and can steer every chat in this window. Sharing stays on your local
          network — nothing is sent to a server.
        </span>
      </footer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header({ onClose }: { onClose?: () => void }): JSX.Element {
  return (
    <header className="remote__header">
      <div>
        <h2 className="remote__title">Remote Access</h2>
        <p className="remote__subtitle">
          Drive these chats from Spettro on your iPhone or iPad, over your local network.
        </p>
      </div>
      {onClose && (
        <button className="remote__close" onClick={onClose} aria-label="Close">
          <CloseIcon />
        </button>
      )}
    </header>
  )
}

// ---------------------------------------------------------------------------
// The switch + host name
// ---------------------------------------------------------------------------

function SwitchRow({ remote }: { remote: RemoteHostState }): JSX.Element {
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState(remote.hostName)

  const connected = remote.devices.filter(
    (d) => !d.revoked && remote.connectedDeviceIds.includes(d.deviceId)
  )

  const statusTitle = !remote.enabled
    ? 'Sharing is off'
    : connected.length === 0
      ? 'Ready for your devices'
      : 'Connected'

  const statusDetail = !remote.enabled
    ? 'Your phone will show this computer as unavailable.'
    : connected.length === 0
      ? `${remote.hostName}${remote.port != null ? ` · port ${remote.port}` : ''}`
      : connected.length === 1
        ? `${connected[0].name} is connected`
        : `${connected.length} devices connected`

  const commitRename = (): void => {
    setRenaming(false)
    const trimmed = draftName.trim()
    if (trimmed.length > 0 && trimmed !== remote.hostName) {
      void call('remoteRenameHost', trimmed)
    } else {
      setDraftName(remote.hostName)
    }
  }

  return (
    <div className="remote__card remote__switch-row">
      <span className={`remote__wifi ${remote.enabled ? 'remote__wifi--on' : ''}`}>
        <WifiIcon off={!remote.enabled} />
      </span>
      <div className="remote__switch-text">
        <span className="remote__status-title">{statusTitle}</span>
        <span className="remote__status-detail">{statusDetail}</span>
        {renaming ? (
          <span className="remote__rename">
            <input
              className="remote__rename-input"
              value={draftName}
              autoFocus
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') {
                  setDraftName(remote.hostName)
                  setRenaming(false)
                }
              }}
              onBlur={commitRename}
            />
          </span>
        ) : (
          <button
            className="remote__rename-link"
            onClick={() => {
              setDraftName(remote.hostName)
              setRenaming(true)
            }}
          >
            Shown to your devices as “{remote.hostName}” — rename
          </button>
        )}
      </div>
      <label className="remote__toggle">
        <input
          type="checkbox"
          checked={remote.enabled}
          onChange={(e) => void call('remoteSetEnabled', e.target.checked)}
        />
        <span className="remote__toggle-track">
          <span className="remote__toggle-thumb" />
        </span>
      </label>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pairing panel
// ---------------------------------------------------------------------------

function PairingPanel({
  remote,
  now,
  deadline
}: {
  remote: RemoteHostState
  now: number
  deadline: number | null
}): JSX.Element {
  const remaining = deadline != null ? Math.max(0, Math.floor((deadline - now) / 1000)) : null
  // A visible countdown is the honest way to present a code that stops
  // working: a user who walks away and comes back can see why a scan failed.
  const expiryText =
    remaining == null
      ? ''
      : remaining > 0
        ? `Expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
        : 'This code has expired — show a new one.'

  return (
    <div className="remote__pairing">
      {remote.pairingQR ? (
        <img className="remote__qr" src={remote.pairingQR} alt="Pairing QR code" />
      ) : (
        <div className="remote__qr remote__qr--missing">
          <QRIcon />
          <span>Couldn&apos;t draw the code</span>
        </div>
      )}
      <div className="remote__pairing-text">
        <span className="remote__pairing-title">Scan this in Spettro on your iPhone</span>
        <span className="remote__pairing-expiry">{expiryText}</span>
      </div>
      <button className="remote__button" onClick={() => void call('remoteClosePairing')}>
        Done
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Paired devices
// ---------------------------------------------------------------------------

function PairedDevices({ remote, now }: { remote: RemoteHostState; now: number }): JSX.Element {
  const active = remote.devices.filter((d) => !d.revoked)
  return (
    <section className="remote__devices">
      <div className="remote__devices-head">
        <h3 className="remote__devices-title">Paired Devices</h3>
        <button className="remote__button remote__button--accent" onClick={() => void call('remoteOpenPairing')}>
          <QRIcon />
          Pair a Device
        </button>
      </div>
      {active.length === 0 ? (
        <div className="remote__empty">
          <PhoneIcon large />
          <span className="remote__empty-title">No devices yet</span>
          <span className="remote__empty-detail">
            Pair once and your phone reconnects on its own from then on.
          </span>
        </div>
      ) : (
        <div className="remote__device-list">
          {active.map((device) => (
            <DeviceRow
              key={device.deviceId}
              device={device}
              connected={remote.connectedDeviceIds.includes(device.deviceId)}
              now={now}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function DeviceRow({
  device,
  connected,
  now
}: {
  device: PairedDeviceDTO
  connected: boolean
  now: number
}): JSX.Element {
  const detail = connected
    ? `Connected · ${device.platform}`
    : device.lastSeenAt != null
      ? `Last seen ${relativeTime(device.lastSeenAt, now)}`
      : device.platform
  return (
    <div className="remote__card remote__device">
      <span className={`remote__device-icon ${connected ? 'remote__device-icon--on' : ''}`}>
        <PhoneIcon />
      </span>
      <div className="remote__device-text">
        <span className="remote__device-name">{device.name}</span>
        <span className="remote__device-detail">{detail}</span>
      </div>
      <button className="remote__remove" onClick={() => void call('remoteRevokeDevice', device.deviceId)}>
        Remove
      </button>
    </div>
  )
}

function relativeTime(msEpoch: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - msEpoch) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? '1 hr ago' : `${hours} hr ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

// ---------------------------------------------------------------------------
// Icons (inline SVG stand-ins for the SF Symbols the Mac app uses)
// ---------------------------------------------------------------------------

function WifiIcon({ off }: { off?: boolean }): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M2.5 9.5a14.5 14.5 0 0 1 19 0" />
      <path d="M5.8 13a9.5 9.5 0 0 1 12.4 0" />
      <path d="M9.2 16.5a4.5 4.5 0 0 1 5.6 0" />
      <circle cx="12" cy="19.5" r="1" fill="currentColor" stroke="none" />
      {off && <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
  )
}

function PhoneIcon({ large }: { large?: boolean }): JSX.Element {
  const size = large ? 28 : 18
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <line x1="10.5" y1="18.5" x2="13.5" y2="18.5" />
    </svg>
  )
}

function QRIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <path d="M14 14h3v3h-3zM20 14h1M14 20h1M18 18h3v3h-3z" />
    </svg>
  )
}

function LockIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  )
}

function CloseIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  )
}

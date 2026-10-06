// Remote Access settings — port of RemoteAccessView.swift.
//
// One switch, one QR code, and the list of phones already allowed in. The
// flow is deliberately two-tiered: turning sharing ON is the everyday action
// (the phone is already paired and just needs the host listening); showing a
// QR is the once-ever action. Collapsing them into one button would put a
// pairing code on screen for no reason.
//
// It lives in Settings › Remote. A code that can't be drawn still pairs: the
// link behind it is offered to copy. A code that runs out says so, with "Show
// New Code", instead of quietly vanishing. Removing a device asks first.

import { useEffect, useState } from 'react'
import type { PairedDeviceDTO, RemoteHostState } from '@shared/model'
import { call, useApp } from '../../state/store'
import { confirmDialog } from '@renderer/views/common/ConfirmDialog'
import { CopyButton } from '@renderer/views/common/Disclosure'
import './remote.css'

export interface RemoteAccessViewProps {
  onClose?: () => void
  /** Inside Settings: the pane has its own title, so no header. */
  embedded?: boolean
}

export default function RemoteAccessView({ onClose, embedded = false }: RemoteAccessViewProps): JSX.Element {
  const app = useApp()
  const remote = app?.remote ?? null

  // Drives the countdown and "last seen" labels without making the whole view
  // time-dependent elsewhere.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  if (!remote) {
    return (
      <div className={`remote${embedded ? ' remote--embedded' : ''}`}>
        {!embedded && <Header onClose={onClose} />}
        {!embedded && <div className="remote__divider" />}
        <p className="remote__muted">Remote access is not available yet.</p>
      </div>
    )
  }

  // Open while there is a code to show (drawn or not) — or one that ran out.
  const pairing = remote.pairingOpen || remote.pairingURL !== null || remote.pairingExpired

  return (
    <div className={`remote${embedded ? ' remote--embedded' : ''}`}>
      {!embedded && <Header onClose={onClose} />}
      {!embedded && <div className="remote__divider" />}
      <SwitchRow remote={remote} />
      {pairing ? <PairingPanel remote={remote} now={now} /> : <PairedDevices remote={remote} now={now} />}
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
      ? 'Open Spettro on your phone, on the same Wi-Fi, to connect.'
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
          <span className="remote__status-detail">
            Shown to your devices as “{remote.hostName}”{' '}
            <button
              className="link remote__rename-link"
              onClick={() => {
                setDraftName(remote.hostName)
                setRenaming(true)
              }}
            >
              Rename
            </button>
          </span>
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

function PairingPanel({ remote, now }: { remote: RemoteHostState; now: number }): JSX.Element {
  const deadline = remote.pairingExpiresAt
  const remaining = deadline != null ? Math.max(0, Math.floor((deadline - now) / 1000)) : null
  const expired = remote.pairingExpired || remaining === 0

  if (expired) {
    return (
      <div className="remote__pairing">
        <div className="remote__qr remote__qr--missing">
          <QRIcon />
          <span>Code expired</span>
        </div>
        <div className="remote__pairing-text">
          <span className="remote__pairing-title">This code has expired</span>
          <span className="remote__pairing-expiry">Codes work for five minutes. Show a new one to pair.</span>
        </div>
        <div className="remote__pairing-actions">
          <button className="remote__button" onClick={() => void call('remoteClosePairing')}>
            Done
          </button>
          <button className="remote__button remote__button--accent" onClick={() => void call('remoteOpenPairing')}>
            Show new code
          </button>
        </div>
      </div>
    )
  }

  // A visible countdown is the honest way to present a code that stops
  // working: a user who walks away and comes back can see why a scan failed.
  const expiryText =
    remaining == null ? '' : `Expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`

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
        <span className="remote__pairing-title">
          {remote.pairingQR ? 'Scan this in Spettro on your iPhone' : 'Pair with the link instead'}
        </span>
        <span className="remote__pairing-expiry">{expiryText}</span>
      </div>
      {remote.pairingURL && (
        <div className="remote__manual">
          <span className="remote__manual-text">
            Can&rsquo;t scan? Copy the pairing link and open it on your phone.
          </span>
          <CopyButton text={remote.pairingURL} label="Copy link" className="remote__button" />
        </div>
      )}
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
        <h3 className="remote__devices-title">Paired devices</h3>
        <button className="remote__button remote__button--accent" onClick={() => void call('remoteOpenPairing')}>
          <QRIcon />
          Pair a device
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
      <button
        className="remote__remove"
        onClick={async () => {
          const answer = await confirmDialog({
            title: `Remove “${device.name}”?`,
            message: 'It won’t be able to connect to this computer until you pair it again.',
            confirmLabel: 'Remove',
            destructive: true
          })
          if (answer === 'confirm') void call('remoteRevokeDevice', device.deviceId)
        }}
      >
        Remove…
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

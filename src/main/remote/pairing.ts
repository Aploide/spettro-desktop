// Pairing crypto and the QR invite — port of RemotePairing.swift.
//
// The QR is a short-lived *invite*, not a credential: the host shows a QR
// carrying a 32-byte pairing secret valid five minutes; the phone connects
// and proves it holds it; the host mints a durable 32-byte device key and
// returns it exactly once. Every later connection proves the device key.
//
// Proofs are HMAC-SHA256 over a host-chosen per-connection challenge with the
// host id bound into the MAC, so a captured proof can be replayed neither
// onto the next connection nor onto a different host.

import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import {
  PAIRING_URL_SCHEME,
  PAIRING_WINDOW_MS,
  REMOTE_KEY_LENGTH,
  REMOTE_PROTOCOL_VERSION,
  type RemoteHostKind
} from '../../shared/remote'

// ---------------------------------------------------------------------------
// Base64URL — QR payloads ride in a URL, so keys are base64url (no `+`, `/`,
// or padding) to survive being a query parameter without escaping.
// ---------------------------------------------------------------------------

export function base64urlEncode(data: Buffer): string {
  return data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64urlDecode(text: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null
  let s = text.replace(/-/g, '+').replace(/_/g, '/')
  const remainder = s.length % 4
  if (remainder === 1) return null
  if (remainder > 0) s += '='.repeat(4 - remainder)
  try {
    return Buffer.from(s, 'base64')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

/** A fresh 32-byte secret/key/challenge from the platform CSPRNG. */
export function randomKey(): Buffer {
  return randomBytes(REMOTE_KEY_LENGTH)
}

/** The proof a client sends: base64url( HMAC-SHA256(key, challenge ‖ utf8(hostID)) ). */
export function computeProof(key: Buffer, challenge: Buffer, hostID: string): string {
  const mac = createHmac('sha256', key)
    .update(Buffer.concat([challenge, Buffer.from(hostID, 'utf8')]))
    .digest()
  return base64urlEncode(mac)
}

/** Constant-time verification via crypto.timingSafeEqual — a byte-by-byte ===
 *  on a MAC leaks how much of a guess was right through timing. */
export function verifyProof(
  candidate: string,
  key: Buffer,
  challenge: Buffer,
  hostID: string
): boolean {
  const expected = createHmac('sha256', key)
    .update(Buffer.concat([challenge, Buffer.from(hostID, 'utf8')]))
    .digest()
  const provided = base64urlDecode(candidate)
  if (!provided || provided.length !== expected.length) return false
  return timingSafeEqual(provided, expected)
}

// ---------------------------------------------------------------------------
// QR payload URL
// ---------------------------------------------------------------------------

export interface PairingPayload {
  protocolVersion: number
  hostID: string
  hostName: string
  hostKind: RemoteHostKind
  /** The one-shot secret proving the scanner saw this QR. */
  secret: Buffer
  /** Address hint for networks that filter mDNS — Bonjour is the real path. */
  address?: string
  port?: number
}

/** Builds the spettro-pair:// URL the QR encodes:
 *  spettro-pair://pair?v=1&h=<hostID>&n=<name>&k=app&s=<secret>&a=<addr>&p=<port>
 *  Values are percent-encoded (encodeURIComponent, spaces as %20 — never `+`,
 *  which iOS URLComponents would read literally). */
export function buildPairingURL(payload: PairingPayload): string {
  const items: [string, string][] = [
    ['v', String(payload.protocolVersion ?? REMOTE_PROTOCOL_VERSION)],
    ['h', payload.hostID],
    ['n', payload.hostName],
    ['k', payload.hostKind],
    ['s', base64urlEncode(payload.secret)]
  ]
  if (payload.address) items.push(['a', payload.address])
  if (payload.port !== undefined) items.push(['p', String(payload.port)])
  const query = items.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  return `${PAIRING_URL_SCHEME}://pair?${query}`
}

// ---------------------------------------------------------------------------
// Pairing window — pairing is only open while one exists and hasn't expired,
// so an attacker on the LAN has five minutes and one guessable-in-2^256
// secret rather than a standing invitation.
// ---------------------------------------------------------------------------

export interface PairingWindow {
  secret: Buffer
  /** ms epoch. */
  openedAt: number
}

export function createPairingWindow(): PairingWindow {
  return { secret: randomKey(), openedAt: Date.now() }
}

export function pairingWindowExpiresAt(window: PairingWindow): number {
  return window.openedAt + PAIRING_WINDOW_MS
}

export function isPairingWindowExpired(window: PairingWindow): boolean {
  return Date.now() >= pairingWindowExpiresAt(window)
}

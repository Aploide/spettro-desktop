// Who is at the other end of a connection, and whether to let them stay.
//
// With a tunnel on, the relay is reachable from the whole internet through
// cloudflared, which dials it from this machine — so a tunneled socket comes
// from loopback and carries the Cf-Warp-Tag-Id cloudflared adds to every
// request it proxies. A phone on the LAN comes from its own address and
// can't make itself look like loopback, so only then is Cf-Connecting-Ip
// (the internet peer's address, set by Cloudflare's edge) believed.
//
// Proofs are HMAC over 256-bit keys, so guessing is hopeless; what's guarded
// here is exposure and load: a connector the user switched off, an address
// hammering auth, sockets that never authenticate, oversized frames.

import type { IncomingHttpHeaders } from 'http'

export type ConnectionVia = 'lan' | 'tunnel'

export interface ConnectionOrigin {
  via: ConnectionVia
  /** The peer's address: the socket's own on the LAN, Cf-Connecting-Ip
   *  through the tunnel. Rate limits key on it. */
  peerIp: string
  /** The connector that proxied a tunneled connection (Cf-Warp-Tag-Id). */
  connectorTag: string | null
}

export const LAN_ORIGIN: ConnectionOrigin = { via: 'lan', peerIp: 'unknown', connectorTag: null }

/** Until a session authenticates, it is closed after this long. */
export const AUTH_DEADLINE_MS = 15_000
/** Most unauthenticated tunneled sockets open at once. */
export const MAX_UNAUTHENTICATED_TUNNELED = 8
/** Most sockets open at once, however they came. */
export const MAX_SESSIONS = 32
/** The biggest frame the relay reads — a phone's largest image prompt,
 *  base64 and all, with room to spare. */
export const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024
/** Before auth a socket may send this many frames, each at most this big:
 *  an auth request is a few hundred bytes. */
export const PREAUTH_MAX_FRAMES = 10
export const PREAUTH_MAX_FRAME_BYTES = 64 * 1024
/** Server pings. Cloudflare drops a WebSocket idle for about 100 s, and a
 *  phone that vanished behind the tunnel leaves a socket only this finds. */
export const HEARTBEAT_MS = 30_000

/** WebSocket close codes. */
export const CLOSE_POLICY = 1008
export const CLOSE_TRY_AGAIN_LATER = 1013

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false
  return /^127\./.test(address) || address === '::1' || /^::ffff:127\./i.test(address)
}

function header(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name]
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' && first.trim() !== '' ? first.trim() : null
}

/** Classifies an accepted connection from its socket address and the
 *  upgrade request's headers. */
export function classifyConnection(remoteAddress: string | undefined, headers: IncomingHttpHeaders): ConnectionOrigin {
  const tag = header(headers, 'cf-warp-tag-id')
  if (isLoopback(remoteAddress) && tag) {
    return { via: 'tunnel', peerIp: header(headers, 'cf-connecting-ip') ?? 'unknown', connectorTag: tag.toLowerCase() }
  }
  return { via: 'lan', peerIp: remoteAddress ?? 'unknown', connectorTag: null }
}

/** The kill switch: a tunneled connection is let in only while this
 *  computer's tunnel is on, and only from its own connector once that is
 *  known. That shuts out a cloudflared left running by a crash, or the same
 *  tunnel installed as a system service, after the user switched it off. */
export function admitsTunneled(
  origin: ConnectionOrigin,
  tunnel: { running: boolean; connectorId: string | null }
): boolean {
  if (origin.via !== 'tunnel') return true
  if (!tunnel.running) return false
  return tunnel.connectorId === null || origin.connectorTag === tunnel.connectorId
}

export interface FailedAuthLimiterOptions {
  /** Failures from one address within `windowMs` that get it blocked. */
  limit?: number
  windowMs?: number
  blockMs?: number
  /** Tunneled failures from anyone within `breakerWindowMs` that stop
   *  pairing over the internet until the user opens a code again. */
  breakerLimit?: number
  breakerWindowMs?: number
  now?: () => number
}

/** Failed auth, counted per address: 5 in 5 minutes blocks it for 15. A
 *  wave from many addresses through the tunnel trips a breaker instead. */
export class FailedAuthLimiter {
  private readonly limit: number
  private readonly windowMs: number
  private readonly blockMs: number
  private readonly breakerLimit: number
  private readonly breakerWindowMs: number
  private readonly now: () => number
  private readonly failures = new Map<string, number[]>()
  private readonly blockedUntil = new Map<string, number>()
  private tunneledFailures: number[] = []
  private tripped = false

  constructor(options: FailedAuthLimiterOptions = {}) {
    this.limit = options.limit ?? 5
    this.windowMs = options.windowMs ?? 5 * 60_000
    this.blockMs = options.blockMs ?? 15 * 60_000
    this.breakerLimit = options.breakerLimit ?? 50
    this.breakerWindowMs = options.breakerWindowMs ?? 10 * 60_000
    this.now = options.now ?? Date.now
  }

  /** Records a failed auth. Returns true when this one tripped the breaker. */
  recordFailure(origin: ConnectionOrigin): boolean {
    const now = this.now()
    const recent = (this.failures.get(origin.peerIp) ?? []).filter((t) => now - t < this.windowMs)
    recent.push(now)
    if (recent.length >= this.limit) {
      this.blockedUntil.set(origin.peerIp, now + this.blockMs)
      this.failures.delete(origin.peerIp)
    } else {
      this.failures.set(origin.peerIp, recent)
    }
    if (origin.via !== 'tunnel') return false
    this.tunneledFailures = this.tunneledFailures.filter((t) => now - t < this.breakerWindowMs)
    this.tunneledFailures.push(now)
    if (!this.tripped && this.tunneledFailures.length > this.breakerLimit) {
      this.tripped = true
      return true
    }
    return false
  }

  isBlocked(peerIp: string): boolean {
    const until = this.blockedUntil.get(peerIp)
    if (until === undefined) return false
    if (this.now() < until) return true
    this.blockedUntil.delete(peerIp)
    return false
  }

  /** Too many tunneled failures lately: pairing over the internet is off
   *  until resetBreaker(). */
  get breakerTripped(): boolean {
    return this.tripped
  }

  resetBreaker(): void {
    this.tripped = false
    this.tunneledFailures = []
  }
}

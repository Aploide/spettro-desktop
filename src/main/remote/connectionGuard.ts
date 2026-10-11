// Who is at the other end of a connection, and whether to let them stay.
//
// The relay is for the local network: a phone finds it by Bonjour or by the
// LAN address in the pairing code, and the peer is whoever the socket says
// it is. No header is ever believed about the peer's address.
//
// Proofs are HMAC over 256-bit keys, so guessing is hopeless; what's guarded
// here is exposure and load: a connection relayed by a proxy, an address
// hammering auth, sockets that never authenticate, oversized frames.

import type { IncomingHttpHeaders } from 'http'

export interface ConnectionOrigin {
  /** The peer's address, as the socket has it. Rate limits key on it. */
  peerIp: string
}

export const LAN_ORIGIN: ConnectionOrigin = { peerIp: 'unknown' }

/** Until a session authenticates, it is closed after this long. */
export const AUTH_DEADLINE_MS = 15_000
/** Most sockets open at once. */
export const MAX_SESSIONS = 32
/** The biggest frame the relay reads — a phone's largest image prompt,
 *  base64 and all, with room to spare. */
export const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024
/** Before auth a socket may send this many frames, each at most this big:
 *  an auth request is a few hundred bytes. */
export const PREAUTH_MAX_FRAMES = 10
export const PREAUTH_MAX_FRAME_BYTES = 64 * 1024
/** Bytes a socket may send before auth, counted off the wire so a frame
 *  too big is cut off while it arrives rather than read whole first. */
export const PREAUTH_MAX_BYTES = 2 * PREAUTH_MAX_FRAME_BYTES
/** Server pings: a phone that vanished (or a NAT that forgot it) leaves a
 *  socket only this finds. */
export const HEARTBEAT_MS = 30_000

/** WebSocket close codes. */
export const CLOSE_POLICY = 1008
export const CLOSE_TRY_AGAIN_LATER = 1013

/** Headers a Cloudflare tunnel adds to every request it relays. */
const PROXY_HEADERS = ['cf-warp-tag-id', 'cf-connecting-ip'] as const

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false
  return /^127\./.test(address) || address === '::1' || /^::ffff:127\./i.test(address)
}

/** An address as compared here: no IPv4-mapped prefix, no zone, lowercase. */
export function plainAddress(address: string): string {
  return address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '').replace(/%.*$/, '').toLowerCase()
}

/** Whether an upgrade request came through a Cloudflare tunnel. Such a
 *  connection is turned away (CLOSE_POLICY) before hello: a cloudflared the
 *  user left running, or a tunnel of their own pointed at this port, must
 *  not put the relay on the internet. Nothing else about a proxy is
 *  trusted either way. */
export function isProxiedConnection(headers: IncomingHttpHeaders): boolean {
  return PROXY_HEADERS.some((name) => headers[name] !== undefined)
}

/** What rate limits count a peer as: its address, plainly spelled. */
export function peerKey(origin: ConnectionOrigin): string {
  return plainAddress(origin.peerIp)
}

export interface FailedAuthLimiterOptions {
  /** Failures from one peer within `windowMs` that get it blocked. */
  limit?: number
  windowMs?: number
  blockMs?: number
  /** Most peers remembered; the longest quiet are forgotten first. */
  maxTracked?: number
  now?: () => number
}

/** How often expired entries are swept out. */
const SWEEP_MS = 60_000

/** Failed auth, counted per peer (peerKey): 5 in 5 minutes blocks it for
 *  15. */
export class FailedAuthLimiter {
  private readonly limit: number
  private readonly windowMs: number
  private readonly blockMs: number
  private readonly maxTracked: number
  private readonly now: () => number
  /** In the order peers last failed, oldest first. */
  private readonly failures = new Map<string, number[]>()
  /** In the order blocks end, soonest first. */
  private readonly blockedUntil = new Map<string, number>()
  private lastSweep = 0

  constructor(options: FailedAuthLimiterOptions = {}) {
    this.limit = options.limit ?? 5
    this.windowMs = options.windowMs ?? 5 * 60_000
    this.blockMs = options.blockMs ?? 15 * 60_000
    this.maxTracked = options.maxTracked ?? 10_000
    this.now = options.now ?? Date.now
  }

  recordFailure(origin: ConnectionOrigin): void {
    const now = this.now()
    this.sweep(now)
    const key = peerKey(origin)
    const recent = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs)
    recent.push(now)
    this.failures.delete(key)
    if (recent.length >= this.limit) {
      this.blockedUntil.delete(key)
      this.blockedUntil.set(key, now + this.blockMs)
    } else {
      this.failures.set(key, recent)
    }
    this.trim()
  }

  isBlocked(origin: ConnectionOrigin): boolean {
    const key = peerKey(origin)
    const until = this.blockedUntil.get(key)
    if (until === undefined) return false
    if (this.now() < until) return true
    this.blockedUntil.delete(key)
    return false
  }

  /** Peers remembered, failing or blocked (for tests). */
  get trackedCount(): number {
    return this.failures.size + this.blockedUntil.size
  }

  /** Forgets failures past their window and blocks past their end. */
  private sweep(now: number): void {
    if (now - this.lastSweep < SWEEP_MS) return
    this.lastSweep = now
    for (const [key, times] of this.failures) {
      if (now - times[times.length - 1] >= this.windowMs) this.failures.delete(key)
    }
    for (const [key, until] of this.blockedUntil) {
      if (until <= now) this.blockedUntil.delete(key)
    }
  }

  /** Past maxTracked, the peers quiet longest go first: failures before
   *  blocks, which are what keep a hammering address out. */
  private trim(): void {
    for (const key of this.failures.keys()) {
      if (this.trackedCount <= this.maxTracked) return
      this.failures.delete(key)
    }
    for (const key of this.blockedUntil.keys()) {
      if (this.trackedCount <= this.maxTracked) return
      this.blockedUntil.delete(key)
    }
  }
}

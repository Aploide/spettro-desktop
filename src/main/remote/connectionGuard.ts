// Who is at the other end of a connection, and whether to let them stay.
//
// With a tunnel on, the relay is reachable from the whole internet through
// cloudflared, which adds Cf-Warp-Tag-Id to every request it proxies. A
// connection carrying that tag is treated as tunneled wherever it came
// from: cloudflared dials the dashboard's service URL, which may name this
// machine's LAN address rather than localhost, and a LAN client that sends
// the header only gets itself held to the tunnel's rules. Cf-Connecting-Ip
// (the internet peer's address, set by Cloudflare's edge) is believed only
// on a connection from this machine itself, which a phone on the LAN can't
// pass for.
//
// Proofs are HMAC over 256-bit keys, so guessing is hopeless; what's guarded
// here is exposure and load: a connector the user switched off, an address
// hammering auth, sockets that never authenticate, oversized frames.

import type { IncomingHttpHeaders } from 'http'
import { networkInterfaces } from 'os'

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
/** Most unauthenticated tunneled sockets open at once, and from any one
 *  peer (peerKey): one address can't take every slot and keep paired phones
 *  out by reconnecting just inside the deadline. */
export const MAX_UNAUTHENTICATED_TUNNELED = 8
export const MAX_UNAUTHENTICATED_TUNNELED_PER_PEER = 2
/** Most sockets open at once, however they came. */
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

/** An address as compared here: no IPv4-mapped prefix, no zone, lowercase. */
export function plainAddress(address: string): string {
  return address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '').replace(/%.*$/, '').toLowerCase()
}

/** Every address this machine has on its interfaces. */
export function localAddresses(): Set<string> {
  const out = new Set<string>()
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) out.add(plainAddress(address.address))
  }
  return out
}

function header(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name]
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' && first.trim() !== '' ? first.trim() : null
}

/** Classifies an accepted connection from its socket address and the
 *  upgrade request's headers. `ownAddresses` are this machine's (where a
 *  cloudflared told to dial its LAN address comes from). */
export function classifyConnection(
  remoteAddress: string | undefined,
  headers: IncomingHttpHeaders,
  ownAddresses: ReadonlySet<string> = new Set()
): ConnectionOrigin {
  const tag = header(headers, 'cf-warp-tag-id')
  if (!tag) return { via: 'lan', peerIp: remoteAddress ?? 'unknown', connectorTag: null }
  const fromHere = isLoopback(remoteAddress) || (remoteAddress !== undefined && ownAddresses.has(plainAddress(remoteAddress)))
  return {
    via: 'tunnel',
    peerIp: fromHere ? (header(headers, 'cf-connecting-ip') ?? 'unknown') : (remoteAddress ?? 'unknown'),
    connectorTag: tag.toLowerCase()
  }
}

/** The eight groups of an IPv6 address, or null when it isn't one. An
 *  embedded IPv4 is the last two groups, past any /64, so it reads as 0s. */
function ipv6Groups(address: string): string[] | null {
  const halves = address.split('::')
  if (halves.length > 2) return null
  const parse = (text: string): string[] | null => {
    if (text === '') return []
    const out: string[] = []
    for (const group of text.split(':')) {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(group)) out.push('0', '0')
      else if (/^[0-9a-f]{1,4}$/i.test(group)) out.push(Number.parseInt(group, 16).toString(16))
      else return null
    }
    return out
  }
  const head = parse(halves[0])
  const tail = halves.length === 2 ? parse(halves[1]) : []
  if (!head || !tail) return null
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  return [...head, ...Array<string>(missing).fill('0'), ...tail]
}

/** What rate limits count a peer as. Through the tunnel an IPv6 peer is its
 *  /64, which one person's devices share and can rotate through freely; on
 *  the LAN every phone is itself, since they all share the network's /64. */
export function peerKey(origin: ConnectionOrigin): string {
  const address = plainAddress(origin.peerIp)
  if (origin.via !== 'tunnel' || !address.includes(':')) return address
  const groups = ipv6Groups(address)
  return groups ? `${groups.slice(0, 4).join(':')}::/64` : address
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
  /** Failures from one peer within `windowMs` that get it blocked. */
  limit?: number
  windowMs?: number
  blockMs?: number
  /** Tunneled failures from anyone within `breakerWindowMs` that stop
   *  pairing over the internet until the user opens a code again. */
  breakerLimit?: number
  breakerWindowMs?: number
  /** Most peers remembered; the longest quiet are forgotten first. */
  maxTracked?: number
  now?: () => number
}

/** How often expired entries are swept out. */
const SWEEP_MS = 60_000

/** Failed auth, counted per peer (peerKey): 5 in 5 minutes blocks it for
 *  15. A wave from many addresses through the tunnel trips a breaker
 *  instead. A soft failure — a socket that let the deadline pass, or sent
 *  too much before auth — counts against the peer but not the breaker,
 *  which is about sign-ins. */
export class FailedAuthLimiter {
  private readonly limit: number
  private readonly windowMs: number
  private readonly blockMs: number
  private readonly breakerLimit: number
  private readonly breakerWindowMs: number
  private readonly maxTracked: number
  private readonly now: () => number
  /** In the order peers last failed, oldest first. */
  private readonly failures = new Map<string, number[]>()
  /** In the order blocks end, soonest first. */
  private readonly blockedUntil = new Map<string, number>()
  private tunneledFailures: number[] = []
  private tripped = false
  private lastSweep = 0

  constructor(options: FailedAuthLimiterOptions = {}) {
    this.limit = options.limit ?? 5
    this.windowMs = options.windowMs ?? 5 * 60_000
    this.blockMs = options.blockMs ?? 15 * 60_000
    this.breakerLimit = options.breakerLimit ?? 50
    this.breakerWindowMs = options.breakerWindowMs ?? 10 * 60_000
    this.maxTracked = options.maxTracked ?? 10_000
    this.now = options.now ?? Date.now
  }

  /** Records a failed auth. Returns true when this one tripped the breaker. */
  recordFailure(origin: ConnectionOrigin, options: { soft?: boolean } = {}): boolean {
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
    if (origin.via !== 'tunnel' || options.soft) return false
    this.tunneledFailures = this.tunneledFailures.filter((t) => now - t < this.breakerWindowMs)
    this.tunneledFailures.push(now)
    if (!this.tripped && this.tunneledFailures.length > this.breakerLimit) {
      this.tripped = true
      return true
    }
    return false
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

  /** Too many tunneled failures lately: pairing over the internet is off
   *  until resetBreaker(). */
  get breakerTripped(): boolean {
    return this.tripped
  }

  resetBreaker(): void {
    this.tripped = false
    this.tunneledFailures = []
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

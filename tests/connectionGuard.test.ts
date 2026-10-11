// Who is at the other end of a relay connection, and the limits that keep
// an address from leaning on the relay.

import { describe, expect, it } from 'vitest'
import {
  FailedAuthLimiter,
  isLoopback,
  isProxiedConnection,
  peerKey,
  plainAddress,
  type ConnectionOrigin
} from '@main/remote/connectionGuard'

describe('addresses', () => {
  it('knows loopback in all its spellings', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) expect(isLoopback(address)).toBe(true)
    for (const address of ['192.168.1.20', '::ffff:192.168.1.20', 'fe80::1', undefined]) expect(isLoopback(address)).toBe(false)
  })

  it('spells an address one way: no mapped prefix, no zone, lowercase', () => {
    expect(plainAddress('::ffff:192.168.1.20')).toBe('192.168.1.20')
    expect(plainAddress('FE80::1C2B%wlan0')).toBe('fe80::1c2b')
    expect(peerKey({ peerIp: '::ffff:192.168.1.20' })).toBe('192.168.1.20')
    expect(peerKey({ peerIp: 'fe80::2' })).not.toBe(peerKey({ peerIp: 'fe80::1' }))
  })
})

describe('isProxiedConnection', () => {
  it('flags an upgrade a Cloudflare tunnel relayed, by either header', () => {
    expect(isProxiedConnection({ 'cf-warp-tag-id': '6f0c9a52-6f43-4bd4-9a7e-3b55e2d3c1aa' })).toBe(true)
    expect(isProxiedConnection({ 'cf-connecting-ip': '203.0.113.9' })).toBe(true)
    expect(isProxiedConnection({ 'cf-connecting-ip': '' })).toBe(true)
  })

  it('leaves a plain LAN upgrade alone', () => {
    expect(isProxiedConnection({ host: '192.168.1.20:7879', upgrade: 'websocket' })).toBe(false)
  })
})

describe('FailedAuthLimiter', () => {
  const origin = (peerIp: string): ConnectionOrigin => ({ peerIp })

  it('blocks an address after five failures in five minutes, for fifteen', () => {
    let now = 0
    const limiter = new FailedAuthLimiter({ now: () => now })
    for (let i = 0; i < 4; i++) limiter.recordFailure(origin('192.168.1.40'))
    expect(limiter.isBlocked(origin('192.168.1.40'))).toBe(false)
    limiter.recordFailure(origin('192.168.1.40'))
    expect(limiter.isBlocked(origin('192.168.1.40'))).toBe(true)
    expect(limiter.isBlocked(origin('::ffff:192.168.1.40'))).toBe(true)
    expect(limiter.isBlocked(origin('192.168.1.41'))).toBe(false)
    now += 15 * 60_000 - 1
    expect(limiter.isBlocked(origin('192.168.1.40'))).toBe(true)
    now += 1
    expect(limiter.isBlocked(origin('192.168.1.40'))).toBe(false)
  })

  it('forgets failures older than five minutes', () => {
    let now = 0
    const limiter = new FailedAuthLimiter({ now: () => now })
    for (let i = 0; i < 4; i++) limiter.recordFailure(origin('192.168.1.40'))
    now += 5 * 60_000
    limiter.recordFailure(origin('192.168.1.40'))
    expect(limiter.isBlocked(origin('192.168.1.40'))).toBe(false)
  })

  it('counts every phone on the network as itself', () => {
    const limiter = new FailedAuthLimiter()
    for (let i = 1; i <= 5; i++) limiter.recordFailure(origin(`fe80::${i}`))
    expect(limiter.isBlocked(origin('fe80::1'))).toBe(false)
    expect(limiter.isBlocked(origin('fe80::99'))).toBe(false)
  })

  it('forgets peers whose failures and blocks have run out, and never remembers too many', () => {
    let now = 0
    const limiter = new FailedAuthLimiter({ now: () => now, maxTracked: 100 })
    for (let i = 0; i < 50; i++) limiter.recordFailure(origin(`192.168.1.${i}`))
    for (let i = 0; i < 5; i++) limiter.recordFailure(origin('192.168.2.7'))
    expect(limiter.trackedCount).toBe(51)
    now += 15 * 60_000
    limiter.recordFailure(origin('192.168.2.8'))
    expect(limiter.trackedCount).toBe(1)
    for (let i = 0; i < 500; i++) limiter.recordFailure(origin(`10.0.${i >> 8}.${i & 255}`))
    expect(limiter.trackedCount).toBe(100)
    // The newest are the ones kept.
    for (let i = 0; i < 4; i++) limiter.recordFailure(origin('10.0.1.243'))
    expect(limiter.isBlocked(origin('10.0.1.243'))).toBe(true)
  })
})

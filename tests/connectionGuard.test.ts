// Who is at the other end of a relay connection, and the limits that keep a
// relay reachable from the internet from being leaned on.

import { describe, expect, it } from 'vitest'
import {
  FailedAuthLimiter,
  admitsTunneled,
  classifyConnection,
  isLoopback,
  peerKey,
  type ConnectionOrigin
} from '@main/remote/connectionGuard'

const CONNECTOR = '6f0c9a52-6f43-4bd4-9a7e-3b55e2d3c1aa'

describe('classifyConnection', () => {
  it('knows loopback in all its spellings', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) expect(isLoopback(address)).toBe(true)
    for (const address of ['192.168.1.20', '::ffff:192.168.1.20', 'fe80::1', undefined]) expect(isLoopback(address)).toBe(false)
  })

  it('calls loopback carrying a connector tag tunneled, and believes the edge about the peer', () => {
    expect(
      classifyConnection('::ffff:127.0.0.1', { 'cf-warp-tag-id': CONNECTOR.toUpperCase(), 'cf-connecting-ip': '203.0.113.9' })
    ).toEqual({ via: 'tunnel', peerIp: '203.0.113.9', connectorTag: CONNECTOR })
  })

  it('holds anything carrying a connector tag to the tunnel’s rules, but believes only this machine about the peer', () => {
    // A LAN client sending the header just locks itself out (the kill
    // switch doesn't know its tag), and can't pass for another address.
    expect(classifyConnection('192.168.1.40', { 'cf-warp-tag-id': CONNECTOR, 'cf-connecting-ip': '203.0.113.9' })).toEqual({
      via: 'tunnel',
      peerIp: '192.168.1.40',
      connectorTag: CONNECTOR
    })
  })

  it('calls cloudflared dialing this machine’s LAN address tunneled, as the dashboard may have it do', () => {
    const own = new Set(['192.168.1.20', 'fe80::1c2b:3aff:fe4d:5e6f'])
    expect(
      classifyConnection('::ffff:192.168.1.20', { 'cf-warp-tag-id': CONNECTOR, 'cf-connecting-ip': '203.0.113.9' }, own)
    ).toEqual({ via: 'tunnel', peerIp: '203.0.113.9', connectorTag: CONNECTOR })
    expect(
      classifyConnection('fe80::1c2b:3aff:fe4d:5e6f%wlan0', { 'cf-warp-tag-id': CONNECTOR, 'cf-connecting-ip': '2001:db8::7' }, own)
    ).toMatchObject({ via: 'tunnel', peerIp: '2001:db8::7' })
    expect(classifyConnection('192.168.1.20', {}, own)).toEqual({ via: 'lan', peerIp: '192.168.1.20', connectorTag: null })
  })

  it('calls plain loopback the LAN', () => {
    expect(classifyConnection('127.0.0.1', {})).toEqual({ via: 'lan', peerIp: '127.0.0.1', connectorTag: null })
  })
})

describe('the kill switch', () => {
  const tunneled: ConnectionOrigin = { via: 'tunnel', peerIp: '203.0.113.9', connectorTag: CONNECTOR }
  const lan: ConnectionOrigin = { via: 'lan', peerIp: '192.168.1.40', connectorTag: null }

  it('turns tunneled connections away while the tunnel is off', () => {
    expect(admitsTunneled(tunneled, { running: false, connectorId: null })).toBe(false)
    expect(admitsTunneled(lan, { running: false, connectorId: null })).toBe(true)
  })

  it('lets in only this computer’s connector once it is known', () => {
    expect(admitsTunneled(tunneled, { running: true, connectorId: null })).toBe(true)
    expect(admitsTunneled(tunneled, { running: true, connectorId: CONNECTOR })).toBe(true)
    expect(admitsTunneled(tunneled, { running: true, connectorId: '00000000-0000-4000-8000-000000000000' })).toBe(false)
  })
})

describe('peerKey', () => {
  const tunnel = (peerIp: string): ConnectionOrigin => ({ via: 'tunnel', peerIp, connectorTag: CONNECTOR })
  const lan = (peerIp: string): ConnectionOrigin => ({ via: 'lan', peerIp, connectorTag: null })

  it('counts an IPv6 peer through the tunnel as its /64, however it is spelled', () => {
    expect(peerKey(tunnel('2001:db8:aa:bb::1'))).toBe('2001:db8:aa:bb::/64')
    expect(peerKey(tunnel('2001:0DB8:00aa:00bb:1234:5678:9abc:def0'))).toBe('2001:db8:aa:bb::/64')
    expect(peerKey(tunnel('2001:db8::1'))).toBe('2001:db8:0:0::/64')
    expect(peerKey(tunnel('64:ff9b::203.0.113.9'))).toBe('64:ff9b:0:0::/64')
  })

  it('leaves IPv4, the LAN and anything unreadable as they are', () => {
    expect(peerKey(tunnel('203.0.113.9'))).toBe('203.0.113.9')
    expect(peerKey(tunnel('::ffff:203.0.113.9'))).toBe('203.0.113.9')
    expect(peerKey(lan('fe80::1'))).toBe('fe80::1')
    expect(peerKey(lan('fe80::2'))).not.toBe(peerKey(lan('fe80::1')))
    expect(peerKey(tunnel('unknown'))).toBe('unknown')
    expect(peerKey(tunnel('1::2::3'))).toBe('1::2::3')
  })
})

describe('FailedAuthLimiter', () => {
  const origin = (peerIp: string, via: 'lan' | 'tunnel' = 'tunnel'): ConnectionOrigin => ({ via, peerIp, connectorTag: null })

  it('blocks an address after five failures in five minutes, for fifteen', () => {
    let now = 0
    const limiter = new FailedAuthLimiter({ now: () => now })
    for (let i = 0; i < 4; i++) limiter.recordFailure(origin('203.0.113.9'))
    expect(limiter.isBlocked(origin('203.0.113.9'))).toBe(false)
    limiter.recordFailure(origin('203.0.113.9'))
    expect(limiter.isBlocked(origin('203.0.113.9'))).toBe(true)
    expect(limiter.isBlocked(origin('203.0.113.10'))).toBe(false)
    now += 15 * 60_000 - 1
    expect(limiter.isBlocked(origin('203.0.113.9'))).toBe(true)
    now += 1
    expect(limiter.isBlocked(origin('203.0.113.9'))).toBe(false)
  })

  it('forgets failures older than five minutes', () => {
    let now = 0
    const limiter = new FailedAuthLimiter({ now: () => now })
    for (let i = 0; i < 4; i++) limiter.recordFailure(origin('203.0.113.9'))
    now += 5 * 60_000
    limiter.recordFailure(origin('203.0.113.9'))
    expect(limiter.isBlocked(origin('203.0.113.9'))).toBe(false)
  })

  it('trips the breaker on a wave of tunneled failures from many addresses, and not on the LAN', () => {
    const limiter = new FailedAuthLimiter()
    for (let i = 0; i < 60; i++) limiter.recordFailure(origin(`192.168.1.${i}`, 'lan'))
    expect(limiter.breakerTripped).toBe(false)
    const tripped: boolean[] = []
    for (let i = 0; i < 51; i++) tripped.push(limiter.recordFailure(origin(`203.0.113.${i}`)))
    expect(tripped.filter(Boolean)).toHaveLength(1)
    expect(tripped.at(-1)).toBe(true)
    expect(limiter.breakerTripped).toBe(true)
    limiter.resetBreaker()
    expect(limiter.breakerTripped).toBe(false)
  })

  it('blocks a whole /64 rotating its addresses', () => {
    const limiter = new FailedAuthLimiter()
    for (let i = 1; i <= 5; i++) limiter.recordFailure(origin(`2001:db8:aa:bb::${i}`))
    expect(limiter.isBlocked(origin('2001:db8:aa:bb::99'))).toBe(true)
    expect(limiter.isBlocked(origin('2001:db8:aa:bc::1'))).toBe(false)
  })

  it('counts a soft failure against the peer, not toward the breaker', () => {
    const limiter = new FailedAuthLimiter()
    for (let i = 0; i < 60; i++) limiter.recordFailure(origin(`203.0.113.${i}`), { soft: true })
    expect(limiter.breakerTripped).toBe(false)
    for (let i = 0; i < 4; i++) limiter.recordFailure(origin('198.51.100.7'), { soft: true })
    limiter.recordFailure(origin('198.51.100.7'))
    expect(limiter.isBlocked(origin('198.51.100.7'))).toBe(true)
  })

  it('forgets peers whose failures and blocks have run out, and never remembers too many', () => {
    let now = 0
    const limiter = new FailedAuthLimiter({ now: () => now, maxTracked: 100 })
    for (let i = 0; i < 50; i++) limiter.recordFailure(origin(`203.0.113.${i}`))
    for (let i = 0; i < 5; i++) limiter.recordFailure(origin('198.51.100.7'))
    expect(limiter.trackedCount).toBe(51)
    now += 15 * 60_000
    limiter.recordFailure(origin('198.51.100.8'))
    expect(limiter.trackedCount).toBe(1)
    for (let i = 0; i < 500; i++) limiter.recordFailure(origin(`10.0.${i >> 8}.${i & 255}`))
    expect(limiter.trackedCount).toBe(100)
    // The newest are the ones kept.
    for (let i = 0; i < 4; i++) limiter.recordFailure(origin('10.0.1.243'))
    expect(limiter.isBlocked(origin('10.0.1.243'))).toBe(true)
  })
})

// Who is at the other end of a relay connection, and the limits that keep a
// relay reachable from the internet from being leaned on.

import { describe, expect, it } from 'vitest'
import {
  FailedAuthLimiter,
  admitsTunneled,
  classifyConnection,
  isLoopback,
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

  it('doesn’t let a LAN client claim to be tunneled, or someone else', () => {
    expect(classifyConnection('192.168.1.40', { 'cf-warp-tag-id': CONNECTOR, 'cf-connecting-ip': '203.0.113.9' })).toEqual({
      via: 'lan',
      peerIp: '192.168.1.40',
      connectorTag: null
    })
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

describe('FailedAuthLimiter', () => {
  const origin = (peerIp: string, via: 'lan' | 'tunnel' = 'tunnel'): ConnectionOrigin => ({ via, peerIp, connectorTag: null })

  it('blocks an address after five failures in five minutes, for fifteen', () => {
    let now = 0
    const limiter = new FailedAuthLimiter({ now: () => now })
    for (let i = 0; i < 4; i++) limiter.recordFailure(origin('203.0.113.9'))
    expect(limiter.isBlocked('203.0.113.9')).toBe(false)
    limiter.recordFailure(origin('203.0.113.9'))
    expect(limiter.isBlocked('203.0.113.9')).toBe(true)
    expect(limiter.isBlocked('203.0.113.10')).toBe(false)
    now += 15 * 60_000 - 1
    expect(limiter.isBlocked('203.0.113.9')).toBe(true)
    now += 1
    expect(limiter.isBlocked('203.0.113.9')).toBe(false)
  })

  it('forgets failures older than five minutes', () => {
    let now = 0
    const limiter = new FailedAuthLimiter({ now: () => now })
    for (let i = 0; i < 4; i++) limiter.recordFailure(origin('203.0.113.9'))
    now += 5 * 60_000
    limiter.recordFailure(origin('203.0.113.9'))
    expect(limiter.isBlocked('203.0.113.9')).toBe(false)
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
})

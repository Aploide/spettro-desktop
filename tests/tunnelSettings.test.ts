// What the tunnel settings accept: the token in every shape the Cloudflare
// dashboard hands it out, the hostname as people type it, and the file the
// two are kept in.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  extractToken,
  normalizeHostname,
  parseToken,
  redactTokens
} from '@main/remote/tunnel/tunnelToken'
import { TunnelStore } from '@main/remote/tunnel/tunnelStore'

const TUNNEL_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

/** A token shaped like the dashboard's: base64 of {a, t, s}. */
function token(fields: Record<string, unknown> = {}): string {
  return Buffer.from(
    JSON.stringify({
      a: '0123456789abcdef0123456789abcdef',
      t: TUNNEL_ID,
      s: Buffer.alloc(32, 7).toString('base64'),
      ...fields
    })
  ).toString('base64')
}

describe('extractToken', () => {
  const T = token()

  it('takes the bare token', () => {
    expect(extractToken(T)).toBe(T)
    expect(extractToken(`  ${T}\n`)).toBe(T)
  })

  it('takes it out of every command the dashboard shows', () => {
    for (const command of [
      `cloudflared service install ${T}`,
      `sudo cloudflared service install ${T}`,
      `cloudflared.exe service install ${T}`,
      `cloudflared tunnel run --token ${T}`,
      `cloudflared tunnel --no-autoupdate run --token ${T}`
    ]) {
      expect(extractToken(command)).toBe(T)
    }
  })

  it('finds nothing in text without one', () => {
    expect(extractToken('')).toBeNull()
    expect(extractToken('cloudflared service install')).toBeNull()
    expect(extractToken('eyJshort')).toBeNull()
  })
})

describe('parseToken', () => {
  it('reads the tunnel the token is for', () => {
    expect(parseToken(token())).toEqual({ accountTag: '0123456789abcdef0123456789abcdef', tunnelId: TUNNEL_ID })
  })

  it('refuses the URL-safe alphabet, which cloudflared would refuse too', () => {
    // A secret with bytes that encode to `+`/`/` in the standard alphabet.
    const standard = token({ s: Buffer.from([0xfb, 0xff, 0xfe, 0xfb, 0xff]).toString('base64'), pad: '>>>???' })
    expect(standard).toMatch(/[+/]/)
    expect(parseToken(standard)).not.toBeNull()
    const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_')
    expect(extractToken(urlSafe)).toBe(urlSafe)
    expect(parseToken(urlSafe)).toBeNull()
  })

  it('refuses what isn’t a token', () => {
    expect(parseToken(Buffer.from('not json at all, no').toString('base64'))).toBeNull()
    expect(parseToken(token({ t: 'not-a-uuid' }))).toBeNull()
    expect(parseToken(token({ s: '' }))).toBeNull()
    expect(parseToken(token({ a: 7 }))).toBeNull()
    expect(parseToken(Buffer.from('[1,2,3]').toString('base64'))).toBeNull()
  })
})

describe('redactTokens', () => {
  it('takes every token out of a line', () => {
    const T = token()
    expect(redactTokens(`run --token ${T} and ${T}`)).toBe('run --token [token] and [token]')
  })
})

describe('normalizeHostname', () => {
  it('keeps the bare, lowercased hostname', () => {
    for (const typed of [
      'spettro.example.com',
      'Spettro.Example.COM',
      'https://spettro.example.com/',
      'wss://spettro.example.com/path?x=1',
      'spettro.example.com.',
      'spettro.example.com:443'
    ]) {
      expect(normalizeHostname(typed)).toEqual({ ok: true, hostname: 'spettro.example.com' })
    }
  })

  it('lets it be blank, for the tunnel to fill in', () => {
    expect(normalizeHostname('  ')).toEqual({ ok: true, hostname: '' })
  })

  it('refuses what isn’t a hostname, and quick tunnels', () => {
    expect(normalizeHostname('localhost').ok).toBe(false)
    expect(normalizeHostname('spettro example.com').ok).toBe(false)
    expect(normalizeHostname('-bad.example.com').ok).toBe(false)
    const quick = normalizeHostname('https://random-words.trycloudflare.com')
    expect(quick).toEqual({ ok: false, message: 'Quick tunnels aren’t supported; use a hostname on your own domain.' })
  })
})

describe('TunnelStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spettro-tunnel-store-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts off, on the preferred port, with internet pairing off', () => {
    expect(new TunnelStore(dir).get()).toEqual({
      enabled: false,
      token: null,
      hostname: '',
      port: 7879,
      allowInternetPairing: false,
      binaryPath: null
    })
  })

  it('remembers what it was told, in a file only the owner can read', () => {
    const store = new TunnelStore(dir)
    store.update({ enabled: true, token: token(), hostname: 'spettro.example.com', port: 8123, allowInternetPairing: true })
    const again = new TunnelStore(dir).get()
    expect(again).toMatchObject({ enabled: true, token: token(), hostname: 'spettro.example.com', port: 8123, allowInternetPairing: true })
    if (process.platform !== 'win32') expect(statSync(store.filePath).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(store.filePath, 'utf8')).token).toBe(token())
  })

  it('keeps the defaults for anything in the file it can’t use', () => {
    writeFileSync(join(dir, 'remote-tunnel.json'), JSON.stringify({ enabled: 'yes', port: 80, token: 5, hostname: 'h.example.com' }))
    expect(new TunnelStore(dir).get()).toMatchObject({ enabled: false, port: 7879, token: null, hostname: 'h.example.com' })
    writeFileSync(join(dir, 'remote-tunnel.json'), '{not json')
    expect(new TunnelStore(dir).get().enabled).toBe(false)
  })
})

// What the internet-access builds left in the app's data folder goes at
// launch, and nothing else does: not a file beside it, not a cloudflared
// somewhere else, not what a symlink points at.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanUpLegacyTunnel } from '@main/remote/legacyTunnelCleanup'

let root: string
let dataDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'spettro-legacy-tunnel-'))
  dataDir = join(root, 'userData')
  mkdirSync(dataDir)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function put(path: string, text = 'x'): string {
  writeFileSync(path, text)
  return path
}

/** What a build with the tunnel left behind. */
function leaveTunnelBehind(platform: NodeJS.Platform = 'linux'): void {
  const exe = platform === 'win32' ? '.exe' : ''
  put(join(dataDir, 'remote-tunnel.json'), JSON.stringify({ enabled: true, token: 'secret', binaryPath: join(root, 'elsewhere', 'cloudflared') }))
  mkdirSync(join(dataDir, 'bin'))
  put(join(dataDir, 'bin', `cloudflared${exe}`))
  put(join(dataDir, 'bin', `cloudflared${exe}.part`))
  put(join(dataDir, 'bin', `cloudflared-new${exe}`))
  put(join(dataDir, 'bin', 'cloudflared.json'), '{}')
  put(join(dataDir, 'cloudflared.pid'), '4242')
  mkdirSync(join(dataDir, 'cloudflared'))
  put(join(dataDir, 'cloudflared', 'config.yml'), '{}')
}

describe('cleanUpLegacyTunnel', () => {
  it('removes the tunnel’s settings, Spettro’s own cloudflared and what came with it', () => {
    leaveTunnelBehind()
    cleanUpLegacyTunnel(dataDir, { platform: 'linux', readCmdline: () => null })
    expect(readdirSync(dataDir)).toEqual([])
  })

  it('takes the .exe names on Windows', () => {
    leaveTunnelBehind('win32')
    cleanUpLegacyTunnel(dataDir, { platform: 'win32' })
    expect(readdirSync(dataDir)).toEqual([])
  })

  it('leaves everything else in the data folder, and a folder that isn’t empty', () => {
    leaveTunnelBehind()
    put(join(dataDir, 'preferences.json'), '{"remoteSharing":true}')
    put(join(dataDir, 'remote-devices.json'), '{}')
    put(join(dataDir, 'bin', 'something-else'))
    cleanUpLegacyTunnel(dataDir, { platform: 'linux', readCmdline: () => null })
    expect(readdirSync(dataDir).sort()).toEqual(['bin', 'preferences.json', 'remote-devices.json'])
    expect(readdirSync(join(dataDir, 'bin'))).toEqual(['something-else'])
  })

  it('never touches a cloudflared outside the data folder, even the one the settings name', () => {
    mkdirSync(join(root, 'elsewhere'))
    const theirs = put(join(root, 'elsewhere', 'cloudflared'))
    leaveTunnelBehind()
    cleanUpLegacyTunnel(dataDir, { platform: 'linux', readCmdline: () => null })
    expect(existsSync(theirs)).toBe(true)
  })

  it('removes no symlink’s target, and doesn’t follow a linked bin folder', () => {
    mkdirSync(join(root, 'elsewhere'))
    const theirs = put(join(root, 'elsewhere', 'cloudflared'))
    symlinkSync(join(root, 'elsewhere'), join(dataDir, 'bin'))
    cleanUpLegacyTunnel(dataDir, { platform: 'linux' })
    expect(existsSync(theirs)).toBe(true)
    rmSync(join(dataDir, 'bin'))
    mkdirSync(join(dataDir, 'bin'))
    symlinkSync(theirs, join(dataDir, 'bin', 'cloudflared'))
    cleanUpLegacyTunnel(dataDir, { platform: 'linux' })
    expect(existsSync(theirs)).toBe(true)
    expect(readdirSync(join(dataDir, 'bin'))).toEqual(['cloudflared'])
  })

  it('ends a cloudflared it started only when /proc says it ran with Spettro’s config', () => {
    const killed: number[] = []
    const config = join(dataDir, 'cloudflared', 'config.yml')
    leaveTunnelBehind()
    cleanUpLegacyTunnel(dataDir, {
      platform: 'linux',
      readCmdline: () => `/usr/bin/cloudflared\0tunnel\0--config\0${config}\0run\0`,
      kill: (pid) => killed.push(pid)
    })
    expect(killed).toEqual([4242])
    leaveTunnelBehind()
    cleanUpLegacyTunnel(dataDir, {
      platform: 'linux',
      readCmdline: () => '/usr/bin/cloudflared\0tunnel\0run\0',
      kill: (pid) => killed.push(pid)
    })
    leaveTunnelBehind()
    cleanUpLegacyTunnel(dataDir, { platform: 'linux', readCmdline: () => '/usr/bin/firefox\0', kill: (pid) => killed.push(pid) })
    // A reused pid whose program merely names the config (an editor that
    // opened it) is not a cloudflared, whatever its arguments say.
    leaveTunnelBehind()
    cleanUpLegacyTunnel(dataDir, {
      platform: 'linux',
      readCmdline: () => `/usr/bin/vim\0${config}\0`,
      kill: (pid) => killed.push(pid)
    })
    leaveTunnelBehind()
    cleanUpLegacyTunnel(dataDir, {
      platform: 'linux',
      readCmdline: () => `/usr/bin/less\0/tmp/cloudflared\0${config}\0`,
      kill: (pid) => killed.push(pid)
    })
    expect(killed).toEqual([4242])
    expect(existsSync(join(dataDir, 'cloudflared.pid'))).toBe(false)
  })

  it('does nothing in a data folder that never had a tunnel, however often it runs', () => {
    // The platform is pinned so the names planted are the names looked for
    // on every CI runner, Windows included.
    const linux = { platform: 'linux' as const, readCmdline: () => null }
    put(join(dataDir, 'preferences.json'), '{}')
    expect(cleanUpLegacyTunnel(dataDir, linux)).toEqual([])
    leaveTunnelBehind()
    expect(cleanUpLegacyTunnel(dataDir, linux).length).toBeGreaterThan(0)
    expect(cleanUpLegacyTunnel(dataDir, linux)).toEqual([])
    expect(readdirSync(dataDir)).toEqual(['preferences.json'])
  })
})

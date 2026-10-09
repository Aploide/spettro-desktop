// Finding a cloudflared, and getting Spettro its own when there is none. The
// network is never touched: the release listing and the download are fakes
// handed to the installer, the way the updater's would be.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GithubRelease } from '@main/model/updater'
import {
  CloudflaredInstaller,
  CloudflaredInstallError,
  cloudflaredAssetName,
  expectedSha256
} from '@main/remote/tunnel/cloudflaredInstaller'
import {
  cloudflaredCandidates,
  isOutdated,
  locateCloudflared,
  parseCloudflaredVersion,
  versionAtLeast
} from '@main/remote/tunnel/cloudflaredLocator'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spettro-cloudflared-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('versions', () => {
  it('reads what cloudflared --version prints', () => {
    expect(parseCloudflaredVersion('cloudflared version 2026.8.2 (built 20260818-01:23:47)')).toBe('2026.8.2')
    expect(parseCloudflaredVersion('something else')).toBeNull()
    expect(parseCloudflaredVersion(null)).toBeNull()
  })

  it('compares them part by part', () => {
    expect(versionAtLeast('2026.8.2', '2024.1.0')).toBe(true)
    expect(versionAtLeast('2024.1.0', '2024.1.0')).toBe(true)
    expect(versionAtLeast('2023.12.9', '2024.1.0')).toBe(false)
    expect(versionAtLeast('2026.10.0', '2026.8.2')).toBe(true)
  })

  it('calls a release over a year old outdated', () => {
    const now = Date.UTC(2026, 9, 9)
    expect(isOutdated('2026.8.2', now)).toBe(false)
    expect(isOutdated('2025.10.0', now)).toBe(false)
    expect(isOutdated('2025.9.0', now)).toBe(true)
  })
})

describe('locateCloudflared', () => {
  const linux = { platform: 'linux' as const, env: { PATH: '/opt/cf:/usr/bin' }, home: '/home/u' }

  it('looks on PATH, then where packages put it, then at Spettro’s copy', () => {
    const paths = cloudflaredCandidates({ dataDir: '/data', explicitPath: '/mine/cloudflared', ...linux }).map((c) => c.path)
    expect(paths).toEqual([
      '/mine/cloudflared',
      '/opt/cf/cloudflared',
      '/usr/bin/cloudflared',
      '/usr/local/bin/cloudflared',
      '/home/u/.local/bin/cloudflared',
      '/data/bin/cloudflared'
    ])
  })

  it('knows where Windows installers put it', () => {
    const paths = cloudflaredCandidates({
      dataDir: 'C:\\Users\\u\\AppData\\Roaming\\Spettro',
      platform: 'win32',
      env: {
        PATH: 'C:\\tools',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        ProgramFiles: 'C:\\Program Files',
        LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local'
      }
    }).map((c) => c.path)
    expect(paths).toEqual([
      'C:\\tools\\cloudflared.exe',
      'C:\\tools\\cloudflared',
      'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
      'C:\\Program Files\\cloudflared\\cloudflared.exe',
      'C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links\\cloudflared.exe',
      'C:\\Users\\u\\AppData\\Roaming\\Spettro\\bin\\cloudflared.exe'
    ])
  })

  it('takes the first that runs and is new enough', async () => {
    const versions: Record<string, string | null> = {
      '/opt/cf/cloudflared': '2023.5.0',
      '/usr/bin/cloudflared': '2026.8.2'
    }
    const found = await locateCloudflared({
      dataDir: '/data',
      ...linux,
      isExecutable: (p) => p in versions,
      readVersion: async (p) => versions[p] ?? null
    })
    expect(found).toEqual({ path: '/usr/bin/cloudflared', version: '2026.8.2', source: 'system' })
  })

  it('takes Spettro’s copy over an older system one, but never over the user’s choice', async () => {
    const versions: Record<string, string> = {
      '/usr/bin/cloudflared': '2025.1.0',
      '/data/bin/cloudflared': '2026.10.0',
      '/mine/cloudflared': '2024.6.0'
    }
    const options = {
      dataDir: '/data',
      ...linux,
      isExecutable: (p: string) => p in versions,
      readVersion: async (p: string) => versions[p] ?? null
    }
    expect((await locateCloudflared(options))?.path).toBe('/data/bin/cloudflared')
    expect((await locateCloudflared({ ...options, explicitPath: '/mine/cloudflared' }))?.path).toBe('/mine/cloudflared')
  })

  it('finds nothing when nothing runs', async () => {
    expect(await locateCloudflared({ dataDir: '/data', ...linux, isExecutable: () => true, readVersion: async () => null })).toBeNull()
  })
})

describe('cloudflaredAssetName', () => {
  const names = ['cloudflared-linux-amd64', 'cloudflared-linux-arm64', 'cloudflared-windows-amd64.exe', 'cloudflared-windows-386.exe']

  it('picks the build for every machine the app ships for', () => {
    expect(cloudflaredAssetName(names, 'linux', 'x64')).toBe('cloudflared-linux-amd64')
    expect(cloudflaredAssetName(names, 'linux', 'arm64')).toBe('cloudflared-linux-arm64')
    expect(cloudflaredAssetName(names, 'win32', 'x64')).toBe('cloudflared-windows-amd64.exe')
  })

  it('emulates on Windows on Arm until a native build is published', () => {
    expect(cloudflaredAssetName(names, 'win32', 'arm64', '10.0.22631')).toBe('cloudflared-windows-amd64.exe')
    expect(cloudflaredAssetName(names, 'win32', 'arm64', '10.0.19045')).toBe('cloudflared-windows-386.exe')
    expect(cloudflaredAssetName([...names, 'cloudflared-windows-arm64.exe'], 'win32', 'arm64', '10.0.22631')).toBe(
      'cloudflared-windows-arm64.exe'
    )
  })

  it('has nothing for the rest', () => {
    expect(cloudflaredAssetName(names, 'linux', 'ia32')).toBeNull()
    expect(cloudflaredAssetName(names, 'darwin', 'arm64')).toBeNull()
  })
})

describe('expectedSha256', () => {
  const hex = 'd33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db'

  it('trusts GitHub’s digest first, then the notes’ checksum block', () => {
    expect(expectedSha256({ name: 'cloudflared-linux-amd64', url: '', size: 1, digest: `sha256:${hex}` }, '')).toBe(hex)
    const body = `### SHA256 Checksums:\n\`\`\`\ncloudflared-linux-arm64: ${'e'.repeat(64)}\ncloudflared-linux-amd64: ${hex}\n\`\`\``
    expect(expectedSha256({ name: 'cloudflared-linux-amd64', url: '', size: 1 }, body)).toBe(hex)
    expect(expectedSha256({ name: 'cloudflared-linux-amd64', url: '', size: 1, digest: 'md5:abc' }, '')).toBeNull()
  })
})

describe('CloudflaredInstaller', () => {
  const binary = Buffer.from('#!/bin/sh\necho "cloudflared version 2026.10.0 (built 20261005-00:00:00)"\n')
  const sha = createHash('sha256').update(binary).digest('hex')

  function release(overrides: Partial<{ digest: string; size: number }> = {}): GithubRelease {
    return {
      tag: '2026.10.0',
      version: '2026.10.0',
      notes: null,
      body: '',
      htmlUrl: 'https://github.com/cloudflare/cloudflared/releases/tag/2026.10.0',
      assets: [
        {
          name: 'cloudflared-linux-amd64',
          url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-linux-amd64',
          size: overrides.size ?? binary.length,
          digest: overrides.digest ?? `sha256:${sha}`
        }
      ]
    }
  }

  /** A response that streams `body` in two chunks. */
  function respond(body: Buffer): IncomingMessage {
    const stream = new PassThrough() as unknown as IncomingMessage & PassThrough
    ;(stream as unknown as { headers: Record<string, string> }).headers = { 'content-length': String(body.length) }
    setImmediate(() => {
      stream.write(body.subarray(0, 10))
      stream.end(body.subarray(10))
    })
    return stream
  }

  function installer(overrides: Partial<ConstructorParameters<typeof CloudflaredInstaller>[0]> = {}): {
    installer: CloudflaredInstaller
    fetched: string[]
  } {
    const fetched: string[] = []
    return {
      fetched,
      installer: new CloudflaredInstaller({
        dataDir: dir,
        platform: 'linux',
        arch: 'x64',
        fetchRelease: async () => release(),
        request: async (url) => {
          fetched.push(url)
          return respond(binary)
        },
        readVersion: async () => '2026.10.0',
        ...overrides
      })
    }
  }

  it('installs the verified asset into userData, executable', async () => {
    const { installer: it_, fetched } = installer()
    const progress: (number | null)[] = []
    const result = await it_.install((p) => progress.push(p))
    const target = join(dir, 'bin', 'cloudflared')
    expect(result).toEqual({ path: target, version: '2026.10.0', asset: 'cloudflared-linux-amd64', sha256: sha })
    expect(fetched).toEqual([release().assets[0].url])
    expect(readFileSync(target)).toEqual(binary)
    expect(statSync(target).mode & 0o111).not.toBe(0)
    expect(existsSync(`${target}.part`)).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'bin', 'cloudflared.json'), 'utf8'))).toMatchObject({ sha256: sha, version: '2026.10.0' })
    expect(progress.at(-1)).toBe(1)
  })

  it('refuses a download that doesn’t match its checksum, and leaves nothing behind', async () => {
    const { installer: it_ } = installer({ fetchRelease: async () => release({ digest: `sha256:${'0'.repeat(64)}` }) })
    await expect(it_.install()).rejects.toMatchObject({ kind: 'download-failed', message: expect.stringMatching(/checksum/) })
    expect(existsSync(join(dir, 'bin', 'cloudflared'))).toBe(false)
    expect(existsSync(join(dir, 'bin', 'cloudflared.part'))).toBe(false)
  })

  it('refuses a release with no checksum at all', async () => {
    const { installer: it_, fetched } = installer({
      fetchRelease: async () => ({ ...release(), assets: [{ ...release().assets[0], digest: undefined }] })
    })
    await expect(it_.install()).rejects.toMatchObject({ kind: 'download-failed' })
    expect(fetched).toEqual([])
  })

  it('refuses a download cut short', async () => {
    const { installer: it_ } = installer({ fetchRelease: async () => release({ size: binary.length + 100 }) })
    await expect(it_.install()).rejects.toBeInstanceOf(CloudflaredInstallError)
  })

  it('takes back a binary that won’t run here', async () => {
    const { installer: it_ } = installer({ readVersion: async () => null })
    await expect(it_.install()).rejects.toMatchObject({ message: 'The downloaded cloudflared doesn’t run on this computer.' })
    expect(existsSync(join(dir, 'bin', 'cloudflared'))).toBe(false)
    expect(existsSync(join(dir, 'bin', 'cloudflared-new'))).toBe(false)
  })

  it('asks the new copy its version before it replaces the old one, and keeps the old one if it won’t say', async () => {
    mkdirSync(join(dir, 'bin'), { recursive: true })
    writeFileSync(join(dir, 'bin', 'cloudflared'), 'old')
    const asked: string[] = []
    const { installer: it_ } = installer({
      readVersion: async (path) => {
        asked.push(path)
        return null
      }
    })
    await expect(it_.install()).rejects.toMatchObject({ kind: 'download-failed' })
    expect(asked).toEqual([join(dir, 'bin', 'cloudflared-new')])
    expect(readFileSync(join(dir, 'bin', 'cloudflared'), 'utf8')).toBe('old')
    expect(existsSync(join(dir, 'bin', 'cloudflared-new'))).toBe(false)
  })

  it('says so on a machine Cloudflare builds nothing for', async () => {
    const { installer: it_ } = installer({ arch: 'ia32' })
    await expect(it_.install()).rejects.toMatchObject({ kind: 'unsupported-platform' })
  })

  it('can be cancelled mid-download', async () => {
    const stalled = new PassThrough() as unknown as IncomingMessage
    ;(stalled as unknown as { headers: Record<string, string> }).headers = {}
    const { installer: it_ } = installer({ request: async () => stalled })
    const running = it_.install()
    await new Promise((resolve) => setImmediate(resolve))
    it_.cancel()
    await expect(running).rejects.toMatchObject({ kind: 'cancelled' })
    expect(it_.isRunning).toBe(false)
  })

  it('takes a new install at once after a cancel, without the two tripping over each other', async () => {
    const stalled = new PassThrough() as unknown as IncomingMessage
    ;(stalled as unknown as { headers: Record<string, string> }).headers = {}
    let calls = 0
    const { installer: it_ } = installer({ request: async () => (++calls === 1 ? stalled : respond(binary)) })
    const first = it_.install()
    await new Promise((resolve) => setImmediate(resolve))
    it_.cancel()
    expect(it_.isRunning).toBe(false)
    const second = it_.install()
    expect(it_.isRunning).toBe(true)
    await expect(first).rejects.toMatchObject({ kind: 'cancelled' })
    await expect(second).resolves.toMatchObject({ path: join(dir, 'bin', 'cloudflared') })
    expect(readFileSync(join(dir, 'bin', 'cloudflared'))).toEqual(binary)
    expect(it_.isRunning).toBe(false)
  })

  it('replaces an earlier copy', async () => {
    mkdirSync(join(dir, 'bin'), { recursive: true })
    writeFileSync(join(dir, 'bin', 'cloudflared'), 'old')
    await installer().installer.install()
    expect(readFileSync(join(dir, 'bin', 'cloudflared'))).toEqual(binary)
  })
})

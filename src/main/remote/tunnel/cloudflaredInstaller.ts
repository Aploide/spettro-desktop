// Gets Spettro its own cloudflared when the machine has none: the official
// release asset for this platform, from cloudflare/cloudflared's latest
// GitHub release, into <userData>/bin.
//
// The file is only used once it matches the checksum GitHub lists for it
// (the asset's `digest`, or failing that the release notes' "SHA256
// Checksums" block — no checksum, no install). It is written beside the
// final path, made executable and asked its version there — which catches
// the wrong architecture and noexec mounts before the tunnel trips over
// them — and only then renamed over the final path. A download that dies
// halfway, or a copy that won't run, never takes the place of one that does.
//
// The checksum comes from the same place the binary does, so this guards
// against a corrupt or truncated download, not a compromised release.

import { createHash } from 'crypto'
import { createWriteStream } from 'fs'
import { chmod, mkdir, rename, rm, writeFile } from 'fs/promises'
import type { IncomingMessage } from 'http'
import { release as osRelease } from 'os'
import { dirname, join } from 'path'
import { fetchLatestRelease, request, type GithubRelease, type ReleaseAsset } from '../../model/updater'
import { downloadedCloudflaredPath, readCloudflaredVersion } from './cloudflaredLocator'

export const CLOUDFLARED_REPO = 'cloudflare/cloudflared'

/** Same as the CLI installer's: about 40–55 MB on a slow line still fits. */
export const CLOUDFLARED_INSTALL_TIMEOUT_MS = 3 * 60_000

/** How long a fresh download gets to say its version. Longer than the
 *  locator's: an antivirus scans a new 50 MB executable before its first
 *  run, and a copy that was only slow must not be thrown away. */
export const FRESH_VERSION_TIMEOUT_MS = 30_000

/** The release asset for this machine, or null when Cloudflare builds none
 *  it can run. Windows on Arm runs the x64 build under emulation (Windows 11)
 *  unless a native arm64 build is published; Windows 10 on Arm can only
 *  emulate 32-bit x86. */
export function cloudflaredAssetName(
  assetNames: readonly string[],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  windowsRelease: string = osRelease()
): string | null {
  if (platform === 'linux') {
    if (arch === 'x64') return 'cloudflared-linux-amd64'
    if (arch === 'arm64') return 'cloudflared-linux-arm64'
    return null
  }
  if (platform === 'win32') {
    if (arch === 'x64') return 'cloudflared-windows-amd64.exe'
    if (arch === 'ia32') return 'cloudflared-windows-386.exe'
    if (arch === 'arm64') {
      if (assetNames.includes('cloudflared-windows-arm64.exe')) return 'cloudflared-windows-arm64.exe'
      const build = Number.parseInt(windowsRelease.split('.')[2] ?? '0', 10) || 0
      return build >= 22000 ? 'cloudflared-windows-amd64.exe' : 'cloudflared-windows-386.exe'
    }
  }
  return null
}

/** The SHA-256 GitHub lists for an asset, lowercase hex, or null. */
export function expectedSha256(asset: ReleaseAsset, releaseBody: string): string | null {
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '')
  if (digest) return digest[1].toLowerCase()
  const escaped = asset.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const listed = new RegExp(`^\\s*${escaped}:\\s*([0-9a-f]{64})\\s*$`, 'mi').exec(releaseBody)
  return listed ? listed[1].toLowerCase() : null
}

export type CloudflaredInstallErrorKind = 'unsupported-platform' | 'download-failed' | 'cancelled'

export class CloudflaredInstallError extends Error {
  constructor(
    readonly kind: CloudflaredInstallErrorKind,
    message: string
  ) {
    super(message)
  }
}

export interface InstalledCloudflared {
  path: string
  version: string
  asset: string
  sha256: string
}

export interface CloudflaredInstallerOptions {
  dataDir: string
  platform?: NodeJS.Platform
  arch?: string
  windowsRelease?: string
  timeoutMs?: number
  fetchRelease?: (repo: string) => Promise<GithubRelease>
  request?: (url: string, accept: string) => Promise<IncomingMessage>
  readVersion?: (path: string) => Promise<string | null>
}

export class CloudflaredInstaller {
  private readonly options: CloudflaredInstallerOptions
  /** Ends the install in progress. Cleared the moment it is called, so a
   *  new install can begin while the cancelled one tidies up. */
  private abort: ((error: CloudflaredInstallError) => void) | null = null
  /** Settles once the last install has finished with its files. */
  private settled: Promise<void> = Promise.resolve()

  constructor(options: CloudflaredInstallerOptions) {
    this.options = options
  }

  get isRunning(): boolean {
    return this.abort !== null
  }

  cancel(): void {
    const abort = this.abort
    this.abort = null
    abort?.(new CloudflaredInstallError('cancelled', 'Cancelled.'))
  }

  /** Downloads, verifies and installs; resolves with the installed copy.
   *  Rejects with a CloudflaredInstallError. */
  async install(onProgress: (fraction: number | null) => void = () => undefined): Promise<InstalledCloudflared> {
    if (this.abort) throw new CloudflaredInstallError('download-failed', 'cloudflared is already being downloaded.')
    const platform = this.options.platform ?? process.platform
    const target = downloadedCloudflaredPath(this.options.dataDir, platform)
    const partial = `${target}.part`
    // Verified and executable, but not yet known to run.
    const candidate = platform === 'win32' ? `${target.slice(0, -'.exe'.length)}-new.exe` : `${target}-new`
    let response: IncomingMessage | null = null
    let aborted: CloudflaredInstallError | null = null
    let abort!: (error: CloudflaredInstallError) => void
    const abortion = new Promise<never>((_, reject) => {
      abort = (error) => {
        aborted = error
        response?.destroy()
        reject(error)
      }
    })
    abortion.catch(() => undefined)
    this.abort = abort
    // A cancelled install may still be removing the partial file this one
    // is about to write.
    const previous = this.settled
    let settle!: () => void
    this.settled = new Promise<void>((resolve) => (settle = resolve))
    const timer = setTimeout(
      () => abort(new CloudflaredInstallError('download-failed', 'Getting cloudflared took too long. Check your connection and try again.')),
      this.options.timeoutMs ?? CLOUDFLARED_INSTALL_TIMEOUT_MS
    )
    timer.unref?.()
    const race = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, abortion])

    try {
      await previous
      if (aborted) throw aborted
      onProgress(null)
      const release = await race((this.options.fetchRelease ?? fetchLatestRelease)(CLOUDFLARED_REPO)).catch(
        (error: unknown) => {
          throw asInstallError(error, 'Couldn’t reach GitHub to get cloudflared.')
        }
      )
      const name = cloudflaredAssetName(
        release.assets.map((a) => a.name),
        platform,
        this.options.arch ?? process.arch,
        this.options.windowsRelease ?? osRelease()
      )
      if (!name) {
        throw new CloudflaredInstallError('unsupported-platform', 'Cloudflare doesn’t publish cloudflared for this computer. Install it yourself, then try again.')
      }
      const asset = release.assets.find((a) => a.name === name)
      if (!asset) throw new CloudflaredInstallError('download-failed', `The latest cloudflared release has no ${name}.`)
      const sha256 = expectedSha256(asset, release.body)
      if (!sha256) {
        throw new CloudflaredInstallError('download-failed', 'The latest cloudflared release lists no checksum, so Spettro won’t use it.')
      }

      await mkdir(dirname(target), { recursive: true })
      response = await race((this.options.request ?? request)(asset.url, 'application/octet-stream')).catch(
        (error: unknown) => {
          throw asInstallError(error, 'Couldn’t download cloudflared.')
        }
      )
      const actual = await race(saveHashed(response, partial, asset.size, onProgress)).catch((error: unknown) => {
        throw asInstallError(error, 'The cloudflared download didn’t finish. Check your connection and try again.')
      })
      if (actual.size === 0 || (asset.size > 0 && actual.size !== asset.size)) {
        throw new CloudflaredInstallError('download-failed', 'The cloudflared download didn’t finish. Check your connection and try again.')
      }
      if (actual.sha256 !== sha256) {
        throw new CloudflaredInstallError('download-failed', 'The downloaded cloudflared didn’t match its checksum, so Spettro didn’t use it.')
      }
      if (platform !== 'win32') await chmod(partial, 0o755)
      // Run under a name of its own (Windows only runs .exe files, and the
      // locator never looks there), so the copy it replaces stays usable
      // until this one has proved it runs.
      await rename(partial, candidate)
      const version = await race(
        (this.options.readVersion ?? ((path: string) => readCloudflaredVersion(path, FRESH_VERSION_TIMEOUT_MS)))(candidate)
      )
      if (version === null) {
        throw new CloudflaredInstallError('download-failed', 'The downloaded cloudflared doesn’t run on this computer.')
      }
      await rename(candidate, target)
      await writeFile(
        join(dirname(target), 'cloudflared.json'),
        JSON.stringify({ version, asset: name, sha256, tag: release.tag, installedAt: Date.now() }, null, 2)
      ).catch(() => undefined)
      onProgress(1)
      return { path: target, version, asset: name, sha256 }
    } catch (error) {
      await rm(partial, { force: true }).catch(() => undefined)
      await rm(candidate, { force: true }).catch(() => undefined)
      throw aborted ?? asInstallError(error, 'Couldn’t get cloudflared.')
    } finally {
      clearTimeout(timer)
      if (this.abort === abort) this.abort = null
      settle()
    }
  }
}

function asInstallError(error: unknown, message: string): CloudflaredInstallError {
  if (error instanceof CloudflaredInstallError) return error
  return new CloudflaredInstallError('download-failed', message)
}

/** Streams a response to disk, hashing it on the way. */
function saveHashed(
  res: IncomingMessage,
  destination: string,
  expectedSize: number,
  onProgress: (fraction: number | null) => void
): Promise<{ size: number; sha256: string }> {
  const declared = Number.parseInt(String(res.headers?.['content-length'] ?? ''), 10)
  const total = Number.isNaN(declared) || declared <= 0 ? expectedSize : declared
  const hash = createHash('sha256')
  const file = createWriteStream(destination, { mode: 0o600 })
  let received = 0
  return new Promise((resolve, reject) => {
    const fail = (err: Error): void => {
      res.destroy()
      file.destroy()
      reject(err)
    }
    res.on('data', (chunk: Buffer) => {
      received += chunk.length
      hash.update(chunk)
      if (total > 0) onProgress(Math.min(1, received / total))
    })
    res.on('error', fail)
    res.on('aborted', () => fail(new Error('aborted')))
    file.on('error', fail)
    file.on('finish', () => resolve({ size: received, sha256: hash.digest('hex') }))
    res.pipe(file)
  })
}

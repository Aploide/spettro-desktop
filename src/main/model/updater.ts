// Update checking and installation for both halves of Spettro on this
// machine: the desktop app (this Electron build) and the `spettro` CLI it
// drives. Nothing here ever updates anything on its own — it decides whether a
// newer release exists and reports it; the user presses the button.
//
// Where the versions come from:
//
//   app  — GitHub releases of the desktop repo. The release workflow already
//          publishes one installer per platform/arch, so the check is "is the
//          newest tag higher than app.getVersion()", and installing means
//          downloading this platform's artifact and handing off to it:
//            · Windows — run the NSIS setup .exe and quit, so it can replace
//              the files this process is holding open.
//            · Linux   — the AppImage is a single file, so the new one is
//              swapped over $APPIMAGE by a small detached shell that waits for
//              us to exit, then relaunches it.
//          Anything else (a dev run, an AppImage-less Linux install) reports
//          canInstallApp: false and the UI links to the release page instead.
//
//   cli  — GitHub releases of the CLI repo, compared against the version the
//          agent reported at handshake. Installing re-runs the official
//          install script (CLIInstaller), which always fetches the latest —
//          the same path onboarding uses — and then the agent is reconnected
//          so the new binary is the one actually running.

import { spawn } from 'child_process'
import { createWriteStream } from 'fs'
import { chmod, mkdir, rm, stat } from 'fs/promises'
import { get as httpsGet } from 'https'
import type { IncomingMessage } from 'http'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { URL } from 'url'
import {
  EMPTY_COMPONENT_UPDATE,
  extractVersion,
  isNewer,
  type ComponentUpdate,
  type UpdateState
} from '../../shared/update'
import type { InstallerEvent } from './cliInstaller'

/** Where the desktop app's own releases live. */
export const APP_REPO = 'aploide/spettro-desktop'
/** Where the CLI's releases live (the same repo the install script is in). */
export const CLI_REPO = 'Aploide/spettro'

/** First automatic check after launch — late enough not to compete with the
 *  agent handshake for the network. */
const FIRST_CHECK_DELAY_MS = 8_000
/** Automatic re-check interval for a long-running window. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** A release body longer than this is cut — the pane shows a summary, and the
 *  full notes are one click away on the release page. */
const NOTES_LIMIT = 1200

const USER_AGENT = 'Spettro-Desktop-Updater'

// ---------------------------------------------------------------------------
// GitHub releases
// ---------------------------------------------------------------------------

export interface ReleaseAsset {
  name: string
  url: string
  size: number
}

export interface GithubRelease {
  tag: string
  /** tag with any leading `v` removed. */
  version: string
  notes: string | null
  htmlUrl: string
  assets: ReleaseAsset[]
}

/** Only these hosts are ever fetched from or followed to — a redirect
 *  anywhere else is treated as a failed download rather than obeyed. */
function isAllowedHost(host: string): boolean {
  return (
    host === 'api.github.com' ||
    host === 'github.com' ||
    host === 'objects.githubusercontent.com' ||
    host === 'release-assets.githubusercontent.com' ||
    host.endsWith('.githubusercontent.com')
  )
}

/** GETs a URL, following up to 5 redirects, and hands the caller the final
 *  response stream. Non-2xx responses reject. */
function request(url: string, accept: string, redirects = 0): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error(`Bad update URL: ${url}`))
      return
    }
    if (parsed.protocol !== 'https:' || !isAllowedHost(parsed.host)) {
      reject(new Error(`Refusing to fetch an update from ${parsed.host || 'an unknown host'}`))
      return
    }

    const req = httpsGet(
      url,
      { headers: { 'User-Agent': USER_AGENT, Accept: accept }, timeout: 30_000 },
      (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          if (redirects >= 5) {
            reject(new Error('Too many redirects while fetching the update'))
            return
          }
          const next = new URL(res.headers.location, url).toString()
          request(next, accept, redirects + 1).then(resolve, reject)
          return
        }
        if (status < 200 || status >= 300) {
          res.resume()
          reject(new Error(status === 404 ? 'No published release was found.' : `HTTP ${status}`))
          return
        }
        resolve(res)
      }
    )
    req.on('timeout', () => req.destroy(new Error('The update server timed out.')))
    req.on('error', reject)
  })
}

async function readJSON(url: string): Promise<unknown> {
  const res = await request(url, 'application/vnd.github+json')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of res) {
    const buf = chunk as Buffer
    size += buf.length
    // A release listing is a few KB; anything this large is not one.
    if (size > 4 * 1024 * 1024) {
      res.destroy()
      throw new Error('The release listing was unexpectedly large.')
    }
    chunks.push(buf)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** The newest published, non-draft release of a repo. */
export async function fetchLatestRelease(repo: string): Promise<GithubRelease> {
  const raw = (await readJSON(`https://api.github.com/repos/${repo}/releases/latest`)) as Record<
    string,
    unknown
  >
  const tag = typeof raw.tag_name === 'string' ? raw.tag_name : ''
  if (tag === '') throw new Error('The release listing had no tag.')
  const body = typeof raw.body === 'string' ? raw.body.trim() : ''
  const assets = Array.isArray(raw.assets)
    ? (raw.assets as Record<string, unknown>[])
        .filter((a) => typeof a.name === 'string' && typeof a.browser_download_url === 'string')
        .map((a) => ({
          name: a.name as string,
          url: a.browser_download_url as string,
          size: typeof a.size === 'number' ? a.size : 0
        }))
    : []

  return {
    tag,
    version: tag.replace(/^v/i, ''),
    notes: body === '' ? null : body.length > NOTES_LIMIT ? `${body.slice(0, NOTES_LIMIT)}…` : body,
    htmlUrl:
      typeof raw.html_url === 'string'
        ? raw.html_url
        : `https://github.com/${repo}/releases/latest`,
    assets
  }
}

// ---------------------------------------------------------------------------
// Picking and fetching this platform's artifact
// ---------------------------------------------------------------------------

/** electron-builder writes `x64`/`arm64` into every artifact name, so the
 *  asset for this machine is the one carrying both the right extension and
 *  the right arch token. A release that ships a single artifact per extension
 *  (no arch in the name) still matches. */
export function pickAppAsset(
  assets: ReleaseAsset[],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): ReleaseAsset | null {
  const extension = platform === 'win32' ? '.exe' : platform === 'linux' ? '.appimage' : null
  if (extension === null) return null

  const candidates = assets.filter((a) => a.name.toLowerCase().endsWith(extension))
  if (candidates.length === 0) return null

  const token = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : arch
  const exact = candidates.find((a) => a.name.toLowerCase().includes(token))
  if (exact) return exact
  // x64 builds are also published as `x86_64`/`amd64` by some tools.
  if (token === 'x64') {
    const alias = candidates.find((a) => /x86_64|amd64/i.test(a.name))
    if (alias) return alias
  }
  // Never hand an x64 machine an arm64 build just because it was the only one.
  const archless = candidates.filter((a) => !/arm64|aarch64|x64|x86_64|amd64/i.test(a.name))
  return archless.length === 1 ? archless[0] : null
}

/** Streams an asset to disk, reporting 0…1 progress when the server declares
 *  a length. Resolves with the file path. */
async function download(
  asset: ReleaseAsset,
  destination: string,
  onProgress: (fraction: number | null) => void
): Promise<string> {
  await mkdir(dirname(destination), { recursive: true })
  const res = await request(asset.url, 'application/octet-stream')
  const declared = Number.parseInt(String(res.headers['content-length'] ?? ''), 10)
  const total = Number.isNaN(declared) || declared <= 0 ? asset.size : declared

  const file = createWriteStream(destination)
  let received = 0

  await new Promise<void>((resolve, reject) => {
    const fail = (err: Error): void => {
      res.destroy()
      file.destroy()
      reject(err)
    }
    res.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (total > 0) onProgress(Math.min(1, received / total))
    })
    res.on('error', fail)
    file.on('error', fail)
    file.on('finish', resolve)
    res.pipe(file)
  })

  const written = await stat(destination)
  if (written.size === 0) throw new Error('The downloaded installer was empty.')
  if (total > 0 && written.size < total) {
    throw new Error('The download ended early — check your connection and try again.')
  }
  return destination
}

// ---------------------------------------------------------------------------
// Handing off to the installer
// ---------------------------------------------------------------------------

/** Single-quotes a path for `sh -c`. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** True when this build is able to replace itself in place. */
export function canInstallApp(isPackaged: boolean): boolean {
  if (!isPackaged) return false
  if (process.platform === 'win32') return true
  if (process.platform === 'linux') return Boolean(process.env.APPIMAGE)
  return false
}

/** Starts the downloaded installer and returns — the caller quits the app
 *  immediately afterwards so the installer can replace files this process
 *  still has open. */
function handOffToInstaller(file: string): void {
  if (process.platform === 'win32') {
    // The NSIS installer is the assisted (oneClick: false) one, so it shows
    // its own window; it closes the running app itself if we are somehow
    // still alive when it starts writing.
    const child = spawn(file, [], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    return
  }

  // Linux AppImage: the running image is mounted from the very file we have
  // to replace, so the swap happens after we exit. The helper waits, moves the
  // new image over the old path, and starts it again.
  const target = process.env.APPIMAGE
  if (!target) throw new Error('This install is not an AppImage, so it cannot update itself.')
  const script = `sleep 2; mv -f ${shQuote(file)} ${shQuote(target)} && chmod +x ${shQuote(
    target
  )} && exec ${shQuote(target)}`
  const child = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' })
  child.unref()
}

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

export interface UpdateManagerOptions {
  /** Version of the running desktop build (app.getVersion()). */
  appVersion: string
  /** False in `electron-vite dev`, where replacing the app makes no sense. */
  isPackaged: boolean
  /** Version the CLI reports (handshake first, `--version` otherwise). */
  cliVersion: () => string | null
  /** Runs the official CLI install script (AppModel's CLIInstaller). */
  installCLI: (onEvent: (event: InstallerEvent) => void) => void
  /** Called after a CLI install so the agent restarts on the new binary. */
  onCLIInstalled: () => Promise<void>
  /** Emits a fresh AppStateDTO to the renderer. */
  onChange: () => void
  /** Quits the app once an installer has been handed off. */
  quit: () => void
}

export class UpdateManager {
  private readonly opts: UpdateManagerOptions
  private app: ComponentUpdate
  private cli: ComponentUpdate
  private timer: NodeJS.Timeout | null = null
  private firstTimer: NodeJS.Timeout | null = null
  private checking = false
  private stopped = false
  /** The last release seen for each component, so re-evaluating against a
   *  newly-learned CLI version costs no network. */
  private latestApp: GithubRelease | null = null
  private latestCLI: GithubRelease | null = null

  constructor(opts: UpdateManagerOptions) {
    this.opts = opts
    this.app = { ...EMPTY_COMPONENT_UPDATE, current: opts.appVersion }
    this.cli = { ...EMPTY_COMPONENT_UPDATE, current: extractVersion(opts.cliVersion()) }
  }

  state(): UpdateState {
    return { app: this.app, cli: this.cli, canInstallApp: canInstallApp(this.opts.isPackaged) }
  }

  /** Starts the automatic checks (idempotent). */
  start(): void {
    if (this.timer || this.stopped) return
    this.firstTimer = setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS)
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS)
    // A check must never keep the process alive on its own.
    this.firstTimer.unref?.()
    this.timer.unref?.()
  }

  shutdown(): void {
    this.stopped = true
    if (this.firstTimer) clearTimeout(this.firstTimer)
    if (this.timer) clearInterval(this.timer)
    this.firstTimer = null
    this.timer = null
  }

  /** Re-evaluates the CLI row against the release we already know about —
   *  called when the agent handshake finally tells us which version is
   *  installed, which usually happens after the first check. */
  refreshCLIVersion(): void {
    const current = extractVersion(this.opts.cliVersion())
    if (current === this.cli.current) return
    this.cli = {
      ...this.cli,
      current,
      available: isNewer(this.cli.latest, current)
    }
    this.opts.onChange()
  }

  /** Checks both components. Concurrent calls collapse into the first. */
  async check(): Promise<void> {
    if (this.checking || this.stopped) return
    this.checking = true
    this.app = { ...this.app, status: this.busy(this.app) ? this.app.status : 'checking' }
    this.cli = { ...this.cli, status: this.busy(this.cli) ? this.cli.status : 'checking' }
    this.opts.onChange()

    const [appResult, cliResult] = await Promise.allSettled([
      fetchLatestRelease(APP_REPO),
      fetchLatestRelease(CLI_REPO)
    ])
    this.checking = false
    if (this.stopped) return

    this.app = this.merge(this.app, appResult, this.opts.appVersion, (release) => {
      this.latestApp = release
    })
    this.cli = this.merge(this.cli, cliResult, extractVersion(this.opts.cliVersion()), (release) => {
      this.latestCLI = release
    })
    this.opts.onChange()
  }

  /** Folds one check result into a component row, leaving an in-flight
   *  install's status and progress alone. */
  private merge(
    previous: ComponentUpdate,
    result: PromiseSettledResult<GithubRelease>,
    current: string | null,
    remember: (release: GithubRelease) => void
  ): ComponentUpdate {
    const busy = this.busy(previous)
    if (result.status === 'rejected') {
      return {
        ...previous,
        current,
        status: busy ? previous.status : 'idle',
        // A failed check is not a failed update: keep it out of the way and
        // only surface it as the row's subtitle.
        message: busy ? previous.message : errText(result.reason)
      }
    }
    const release = result.value
    remember(release)
    return {
      ...previous,
      current,
      latest: release.version,
      available: isNewer(release.version, current),
      releaseUrl: release.htmlUrl,
      releaseNotes: release.notes,
      status: busy ? previous.status : 'idle',
      message: busy ? previous.message : null,
      checkedAt: Date.now()
    }
  }

  private busy(update: ComponentUpdate): boolean {
    return (
      update.status === 'downloading' ||
      update.status === 'installing' ||
      update.status === 'relaunching'
    )
  }

  private setApp(patch: Partial<ComponentUpdate>): void {
    this.app = { ...this.app, ...patch }
    this.opts.onChange()
  }

  private setCLI(patch: Partial<ComponentUpdate>): void {
    this.cli = { ...this.cli, ...patch }
    this.opts.onChange()
  }

  // -------------------------------------------------------------------------
  // Applying an update
  // -------------------------------------------------------------------------

  /** Downloads this platform's installer and hands off to it. Resolves once
   *  the handoff is done; the app quits a moment later. */
  async installApp(): Promise<void> {
    if (this.busy(this.app)) return
    if (!canInstallApp(this.opts.isPackaged)) {
      this.setApp({
        status: 'failed',
        message: 'This build can’t replace itself — download the new version instead.'
      })
      return
    }

    let release = this.latestApp
    if (!release) {
      this.setApp({ status: 'checking', message: null })
      try {
        release = await fetchLatestRelease(APP_REPO)
        this.latestApp = release
      } catch (err) {
        this.setApp({ status: 'failed', message: errText(err) })
        return
      }
    }
    if (!isNewer(release.version, this.opts.appVersion)) {
      this.setApp({ status: 'idle', available: false, message: null, progress: null })
      return
    }

    const asset = pickAppAsset(release.assets)
    if (!asset) {
      this.setApp({
        status: 'failed',
        message: `Release ${release.version} has no installer for ${process.platform} ${process.arch}.`
      })
      return
    }

    const target = join(tmpdir(), 'spettro-update', asset.name)
    this.setApp({ status: 'downloading', progress: 0, message: `Downloading ${asset.name}…` })
    try {
      await rm(target, { force: true })
      await download(asset, target, (fraction) => {
        // Repainting on every chunk would flood the IPC channel; whole
        // percents are all the bar can show anyway.
        const next = fraction === null ? null : Math.round(fraction * 100) / 100
        if (next !== this.app.progress) this.setApp({ progress: next })
      })
      if (process.platform !== 'win32') await chmod(target, 0o755)
    } catch (err) {
      this.setApp({ status: 'failed', progress: null, message: errText(err) })
      return
    }

    this.setApp({ status: 'installing', progress: 1, message: 'Starting the installer…' })
    try {
      handOffToInstaller(target)
    } catch (err) {
      this.setApp({ status: 'failed', progress: null, message: errText(err) })
      return
    }
    this.setApp({ status: 'relaunching', message: 'Spettro is closing to finish the update…' })
    // Let the state reach the window before the process goes away.
    setTimeout(() => this.opts.quit(), 800)
  }

  /** Re-runs the CLI install script and reconnects the agent afterwards. */
  async installCLI(): Promise<void> {
    if (this.busy(this.cli)) return
    this.setCLI({ status: 'installing', progress: null, message: 'Running the Spettro installer…' })

    const finished = await new Promise<boolean>((resolve) => {
      this.opts.installCLI((event) => {
        if (event.type === 'output') {
          this.setCLI({ message: event.line })
        } else {
          resolve(event.success)
        }
      })
    })

    if (!finished) {
      this.setCLI({ status: 'failed', message: 'The installer did not complete.' })
      return
    }

    this.setCLI({ message: 'Restarting the agent…' })
    try {
      await this.opts.onCLIInstalled()
    } catch (err) {
      this.setCLI({ status: 'failed', message: errText(err) })
      return
    }

    const current = extractVersion(this.opts.cliVersion())
    this.setCLI({
      status: 'done',
      current,
      available: isNewer(this.cli.latest, current),
      message: current ? `Updated to ${current}.` : 'Update installed.'
    })
    // Confirm against the release listing rather than trusting the tag we had.
    void this.check()
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

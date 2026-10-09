// The tunnel's settings — <dataDir>/remote-tunnel.json, 0600.
//
// The token is a live credential: whoever holds it can run a connector for
// the user's tunnel and receive its traffic. It is kept the way the paired
// device keys next to it are (remote-devices.json): a file only the owner
// can read, never preferences.json, and never handed to the renderer.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { REMOTE_PREFERRED_PORT } from '../../../shared/remote'
import { writePrivate } from '../pairedDevices'

export const TUNNEL_PORT_MIN = 1024
export const TUNNEL_PORT_MAX = 65535

export interface TunnelSettings {
  /** The switch: run the tunnel whenever remote access is on. */
  enabled: boolean
  /** The tunnel token, or null when none is stored. */
  token: string | null
  /** The public hostname, lowercased and bare ('' while unset). */
  hostname: string
  /** The local port the relay pins for the dashboard's service URL. */
  port: number
  /** Whether a phone may pair through the tunnel (resume always works). */
  allowInternetPairing: boolean
  /** A cloudflared the user chose, tried before any other. */
  binaryPath: string | null
}

export const DEFAULT_TUNNEL_SETTINGS: TunnelSettings = {
  enabled: false,
  token: null,
  hostname: '',
  port: REMOTE_PREFERRED_PORT,
  allowInternetPairing: false,
  binaryPath: null
}

export function isValidTunnelPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= TUNNEL_PORT_MIN && port <= TUNNEL_PORT_MAX
}

export class TunnelStore {
  readonly filePath: string
  private settings: TunnelSettings

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'remote-tunnel.json')
    this.settings = this.load()
  }

  private load(): TunnelSettings {
    const settings = { ...DEFAULT_TUNNEL_SETTINGS }
    if (!existsSync(this.filePath)) return settings
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, unknown>
      if (typeof raw !== 'object' || raw === null) throw new Error('not an object')
      if (typeof raw.enabled === 'boolean') settings.enabled = raw.enabled
      if (typeof raw.token === 'string' && raw.token !== '') settings.token = raw.token
      if (typeof raw.hostname === 'string') settings.hostname = raw.hostname
      if (isValidTunnelPort(raw.port)) settings.port = raw.port
      if (typeof raw.allowInternetPairing === 'boolean') settings.allowInternetPairing = raw.allowInternetPairing
      if (typeof raw.binaryPath === 'string' && raw.binaryPath !== '') settings.binaryPath = raw.binaryPath
    } catch (error) {
      console.error('[remote] remote-tunnel.json is unreadable; the tunnel starts unconfigured', error)
    }
    return settings
  }

  get(): Readonly<TunnelSettings> {
    return this.settings
  }

  /** Changes some settings and writes them out. */
  update(patch: Partial<TunnelSettings>): void {
    this.settings = { ...this.settings, ...patch }
    try {
      writePrivate(this.filePath, JSON.stringify(this.settings, null, 2))
    } catch (error) {
      console.error('[remote] could not save the tunnel settings', error)
    }
  }
}

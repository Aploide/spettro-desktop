// The host's record of which phones may attach, and the identity it
// advertises itself under — port of PairedDeviceStore.swift.
//
// Both are long-lived on purpose. The host id has to outlive relaunches or a
// paired phone would not recognise the host it paired with; the device keys
// have to outlive them or the user would scan a QR every morning. This file
// is what makes "pair once" true.
//
// Storage is a 0600 file (the macOS app made the same call over the keychain
// — see PairedDeviceStore.swift's rationale): owner-only permissions, the
// same discipline as ~/.ssh and the CLI's own ~/.spettro.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { hostname } from 'os'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import type { PairedDeviceDTO } from '../../shared/model'
import { base64urlDecode, base64urlEncode, randomKey } from './pairing'

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface PairedDeviceRecord {
  deviceId: string
  name: string
  platform: string
  /** base64url, 32 bytes decoded — a live authentication key. */
  key: string
  /** ms epoch. */
  pairedAt: number
  /** ms epoch, null when never seen since pairing. */
  lastSeenAt: number | null
  /** Revocation is recorded, not deleted, so a revoked phone gets a clear
   *  "access removed" instead of silently re-pairing at the next QR. */
  revoked: boolean
}

function writePrivate(filePath: string, contents: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, contents, { mode: 0o600 })
  renameSync(tmp, filePath)
  // Re-applied after every write: the rename replaces the file, so
  // permissions set once on an earlier incarnation would not survive.
  try {
    chmodSync(filePath, 0o600)
  } catch {
    /* best effort on platforms without POSIX modes */
  }
}

// ---------------------------------------------------------------------------
// Device store — <dataDir>/remote-devices.json
// ---------------------------------------------------------------------------

export class PairedDeviceStore {
  private readonly filePath: string
  private devices: PairedDeviceRecord[] = []

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'remote-devices.json')
    this.devices = this.load()
  }

  private load(): PairedDeviceRecord[] {
    if (!existsSync(this.filePath)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (!Array.isArray(parsed)) throw new Error('not an array')
      return parsed.filter(
        (d): d is PairedDeviceRecord =>
          typeof d === 'object' &&
          d !== null &&
          typeof d.deviceId === 'string' &&
          typeof d.key === 'string'
      )
    } catch (error) {
      // Refuse to silently start from empty on a *corrupt* file: that presents
      // as every phone suddenly being unpaired, which is exactly the confusing
      // failure this store exists to prevent.
      console.error('[remote] remote-devices.json is unreadable; pairings are not loaded', error)
      return []
    }
  }

  private persist(): void {
    try {
      writePrivate(this.filePath, JSON.stringify(this.devices, null, 2))
    } catch (error) {
      console.error('[remote] could not save paired devices', error)
    }
  }

  list(): PairedDeviceRecord[] {
    return [...this.devices]
  }

  /** Devices that may currently authenticate. */
  active(): PairedDeviceRecord[] {
    return this.devices.filter((d) => !d.revoked)
  }

  device(id: string): PairedDeviceRecord | undefined {
    return this.devices.find((d) => d.deviceId === id)
  }

  /** The decoded 32-byte key for a device, or null. */
  deviceKey(id: string): Buffer | null {
    const record = this.device(id)
    if (!record) return null
    return base64urlDecode(record.key)
  }

  /** Records a newly paired device, or re-keys one that paired again.
   *  Re-pairing REPLACES the key rather than adding a row — one phone, one
   *  record — and a revoked device the user deliberately re-pairs is being
   *  let back in. Returns the freshly minted 32-byte key. */
  pair(id: string, name: string, platform: string): { record: PairedDeviceRecord; key: Buffer } {
    const key = randomKey()
    const record: PairedDeviceRecord = {
      deviceId: id,
      name,
      platform,
      key: base64urlEncode(key),
      pairedAt: Date.now(),
      lastSeenAt: Date.now(),
      revoked: false
    }
    const index = this.devices.findIndex((d) => d.deviceId === id)
    if (index >= 0) this.devices[index] = record
    else this.devices.push(record)
    this.persist()
    return { record, key }
  }

  markSeen(id: string): void {
    const record = this.device(id)
    if (!record) return
    record.lastSeenAt = Date.now()
    this.persist()
  }

  /** Revokes without deleting — see the record's own comment. */
  revoke(id: string): void {
    const record = this.device(id)
    if (!record || record.revoked) return
    record.revoked = true
    this.persist()
  }

  toDTOs(): PairedDeviceDTO[] {
    return this.devices.map((d) => ({
      deviceId: d.deviceId,
      name: d.name,
      platform: d.platform,
      pairedAt: d.pairedAt,
      lastSeenAt: d.lastSeenAt,
      revoked: d.revoked
    }))
  }
}

// ---------------------------------------------------------------------------
// Host identity — <dataDir>/remote-host.json
// ---------------------------------------------------------------------------

export interface HostIdentity {
  hostId: string
  hostName: string
}

/** Stable identity this host advertises. The hostId is minted once and kept
 *  forever — a phone's stored credential names it, so regenerating it would
 *  silently unpair every device. NEVER regenerate an existing hostId. */
export class HostIdentityStore {
  private readonly filePath: string
  private identity: HostIdentity

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'remote-host.json')
    this.identity = this.loadOrCreate()
  }

  private loadOrCreate(): HostIdentity {
    if (existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
        if (typeof parsed === 'object' && parsed !== null && typeof parsed.hostId === 'string' && parsed.hostId.length > 0) {
          return {
            hostId: parsed.hostId,
            hostName:
              typeof parsed.hostName === 'string' && parsed.hostName.trim().length > 0
                ? parsed.hostName
                : defaultHostName()
          }
        }
      } catch (error) {
        console.error('[remote] remote-host.json is unreadable', error)
      }
    }
    const fresh: HostIdentity = { hostId: randomUUID(), hostName: defaultHostName() }
    this.persist(fresh)
    return fresh
  }

  private persist(identity: HostIdentity): void {
    try {
      writePrivate(this.filePath, JSON.stringify(identity, null, 2))
    } catch (error) {
      console.error('[remote] could not save host identity', error)
    }
  }

  get hostId(): string {
    return this.identity.hostId
  }

  get hostName(): string {
    return this.identity.hostName
  }

  /** The Bonjour instance name. Bonjour requires uniqueness within a service
   *  type on a link; the short host-id suffix keeps two identically named
   *  machines from fighting over one registration. */
  get serviceName(): string {
    return `${this.identity.hostName} (${this.identity.hostId.slice(0, 4)})`
  }

  /** Renames the host. The hostId is untouched — always. */
  rename(name: string): void {
    const trimmed = name.trim()
    this.identity = {
      hostId: this.identity.hostId,
      hostName: trimmed.length > 0 ? trimmed : defaultHostName()
    }
    this.persist(this.identity)
  }
}

function defaultHostName(): string {
  const name = hostname().trim().replace(/\.local$/i, '')
  return name.length > 0 ? name : 'Spettro'
}

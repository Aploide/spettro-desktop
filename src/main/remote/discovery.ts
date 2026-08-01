// Bonjour advertising — the host half of RemoteDiscovery.swift.
//
// Clients store a host *id*, never an address, and rediscover the host by
// browsing `_spettro-remote._tcp` and matching the `hostid` TXT key. That is
// what makes pairing a one-time act: after a DHCP change the phone finds the
// service again and reconnects on its own. A client that cannot find `hostid`
// in the TXT record ignores the service, so the TXT contract is not optional.

import { Bonjour, type Service } from 'bonjour-service'
import {
  REMOTE_BONJOUR_TYPE,
  REMOTE_PROTOCOL_VERSION,
  RemoteTXTKey,
  type RemoteHostKind
} from '../../shared/remote'

export interface AdvertiseOptions {
  /** Stable host UUID — what a paired client matches on. */
  hostId: string
  /** Display name, e.g. "Carlo's laptop". */
  hostName: string
  /** Bonjour instance name (unique on the link): "<name> (<id prefix>)". */
  serviceName: string
  port: number
  kind?: RemoteHostKind
}

/** Publishes (and republishes) the `_spettro-remote._tcp` advertisement. */
export class RemoteAdvertiser {
  private bonjour: Bonjour | null = null
  private service: Service | null = null

  start(options: AdvertiseOptions): void {
    this.stop()
    try {
      const bonjour = new Bonjour()
      this.bonjour = bonjour
      this.service = bonjour.publish({
        name: options.serviceName,
        type: REMOTE_BONJOUR_TYPE, // advertised as _spettro-remote._tcp
        port: options.port,
        txt: {
          [RemoteTXTKey.hostID]: options.hostId,
          [RemoteTXTKey.hostName]: options.hostName,
          [RemoteTXTKey.hostKind]: options.kind ?? 'app',
          [RemoteTXTKey.protocolVersion]: String(REMOTE_PROTOCOL_VERSION)
        }
      })
      this.service.on('error', (error: unknown) => {
        console.error('[remote] bonjour advertise error', error)
      })
    } catch (error) {
      // Advertising is best-effort: the QR carries an address hint precisely
      // for environments where mDNS does not work.
      console.error('[remote] could not advertise over bonjour', error)
      this.bonjour = null
      this.service = null
    }
  }

  stop(): void {
    const bonjour = this.bonjour
    this.bonjour = null
    this.service = null
    if (!bonjour) return
    try {
      bonjour.unpublishAll(() => {
        try {
          bonjour.destroy()
        } catch {
          /* ignore */
        }
      })
    } catch {
      try {
        bonjour.destroy()
      } catch {
        /* ignore */
      }
    }
  }

  get isAdvertising(): boolean {
    return this.service !== null
  }
}

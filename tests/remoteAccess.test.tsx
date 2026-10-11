// @vitest-environment jsdom
//
// Settings › Remote: sharing stays on the local network and the footer says
// so; a pairing code that can't be scanned offers its link to copy; a paired
// phone's Remove asks first; and the copy speaks of phones, not iPhones.

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { RemoteHostState } from '@shared/model'
import { vi } from 'vitest'

const calls: [string, unknown[]][] = []

function remoteWith(extra: Partial<RemoteHostState> = {}): RemoteHostState {
  return {
    enabled: true,
    port: 7879,
    hostId: 'host-1',
    hostName: 'carlo-desktop',
    pairingOpen: false,
    pairingURL: null,
    pairingQR: null,
    pairingExpiresAt: null,
    pairingExpired: false,
    devices: [
      { deviceId: 'd1', name: 'Pixel 9', platform: 'Android 16', pairedAt: 0, lastSeenAt: null, revoked: false },
      { deviceId: 'd2', name: 'Carlo’s iPhone', platform: 'iOS 19', pairedAt: 0, lastSeenAt: null, revoked: false }
    ],
    connectedDeviceIds: [],
    // The view reads none of the tunnel's state any more.
    ...({ tunnel: null, tunneledDeviceIds: [] } as unknown as Pick<RemoteHostState, 'tunnel' | 'tunneledDeviceIds'>),
    ...extra
  }
}

let remote: RemoteHostState = remoteWith()

vi.mock('@renderer/state/store', () => {
  const call = (method: string, ...args: unknown[]): Promise<unknown> => {
    calls.push([method, args])
    return Promise.resolve(null)
  }
  return {
    call,
    quietCall: call,
    useApp: () => ({ remote, update: { app: { current: '0.1.7' } }, agentVersion: '2.9.0' })
  }
})

const { default: RemoteAccessView } = await import('@renderer/views/remote/RemoteAccessView')
const { ConfirmHost } = await import('@renderer/views/common/ConfirmDialog')

afterEach(() => {
  cleanup()
  calls.length = 0
  remote = remoteWith()
})

const callsTo = (method: string): unknown[][] => calls.filter(([m]) => m === method).map(([, args]) => args)

describe('Settings › Remote', () => {
  it('lists connected phones, with a Remove that asks first', async () => {
    remote = remoteWith({ connectedDeviceIds: ['d1', 'd2'] })
    render(
      <>
        <RemoteAccessView embedded />
        <ConfirmHost />
      </>
    )
    expect(screen.getByText('Connected · Android 16')).toBeTruthy()
    expect(screen.getByText('Connected · iOS 19')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Pixel 9' }))
    await act(async () => undefined)
    const alert = screen.getByRole('alertdialog', { name: 'Remove “Pixel 9”?' })
    fireEvent.click(within(alert).getByRole('button', { name: 'Remove' }))
    await act(async () => undefined)
    expect(callsTo('remoteRevokeDevice')).toEqual([['d1']])
  })

  it('promises that nothing leaves the network, and offers nothing over the internet', () => {
    render(<RemoteAccessView embedded />)
    expect(document.querySelector('.remote__footer')?.textContent).toMatch(/nothing is sent to a server\.$/)
    expect(screen.queryByRole('region', { name: 'Access over the internet' })).toBeNull()
    expect(document.body.textContent).not.toMatch(/internet|Cloudflare|tunnel/i)
  })

  it('offers the pairing link to copy when the code can’t be scanned', () => {
    remote = remoteWith({ pairingOpen: true, pairingURL: 'spettro-pair://pair?v=1', pairingExpiresAt: Date.now() + 60_000 })
    render(<RemoteAccessView embedded />)
    expect(screen.getByText('Can’t scan? Copy the pairing link and open it on your phone.')).toBeTruthy()
    expect(screen.getByText('Pair with the link instead')).toBeTruthy()
  })

  it('speaks of phones, not iPhones', () => {
    remote = remoteWith({ pairingOpen: true, pairingQR: 'data:image/png;base64,AA', pairingURL: 'x' })
    render(<RemoteAccessView />)
    expect(screen.getByText('Scan this in Spettro on your phone')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/iPhone or iPad/)
  })
})

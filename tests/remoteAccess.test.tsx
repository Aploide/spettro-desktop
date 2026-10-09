// @vitest-environment jsdom
//
// Settings › Remote with the Cloudflare tunnel: off by default and two
// sentences long until it is set up; turned on, it opens numbered steps with
// the fields in them (the token field taking the whole install command on
// paste, the hostname following what main fills in from the tunnel); the
// status says Off / Downloading… / Connecting… / Connected as <host>, and a
// problem says main's sentence with the button that fixes it. A phone in
// through the tunnel says so on its row, beside a Remove that asks first.

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { RemoteHostState, RemoteTunnelState } from '@shared/model'
import { vi } from 'vitest'

const calls: [string, unknown[]][] = []
let answers: Record<string, unknown> = {}

const TUNNEL_OFF: RemoteTunnelState = {
  enabled: false,
  hostname: '',
  hasToken: false,
  tunnelId: null,
  port: 7879,
  allowInternetPairing: false,
  status: 'off',
  downloadProgress: null,
  connections: 0,
  locations: [],
  protocol: null,
  error: null,
  warning: null,
  retryAt: null,
  binary: null,
  log: []
}

const CONNECTED: RemoteTunnelState = {
  ...TUNNEL_OFF,
  enabled: true,
  hostname: 'spettro.example.com',
  hasToken: true,
  tunnelId: '1a2b3c4d-0000-4000-8000-000000000000',
  status: 'connected',
  connections: 4,
  locations: ['fra08', 'ams02'],
  protocol: 'quic',
  binary: { path: '/usr/bin/cloudflared', version: '2026.8.2', source: 'system' }
}

function remoteWith(tunnel: RemoteTunnelState, extra: Partial<RemoteHostState> = {}): RemoteHostState {
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
    tunnel,
    tunneledDeviceIds: [],
    ...extra
  }
}

let remote: RemoteHostState = remoteWith(TUNNEL_OFF)

vi.mock('@renderer/state/store', () => {
  const call = (method: string, ...args: unknown[]): Promise<unknown> => {
    calls.push([method, args])
    return Promise.resolve(method in answers ? answers[method] : null)
  }
  return {
    call,
    quietCall: call,
    useApp: () => ({ remote, update: { app: { current: '0.1.7' } }, agentVersion: '2.9.0' })
  }
})

const { default: RemoteAccessView } = await import('@renderer/views/remote/RemoteAccessView')
const { retryIn, shortTunnelId, tunnelStatus, CLOUDFLARE_DASHBOARD } = await import(
  '@renderer/views/remote/InternetAccess'
)
const { ConfirmHost } = await import('@renderer/views/common/ConfirmDialog')

afterEach(() => {
  cleanup()
  calls.length = 0
  answers = {}
  remote = remoteWith(TUNNEL_OFF)
})

const callsTo = (method: string): unknown[][] => calls.filter(([m]) => m === method).map(([, args]) => args)
const card = (): HTMLElement => screen.getByRole('region', { name: 'Access over the internet' })

describe('the tunnel’s status line', () => {
  const now = 1_000_000

  it('says Off, with the hostname once there is one', () => {
    expect(tunnelStatus(TUNNEL_OFF, true, now)).toEqual({ text: 'Off', tone: 'off' })
    expect(tunnelStatus({ ...CONNECTED, enabled: false, status: 'off' }, true, now).text).toBe(
      'Off · spettro.example.com'
    )
  })

  it('walks Downloading → Connecting → Connected as <host>', () => {
    expect(tunnelStatus({ ...CONNECTED, status: 'downloading', downloadProgress: 0.42 }, true, now).text).toBe(
      'Downloading cloudflared… 42%'
    )
    expect(tunnelStatus({ ...CONNECTED, status: 'downloading', downloadProgress: null }, true, now).text).toBe(
      'Downloading cloudflared…'
    )
    expect(tunnelStatus({ ...CONNECTED, status: 'starting' }, true, now)).toEqual({ text: 'Connecting…', tone: 'busy' })
    expect(tunnelStatus(CONNECTED, true, now)).toEqual({ text: 'Connected as spettro.example.com', tone: 'ok' })
  })

  it('is amber when connected with something to fix, or without a hostname', () => {
    expect(tunnelStatus({ ...CONNECTED, warning: 'In Cloudflare…' }, true, now).tone).toBe('warn')
    expect(tunnelStatus({ ...CONNECTED, hostname: '' }, true, now)).toEqual({
      text: 'Connected · add the public hostname below',
      tone: 'warn'
    })
  })

  it('names what is wrong, and waits for sharing when sharing is off', () => {
    const error = (kind: NonNullable<RemoteTunnelState['error']>['kind']): string =>
      tunnelStatus({ ...CONNECTED, status: 'error', error: { kind, message: '…' } }, true, now).text
    expect(error('bad-token')).toBe('Cloudflare didn’t accept the token')
    expect(error('port-in-use')).toBe('The tunnel’s port is taken')
    expect(error('download-failed')).toBe('Couldn’t download cloudflared')
    expect(tunnelStatus({ ...CONNECTED, status: 'off' }, false, now).text).toBe('Off while sharing is off')
    expect(tunnelStatus({ ...CONNECTED, hasToken: false, status: 'needs-setup' }, true, now).text).toBe(
      'Finish setting it up below'
    )
  })

  it('counts down to the next try', () => {
    expect(retryIn(null, now)).toBeNull()
    expect(retryIn(now - 1, now)).toBeNull()
    expect(retryIn(now + 30_000, now)).toBe('0:30')
    expect(retryIn(now + 61_500, now)).toBe('1:02')
    expect(tunnelStatus({ ...CONNECTED, status: 'reconnecting', retryAt: now + 5_000 }, true, now).text).toBe(
      'Reconnecting… trying again in 0:05'
    )
  })

  it('shows the tunnel by the first block of its id', () => {
    expect(shortTunnelId(CONNECTED.tunnelId)).toBe('1a2b3c4d')
    expect(shortTunnelId(null)).toBeNull()
  })
})

describe('Access over the internet', () => {
  it('is off by default, and says what it needs in plain words', () => {
    render(<RemoteAccessView embedded />)
    const toggle = within(card()).getByRole('switch', { name: 'Access over the internet' }) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(within(card()).getByTestId('tunnel-status').textContent).toBe('Off')
    expect(card().textContent).toMatch(/free Cloudflare account and a domain on Cloudflare/)
    expect(card().textContent).toMatch(/Cloudflare tunnel, which is free/)
    // The steps wait folded until asked for.
    expect(within(card()).queryByLabelText('Tunnel token')).toBeNull()
    expect(within(card()).getByRole('button', { name: 'Set it up' }).getAttribute('aria-expanded')).toBe('false')
    // Nothing about pairing over the internet before there is a tunnel.
    expect(within(card()).queryByRole('checkbox', { name: 'Allow pairing over the internet' })).toBeNull()
  })

  it('turns on, and opens the steps when there is nothing set up yet', () => {
    render(<RemoteAccessView embedded />)
    fireEvent.click(within(card()).getByRole('switch', { name: 'Access over the internet' }))
    expect(callsTo('remoteTunnelSetEnabled')).toEqual([[true]])
    expect(within(card()).getByLabelText('Tunnel token')).toBeTruthy()
    const steps = card().querySelectorAll('.remote__step')
    expect(steps).toHaveLength(4)
    expect(steps[0].textContent).toMatch(/Zero Trust › Networks › Tunnels/)
    expect(steps[1].textContent).toMatch(/install the connector/)
    expect(steps[2].textContent).toMatch(/service type to HTTP and the URL to localhost:7879/)
  })

  it('opens the Cloudflare dashboard from step 1', () => {
    render(<RemoteAccessView embedded />)
    fireEvent.click(within(card()).getByRole('button', { name: 'Set it up' }))
    fireEvent.click(within(card()).getByRole('button', { name: 'Open Cloudflare' }))
    expect(callsTo('openExternal')).toEqual([[CLOUDFLARE_DASHBOARD]])
  })

  it('copies the dashboard’s values for the public hostname', async () => {
    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: (text: string) => void written.push(text) },
      configurable: true
    })
    remote = remoteWith({ ...TUNNEL_OFF, port: 8123 })
    render(<RemoteAccessView embedded />)
    fireEvent.click(within(card()).getByRole('button', { name: 'Set it up' }))
    const chips = card().querySelectorAll('.remote__chip')
    expect([...chips].map((c) => c.querySelector('code')?.textContent)).toEqual(['HTTP', 'localhost:8123'])
    fireEvent.click(within(chips[1] as HTMLElement).getByRole('button', { name: 'Copy' }))
    expect(written).toEqual(['localhost:8123'])
  })

  it('saves a pasted install command as it lands, token and all', async () => {
    remote = remoteWith({ ...TUNNEL_OFF, enabled: true, status: 'needs-setup' })
    answers.remoteTunnelConfigure = { ok: true }
    render(<RemoteAccessView embedded />)
    const field = within(card()).getByLabelText('Tunnel token') as HTMLInputElement
    expect(field.type).toBe('password')
    const command = 'sudo cloudflared service install eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0='
    fireEvent.paste(field, { clipboardData: { getData: () => command } })
    await act(async () => undefined)
    expect(callsTo('remoteTunnelConfigure')).toEqual([[{ token: command }]])
    expect(field.value).toBe('')
  })

  it('says why a token was refused, under the field', async () => {
    remote = remoteWith({ ...TUNNEL_OFF, enabled: true, status: 'needs-setup' })
    answers.remoteTunnelConfigure = { ok: false, field: 'token', message: 'That doesn’t look like a tunnel token.' }
    render(<RemoteAccessView embedded />)
    const field = within(card()).getByLabelText('Tunnel token')
    fireEvent.change(field, { target: { value: 'hello' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await act(async () => undefined)
    expect(within(card()).getByRole('alert').textContent).toBe('That doesn’t look like a tunnel token.')
  })

  it('shows a saved token by its tunnel, never the token', () => {
    remote = remoteWith(CONNECTED)
    render(<RemoteAccessView embedded />)
    fireEvent.click(within(card()).getByRole('button', { name: 'Tunnel settings' }))
    expect(card().textContent).toMatch(/Tunnel 1a2b3c4d… is saved/)
    expect(within(card()).queryByLabelText('Tunnel token')).toBeNull()
    fireEvent.click(within(card()).getByRole('button', { name: 'Replace' }))
    expect(within(card()).getByLabelText('Tunnel token')).toBeTruthy()
  })

  it('asks before forgetting the token', async () => {
    remote = remoteWith(CONNECTED)
    render(
      <>
        <RemoteAccessView embedded />
        <ConfirmHost />
      </>
    )
    fireEvent.click(within(card()).getByRole('button', { name: 'Tunnel settings' }))
    fireEvent.click(within(card()).getByRole('button', { name: 'Forget' }))
    await act(async () => undefined)
    const alert = screen.getByRole('alertdialog', { name: 'Forget the tunnel token?' })
    fireEvent.click(within(alert).getByRole('button', { name: 'Forget' }))
    await act(async () => undefined)
    expect(callsTo('remoteTunnelForgetToken')).toEqual([[]])
  })

  it('follows the hostname main fills in from the tunnel, and saves one typed', async () => {
    remote = remoteWith({ ...CONNECTED, hostname: '' })
    const { rerender } = render(<RemoteAccessView embedded />)
    fireEvent.click(within(card()).getByRole('button', { name: 'Tunnel settings' }))
    const field = within(card()).getByLabelText('Public hostname') as HTMLInputElement
    expect(field.value).toBe('')

    remote = remoteWith({
      ...CONNECTED,
      log: ['Found the public hostname spettro.example.com in the tunnel’s settings.']
    })
    rerender(<RemoteAccessView embedded />)
    expect(field.value).toBe('spettro.example.com')
    expect(card().textContent).toMatch(/Found in the tunnel’s settings in Cloudflare/)

    fireEvent.change(field, { target: { value: 'https://phone.example.com/' } })
    fireEvent.blur(field)
    await act(async () => undefined)
    expect(callsTo('remoteTunnelConfigure')).toEqual([[{ hostname: 'https://phone.example.com/' }]])
  })

  it('says Connected as the hostname, and checks from the internet', async () => {
    remote = remoteWith(CONNECTED)
    answers.remoteTunnelCheck = { ok: true, message: 'This computer answers at spettro.example.com.' }
    render(<RemoteAccessView embedded />)
    expect(within(card()).getByTestId('tunnel-status').textContent).toBe('Connected as spettro.example.com')
    fireEvent.click(within(card()).getByRole('button', { name: 'Check from the internet' }))
    await act(async () => undefined)
    expect(callsTo('remoteTunnelCheck')).toEqual([[]])
    expect(card().textContent).toMatch(/This computer answers at spettro.example.com\./)
  })

  it('shows cloudflared’s download as it goes', () => {
    remote = remoteWith({ ...CONNECTED, status: 'downloading', downloadProgress: 0.42, binary: null })
    render(<RemoteAccessView embedded />)
    expect(within(card()).getByTestId('tunnel-status').textContent).toBe('Downloading cloudflared… 42%')
    expect(within(card()).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42')
  })

  it('says a taken port in words, with Try again and the port field', () => {
    const message =
      'Port 7879 is in use by another program, so the tunnel can’t reach Spettro. Close it, or choose another port and update the service URL in Cloudflare.'
    remote = remoteWith({ ...CONNECTED, status: 'error', error: { kind: 'port-in-use', message } })
    render(<RemoteAccessView embedded />)
    expect(within(card()).getByRole('alert').textContent).toMatch(message)
    fireEvent.click(within(card()).getByRole('button', { name: 'Try again' }))
    expect(callsTo('remoteTunnelRetry')).toEqual([[]])
    fireEvent.click(within(card()).getByRole('button', { name: 'Choose another port' }))
    expect((within(card()).getByLabelText('Local port') as HTMLInputElement).value).toBe('7879')
  })

  it('sends a refused token back to the token field, not to Try again', () => {
    remote = remoteWith({
      ...CONNECTED,
      status: 'error',
      error: { kind: 'bad-token', message: 'That tunnel token wasn’t accepted. Copy it again from the Cloudflare dashboard.' }
    })
    render(<RemoteAccessView embedded />)
    expect(within(card()).queryByRole('button', { name: 'Try again' })).toBeNull()
    fireEvent.click(within(card()).getByRole('button', { name: 'Paste a new token' }))
    expect(within(card()).getByLabelText('Tunnel token')).toBeTruthy()
  })

  it('shows the dashboard’s routing warning', () => {
    const warning =
      'In Cloudflare, spettro.example.com sends traffic to http://localhost:8080. Set its service type to HTTP and the URL to localhost:7879.'
    remote = remoteWith({ ...CONNECTED, warning })
    render(<RemoteAccessView embedded />)
    expect(card().textContent).toMatch(warning)
  })

  it('keeps pairing over the internet off until asked, with its risk said', () => {
    remote = remoteWith(CONNECTED)
    render(<RemoteAccessView embedded />)
    const box = within(card()).getByRole('checkbox', { name: 'Allow pairing over the internet' }) as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(card().textContent).toMatch(/New phones pair on the same Wi-Fi first/)
    expect(card().textContent).toMatch(/Cloudflare decrypts the traffic at its edge/)
    fireEvent.click(box)
    expect(callsTo('remoteTunnelConfigure')).toEqual([[{ allowInternetPairing: true }]])
  })

  it('says when pairing over the internet was paused for failed sign-ins', () => {
    remote = remoteWith({ ...CONNECTED, allowInternetPairing: true, internetPairingPaused: true })
    render(<RemoteAccessView embedded />)
    expect(card().textContent).toMatch(/pairing over the internet is paused/)
  })
})

describe('Remote with the tunnel on', () => {
  it('marks a phone that came in over the internet, with a Remove that asks first', async () => {
    remote = remoteWith(CONNECTED, { connectedDeviceIds: ['d1', 'd2'], tunneledDeviceIds: ['d1'] })
    render(
      <>
        <RemoteAccessView embedded />
        <ConfirmHost />
      </>
    )
    expect(screen.getByText('Connected over the internet · Android 16')).toBeTruthy()
    expect(screen.getByText('Connected on your network · iOS 19')).toBeTruthy()
    expect(screen.getByText('Internet')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Pixel 9' }))
    await act(async () => undefined)
    const alert = screen.getByRole('alertdialog', { name: 'Remove “Pixel 9”?' })
    fireEvent.click(within(alert).getByRole('button', { name: 'Remove' }))
    await act(async () => undefined)
    expect(callsTo('remoteRevokeDevice')).toEqual([['d1']])
  })

  it('stops promising that nothing leaves the network', () => {
    render(<RemoteAccessView embedded />)
    expect(document.querySelector('.remote__footer')?.textContent).toMatch(/nothing is sent to a server\.$/)
    cleanup()
    remote = remoteWith(CONNECTED)
    render(<RemoteAccessView embedded />)
    expect(document.querySelector('.remote__footer')?.textContent).toMatch(/through Cloudflare/)
  })

  it('says a pairing link opens on any phone, and to keep it close when it works from anywhere', () => {
    const pairing = { pairingOpen: true, pairingURL: 'spettro-pair://pair?v=1', pairingExpiresAt: Date.now() + 60_000 }
    remote = remoteWith(TUNNEL_OFF, pairing)
    render(<RemoteAccessView embedded />)
    expect(screen.getByText('Can’t scan? Copy the pairing link and open it on your phone.')).toBeTruthy()
    expect(screen.getByText('Pair with the link instead')).toBeTruthy()
    cleanup()
    remote = remoteWith({ ...CONNECTED, allowInternetPairing: true }, pairing)
    render(<RemoteAccessView embedded />)
    expect(screen.getByText(/send it only to yourself/)).toBeTruthy()
  })

  it('speaks of phones, not iPhones', () => {
    remote = remoteWith(TUNNEL_OFF, { pairingOpen: true, pairingQR: 'data:image/png;base64,AA', pairingURL: 'x' })
    render(<RemoteAccessView />)
    expect(screen.getByText('Scan this in Spettro on your phone')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/iPhone or iPad/)
  })
})

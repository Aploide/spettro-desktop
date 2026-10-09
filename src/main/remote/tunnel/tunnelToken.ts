// What the user pastes into the tunnel settings, made sense of: the token
// (on its own, or inside the command the Cloudflare dashboard shows) and the
// public hostname. Pure, so every shape the dashboard hands out is a test.
//
// A tunnel token is base64 (the standard alphabet — cloudflared decodes it
// with base64.StdEncoding) of {"a": account tag, "t": tunnel UUID, "s":
// secret}. Being JSON that starts `{"`, it always starts `eyJ`. It names the
// tunnel but not the hostname; that comes from the dashboard's public
// hostname route, which the user types here (or the tunnel reports).

/** A token anywhere in a pasted line. Wider than the standard alphabet on
 *  purpose, so a URL-safe copy is found and then refused with a reason
 *  instead of silently cut short. */
export const TOKEN_RE = /eyJ[A-Za-z0-9+/_=-]{40,}/

const TOKEN_RE_GLOBAL = new RegExp(TOKEN_RE.source, 'g')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The token in what the user pasted: the bare token, or any of the
 *  dashboard's install commands — `cloudflared service install <T>`, with
 *  sudo or as `cloudflared.exe` on Windows, or `cloudflared tunnel run
 *  --token <T>`. Null when there is none. */
export function extractToken(input: string): string | null {
  const match = TOKEN_RE.exec(input.trim())
  return match ? match[0] : null
}

export interface ParsedToken {
  accountTag: string
  tunnelId: string
}

/** The token's account and tunnel, or null when cloudflared would refuse it
 *  ("Provided Tunnel token is not valid."): not standard base64, not JSON,
 *  or missing a part. */
export function parseToken(token: string): ParsedToken | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(token) || token.length % 4 !== 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { a, t, s } = parsed as { a?: unknown; t?: unknown; s?: unknown }
  if (typeof a !== 'string' || a === '') return null
  if (typeof t !== 'string' || !UUID_RE.test(t)) return null
  if (typeof s !== 'string' || s === '') return null
  return { accountTag: a, tunnelId: t.toLowerCase() }
}

/** Takes every token out of a line before it is kept or logged. */
export function redactTokens(line: string): string {
  return line.replace(TOKEN_RE_GLOBAL, '[token]')
}

export type HostnameResult = { ok: true; hostname: string } | { ok: false; message: string }

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** The bare hostname in what the user typed — lowercased, without a scheme,
 *  path, port or trailing dot. '' is fine: the tunnel can fill it in. */
export function normalizeHostname(input: string): HostnameResult {
  let host = input.trim().toLowerCase()
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  host = host.replace(/[/?#].*$/, '')
  host = host.replace(/:\d*$/, '')
  host = host.replace(/\.$/, '')
  if (host === '') return { ok: true, hostname: '' }
  if (!HOSTNAME_RE.test(host)) {
    return { ok: false, message: 'That isn’t a hostname. Use the one from the tunnel’s public hostname, like spettro.example.com.' }
  }
  if (host === 'trycloudflare.com' || host.endsWith('.trycloudflare.com')) {
    return { ok: false, message: 'Quick tunnels aren’t supported; use a hostname on your own domain.' }
  }
  return { ok: true, hostname: host }
}

// What cloudflared's log says about the tunnel, line by line. cloudflared has
// no API for its own state beyond the metrics server's /ready, so the log is
// where "connected to fra08", "the token was refused" and "the dashboard
// routes this hostname elsewhere" come from.
//
// Run with `--output json`, each line is one zerolog object: level, time,
// message, plus fields (connIndex, location, protocol, error, config, …).
// Usage errors — a token that doesn't parse — are printed as plain text
// even then, so plain lines are read too, as is the default
// "<time> INF <message> key=value" format in case a flag goes unheeded.
//
// The message strings matched below are cloudflared's own, from its source
// (connection/observer.go, connection/control.go, supervisor/*.go,
// orchestration/orchestrator.go, metrics/metrics.go,
// cmd/cloudflared/tunnel/{configuration,subcommands}.go).

import { redactTokens } from './tunnelToken'

export interface LogEntry {
  /** 'debug' | 'info' | 'warn' | 'error' | 'fatal', or null for plain text. */
  level: string | null
  message: string
  fields: Record<string, unknown>
}

const LEVEL_WORDS: Record<string, string> = { DBG: 'debug', INF: 'info', WRN: 'warn', ERR: 'error', FTL: 'fatal' }

export function parseLogLine(line: string): LogEntry {
  const text = line.trim()
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>
      if (typeof obj === 'object' && obj !== null && typeof obj.message === 'string') {
        const { level, message, time: _time, ...fields } = obj
        return { level: typeof level === 'string' ? level : null, message, fields }
      }
    } catch {
      // Not JSON after all; read it as text.
    }
  }
  const plain = /^\S+ (DBG|INF|WRN|ERR|FTL) (.*)$/.exec(text)
  if (plain) {
    const fields: Record<string, unknown> = {}
    let message = plain[2]
    // Fields trail the message as key=value (values with spaces quoted).
    const firstField = message.search(/ \w+=(?:"[^"]*"|\S+)/)
    if (firstField >= 0) {
      const tail = message.slice(firstField)
      message = message.slice(0, firstField)
      for (const match of tail.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g)) {
        const raw = match[2]
        fields[match[1]] = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\"/g, '"') : raw
      }
    }
    return { level: LEVEL_WORDS[plain[1]], message: message.trim(), fields }
  }
  return { level: null, message: text, fields: {} }
}

/** A short, token-free rendering of a line for the diagnostics list. */
export function displayLine(entry: LogEntry): string {
  const level = entry.level ? `${entry.level.slice(0, 4).toUpperCase()} ` : ''
  const parts = [entry.message]
  for (const [key, value] of Object.entries(entry.fields)) {
    if (key === 'config' || key === 'event') continue
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    parts.push(`${key}=${text.length > 160 ? `${text.slice(0, 160)}…` : text}`)
  }
  return redactTokens(`${level}${parts.join(' ')}`)
}

export type FatalKind = 'bad-token' | 'unauthorized' | 'launch'

export type LogSignal =
  | { kind: 'metrics'; port: number }
  | { kind: 'connector'; id: string }
  | { kind: 'registered'; connIndex: number; location: string | null; protocol: 'quic' | 'http2' | null }
  | { kind: 'unregistered'; connIndex: number | null }
  | { kind: 'retrying' }
  | { kind: 'fatal'; fatal: FatalKind; message: string }
  | { kind: 'network'; message: string }
  | { kind: 'udp-blocked' }
  | { kind: 'config'; ingress: IngressRule[] | null }

function numberField(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN
  return Number.isInteger(n) ? n : null
}

/** What a line means for the tunnel, or null when it means nothing. */
export function signalFor(entry: LogEntry): LogSignal | null {
  const { message, fields } = entry
  const error = typeof fields.error === 'string' ? fields.error : ''

  const metrics = /^Starting metrics server on (.+):(\d+)\/metrics/.exec(message)
  if (metrics) return { kind: 'metrics', port: Number.parseInt(metrics[2], 10) }

  const connector = /^Generated Connector ID: ([0-9a-f-]{36})/i.exec(message)
  if (connector) return { kind: 'connector', id: connector[1].toLowerCase() }

  if (message === 'Registered tunnel connection') {
    const protocol = fields.protocol === 'quic' || fields.protocol === 'http2' ? fields.protocol : null
    return {
      kind: 'registered',
      connIndex: numberField(fields.connIndex) ?? 0,
      location: typeof fields.location === 'string' ? fields.location : null,
      protocol
    }
  }
  if (message === 'Unregistered tunnel connection' || message === 'Connection terminated') {
    return { kind: 'unregistered', connIndex: numberField(fields.connIndex) }
  }
  if (/^Retrying connection in up to /.test(message)) return { kind: 'retrying' }

  // The edge turned the connector away. The permanent reasons — the tunnel
  // was deleted, or its token rotated — won't get better by retrying.
  // "Failed to get tunnel" is the edge finding no such tunnel for the
  // account: a deleted one, or a token for a tunnel that never existed.
  if (message === 'Register tunnel error from server side') {
    if (/unauthori[sz]ed|invalid tunnel secret|tunnel not found|tunnel.*deleted|forbidden|failed to get tunnel/i.test(error)) {
      return { kind: 'fatal', fatal: 'unauthorized', message: error }
    }
    return { kind: 'network', message: error || message }
  }

  if (/Provided Tunnel token is not valid/.test(message)) return { kind: 'fatal', fatal: 'bad-token', message }
  if (/^Failed to read token file|flag provided but not defined|^Incorrect Usage/.test(message)) {
    return { kind: 'fatal', fatal: 'launch', message }
  }

  if (/egress\s+UDP to port 7844/.test(message)) return { kind: 'udp-blocked' }

  if (
    /^(Failed to dial a quic connection|Unable to establish connection with Cloudflare edge|initial tunnel connection failed|Serve tunnel error)/.test(
      message
    ) ||
    /edge discovery|no such host|network is unreachable|i\/o timeout|lookup .* on /i.test(`${message} ${error}`)
  ) {
    return { kind: 'network', message: error || message }
  }

  if (message === 'Updated to new configuration') {
    return { kind: 'config', ingress: parseIngress(fields.config) }
  }
  return null
}

// ---------------------------------------------------------------------------
// Ingress — where the dashboard routes the public hostname
// ---------------------------------------------------------------------------

export interface IngressRule {
  hostname?: string
  path?: string
  service?: string
}

/** The ingress rules in a remote configuration — the `config` field of
 *  "Updated to new configuration", a JSON string (or the object /config
 *  serves). */
export function parseIngress(config: unknown): IngressRule[] | null {
  let value = config
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (typeof value !== 'object' || value === null) return null
  const ingress = (value as { ingress?: unknown }).ingress
  if (!Array.isArray(ingress)) return null
  return ingress
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    .map((r) => {
      const rule: IngressRule = {}
      if (typeof r.hostname === 'string' && r.hostname !== '') rule.hostname = r.hostname
      if (typeof r.path === 'string' && r.path !== '') rule.path = r.path
      if (typeof r.service === 'string') rule.service = r.service
      return rule
    })
}

/** cloudflared's hostname match: case-insensitive, `*.` a wildcard for any
 *  subdomain, no hostname matching everything. */
export function hostnameMatches(pattern: string | undefined, hostname: string): boolean {
  if (!pattern) return true
  const p = pattern.toLowerCase()
  const h = hostname.toLowerCase()
  if (p === h || p === '*') return true
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1
  return false
}

/** Whether a rule's path lets the relay's `/` through. */
function pathAdmitsRoot(path: string | undefined): boolean {
  if (!path) return true
  try {
    return new RegExp(path).test('/')
  } catch {
    return false
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** Whether a service URL reaches this relay: plain HTTP (or ws) to loopback
 *  on our port. HTTPS fails — the relay speaks plain WebSocket. */
export function servicePointsAt(service: string | undefined, port: number): boolean {
  if (!service) return false
  let url: URL
  try {
    url = new URL(service)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'ws:') return false
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return false
  const actual = url.port === '' ? 80 : Number.parseInt(url.port, 10)
  return actual === port
}

export interface IngressCheck {
  /** What to fix in the dashboard, or null when the route is right. */
  warning: string | null
  /** With no hostname set: the one public hostname that reaches us. */
  suggestedHostname: string | null
}

function serviceFix(port: number): string {
  return `set its service type to HTTP and the URL to localhost:${port}`
}

/** Checks the dashboard's route for `hostname` against the relay's port. The
 *  first rule that matches wins, as in cloudflared. */
export function checkIngress(rules: IngressRule[], hostname: string, port: number): IngressCheck {
  if (hostname === '') {
    const ours = rules.filter((r) => r.hostname && !r.hostname.includes('*') && servicePointsAt(r.service, port))
    if (ours.length === 1) return { warning: null, suggestedHostname: (ours[0].hostname as string).toLowerCase() }
    if (ours.length > 1) {
      return { warning: 'More than one of this tunnel’s public hostnames reaches Spettro. Type the one phones should use.', suggestedHostname: null }
    }
    return {
      warning: `None of this tunnel’s public hostnames reaches Spettro. In Cloudflare, add one and ${serviceFix(port)}.`,
      suggestedHostname: null
    }
  }
  const rule = rules.find((r) => r.hostname && hostnameMatches(r.hostname, hostname) && pathAdmitsRoot(r.path))
  if (!rule) {
    return {
      warning: `${hostname} isn’t a public hostname of this tunnel. In Cloudflare, add it and ${serviceFix(port)}.`,
      suggestedHostname: null
    }
  }
  if (servicePointsAt(rule.service, port)) return { warning: null, suggestedHostname: null }
  if (rule.service && /^https:/i.test(rule.service)) {
    return {
      warning: `In Cloudflare, ${hostname} uses HTTPS, which Spettro doesn’t speak locally. ${capitalize(serviceFix(port))}.`,
      suggestedHostname: null
    }
  }
  return {
    warning: `In Cloudflare, ${hostname} sends traffic to ${rule.service ?? 'nothing'}. ${capitalize(serviceFix(port))}.`,
    suggestedHostname: null
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

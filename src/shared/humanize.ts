// Error messages a person can act on.
//
// Errors reach the screen from a dozen places — a process that won't start,
// an RPC the CLI refused, a provider's 401 body, a socket that never opened —
// and every one of them used to be printed as it came: "spawn … EACCES",
// "Internal error", "The Spettro agent exited (code 1)". Each says what broke
// to the person who wrote the code, and nothing to the person in front of it.
//
// humanizeError() turns any of them into one sentence that says what
// happened, one that says what to do, and at most one action to do it with.
// The raw text is kept (`raw`) for the "Show details" disclosure and the
// diagnostics a bug report needs — it is demoted, never thrown away.
//
// Pure and shared: main uses it for the transcript's error notices (which also
// reach paired phones), the renderer for everything it shows itself.

/** The one next step an error offers. Call sites map the kind to a handler;
 *  a site that can't perform it simply shows no button. */
export type ErrorActionKind =
  | 'retry'
  | 'restart'
  | 'reinstall'
  | 'update'
  | 'connect'
  | 'models'
  | 'none'

export interface HumanError {
  /** Short, sentence case, no trailing period: "Your API key was rejected". */
  title: string
  /** What to do about it, as a full sentence. */
  detail: string
  action: { kind: ErrorActionKind; label: string } | null
  /** The message as it arrived, minus IPC routing noise — for "Show details". */
  raw: string
  /** False when no pattern matched and `detail` is the raw message itself. */
  known: boolean
}

export interface HumanizeContext {
  /** A local model server being probed ("http://localhost:11434"): refused
   *  connections then mean "it isn't running", not "you're offline". */
  endpoint?: string
  /** That server's product name, when known ("Ollama"). */
  serverName?: string
}

/** Electron prefixes a rejected invoke with its own routing; Node prefixes
 *  "Error: ". Neither is anything a person needs to read. */
export function stripErrorNoise(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^(?:Acp)?Error:\s*/, '')
    .trim()
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return stripErrorNoise(err.message)
  if (typeof err === 'string') return stripErrorNoise(err)
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return stripErrorNoise((err as { message: string }).message)
  }
  return String(err)
}

interface Rule {
  test: RegExp
  build: (match: RegExpMatchArray, ctx: HumanizeContext) => Omit<HumanError, 'raw' | 'known'>
}

const action = (kind: ErrorActionKind, label: string): HumanError['action'] => ({ kind, label })

// Order matters: the first match wins, so the specific rules sit above the
// general ones (a 401 from a provider is about the key, not the network).
const RULES: Rule[] = [
  {
    test: /prompt has no text content/i,
    build: () => ({
      title: 'Add a few words to send with your image',
      detail: 'Spettro needs some text alongside an image to know what you want.',
      action: null
    })
  },
  {
    // Spawning a binary that isn't executable (or a directory, or a script
    // without its interpreter).
    test: /\bEACCES\b|permission denied.*spawn|spawn.*permission denied/i,
    build: () => ({
      title: 'Spettro’s helper app can’t be started',
      detail: 'This computer isn’t allowing it to run. Reinstalling it usually fixes this.',
      action: action('reinstall', 'Reinstall')
    })
  },
  {
    test: /\bspawn\b.*\bENOENT\b|\bENOENT\b.*\bspawn\b/i,
    build: () => ({
      title: 'Spettro’s helper app is missing',
      detail: 'It may have been moved or deleted. Reinstall it to keep going.',
      action: action('reinstall', 'Reinstall')
    })
  },
  {
    test: /keeps stopping/i,
    build: () => ({
      title: 'Spettro keeps stopping',
      detail: 'Its engine quit several times in a row. The details below may say why.',
      action: action('restart', 'Try Again')
    })
  },
  {
    // Gone before the handshake (main adds the sentence): any executable can
    // be chosen as the engine, and /usr/bin/true "starts" and exits 0. One
    // more start won't change that; another file or a fresh install will.
    test: /quit before answering/i,
    build: () => ({
      title: 'That file doesn’t seem to be Spettro',
      detail: 'It quit as soon as it started. Choose another file, or install Spettro.',
      action: action('reinstall', 'Install Spettro')
    })
  },
  {
    test: /exited(?: unexpectedly)?\s*\((?:exit )?code (-?\d+)\)|\bexit(?:ed)? (?:with )?(?:code|status) (-?\d+)/i,
    build: () => ({
      title: 'Spettro stopped unexpectedly',
      detail: 'Its engine quit. Starting it again usually helps.',
      action: action('restart', 'Restart')
    })
  },
  {
    test: /malformed initialize|missing sessionId|did not answer the handshake|unexpected (?:response|reply)/i,
    build: () => ({
      title: 'Spettro’s helper app didn’t answer as expected',
      detail: 'It may be out of date. Updating it usually fixes this.',
      action: action('update', 'Update')
    })
  },
  {
    // A turn with no provider set up: the CLI fails it at the first model
    // call ("plan agent: agent call failed: no API endpoint configured for
    // provider \"\"").
    test: /no API endpoint configured|no (?:active )?(?:provider|model) (?:is )?(?:configured|selected|set)/i,
    build: () => ({
      title: 'No model is connected',
      detail: 'Connect a model in Settings › Models & Providers, then try again.',
      action: action('connect', 'Connect a Model')
    })
  },
  {
    test: /unknown model|model[^.\n]{0,40}not (?:found|available|supported)|no such model|model_not_found/i,
    build: () => ({
      title: 'That model isn’t available',
      detail: 'The provider may have removed it. Pick another model and try again.',
      action: action('models', 'Choose a Model')
    })
  },
  {
    test: /\b401\b|\b403\b|invalid[ _-]?(?:api[ _-]?)?key|incorrect api key|api key (?:is )?(?:invalid|missing|not valid)|unauthori[sz]ed|authentication[_ ]?error|forbidden/i,
    build: () => ({
      title: 'Your API key was rejected',
      detail: 'Check the key in Settings › Models & Providers, or connect another provider.',
      action: action('connect', 'Open Models & Providers')
    })
  },
  {
    test: /\b529\b|overloaded/i,
    build: () => ({
      title: 'The model provider is overloaded',
      detail: 'It’s turning requests away right now. Nothing was lost — try again in a moment.',
      action: action('retry', 'Try Again')
    })
  },
  {
    test: /\b429\b|rate[ _-]?limit|too many requests|quota|insufficient[_ ]credits|credit balance/i,
    build: (match) => {
      const credits = /quota|credit/i.test(match[0])
      return {
        title: credits ? 'You’re out of credits with this provider' : 'You’ve hit the provider’s rate limit',
        detail: credits
          ? 'Add credits in the provider’s console, or switch to another model.'
          : 'Wait a minute, then try again.',
        action: credits ? action('models', 'Choose a Model') : action('retry', 'Try Again')
      }
    }
  },
  {
    test: /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b|network (?:is )?(?:down|unreachable|error)|offline|could not resolve host|getaddrinfo|fetch failed|socket hang up/i,
    build: (match, ctx) => {
      if (ctx.endpoint) {
        const where = ctx.endpoint.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
        return {
          title: `Nothing is running at ${where}`,
          detail: ctx.serverName
            ? `Is ${ctx.serverName} open? Start it, then try again.`
            : 'Start your local model server, then try again.',
          action: action('retry', 'Try Again')
        }
      }
      const refused = /ECONNREFUSED|ECONNRESET/i.test(match[0])
      return {
        title: refused ? 'Spettro couldn’t connect' : 'You appear to be offline',
        detail: 'Check your internet connection, then try again.',
        action: action('retry', 'Try Again')
      }
    }
  },
  {
    test: /timed out|timeout/i,
    build: () => ({
      title: 'That took too long',
      detail: 'Spettro gave up waiting. Check your connection, then try again.',
      action: action('retry', 'Try Again')
    })
  },
  {
    // A JSON-RPC category with no reason behind it ("Internal error",
    // "Invalid params"): the reason was lost before it got here.
    test: /^(?:internal error|invalid params|method not found)\.?$/i,
    build: () => ({
      title: 'Something went wrong inside Spettro',
      detail: 'Try again. If it keeps happening, the details below can help.',
      action: action('retry', 'Try Again')
    })
  }
]

/** The longest raw message a fallback puts on screen before "Show details". */
const FALLBACK_LIMIT = 280

export function humanizeError(err: unknown, ctx: HumanizeContext = {}): HumanError {
  const raw = errorText(err)
  for (const rule of RULES) {
    const match = raw.match(rule.test)
    if (match) return { ...rule.build(match, ctx), raw, known: true }
  }
  // Unknown: the message itself is the best detail there is — its first
  // line, cut to something that fits, with the whole of it behind "details".
  const firstLine = raw.split('\n').find((l) => l.trim() !== '')?.trim() ?? ''
  const detail =
    firstLine === ''
      ? 'Try again. If it keeps happening, the details below can help.'
      : firstLine.length > FALLBACK_LIMIT
        ? `${firstLine.slice(0, FALLBACK_LIMIT - 1)}…`
        : firstLine
  return { title: 'Something went wrong', detail: sentence(detail), action: null, raw, known: false }
}

/** "Title. Detail" — one line for places that have room for only one, like
 *  a transcript notice or a phone's banner. */
export function humanSentence(err: unknown, ctx?: HumanizeContext): string {
  const human = humanizeError(err, ctx)
  return human.known ? `${human.title}. ${human.detail}` : human.detail
}

function sentence(text: string): string {
  const t = text.charAt(0).toUpperCase() + text.slice(1)
  return /[.!?…)]$/.test(t) ? t : `${t}.`
}

/** What "Copy diagnostics" puts on the clipboard: enough for a bug report,
 *  nothing private beyond what the user can read in it first. */
export function diagnosticsText(info: {
  appVersion: string | null
  engineVersion: string | null
  platform: string
  error?: string | null
  log: string[]
}): string {
  const lines = [
    `Spettro Desktop ${info.appVersion ?? 'unknown'}`,
    `Engine ${info.engineVersion ?? 'unknown'}`,
    `Platform ${info.platform}`
  ]
  if (info.error) lines.push('', `Error: ${info.error}`)
  const tail = info.log.slice(-40)
  if (tail.length > 0) lines.push('', 'Last engine output:', ...tail)
  return lines.join('\n')
}

// Errors in words (shared/humanize.ts): every pattern the app knows becomes a
// sentence with one next step, the raw text survives for "Show details", and
// an unknown error falls back to its own first line rather than a vague
// "something went wrong". A screenshot of a toast can't tell a 401 from a 429.

import { describe, expect, it } from 'vitest'
import { diagnosticsText, errorText, humanizeError, humanSentence } from '@shared/humanize'
import { busyGuard } from '@shared/busyGuard'

describe('humanizeError', () => {
  const cases: [string, string, string, string | null][] = [
    // [raw, title, action kind, ...]
    ['Could not start Spettro: spawn /home/me/.local/bin/spettro EACCES', 'Spettro’s helper app can’t be started', 'reinstall', null],
    ['Could not start Spettro: spawn /opt/spettro ENOENT', 'Spettro’s helper app is missing', 'reinstall', null],
    ['The Spettro agent exited (code 1).', 'Spettro stopped unexpectedly', 'restart', null],
    ['The Spettro agent exited unexpectedly (exit code 2).', 'Spettro stopped unexpectedly', 'restart', null],
    ['The Spettro agent keeps stopping (exit 1).', 'Spettro keeps stopping', 'restart', null],
    ['malformed initialize result', 'Spettro’s helper app didn’t answer as expected', 'update', null],
    ['session/new response missing sessionId', 'Spettro’s helper app didn’t answer as expected', 'update', null],
    ['The Spettro agent did not answer the handshake in time.', 'Spettro’s helper app didn’t answer as expected', 'update', null],
    ['invalid api key for provider anthropic', 'Your API key was rejected', 'connect', null],
    ['POST https://api.openai.com/v1/responses: 401 Unauthorized', 'Your API key was rejected', 'connect', null],
    ['403 Forbidden: your key lacks access', 'Your API key was rejected', 'connect', null],
    ['rate limit exceeded, retry in 20s', 'You’ve hit the provider’s rate limit', 'retry', null],
    ['429 Too Many Requests', 'You’ve hit the provider’s rate limit', 'retry', null],
    ['insufficient_quota: You exceeded your current quota', 'You’re out of credits with this provider', 'models', null],
    ['anthropic: 529 overloaded_error', 'The model provider is overloaded', 'retry', null],
    ['connect ECONNREFUSED 127.0.0.1:443', 'Spettro couldn’t connect', 'retry', null],
    ['getaddrinfo ENOTFOUND api.anthropic.com', 'You appear to be offline', 'retry', null],
    ['curl: (6) Could not resolve host: raw.githubusercontent.com', 'You appear to be offline', 'retry', null],
    ['prompt has no text content', 'Add a few words to send with your image', 'none', null],
    ['unknown model "gpt-9" for provider openai', 'That model isn’t available', 'models', null],
    ['The update server timed out.', 'That took too long', 'retry', null],
    ['Internal error', 'Something went wrong inside Spettro', 'retry', null]
  ]

  it.each(cases)('%s', (raw, title, kind) => {
    const human = humanizeError(raw)
    expect(human.title).toBe(title)
    expect(human.action?.kind ?? 'none').toBe(kind)
    expect(human.known).toBe(true)
    // The raw text is never lost: it is what "Show details" shows.
    expect(human.raw).toBe(raw)
  })

  it('says "nothing is running there" for a local server that refuses, naming it', () => {
    const human = humanizeError('connect ECONNREFUSED 127.0.0.1:1234', {
      endpoint: 'http://localhost:1234',
      serverName: 'LM Studio'
    })
    expect(human.title).toBe('Nothing is running at localhost:1234')
    expect(human.detail).toBe('Is LM Studio open? Start it, then try again.')
  })

  it('takes the reason out of Error objects and IPC noise', () => {
    const err = new Error("Error invoking remote method 'spettro:invoke': Error: invalid api key")
    expect(errorText(err)).toBe('invalid api key')
    expect(humanizeError(err).title).toBe('Your API key was rejected')
  })

  it('falls back to the first line of an unknown error, as a sentence', () => {
    const human = humanizeError('steering queue closed\nat bridge.go:450')
    expect(human.known).toBe(false)
    expect(human.title).toBe('Something went wrong')
    expect(human.detail).toBe('Steering queue closed.')
    expect(human.action).toBeNull()
  })

  it('cuts a very long unknown error, keeping the whole of it raw', () => {
    const raw = 'x'.repeat(1000)
    const human = humanizeError(raw)
    expect(human.detail.length).toBeLessThanOrEqual(281)
    expect(human.raw).toBe(raw)
  })

  it('humanSentence joins title and detail for one-line places', () => {
    expect(humanSentence('429')).toBe('You’ve hit the provider’s rate limit. Wait a minute, then try again.')
    expect(humanSentence('weird thing')).toBe('Weird thing.')
  })

  it('diagnostics carry versions, platform, the error and the last 40 log lines', () => {
    const log = Array.from({ length: 50 }, (_, i) => `line ${i}`)
    const text = diagnosticsText({ appVersion: '0.1.7', engineVersion: '2.9.0', platform: 'linux', error: 'boom', log })
    expect(text).toContain('Spettro Desktop 0.1.7')
    expect(text).toContain('Engine 2.9.0')
    expect(text).toContain('Error: boom')
    expect(text).not.toContain('line 9\n')
    expect(text.trim().endsWith('line 49')).toBe(true)
    expect(text.split('\n').filter((l) => l.startsWith('line ')).length).toBe(40)
  })
})

describe('busyGuard (quit, update and restart)', () => {
  it('asks nothing when nothing is running', () => {
    expect(busyGuard('quit', 0, 0)).toBeNull()
    expect(busyGuard('update', 0)).toBeNull()
    expect(busyGuard('restart', 0)).toBeNull()
  })

  it('offers to wait for running chats', () => {
    expect(busyGuard('quit', 2)).toEqual({
      title: 'Spettro is working on 2 tasks',
      message: 'Quitting now stops them.',
      whenFinishedLabel: 'Quit When Finished',
      nowLabel: 'Quit Now'
    })
    expect(busyGuard('update', 1)?.whenFinishedLabel).toBe('Update When Finished')
    expect(busyGuard('update', 1)?.message).toBe('Updating now restarts Spettro, which stops it.')
  })

  it('never offers to wait for a terminal command, which may never end', () => {
    const guard = busyGuard('quit', 0, 1)
    expect(guard?.title).toBe('A terminal is still running a command')
    expect(guard?.whenFinishedLabel).toBeNull()
    expect(guard?.nowLabel).toBe('Quit Now')
    expect(busyGuard('quit', 1, 2)?.message).toBe(
      'Quitting now stops them. There are also commands running in 2 terminals.'
    )
  })

  it('restarting the engine can only be done now or not at all', () => {
    expect(busyGuard('restart', 3)).toMatchObject({ whenFinishedLabel: null, nowLabel: 'Restart Now' })
    // Terminals don't run on the engine; restarting leaves them be.
    expect(busyGuard('restart', 0, 4)).toBeNull()
  })
})

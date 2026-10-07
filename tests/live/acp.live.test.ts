// The main process against a REAL `spettro --acp`, not a fake one.
//
// acpGaps.test.ts drives the same code with the subprocess faked from
// tests/wire.ts, which is only as right as our reading of the Go source. This
// runs the app's own AppModel, AcpConnection and AcpAgent against a binary,
// so a CLI that drifted from that reading fails here first.
//
// Skipped unless SPETTRO_BIN names the binary:
//
//   SPETTRO_BIN=/path/to/spettro/bin/spettro npx vitest run tests/live
//
// Nothing here spends a token. The CLI runs under a throwaway HOME, so it is
// unconfigured (Ask first, no provider) and the user's ~/.spettro is never
// touched; a prompt there fails at the provider before anything leaves the
// machine — which is the error path worth seeing end to end anyway.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AcpAgent } from '@main/acp'
import { AppModel } from '@main/model/appModel'
import type { ChatSession } from '@main/model/chatSession'
import { configValue } from '@shared/ipc'
import type { ChatMessage } from '@shared/model'

const BIN = process.env['SPETTRO_BIN']

/** Polls until `fn` is truthy, or fails after `ms` saying what it waited for. */
async function until<T>(what: string, fn: () => T | null | undefined | false, ms = 15000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

function messages(session: ChatSession): ChatMessage[] {
  return session.items.flatMap((item) => (item.kind === 'message' ? [item.message] : []))
}

type Internals = {
  agent: AcpAgent | null
  connect(rootedAt?: string): Promise<void>
}

describe.skipIf(!BIN)('the app against a real spettro', () => {
  let root: string
  let project: string
  let savedHome: string | undefined
  let model: AppModel
  let chat: ChatSession

  const internals = (): Internals => model as unknown as Internals

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'spettro-live-'))
    project = join(root, 'project')
    mkdirSync(project)
    mkdirSync(join(root, 'home'))
    mkdirSync(join(root, 'userData'))
    // The CLI reads its config from $HOME/.spettro only, and inherits the
    // app's environment (AcpConnection.start).
    savedHome = process.env['HOME']
    process.env['HOME'] = join(root, 'home')
    writeFileSync(
      join(root, 'userData', 'preferences.json'),
      JSON.stringify({ explicitCLIPath: BIN, lastProjectPath: project, recentProjects: [project] })
    )
    model = new AppModel({ userDataDir: join(root, 'userData'), appVersion: '0.0.0-live' })
    // connect() rather than bootstrap(): bootstrap also starts the release
    // and subscription checks, which go to the network.
    await internals().connect(project)
    expect(internals().agent).not.toBeNull()
  }, 30000)

  afterAll(() => {
    model?.shutdown()
    if (savedHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = savedHome
    rmSync(root, { recursive: true, force: true })
  })

  it('a new chat gets the CLI’s options and commands, and /help answers without a model', async () => {
    chat = model.newChat(project)
    await until('the chat attached', () => chat.acpSessionId)
    expect(chat.configOptions.map((o) => o.id)).toEqual([
      'mode',
      'model',
      'permission',
      'thinking',
      'ultra',
      'workflow_size'
    ])
    await until('slash commands', () => chat.commands.length > 0)
    expect(chat.commands.map((c) => c.name)).toContain('ultra')
    expect(chat.commands.map((c) => c.name)).not.toContain('ultracode')

    model.send(chat.id, '/help', [])
    await until('the /help turn ended', () => !chat.isBusy && messages(chat).some((m) => m.role === 'assistant'))
    const reply = messages(chat).find((m) => m.role === 'assistant')
    expect(reply?.text).toMatch(/\/ultra/)
  }, 30000)

  it('Ultra under Ask first is saved and reads as suspended', async () => {
    await model.setConfigValue(chat.id, 'ultra', true)
    expect(configValue(chat.configOptions, 'ultra')).toBe(true)
    expect(chat.configOptions.find((o) => o.id === 'ultra')?.description).toMatch(/suspended/)
    // Leave the throwaway config as it started.
    await model.setConfigValue(chat.id, 'ultra', false)
    expect(configValue(chat.configOptions, 'ultra')).toBe(false)
  }, 30000)

  it('a refused turn shows the CLI’s reason in words, never "Internal error"', async () => {
    model.send(chat.id, 'hello', [])
    const notice = await until('the error notice', () =>
      messages(chat).find((m) => m.role === 'notice' && m.noticeIsError && m.endsTurn)
    )
    expect(notice.text).not.toMatch(/internal error/i)
    expect(notice.text).toMatch(/connect a model/i)
    // The raw reason is kept behind "Show details".
    expect(notice.detail).toMatch(/no API endpoint configured/)
    await until('the turn ended', () => !chat.isBusy)
  }, 30000)

  it('an image-only message goes out with text, so the CLI takes it', async () => {
    const before = messages(chat).length
    // A 1×1 PNG.
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    model.send(chat.id, '', [{ data: png, mimeType: 'image/png' }])
    const notice = await until('the turn’s outcome', () =>
      messages(chat)
        .slice(before)
        .find((m) => m.role === 'notice' && m.noticeIsError)
    )
    // It fails at the provider (there is none), not at "prompt has no text".
    expect(notice.detail ?? notice.text).not.toMatch(/no text content/)
    await until('the turn ended', () => !chat.isBusy)
  }, 30000)

  it('a reopened chat resumes after a restart and gets its commands without a prompt', async () => {
    const acpId = chat.acpSessionId
    // A restart drops every live session; the chat keeps only the id.
    await model.reconnect()
    chat.setCommands([])
    model.openChat(chat.id)
    await until('slash commands after resume', () => chat.commands.length > 0, 5000)
    // The same CLI session, not a fresh one — and nothing said it was lost.
    expect(chat.acpSessionId).toBe(acpId)
    expect(messages(chat).some((m) => /starting fresh/.test(m.text))).toBe(false)
  }, 30000)

  it('the CLI lists the conversation, and deleting the chat closes its session', async () => {
    const acpId = chat.acpSessionId as string
    const agent = internals().agent as AcpAgent
    const listed = await agent.listSessions(project)
    expect(listed.map((s) => s.sessionId)).toContain(acpId)

    model.closeChat(chat.id)
    // session/close (sent without waiting) frees the session in the CLI;
    // prompting it then finds nothing live under that id.
    await new Promise((r) => setTimeout(r, 500))
    await expect(
      agent.raw('session/prompt', { sessionId: acpId, prompt: [{ type: 'text', text: '/help' }] })
    ).rejects.toThrow(/not found/i)
  }, 30000)
})

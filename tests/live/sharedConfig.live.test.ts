// Settings the CLI shares across sessions, against a REAL `spettro --acp`.
//
// The model, permission, thinking level, Ultra and workflow size live in
// ~/.spettro/config.json for every session and for the TUI (bridge.go
// sharedSettings). A chat that has been cold since launch still shows what
// they were when it was last open; opening it used to push those stale values
// back, which could quietly turn YOLO back on. acpGaps.test.ts covers the same
// against a fake; this checks the file the CLI actually writes.
//
//   SPETTRO_BIN=/path/to/spettro/bin/spettro npx vitest run tests/live
//
// Nothing here spends a token; the CLI runs under a throwaway HOME.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppModel } from '@main/model/appModel'
import type { ChatSession } from '@main/model/chatSession'
import { configValue } from '@shared/ipc'

const BIN = process.env['SPETTRO_BIN']

async function until<T>(what: string, fn: () => T | null | undefined | false, ms = 15000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe.skipIf(!BIN)('shared settings against a real spettro', () => {
  let root: string
  let project: string
  let savedHome: string | undefined
  let model: AppModel

  const config = (): { permission?: string; thinking_level?: string } =>
    JSON.parse(readFileSync(join(root, 'home', '.spettro', 'config.json'), 'utf8'))

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'spettro-live-'))
    project = join(root, 'project')
    mkdirSync(project)
    mkdirSync(join(root, 'home'))
    mkdirSync(join(root, 'userData'))
    savedHome = process.env['HOME']
    process.env['HOME'] = join(root, 'home')
    writeFileSync(
      join(root, 'userData', 'preferences.json'),
      JSON.stringify({ explicitCLIPath: BIN, lastProjectPath: project, recentProjects: [project] })
    )
    model = new AppModel({ userDataDir: join(root, 'userData'), appVersion: '0.0.0-live' })
    await (model as unknown as { connect(at: string): Promise<void> }).connect(project)
  }, 30000)

  afterAll(() => {
    model?.shutdown()
    if (savedHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = savedHome
    rmSync(root, { recursive: true, force: true })
  })

  const live = (chat: ChatSession): boolean =>
    (model as unknown as { liveACPSessionId(s: ChatSession): string | null }).liveACPSessionId(chat) !== null

  async function attached(chat: ChatSession): Promise<void> {
    await until('the chat attached', () => chat.acpSessionId && chat.configOptions.length > 0)
  }

  it('opening a chat that was cold since launch keeps what another chat set', async () => {
    const a = model.newChat(project)
    await attached(a)
    // A chat needs a saved session to be resumed rather than replaced; a
    // turn refused for want of a provider saves one, spending nothing.
    model.send(a.id, 'hello', [])
    await until('the turn ended', () => !a.isBusy && a.items.length > 1)
    const b = model.newChat(project)
    await attached(b)
    await model.setConfigValue(b.id, 'thinking', 'max')
    await model.setConfigValue(b.id, 'permission', 'yolo')
    expect(config()).toMatchObject({ thinking_level: 'max', permission: 'yolo' })

    // A relaunch: every chat is cold, and a still shows max / yolo.
    await model.reconnect()
    model.openChat(b.id)
    await until('b resumed', () => live(b))
    await model.setConfigValue(b.id, 'thinking', 'low')
    await model.setConfigValue(b.id, 'permission', 'ask-first')
    expect(config()).toMatchObject({ thinking_level: 'low', permission: 'ask-first' })
    // The cold chat already shows the change…
    expect(configValue(a.configOptions, 'permission')).toBe('ask-first')

    // …and opening it does not put max / yolo back.
    const before = a.acpSessionId
    model.openChat(a.id)
    await until('a resumed', () => live(a))
    expect(a.acpSessionId).toBe(before)
    expect(config()).toMatchObject({ thinking_level: 'low', permission: 'ask-first' })
    expect(configValue(b.configOptions, 'permission')).toBe('ask-first')
    expect(configValue(b.configOptions, 'thinking')).toBe('low')
    expect(configValue(a.configOptions, 'permission')).toBe('ask-first')
  }, 60000)
})

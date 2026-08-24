// setConfigValue has to tell two failures apart that arrive through the same
// catch block, and getting it wrong is invisible until you look closely: the
// chip goes on showing a value the agent refused, and the refusal is retried
// before every subsequent turn, forever. Ultra under the "Ask first"
// permission level is the case that does this in practice.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppModel } from '@main/model/appModel'
import { AcpError } from '@main/acp'
import type { ChatSession } from '@main/model/chatSession'

let dir: string
let model: AppModel

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spettro-test-'))
  model = new AppModel({ userDataDir: dir, appVersion: '0.0.0-test' })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A chat with a live ACP session and one boolean option showing `false`. */
function armedChat(): ChatSession {
  const session = model.newChat('/project')
  session.acpSessionId = 'acp-1'
  session.configOptions = [
    { id: 'ultra', name: 'Ultra', kind: { type: 'boolean', currentValue: false } }
  ]
  return session
}

/** Stands in for the live agent, with `setConfigOption` under our control. */
function withAgent(setConfigOption: () => Promise<never> | Promise<unknown>): void {
  const internals = model as unknown as {
    agent: unknown
    liveACPSessionId: (s: ChatSession) => string | null
  }
  internals.agent = { setConfigOption }
  internals.liveACPSessionId = (s) => s.acpSessionId
}

describe('when the agent refuses the change', () => {
  it('rolls the chip back to what the agent is actually running', async () => {
    const session = armedChat()
    withAgent(() =>
      Promise.reject(
        new AcpError('rpc', 'ultra requires the Restricted or YOLO permission level', -32602)
      )
    )

    await model.setConfigValue(session.id, 'ultra', true)

    // Leaving `true` on screen would have the bar advertise a mode the agent
    // never entered.
    expect(session.displayedConfigValues()['ultra']).toBe(false)
  })

  it('does not queue the refusal for retry', async () => {
    const session = armedChat()
    withAgent(() => Promise.reject(new AcpError('rpc', 'refused', -32602)))

    await model.setConfigValue(session.id, 'ultra', true)

    // The CLI will refuse this every time until Permission changes; retrying
    // achieves nothing but another notice before every turn.
    expect(session.pendingConfigChanges['ultra']).toBeUndefined()
  })

  it('tells the user why, in the agent’s own words', async () => {
    const session = armedChat()
    withAgent(() => Promise.reject(new AcpError('rpc', 'needs Restricted or YOLO', -32602)))

    await model.setConfigValue(session.id, 'ultra', true)

    const notices = session.items.filter(
      (item) => item.kind === 'message' && item.message.role === 'notice'
    )
    expect(notices).toHaveLength(1)
  })
})

describe('when the agent never answered at all', () => {
  it('keeps the change queued so it survives an agent restart', async () => {
    const session = armedChat()
    withAgent(() => Promise.reject(new AcpError('transport', 'The Spettro agent is not running.')))

    await model.setConfigValue(session.id, 'ultra', true)

    // We have no idea what the agent's config is now, and this is exactly the
    // case the queue was written for.
    expect(session.pendingConfigChanges['ultra']).toBe(true)
  })

  it('does the same when the process died mid-flight', async () => {
    const session = armedChat()
    withAgent(() => Promise.reject(new AcpError('terminated', 'The Spettro agent exited (1).', 1)))

    await model.setConfigValue(session.id, 'ultra', true)
    expect(session.pendingConfigChanges['ultra']).toBe(true)
  })
})

describe('with no live session yet', () => {
  it('queues the change rather than losing it', async () => {
    // A cold chat's ConfigBar has to stick: this is what makes the value the
    // user picked before the first prompt reach the session that attaches.
    const session = model.newChat('/project')
    session.configOptions = [
      { id: 'ultra', name: 'Ultra', kind: { type: 'boolean', currentValue: false } }
    ]
    const internals = model as unknown as { agent: unknown }
    internals.agent = null

    await model.setConfigValue(session.id, 'ultra', true)
    expect(session.pendingConfigChanges['ultra']).toBe(true)
  })
})

describe('when the agent accepts', () => {
  it('takes the agent’s reported options as the new truth', async () => {
    const session = armedChat()
    withAgent(() =>
      Promise.resolve([
        { id: 'ultra', name: 'Ultra', kind: { type: 'boolean', currentValue: true } }
      ])
    )

    await model.setConfigValue(session.id, 'ultra', true)

    expect(session.displayedConfigValues()['ultra']).toBe(true)
    expect(session.pendingConfigChanges['ultra']).toBeUndefined()
  })
})

describe('an unknown chat', () => {
  it('is a no-op, not a crash', async () => {
    await expect(model.setConfigValue('nope', 'ultra', true)).resolves.toBeUndefined()
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// A fake `spettro --acp` on the far side of a real AcpConnection: every line
// the app writes is recorded and answered by `handlers`, and every line the
// agent sends goes through the connection's own parser. Shared by the tests
// that drive the main process against the ACP surface (acpGaps, remoteHost).

import { AcpConnection } from '@main/acp'
import type { JSONValue } from '@shared/acp'

export type Message = { id?: number | string; method?: string; params?: JSONValue; result?: JSONValue }
export type Handler = (params: JSONValue) => JSONValue | Promise<JSONValue>

/** Thrown from a handler to answer with a JSON-RPC error instead. */
export class Reply extends Error {
  constructor(readonly error: { code: number; message: string; data?: JSONValue }) {
    super(error.message)
  }
}

export class FakeAgent {
  readonly conn = new AcpConnection({ executablePath: 'spettro', workingDirectory: '/' })
  /** Everything the app wrote, in order. */
  readonly sent: Message[] = []
  readonly handlers: Record<string, Handler> = {}

  constructor() {
    const internals = this.conn as unknown as { running: boolean; child: unknown }
    internals.running = true
    internals.child = {
      stdin: { write: (line: string) => this.receive(JSON.parse(line) as Message) },
      exitCode: null,
      killed: false,
      kill: () => undefined
    }
  }

  /** What the app sent for `method`, requests and notifications alike. */
  calls(method: string): Message[] {
    return this.sent.filter((m) => m.method === method)
  }

  /** A line from the agent, through the connection's own parser. */
  push(message: object): void {
    ;(this.conn as unknown as { handleLine(text: string): void }).handleLine(
      JSON.stringify({ jsonrpc: '2.0', ...message })
    )
  }

  update(sessionId: string, update: JSONValue): void {
    this.push({ method: 'session/update', params: { sessionId, update } })
  }

  /** An agent → app request, e.g. session/request_permission. */
  ask(id: number, method: string, params: JSONValue): void {
    this.push({ id, method, params })
  }

  private receive(message: Message): void {
    this.sent.push(message)
    if (message.method === undefined || message.id === undefined) return
    const handler = this.handlers[message.method]
    if (!handler) return
    const id = message.id
    Promise.resolve()
      .then(() => handler(message.params ?? null))
      .then(
        (result) => this.push({ id, result }),
        (err: unknown) => {
          if (err instanceof Reply) this.push({ id, error: err.error })
          else throw err
        }
      )
  }
}

/** A promise someone else settles. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/** Lets every queued continuation run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

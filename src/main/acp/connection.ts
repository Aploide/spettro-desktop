// The JSON-RPC pipe to a running ACP agent — the TypeScript port of
// spettro-apple's ACPConnection.swift + SubprocessTransport.swift, fused into
// one class since Electron's main process only ever hosts the agent as a
// child process.
//
// Runs `<exe> --acp --cwd <workingDirectory>` and speaks newline-delimited
// JSON-RPC 2.0 over its stdio (one message per line, 0x0A-terminated,
// matching github.com/coder/acp-go-sdk's connection layer). stdout carries
// protocol messages, stderr carries diagnostics.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import os from 'node:os'
import type {
  ACPPermissionRequest,
  ACPQuestionRequest,
  ACPSessionUpdate,
  JSONValue,
  RPCID
} from '../../shared/acp'
import {
  intValue,
  objectValue,
  parsePermissionRequest,
  parseQuestionFromPermission,
  parseQuestionRequest,
  parseSessionUpdate,
  stringValue
} from './parse'

export class AcpError extends Error {
  kind: 'rpc' | 'decode' | 'terminated' | 'transport'
  code?: number
  /** A JSON-RPC error's `data`, verbatim — where the real reason lives. */
  data?: JSONValue

  constructor(kind: AcpError['kind'], message: string, code?: number, data?: JSONValue) {
    super(message)
    this.name = 'AcpError'
    this.kind = kind
    if (code !== undefined) this.code = code
    if (data !== undefined) this.data = data
  }
}

/**
 * The human half of a JSON-RPC error.
 *
 * The SDK the CLI is built on turns every plain Go error into
 * `{code: -32603, message: "Internal error", data: {error: "<the reason>"}}`,
 * and invalid params into `-32602 "Invalid params"` with the reason in `data`
 * likewise (acp-go-sdk errors.go). `message` is the JSON-RPC category; the
 * sentence a person can act on ("invalid api key", "prompt has no text
 * content") is only ever in `data`.
 */
export function rpcErrorMessage(message: string, data: JSONValue | undefined): string {
  if (typeof data === 'string' && data.trim() !== '') return data
  const obj = objectValue(data)
  const reason = stringValue(obj?.['error']) ?? stringValue(obj?.['message'])
  return reason !== null && reason.trim() !== '' ? reason : message
}

interface PendingRequest {
  resolve: (value: JSONValue) => void
  reject: (error: Error) => void
}

/** Stable map key for an RPCID — `7` and `"7"` must not collide. */
function rpcKey(id: RPCID): string {
  return typeof id === 'number' ? `n:${id}` : `s:${id}`
}

/** A JSON-RPC connection to one `spettro --acp` subprocess. */
export class AcpConnection {
  // Delegate callbacks — set before start(). Each carries the decoded event
  // *and* the payload it was decoded from: the app renders the decoded form,
  // the remote host relays the raw one verbatim to attached phones.
  onSessionUpdate: ((sessionId: string, update: ACPSessionUpdate, raw: JSONValue) => void) | null =
    null
  onPermissionRequest:
    | ((req: { rpcId: RPCID; request: ACPPermissionRequest; raw: JSONValue }) => void)
    | null = null
  onQuestionRequest:
    | ((req: {
        rpcId: RPCID
        request: ACPQuestionRequest
        raw: JSONValue
        transport: 'ask' | 'permission'
      }) => void)
    | null = null
  /** An agent-originated extension notification (`_spettro/*`) — notably
   *  `_spettro/account/update` while a device-flow login advances. Delivered
   *  raw: the app decodes what it models, and the remote host relays the same
   *  payload verbatim to attached phones. */
  onExtensionNotification: ((method: string, params: JSONValue) => void) | null = null
  /** The agent withdrew one of its own requests (`$/cancel_request`) — a
   *  permission prompt that timed out, or whose turn was cancelled. Carries
   *  the id of the request being withdrawn. */
  onCancelRequest: ((rpcId: RPCID) => void) | null = null
  onTerminate: ((code: number) => void) | null = null
  onLog: ((line: string) => void) | null = null

  private readonly executablePath: string
  private readonly workingDirectory: string

  private child: ChildProcessWithoutNullStreams | null = null
  private running = false
  private spawned = false
  private stdoutBuffer: Buffer = Buffer.alloc(0)
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  /** Synthetic "type my own answer" option ids for questions delivered over
   *  the permission transport, keyed by the agent's rpc id. Consumed by
   *  AcpAgent.replyQuestion when it encodes the permission-response envelope. */
  private readonly questionCustomOptions = new Map<string, string | null>()

  constructor(opts: { executablePath: string; workingDirectory: string }) {
    this.executablePath = opts.executablePath
    this.workingDirectory = opts.workingDirectory
  }

  // MARK: Lifecycle

  /** Spawns `<exe> --acp --cwd <workingDirectory>`; rejects on spawn error. */
  start(): Promise<void> {
    // Ensure the child can find its own config (~/.spettro) and any tools on
    // the user's PATH by inheriting a login-shell-like environment. POSIX
    // only — Windows resolves the .exe path directly and needs no prepend.
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (process.platform !== 'win32') {
      const extra = `${os.homedir()}/.local/bin:/usr/local/bin`
      env['PATH'] = env['PATH'] ? `${extra}:${env['PATH']}` : extra
    }

    const child = spawn(this.executablePath, ['--acp', '--cwd', this.workingDirectory], {
      cwd: this.workingDirectory,
      env,
      shell: false,
      windowsHide: true
    })
    this.child = child

    child.stdout.on('data', (chunk: Buffer) => this.ingest(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.length > 0) this.onLog?.(line)
      }
    })
    // stdin write failures (EPIPE after the child dies) surface as 'error'
    // events; without a listener they would crash the process.
    child.stdin.on('error', (err: Error) => {
      this.onLog?.(`stdin error: ${err.message}`)
    })
    child.on('exit', (code, signal) => {
      if (!this.spawned) return // spawn failed; start() already rejected
      this.running = false
      this.handleTermination(code ?? (signal ? 1 : 0))
    })

    return new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off('error', onError)
        this.spawned = true
        this.running = true
        // Post-launch errors (e.g. kill failures) must still have a handler.
        child.on('error', (err: Error) => this.onLog?.(`process error: ${err.message}`))
        resolve()
      }
      const onError = (err: Error): void => {
        child.off('spawn', onSpawn)
        this.child = null
        reject(new AcpError('transport', `Could not start Spettro: ${err.message}`))
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })
  }

  stop(): void {
    this.running = false
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      this.child.kill()
    }
    // Whatever is still awaiting a reply is never going to get one. Fail it
    // here rather than waiting for the process to actually die: a child that
    // ignores SIGTERM would otherwise leave callers suspended forever.
    this.failPending(new AcpError('transport', 'The Spettro agent is not running.'))
  }

  private handleTermination(code: number): void {
    this.failPending(
      new AcpError('terminated', `The Spettro agent exited (code ${code}).`, code)
    )
    this.questionCustomOptions.clear()
    this.onTerminate?.(code)
  }

  private failPending(error: Error): void {
    const waiters = Array.from(this.pending.values())
    this.pending.clear()
    for (const w of waiters) w.reject(error)
  }

  // MARK: Outgoing

  /** Sends a request and awaits its response payload (the `result` object). */
  request(method: string, params: JSONValue): Promise<JSONValue> {
    const id = this.nextId++
    if (!this.running || !this.child) {
      return Promise.reject(new AcpError('transport', 'The Spettro agent is not running.'))
    }
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    return new Promise<JSONValue>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.write(line)
      } catch (err) {
        this.pending.delete(id)
        reject(
          err instanceof AcpError
            ? err
            : new AcpError('transport', err instanceof Error ? err.message : String(err))
        )
      }
    })
  }

  /** Sends a notification (no response expected). Fire-and-forget. */
  notify(method: string, params: JSONValue): void {
    try {
      this.write(JSON.stringify({ jsonrpc: '2.0', method, params }))
    } catch {
      // Best-effort: nothing to correlate a failure with.
    }
  }

  /** Replies to an agent-originated request, echoing its exact id form. */
  respond(id: RPCID, result: JSONValue): void {
    try {
      this.write(JSON.stringify({ jsonrpc: '2.0', id, result }))
    } catch {
      // Best-effort.
    }
  }

  /** Replies to an agent-originated request with a JSON-RPC error. */
  respondError(id: RPCID, code: number, message: string): void {
    try {
      this.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }))
    } catch {
      // Best-effort.
    }
  }

  private write(line: string): void {
    if (!this.running || !this.child) {
      throw new AcpError('transport', 'The Spettro agent is not running.')
    }
    this.child.stdin.write(line + '\n')
  }

  // MARK: Incoming

  /** Splits the incoming byte stream on newlines. Reads arrive in arbitrary
   *  chunks, so a partial line is held in the buffer until its newline lands. */
  private ingest(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk])
    let idx: number
    while ((idx = this.stdoutBuffer.indexOf(0x0a)) !== -1) {
      const line = this.stdoutBuffer.subarray(0, idx)
      this.stdoutBuffer = this.stdoutBuffer.subarray(idx + 1)
      if (line.length > 0) this.handleLine(line.toString('utf8'))
    }
  }

  private handleLine(text: string): void {
    let root: JSONValue
    try {
      root = JSON.parse(text) as JSONValue
    } catch {
      this.onLog?.('skipping unparseable line')
      return
    }
    const obj = objectValue(root)
    if (!obj) {
      this.onLog?.('skipping unparseable line')
      return
    }

    const method = stringValue(obj['method'])
    const rpcId = decodeRpcId(obj['id'])

    if (method !== null) {
      if (rpcId !== null) {
        this.handleIncomingRequest(method, rpcId, obj['params'])
      } else {
        this.handleNotification(method, obj['params'])
      }
      return
    }

    // A response to one of our requests — all of ours use integer ids.
    if (typeof rpcId !== 'number') return
    const continuation = this.pending.get(rpcId)
    if (!continuation) return
    this.pending.delete(rpcId)
    const error = objectValue(obj['error'])
    if (error) {
      const code = intValue(error['code']) ?? -1
      const data = error['data']
      const message = rpcErrorMessage(stringValue(error['message']) ?? 'unknown error', data)
      continuation.reject(new AcpError('rpc', message, code, data))
    } else {
      continuation.resolve(obj['result'] ?? null)
    }
  }

  private handleNotification(method: string, params: JSONValue | undefined): void {
    // JSON-RPC's own cancellation, which the SDK sends when the context of a
    // request it made of us ends: the prompt it was waiting on is moot.
    if (method === '$/cancel_request') {
      const rpcId = decodeRpcId(objectValue(params)?.['requestId'])
      if (rpcId === null) return
      this.questionCustomOptions.delete(rpcKey(rpcId))
      this.onCancelRequest?.(rpcId)
      return
    }
    // ACP extension methods are namespaced with a leading underscore. These
    // used to be dropped on the floor, which is why an account change made in
    // the TUI (or a login completing in the browser) never reached the app.
    if (method.startsWith('_')) {
      this.onExtensionNotification?.(method, params ?? null)
      return
    }
    if (method !== 'session/update' || params === undefined) return
    const obj = objectValue(params)
    if (!obj) return
    const sessionId = stringValue(obj['sessionId'])
    const update = obj['update']
    if (sessionId === null || update === undefined) return
    const parsed = parseSessionUpdate(update)
    if (!parsed) return
    this.onSessionUpdate?.(sessionId, parsed, update)
  }

  private handleIncomingRequest(method: string, id: RPCID, params: JSONValue | undefined): void {
    switch (method) {
      case 'session/request_permission': {
        const request = params === undefined ? null : parsePermissionRequest(params)
        if (!request || params === undefined) {
          this.respondError(id, -32602, 'invalid permission request')
          return
        }
        // A permission request carrying _meta["spettro.app/question"] is not
        // a permission prompt at all — it is an ask-user question an older
        // CLI is walking over this transport.
        const question = parseQuestionFromPermission(params)
        if (question) {
          this.questionCustomOptions.set(rpcKey(id), question.customOptionId)
          this.onQuestionRequest?.({
            rpcId: id,
            request: question.request,
            raw: params,
            transport: 'permission'
          })
          return
        }
        this.onPermissionRequest?.({ rpcId: id, request, raw: params })
        return
      }
      case '_spettro/question/ask': {
        // Served because we mirrored it back at `initialize`; the agent
        // calls nothing it wasn't told we implement.
        const request = params === undefined ? null : parseQuestionRequest(params)
        if (!request || params === undefined) {
          this.respondError(id, -32602, 'invalid question payload')
          return
        }
        this.onQuestionRequest?.({ rpcId: id, request, raw: params, transport: 'ask' })
        return
      }
      default:
        // We advertise no core client capabilities, so the agent should not
        // call fs/* or terminal/*; refuse anything unexpected cleanly.
        this.respondError(id, -32601, `method not supported: ${method}`)
    }
  }

  /** @internal Consumes the synthetic custom-input option id recorded when a
   *  question was delivered over the permission transport. Not public API —
   *  used only by AcpAgent.replyQuestion. */
  consumeQuestionCustomOption(rpcId: RPCID): string | null {
    const key = rpcKey(rpcId)
    const value = this.questionCustomOptions.get(key) ?? null
    this.questionCustomOptions.delete(key)
    return value
  }
}

/** JSON-RPC ids are ints or strings; we echo the exact form the peer used. */
function decodeRpcId(value: JSONValue | undefined): RPCID | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isInteger(value)) return value
  return null
}

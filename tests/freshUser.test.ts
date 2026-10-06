// What a first-time user hits before Spettro has done anything for them
// (main side): a file chosen as the engine is checked — nothing there, can't
// run, isn't Spettro — and never swapped for another copy; a download that
// fails fails the install instead of "finishing"; the home-folder answer and
// a new project's folder are remembered; a resend can't stack copies of a
// message nothing can answer.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkExplicitCLI, EXPLICIT_CLI_PROBLEM, looksLikeSpettroVersion } from '@main/model/cliLocator'
import { installCommand } from '@main/model/cliInstaller'
import { newProjectPath, projectFolderName } from '@main/model/projectFolder'
import { Prefs } from '@main/model/prefs'
import { humanizeError } from '@shared/humanize'

const POSIX = process.platform !== 'win32'

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'spettro-fresh-'))
  dirs.push(d)
  return d
}
function script(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

describe('choosing the engine by hand', () => {
  it('says there is no file, rather than "that isn’t Spettro", for a path with nothing at it', async () => {
    expect(await checkExplicitCLI(join(scratch(), 'Downloads', 'spettro'))).toEqual({ ok: false, problem: 'missing' })
    expect(EXPLICIT_CLI_PROBLEM.missing).toBe('There’s no file at that path.')
  })

  it.runIf(POSIX)('says it can’t run a file that isn’t executable', async () => {
    const path = join(scratch(), 'spettro')
    writeFileSync(path, 'not a program')
    expect(await checkExplicitCLI(path)).toEqual({ ok: false, problem: 'not-runnable' })
  })

  it.runIf(POSIX)('turns down any other program, /usr/bin/true included', async () => {
    const dir = scratch()
    expect(await checkExplicitCLI(script(dir, 'true', 'exit 0'))).toEqual({ ok: false, problem: 'not-spettro' })
    expect(await checkExplicitCLI(script(dir, 'python', 'echo "Python 3.12.1"'))).toEqual({
      ok: false,
      problem: 'not-spettro'
    })
  })

  it.runIf(POSIX)('takes a file that says it is Spettro, at the path it was given', async () => {
    const path = script(scratch(), 'spettro', 'echo "spettro v2.8.2"')
    expect(await checkExplicitCLI(path)).toEqual({ ok: true, cli: { path, version: 'spettro v2.8.2', isDev: false } })
  })

  it('knows Spettro’s version lines and nothing else', () => {
    expect(looksLikeSpettroVersion('spettro v2.8.2')).toBe(true)
    expect(looksLikeSpettroVersion('spettro dev')).toBe(true)
    expect(looksLikeSpettroVersion('2.9.0')).toBe(true)
    expect(looksLikeSpettroVersion(null)).toBe(false)
    expect(looksLikeSpettroVersion('GNU coreutils 9.4')).toBe(false)
  })

  it('reads an engine that quits before answering as the wrong file, not a crash to retry', () => {
    const human = humanizeError('The Spettro agent exited (code 0). It quit before answering — it may not be Spettro.')
    expect(human.title).toBe('That file doesn’t seem to be Spettro')
    expect(human.action).toEqual({ kind: 'reinstall', label: 'Install Spettro' })
    // A crash after the handshake is still one more start.
    expect(humanizeError('The Spettro agent exited (code 1).').action?.kind).toBe('restart')
  })
})

describe.runIf(POSIX)('the install command', () => {
  /** Runs the real command line with a stand-in curl first on PATH. */
  function run(curl: string): { status: number; stderr: string; stdout: string } {
    const bin = scratch()
    script(bin, 'curl', curl)
    const [command, args] = installCommand('linux')
    try {
      const stdout = execFileSync(command, args, {
        env: { PATH: `${bin}:/usr/bin:/bin` },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      })
      return { status: 0, stderr: '', stdout }
    } catch (err) {
      const e = err as { status: number; stderr: string; stdout: string }
      return { status: e.status, stderr: e.stderr, stdout: e.stdout }
    }
  }

  it('fails when the download fails, saying so (it used to "finish")', () => {
    const result = run('echo "curl: (6) Could not resolve host" >&2; exit 6')
    expect(result.status).toBe(6)
    expect(result.stderr).toContain('Couldn\'t download the installer (curl exited 6).')
  })

  it('runs what it downloaded', () => {
    const result = run('echo "echo installed-ok"')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('installed-ok')
  })
})

describe('a new project folder', () => {
  it('makes the name safe for any file system rather than refusing it', () => {
    expect(projectFolderName('Bakery website')).toBe('Bakery website')
    expect(projectFolderName('  my/new:site?  ')).toBe('my-new-site')
    expect(projectFolderName('.hidden')).toBe('hidden')
    expect(projectFolderName('   ')).toBe('')
  })

  it('numbers a name already taken instead of sharing its folder', () => {
    const root = scratch()
    mkdirSync(join(root, 'Bakery'))
    mkdirSync(join(root, 'Bakery 2'))
    expect(newProjectPath(root, 'Bakery')).toBe(join(root, 'Bakery 3'))
    expect(newProjectPath(root, 'Shop')).toBe(join(root, 'Shop'))
    expect(() => newProjectPath(root, '///')).toThrow('Give the project a name.')
    expect(existsSync(join(root, 'Shop'))).toBe(false)
  })
})

describe('the home-folder question', () => {
  it('is remembered per folder across launches', () => {
    const dir = scratch()
    const first = new Prefs(dir)
    first.approveBroadFolder('/home/anna')
    first.approveBroadFolder('/home/anna')
    expect(new Prefs(dir).approvedBroadFolders).toEqual(['/home/anna'])
    expect(JSON.parse(readFileSync(join(dir, 'preferences.json'), 'utf8')).approvedBroadFolders).toEqual(['/home/anna'])
  })
})

describe('Try again with nothing connected', () => {
  it('sends nothing, so failed copies of the message don’t stack up', async () => {
    const { AppModel } = await import('@main/model/appModel')
    const m = new AppModel({ userDataDir: scratch(), appVersion: '0.0.0-test' })
    const chat = m.newChat('/tmp/bakery')
    chat.items.push({
      kind: 'message',
      message: { id: 'u1', role: 'user', text: 'Make a website', attachments: [], isStreaming: false, timestamp: 0 }
    })
    const sent: string[] = []
    ;(m as unknown as { send: (id: string, text: string) => void }).send = (_id, text) => sent.push(text)
    let nothingConnected = true
    const ext = (m as unknown as { extensions: object }).extensions
    Object.defineProperty(ext, 'needsProviderSetup', { get: () => nothingConnected })
    m.retryLast(chat.id)
    expect(sent).toEqual([])
    // Connected: Try again is what it says.
    nothingConnected = false
    m.retryLast(chat.id)
    expect(sent).toEqual(['Make a website'])
  })
})

// Persisted app preferences — the port of the UserDefaults keys in
// spettro-apple (appendix C). One small JSON file at
// userData/preferences.json, loaded synchronously at startup and rewritten
// whole (tmp + rename) on every change.
//
// Keys:
//   explicitCLIPath   — user override for the CLI binary (spettro.explicitCLIPath)
//   lastProjectPath   — folder picked via chooseProject (spettro.lastProjectPath)
//   lastConfigOptions — last full ACPConfigOption set seen from any session
//                       (spettro.lastConfigOptions); seeds new chats
//   recentProjects    — most-recent-first, deduped, capped at 10
//   cachedCommandsByProject
//                     — the last available-commands list advertised in each
//                       project folder (skills make it per project); the ''
//                       key holds the last list seen anywhere, the fallback
//                       for a folder never opened. Empty updates never wipe
//                       it. Replaces the single global `cachedCommands`
//                       (spettro.cachedCommands), which is read once and
//                       migrated into that fallback.
//   appearance        — 'system' | 'light' | 'dark'; main applies it to
//                       nativeTheme.themeSource before the window exists
//   providerSetupSkipped
//                     — the user chose "Continue without" on the connect
//                       step; the setup screen stays away on later launches
//                       (the no-model bar above the composer remains)
//   notifyWhenDone    — a system notification when a turn finishes while the
//                       window is in the background
//   approvedBroadFolders
//                     — the home folder (or /) the user said "Continue" for on
//                       the new-session warning, so it isn't asked again on
//                       every new session and every launch
//   pendingDefaults   — shared settings (model, permission, thinking, ultra,
//                       workflow size) the user changed while no session was
//                       live; the next session to attach pushes them, once
//   knownSessionIds   — every CLI session id this app created or imported,
//                       kept after the chat is deleted: the CLI keeps those
//                       on disk, and they are not "started in a terminal"

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { ACPCommand, ACPConfigOption } from '../../shared/acp'
import { isAppearance, type Appearance } from '../../shared/model'

interface PrefsData {
  explicitCLIPath: string
  lastProjectPath: string
  lastConfigOptions: ACPConfigOption[]
  recentProjects: string[]
  cachedCommandsByProject: Record<string, ACPCommand[]>
  appearance: Appearance
  providerSetupSkipped: boolean
  notifyWhenDone: boolean
  approvedBroadFolders: string[]
  pendingDefaults: Record<string, string | boolean>
  knownSessionIds: string[]
}

/** The commands-cache key for "the last list seen in any folder". */
const ANY_PROJECT = ''

/** Folders whose command lists are remembered, besides the fallback. Oldest
 *  written goes first, so the file can't grow with every folder ever opened. */
const MAX_CACHED_PROJECTS = 40

/** Session ids remembered as the app's own; the oldest go first. */
const MAX_KNOWN_SESSIONS = 2000

function defaults(): PrefsData {
  return {
    explicitCLIPath: '',
    lastProjectPath: '',
    lastConfigOptions: [],
    recentProjects: [],
    cachedCommandsByProject: {},
    appearance: 'system',
    providerSetupSkipped: false,
    notifyWhenDone: true,
    approvedBroadFolders: [],
    pendingDefaults: {},
    knownSessionIds: []
  }
}

function isCommandList(value: unknown): value is ACPCommand[] {
  return (
    Array.isArray(value) &&
    value.every(
      (c) => typeof c === 'object' && c !== null && typeof (c as ACPCommand).name === 'string'
    )
  )
}

function sanitize(raw: unknown): PrefsData {
  const data = defaults()
  if (typeof raw !== 'object' || raw === null) return data
  const obj = raw as Record<string, unknown>
  if (typeof obj.explicitCLIPath === 'string') data.explicitCLIPath = obj.explicitCLIPath
  if (typeof obj.lastProjectPath === 'string') data.lastProjectPath = obj.lastProjectPath
  if (Array.isArray(obj.lastConfigOptions)) {
    data.lastConfigOptions = obj.lastConfigOptions as ACPConfigOption[]
  }
  if (Array.isArray(obj.recentProjects)) {
    data.recentProjects = obj.recentProjects.filter((p): p is string => typeof p === 'string')
  }
  if (typeof obj.cachedCommandsByProject === 'object' && obj.cachedCommandsByProject !== null) {
    for (const [path, commands] of Object.entries(obj.cachedCommandsByProject)) {
      if (isCommandList(commands)) data.cachedCommandsByProject[path] = commands
    }
  }
  // Migration: the old single list becomes the any-folder fallback.
  if (data.cachedCommandsByProject[ANY_PROJECT] === undefined && isCommandList(obj.cachedCommands)) {
    if (obj.cachedCommands.length > 0) data.cachedCommandsByProject[ANY_PROJECT] = obj.cachedCommands
  }
  if (isAppearance(obj.appearance)) data.appearance = obj.appearance
  if (typeof obj.providerSetupSkipped === 'boolean') data.providerSetupSkipped = obj.providerSetupSkipped
  if (typeof obj.notifyWhenDone === 'boolean') data.notifyWhenDone = obj.notifyWhenDone
  if (Array.isArray(obj.approvedBroadFolders)) {
    data.approvedBroadFolders = obj.approvedBroadFolders.filter((p): p is string => typeof p === 'string')
  }
  if (typeof obj.pendingDefaults === 'object' && obj.pendingDefaults !== null) {
    for (const [id, value] of Object.entries(obj.pendingDefaults)) {
      if (typeof value === 'string' || typeof value === 'boolean') data.pendingDefaults[id] = value
    }
  }
  if (Array.isArray(obj.knownSessionIds)) {
    data.knownSessionIds = obj.knownSessionIds.filter((id): id is string => typeof id === 'string')
  }
  return data
}

export class Prefs {
  private readonly file: string
  private data: PrefsData

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'preferences.json')
    this.data = this.loadFromDisk()
  }

  private loadFromDisk(): PrefsData {
    try {
      return sanitize(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      return defaults()
    }
  }

  /** Atomic (tmp + rename) whole-file rewrite; failures are silent, matching
   *  the fail-silent UserDefaults semantics of the macOS app. */
  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch {
      // Unwritable prefs must never crash the app.
    }
  }

  get explicitCLIPath(): string {
    return this.data.explicitCLIPath
  }

  set explicitCLIPath(value: string) {
    this.data.explicitCLIPath = value
    this.save()
  }

  get lastProjectPath(): string {
    return this.data.lastProjectPath
  }

  set lastProjectPath(value: string) {
    this.data.lastProjectPath = value
    this.save()
  }

  get lastConfigOptions(): ACPConfigOption[] {
    // Clone: sessions mutate their option arrays in place, and a shared
    // reference would silently rewrite the persisted seed.
    return structuredClone(this.data.lastConfigOptions)
  }

  set lastConfigOptions(options: ACPConfigOption[]) {
    // Empty option sets are never persisted (rememberConfig semantics).
    if (options.length === 0) return
    this.data.lastConfigOptions = structuredClone(options)
    this.save()
  }

  get recentProjects(): string[] {
    return [...this.data.recentProjects]
  }

  /** Moves (or inserts) a project at the front, deduped, capped at 10. */
  addRecentProject(path: string): void {
    const rest = this.data.recentProjects.filter((p) => p !== path)
    this.data.recentProjects = [path, ...rest].slice(0, 10)
    this.save()
  }

  removeRecentProject(path: string): void {
    const next = this.data.recentProjects.filter((p) => p !== path)
    if (next.length === this.data.recentProjects.length) return
    this.data.recentProjects = next
    this.save()
  }

  /** The commands to show in a chat that hasn't heard from the agent yet:
   *  the folder's own last list, else the last list seen anywhere. */
  cachedCommands(projectPath: string): ACPCommand[] {
    const byProject = this.data.cachedCommandsByProject
    return structuredClone(byProject[projectPath] ?? byProject[ANY_PROJECT] ?? [])
  }

  setCachedCommands(projectPath: string, commands: ACPCommand[]): void {
    // saveCache ignores empty lists, so a transient empty update can't wipe
    // the cache (appendix C).
    if (commands.length === 0) return
    const byProject = { ...this.data.cachedCommandsByProject }
    // Re-inserted so the key order is oldest-written first.
    delete byProject[projectPath]
    byProject[projectPath] = structuredClone(commands)
    byProject[ANY_PROJECT] = structuredClone(commands)
    const folders = Object.keys(byProject).filter((k) => k !== ANY_PROJECT)
    for (const stale of folders.slice(0, Math.max(0, folders.length - MAX_CACHED_PROJECTS))) {
      delete byProject[stale]
    }
    this.data.cachedCommandsByProject = byProject
    this.save()
  }

  get appearance(): Appearance {
    return this.data.appearance
  }

  set appearance(value: Appearance) {
    this.data.appearance = value
    this.save()
  }

  get providerSetupSkipped(): boolean {
    return this.data.providerSetupSkipped
  }

  set providerSetupSkipped(value: boolean) {
    this.data.providerSetupSkipped = value
    this.save()
  }

  get notifyWhenDone(): boolean {
    return this.data.notifyWhenDone
  }

  set notifyWhenDone(value: boolean) {
    this.data.notifyWhenDone = value
    this.save()
  }

  get approvedBroadFolders(): string[] {
    return [...this.data.approvedBroadFolders]
  }

  approveBroadFolder(path: string): void {
    if (this.data.approvedBroadFolders.includes(path)) return
    this.data.approvedBroadFolders = [...this.data.approvedBroadFolders, path]
    this.save()
  }

  /** Shared settings waiting for a live session to carry them to the CLI. */
  get pendingDefaults(): Record<string, string | boolean> {
    return { ...this.data.pendingDefaults }
  }

  set pendingDefaults(values: Record<string, string | boolean>) {
    this.data.pendingDefaults = { ...values }
    this.save()
  }

  isKnownSession(id: string): boolean {
    return this.data.knownSessionIds.includes(id)
  }

  rememberSession(id: string): void {
    if (this.data.knownSessionIds.includes(id)) return
    this.data.knownSessionIds = [...this.data.knownSessionIds, id].slice(-MAX_KNOWN_SESSIONS)
    this.save()
  }
}

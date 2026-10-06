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
//   cachedCommands    — last available-commands list any agent advertised
//                       (spettro.cachedCommands); empty updates never wipe it
//   appearance        — 'system' | 'light' | 'dark'; main applies it to
//                       nativeTheme.themeSource before the window exists

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { ACPCommand, ACPConfigOption } from '../../shared/acp'
import { isAppearance, type Appearance } from '../../shared/model'

interface PrefsData {
  explicitCLIPath: string
  lastProjectPath: string
  lastConfigOptions: ACPConfigOption[]
  recentProjects: string[]
  cachedCommands: ACPCommand[]
  appearance: Appearance
}

const DEFAULTS: PrefsData = {
  explicitCLIPath: '',
  lastProjectPath: '',
  lastConfigOptions: [],
  recentProjects: [],
  cachedCommands: [],
  appearance: 'system'
}

function sanitize(raw: unknown): PrefsData {
  const data: PrefsData = {
    explicitCLIPath: '',
    lastProjectPath: '',
    lastConfigOptions: [],
    recentProjects: [],
    cachedCommands: [],
    appearance: 'system'
  }
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
  if (Array.isArray(obj.cachedCommands)) {
    data.cachedCommands = obj.cachedCommands as ACPCommand[]
  }
  if (isAppearance(obj.appearance)) data.appearance = obj.appearance
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
      return { ...DEFAULTS, lastConfigOptions: [], recentProjects: [], cachedCommands: [] }
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

  get cachedCommands(): ACPCommand[] {
    return structuredClone(this.data.cachedCommands)
  }

  set cachedCommands(commands: ACPCommand[]) {
    // saveCache ignores empty lists, so a transient empty update can't wipe
    // the cache (appendix C).
    if (commands.length === 0) return
    this.data.cachedCommands = structuredClone(commands)
    this.save()
  }

  get appearance(): Appearance {
    return this.data.appearance
  }

  set appearance(value: Appearance) {
    this.data.appearance = value
    this.save()
  }
}

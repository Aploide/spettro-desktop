// How the app learns which Spettro plan the user is on — the port of
// Spettro/Model/SubscriptionStore.swift (docs/16).
//
// The CLI caches the last-known subscription in ~/.spettro/config.json
// (spettro_email / spettro_plan / spettro_plan_status); the app only reads
// that mirror. The watcher observes the ~/.spettro DIRECTORY, not the file:
// the CLI rewrites config.json atomically (write temp, rename over), so a
// watch on the file itself would go silent after the first change. If the
// directory doesn't exist yet, a retry timer keeps trying to attach.

import { readFileSync, watch, type FSWatcher } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Plan, SubscriptionState } from '../../shared/model'

const DISCONNECTED: SubscriptionState = { plan: 'unknown', email: null }

export class SubscriptionStore {
  private readonly dir = join(homedir(), '.spettro')
  private readonly file = join(this.dir, 'config.json')
  private watcher: FSWatcher | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private started = false

  current: SubscriptionState = { ...DISCONNECTED }

  constructor(private readonly onChange: (state: SubscriptionState) => void) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.reload(true)
    this.tryWatch()
  }

  stop(): void {
    this.started = false
    if (this.watcher) {
      try {
        this.watcher.close()
      } catch {
        // already dead
      }
      this.watcher = null
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private tryWatch(): void {
    if (!this.started || this.watcher) return
    try {
      const watcher = watch(this.dir, () => this.reload(false))
      watcher.on('error', () => {
        try {
          watcher.close()
        } catch {
          // ignore
        }
        if (this.watcher === watcher) this.watcher = null
        this.scheduleRetry()
      })
      this.watcher = watcher
    } catch {
      // ~/.spettro doesn't exist yet (CLI never ran) — retry until it does.
      this.scheduleRetry()
    }
  }

  private scheduleRetry(): void {
    if (!this.started || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.reload(false)
      this.tryWatch()
    }, 5000)
    this.retryTimer.unref?.()
  }

  private reload(force: boolean): void {
    const next = this.read()
    if (force || next.plan !== this.current.plan || next.email !== this.current.email) {
      this.current = next
      this.onChange(next)
    }
  }

  /** Deliberately forgiving: any failure maps to "not connected". */
  private read(): SubscriptionState {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ...DISCONNECTED }
      }
      const obj = parsed as Record<string, unknown>
      const email = typeof obj.spettro_email === 'string' ? obj.spettro_email.trim() : ''
      // Presence of the email doubles as the connected/disconnected signal.
      if (email === '') return { ...DISCONNECTED }
      const rawPlan =
        typeof obj.spettro_plan === 'string' ? obj.spettro_plan.trim().toLowerCase() : ''
      // Connected with no plan field means free tier (same rule as the TUI).
      // Any other tier name passes through verbatim — SubscriptionPlan is an
      // open enum, and a new tier should read as itself, not as "no plan".
      const plan: Plan = rawPlan === '' ? 'free' : rawPlan
      return { plan, email }
    } catch {
      return { ...DISCONNECTED }
    }
  }
}

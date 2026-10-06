// The token layer's contract, checked on the CSS text itself.
//
// A token declared for dark and forgotten in light does not fail anywhere: the
// light scheme silently inherits the dark value, and the result is a dark-mode
// colour on a near-white page — exactly how the old palette ended up patching
// --mode-* and --diff-* locally in half a dozen view stylesheets. A screenshot
// shows it only if someone happens to look at the right view in the right
// scheme, so the parity is asserted here instead.

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { modeColor } from '@renderer/design/theme'

const RENDERER = resolve(__dirname, '../src/renderer/src')
const THEME = readFileSync(join(RENDERER, 'design/theme.css'), 'utf8')

/** The body of the first `{…}` block starting at `from`, braces balanced. */
function blockAt(css: string, from: number): string {
  const open = css.indexOf('{', from)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i)
  }
  throw new Error('unbalanced block')
}

function tokens(block: string): Set<string> {
  return new Set([...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
}

/** Top-level `:root` blocks, in order (the media block's own :root excluded). */
function rootBlocks(css: string): string[] {
  const out: string[] = []
  let depth = 0
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') depth--
    else if (depth === 0 && css.startsWith(':root', i)) out.push(blockAt(css, i))
  }
  return out
}

/** The palette lives in the top-level :root that declares --canvas (dark,
 *  the default) and in the :root inside the light media query. */
const dark = tokens(rootBlocks(THEME).find((b) => b.includes('--canvas:')) ?? '')
const lightMedia = THEME.indexOf('@media (prefers-color-scheme: light)')
const lightBody = lightMedia < 0 ? '' : blockAt(THEME, lightMedia)
const light = tokens(lightBody === '' ? '' : blockAt(lightBody, lightBody.indexOf(':root')))

describe('theme.css', () => {
  it('has a dark palette and a light palette', () => {
    expect(dark.size).toBeGreaterThan(20)
    expect(lightMedia).toBeGreaterThan(0)
    expect(light.size).toBeGreaterThan(20)
  })

  it('declares every dark token in the light scheme too', () => {
    const missing = [...dark].filter((t) => !light.has(t))
    expect(missing).toEqual([])
  })

  it('declares no light-only token', () => {
    const extra = [...light].filter((t) => !dark.has(t))
    expect(extra).toEqual([])
  })

  it('covers the mode, diff and alias tokens in both schemes', () => {
    for (const t of [
      '--mode-plan',
      '--mode-coding',
      '--mode-ask',
      '--diff-added',
      '--diff-removed',
      '--diff-added-bg',
      '--diff-removed-bg',
      '--agent-accent',
      '--assistant-bubble',
      '--user-bubble'
    ]) {
      expect(dark.has(t), `${t} (dark)`).toBe(true)
      expect(light.has(t), `${t} (light)`).toBe(true)
    }
  })

  it('backs every modeColor() result with a declared token', () => {
    const names = ['blue', 'green', 'cyan', 'yellow', 'magenta', 'purple', 'red']
    const ids = ['plan', 'planning', 'coding', 'code', 'chat', 'ask', 'unknown-spec']
    for (const name of [...names, ...ids]) {
      const ref = /^var\((--[a-z0-9-]+)\)$/.exec(modeColor(name))
      expect(ref, name).not.toBeNull()
      expect(dark.has(ref![1]) || ref![1] === '--accent-text', name).toBe(true)
      expect(light.has(ref![1]), name).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// The view stylesheets: tokens only, and no global name defined twice.
// ---------------------------------------------------------------------------

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return cssFiles(path)
    return name.endsWith('.css') ? [path] : []
  })
}

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

describe('view stylesheets', () => {
  it('use tokens instead of hex colours', () => {
    // activation.css is the one exception: its glow ramps are an effect's
    // palette, tuned per scheme in place, not a colour any other view shares.
    const offenders = cssFiles(join(RENDERER, 'views'))
      .filter((f) => !f.endsWith('activation.css'))
      .flatMap((f) =>
        stripComments(readFileSync(f, 'utf8'))
          .split('\n')
          .filter((line) => /#[0-9a-fA-F]{3,8}\b/.test(line))
          .map((line) => `${f.slice(RENDERER.length)}: ${line.trim()}`)
      )
    expect(offenders).toEqual([])
  })

  it('define .icon-btn and .sheet-card exactly once across the renderer', () => {
    const all = cssFiles(RENDERER).map((f) => stripComments(readFileSync(f, 'utf8'))).join('\n')
    expect(all.match(/^\.icon-btn\s*\{/gm)?.length).toBe(1)
    expect(all.match(/^\.sheet-card\s*\{/gm)?.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// The appearance preference, which main applies before the window exists.
// ---------------------------------------------------------------------------

describe('appearance preference', () => {
  it('defaults to system, persists a choice, and ignores garbage on disk', async () => {
    const { mkdtempSync, writeFileSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { Prefs } = await import('@main/model/prefs')
    const dir = mkdtempSync(join(tmpdir(), 'spettro-prefs-'))

    expect(new Prefs(dir).appearance).toBe('system')

    const prefs = new Prefs(dir)
    prefs.appearance = 'light'
    expect(new Prefs(dir).appearance).toBe('light')

    // A hand-edited or future value must not reach nativeTheme.themeSource,
    // which throws on anything but the three it knows.
    writeFileSync(join(dir, 'preferences.json'), JSON.stringify({ appearance: 'sepia' }))
    expect(new Prefs(dir).appearance).toBe('system')
  })
})

describe('AppModel.setAppearance', () => {
  // The IPC handler passes the renderer's argument straight through, so the
  // model is the gate in front of nativeTheme.themeSource.
  async function model(): Promise<{
    m: import('@main/model/appModel').AppModel
    applied: string[]
    states: string[]
    dir: string
  }> {
    const { mkdtempSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { AppModel } = await import('@main/model/appModel')
    const dir = mkdtempSync(join(tmpdir(), 'spettro-appearance-'))
    const applied: string[] = []
    const states: string[] = []
    const m = new AppModel({
      userDataDir: dir,
      appVersion: '0.0.0-test',
      applyAppearance: (mode) => applied.push(mode)
    })
    m.on('event', (e: { type: string; state?: { appearance: string } }) => {
      if (e.type === 'app-state' && e.state) states.push(e.state.appearance)
    })
    return { m, applied, states, dir }
  }

  it('applies, persists and announces a valid choice', async () => {
    const { m, applied, states, dir } = await model()
    expect(m.getState().appearance).toBe('system')
    m.setAppearance('dark')
    expect(applied).toEqual(['dark'])
    expect(states).toEqual(['dark'])
    const { Prefs } = await import('@main/model/prefs')
    expect(new Prefs(dir).appearance).toBe('dark')
  })

  it('ignores anything but system, light and dark', async () => {
    const { m, applied, states } = await model()
    m.setAppearance('sepia' as never)
    m.setAppearance(undefined as never)
    expect(applied).toEqual([])
    expect(states).toEqual([])
    expect(m.appearance).toBe('system')
  })
})

// ---------------------------------------------------------------------------
// The accents: Lilac (the palettes above) and Monochrome (data-accent='mono'),
// each in both schemes.
// ---------------------------------------------------------------------------

/** Declarations of a block, `--name: value` (values trimmed). */
function values(block: string): Map<string, string> {
  return new Map([...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
}

const MONO_SELECTOR = ":root[data-accent='mono']"
const monoDarkAt = THEME.indexOf(MONO_SELECTOR)
const monoLightMedia = THEME.indexOf('@media (prefers-color-scheme: light)', monoDarkAt)
const monoLightBody = monoLightMedia < 0 ? '' : blockAt(THEME, monoLightMedia)

const PALETTE = {
  lilac: {
    dark: values(rootBlocks(THEME).find((b) => b.includes('--canvas:')) ?? ''),
    light: values(lightBody === '' ? '' : blockAt(lightBody, lightBody.indexOf(':root')))
  },
  mono: {
    dark: values(monoDarkAt < 0 ? '' : blockAt(THEME, monoDarkAt)),
    light: values(monoLightBody === '' ? '' : blockAt(monoLightBody, monoLightBody.indexOf(MONO_SELECTOR)))
  }
}

/** A scheme's palette as an accent sees it: the shared palette with the
 *  accent's overrides on top. */
function resolved(accent: 'lilac' | 'mono', scheme: 'dark' | 'light'): Map<string, string> {
  return new Map([...PALETTE.lilac[scheme], ...(accent === 'mono' ? PALETTE.mono[scheme] : [])])
}

/** Every token an accent decides. Views use these instead of deriving
 *  their own shades of --accent, so both accents cover all of them. */
const ACCENT_TOKENS = [
  '--accent',
  '--accent-hover',
  '--accent-contrast',
  '--accent-text',
  '--accent-soft',
  '--focus-ring',
  '--selection',
  '--agent-accent',
  '--switch-on',
  '--mode-plan',
  '--mode-coding',
  '--mode-ask'
]

function rgb(value: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(value)
  if (!hex) throw new Error(`not a #rrggbb colour: ${value}`)
  const n = parseInt(hex[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const COMBOS = [
  ['lilac', 'dark'],
  ['lilac', 'light'],
  ['mono', 'dark'],
  ['mono', 'light']
] as const

describe('accents', () => {
  it('has a monochrome block for each scheme', () => {
    expect(monoDarkAt).toBeGreaterThan(lightMedia)
    expect(PALETTE.mono.dark.size).toBeGreaterThan(0)
    expect(PALETTE.mono.light.size).toBeGreaterThan(0)
  })

  it('declares the same tokens in both monochrome blocks, and only palette tokens', () => {
    expect([...PALETTE.mono.light.keys()].sort()).toEqual([...PALETTE.mono.dark.keys()].sort())
    const unknown = [...PALETTE.mono.dark.keys()].filter((t) => !dark.has(t))
    expect(unknown).toEqual([])
  })

  it('covers every accent token in all four accent × scheme palettes', () => {
    for (const t of ACCENT_TOKENS) {
      expect(PALETTE.lilac.dark.has(t), `${t} lilac dark`).toBe(true)
      expect(PALETTE.lilac.light.has(t), `${t} lilac light`).toBe(true)
      expect(PALETTE.mono.dark.has(t), `${t} mono dark`).toBe(true)
      expect(PALETTE.mono.light.has(t), `${t} mono light`).toBe(true)
    }
  })

  it('changes nothing but the accent: neutrals and semantic colours are shared', () => {
    for (const t of [
      '--canvas',
      '--sidebar-bg',
      '--surface-raised',
      '--text-primary',
      '--text-secondary',
      '--text-tertiary',
      '--hairline',
      '--success',
      '--danger',
      '--warning',
      '--diff-added-bg'
    ]) {
      expect(PALETTE.mono.dark.has(t), t).toBe(false)
    }
  })

  it('keeps Ultra on fire in both accents', () => {
    for (const t of ['--ultra-ember', '--ultra-flame', '--ultra-spark', '--ultra-core']) {
      expect(PALETTE.mono.dark.has(t), t).toBe(false)
      expect(PALETTE.mono.light.has(t), t).toBe(false)
      const [r, g, b] = rgb(PALETTE.lilac.dark.get(t)!)
      // Warm: red leads, blue trails.
      expect(r).toBeGreaterThan(b)
      expect(r).toBeGreaterThanOrEqual(g)
    }
  })

  it('uses true neutral greys for the surfaces and text', () => {
    for (const scheme of ['dark', 'light'] as const) {
      for (const t of [
        '--canvas',
        '--sidebar-bg',
        '--surface-raised',
        '--surface-sunken',
        '--user-bubble-bg',
        '--text-primary',
        '--text-secondary',
        '--text-tertiary'
      ]) {
        const [r, g, b] = rgb(PALETTE.lilac[scheme].get(t)!)
        // No warm (or any) cast: channels within a hair of each other.
        expect(Math.max(r, g, b) - Math.min(r, g, b), `${t} ${scheme}`).toBeLessThanOrEqual(5)
      }
    }
  })

  it('makes Monochrome colourless and Lilac a lilac', () => {
    for (const scheme of ['dark', 'light'] as const) {
      for (const t of ['--accent', '--accent-hover', '--accent-text', '--accent-contrast', '--mode-plan']) {
        const [r, g, b] = rgb(resolved('mono', scheme).get(t)!)
        expect(Math.max(r, g, b) - Math.min(r, g, b), `${t} mono ${scheme}`).toBeLessThanOrEqual(5)
      }
      const [r, g, b] = rgb(resolved('lilac', scheme).get('--accent')!)
      // Blue-violet: blue leads, then red, then green.
      expect(b).toBeGreaterThan(r)
      expect(r).toBeGreaterThan(g)
    }
  })

  it.each(COMBOS)('passes WCAG AA in %s × %s', (accent, scheme) => {
    const p = resolved(accent, scheme)
    const at = (t: string): string => p.get(t)!
    const surfaces = ['--canvas', '--sidebar-bg', '--surface-raised', '--surface-sunken']
    // Label on a filled accent button (and on its hover shade).
    expect(contrast(at('--accent-contrast'), at('--accent'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(at('--accent-contrast'), at('--accent-hover'))).toBeGreaterThanOrEqual(4.5)
    for (const s of surfaces) {
      for (const t of ['--text-primary', '--text-secondary', '--text-tertiary', '--accent-text']) {
        expect(contrast(at(t), at(s)), `${t} on ${s}`).toBeGreaterThanOrEqual(4.5)
      }
      // A filled control (a toggle, the slider's fill) against its surface.
      expect(contrast(at('--accent'), at(s)), `--accent on ${s}`).toBeGreaterThanOrEqual(3)
    }
  })

  it('never paints text in the fill colour (text takes --accent-text)', () => {
    const offenders = cssFiles(RENDERER).flatMap((f) =>
      stripComments(readFileSync(f, 'utf8'))
        .split('\n')
        .filter((line) => /^\s*color:\s*var\(--accent\)/.test(line))
        .map((line) => `${f.slice(RENDERER.length)}: ${line.trim()}`)
    )
    expect(offenders).toEqual([])
  })

  it('draws every focus ring in --focus-ring', () => {
    const offenders = cssFiles(RENDERER).flatMap((f) =>
      stripComments(readFileSync(f, 'utf8'))
        .split('\n')
        .filter((line) => /outline:.*var\(--accent/.test(line))
        .map((line) => `${f.slice(RENDERER.length)}: ${line.trim()}`)
    )
    expect(offenders).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The accent preference.
// ---------------------------------------------------------------------------

describe('accent preference', () => {
  it('defaults to lilac, persists a choice, and ignores garbage on disk', async () => {
    const { mkdtempSync, writeFileSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { Prefs } = await import('@main/model/prefs')
    const dir = mkdtempSync(join(tmpdir(), 'spettro-accent-'))

    expect(new Prefs(dir).accent).toBe('lilac')

    const prefs = new Prefs(dir)
    prefs.accent = 'mono'
    expect(new Prefs(dir).accent).toBe('mono')
    // The other preferences are untouched by it.
    expect(new Prefs(dir).appearance).toBe('system')

    writeFileSync(join(dir, 'preferences.json'), JSON.stringify({ accent: 'terracotta' }))
    expect(new Prefs(dir).accent).toBe('lilac')
    writeFileSync(join(dir, 'preferences.json'), JSON.stringify({ accent: 42, appearance: 'dark' }))
    expect(new Prefs(dir).accent).toBe('lilac')
    expect(new Prefs(dir).appearance).toBe('dark')
  })
})

describe('AppModel.setAccent', () => {
  async function model(): Promise<{
    m: import('@main/model/appModel').AppModel
    applied: string[]
    states: string[]
    dir: string
  }> {
    const { mkdtempSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { AppModel } = await import('@main/model/appModel')
    const dir = mkdtempSync(join(tmpdir(), 'spettro-accent-model-'))
    const applied: string[] = []
    const states: string[] = []
    const m = new AppModel({
      userDataDir: dir,
      appVersion: '0.0.0-test',
      applyAppearance: (mode) => applied.push(mode)
    })
    m.on('event', (e: { type: string; state?: { accent: string } }) => {
      if (e.type === 'app-state' && e.state) states.push(e.state.accent)
    })
    return { m, applied, states, dir }
  }

  it('persists and announces a valid choice, without touching the scheme', async () => {
    const { m, applied, states, dir } = await model()
    expect(m.getState().accent).toBe('lilac')
    m.setAccent('mono')
    expect(states).toEqual(['mono'])
    expect(applied).toEqual([])
    expect(m.accent).toBe('mono')
    const { Prefs } = await import('@main/model/prefs')
    expect(new Prefs(dir).accent).toBe('mono')
    // Choosing what is already in force announces nothing.
    m.setAccent('mono')
    expect(states).toEqual(['mono'])
  })

  it('ignores anything but lilac and mono', async () => {
    const { m, states } = await model()
    m.setAccent('terracotta' as never)
    m.setAccent(undefined as never)
    expect(states).toEqual([])
    expect(m.accent).toBe('lilac')
  })
})

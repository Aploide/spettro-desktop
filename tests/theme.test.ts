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
      expect(dark.has(ref![1]) || ref![1] === '--accent', name).toBe(true)
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

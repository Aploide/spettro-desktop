// The lit Ultra bar at rest. Once the meteor has burnt out, the fill it left
// keeps smouldering while the slider is open: a slow wave of heat runs along
// it toward the white-hot end, and a handful of embers drift the same way,
// bobbing a little and warming as they go. It is the bar's own fire breathing
// — never brighter than the fill, never outside it, slow enough to sit in the
// corner of the eye while the caption below is read.
//
// Like the meteor (meteor.ts), a frame is a pure function of (time, seed):
// each ember loops along the bar in closed form, so the harness can freeze
// any instant (`idleTime`) and a dropped frame costs nothing. The slider runs
// it at 30 frames a second on a canvas the size of the bar, and only while
// it can be seen: never under reduced motion, never with the window hidden,
// and not at all once the popover has closed.

import { clamp01, heatColor, mix, random, rgba, type MeteorPalette } from './meteor'

interface Mote {
  /** Pixels per second along the bar. */
  speed: number
  /** Where on its loop it is at t = 0 (0…1). */
  offset: number
  /** How far it bobs off the centre line, and how fast. */
  amp: number
  bob: number
  phase: number
  /** Radius of its bright core, in px. */
  size: number
  /** How fast it twinkles, in radians a second. */
  freq: number
}

export interface EmberField {
  /** The fill's ends along the bar, and the bar's centre line and height. */
  left: number
  right: number
  y: number
  height: number
  motes: Mote[]
}

export interface EmberGeometry {
  /** Where the fill ends (the Ultra stop), in canvas px from the bar's left. */
  fillEnd: number
  /** The bar's height. */
  height: number
}

/** Seconds for a wave of heat to run the length of the bar. */
const WAVE = 3.8
/** Off-screen run-up at each end of an ember's loop, so it fades in and out
 *  inside the bar instead of popping at its edge. */
const PAD = 6

/** Plans the embers for a bar: about one every 40px, never fewer than five. */
export function planEmbers(g: EmberGeometry, seed: number): EmberField {
  const rand = random(seed)
  const half = g.height / 2
  const count = Math.max(5, Math.round(g.fillEnd / 40))
  const motes: Mote[] = []
  for (let i = 0; i < count; i++) {
    motes.push({
      speed: 12 + rand() * 20,
      // Spread evenly round the loop, then jittered: never a clump.
      offset: (i + rand() * 0.7) / count,
      amp: half * (0.15 + rand() * 0.35),
      bob: 0.8 + rand() * 1.4,
      phase: rand() * Math.PI * 2,
      size: 0.75 + rand() * 0.7,
      freq: 2 + rand() * 3
    })
  }
  return { left: 0, right: g.fillEnd, y: half, height: g.height, motes }
}

const frac = (v: number): number => v - Math.floor(v)

/**
 * Draws the field at `t` seconds onto a context already scaled to CSS pixels.
 * The caller clears the canvas first.
 */
export function drawEmbers(
  ctx: CanvasRenderingContext2D,
  field: EmberField,
  t: number,
  palette: MeteorPalette
): void {
  const { left, right, y, height } = field
  const length = right - left
  if (length <= 0) return
  const add = palette.additive
  ctx.save()

  // The heat: two soft bright bands, out of step, running toward the stop.
  // Light on the fire, never a stripe of its own: wide and low.
  ctx.globalCompositeOperation = add ? 'lighter' : 'source-over'
  for (const [period, offset, strength, width] of [
    [WAVE, 0, add ? 0.2 : 0.26, 0.42],
    [WAVE * 1.37, 0.55, add ? 0.1 : 0.14, 0.3]
  ]) {
    const w = length * width
    const centre = left - w + frac(t / period + offset) * (length + 2 * w)
    const band = ctx.createLinearGradient(centre - w, 0, centre + w, 0)
    // Hotter toward the stop, as the fill is.
    const at = clamp01((centre - left) / length)
    const c = mix(palette.spark, palette.core, at)
    band.addColorStop(0, rgba(c, 0))
    band.addColorStop(0.5, rgba(c, strength * (0.6 + 0.4 * at)))
    band.addColorStop(1, rgba(c, 0))
    ctx.fillStyle = band
    ctx.fillRect(Math.max(left, centre - w), 0, Math.min(right, centre + w) - Math.max(left, centre - w), height)
  }

  // The embers: tiny motes with a glow, heating as they near the stop.
  const loop = length + 2 * PAD
  for (const m of field.motes) {
    const u = frac(m.offset + (t * m.speed) / loop)
    const x = left - PAD + u * loop
    if (x < left - m.size * 3 || x > right + m.size * 3) continue
    const along = clamp01((x - left) / length)
    // In and out along the loop, so none appears or vanishes in mid-bar.
    const life = Math.pow(Math.sin(Math.PI * u), 0.7)
    const twinkle = 0.7 + 0.3 * Math.sin(t * m.freq + m.phase)
    const alpha = 0.75 * life * twinkle
    if (alpha <= 0.02) continue
    const my = y + m.amp * Math.sin(t * m.bob + m.phase)
    // Brighter than the fill under it wherever it is: gold over the ember
    // end, near-white over the hot end.
    const color = mix(heatColor(palette, 0.55 + 0.45 * along), palette.core, add ? 0.35 : 0.6)
    const glow = ctx.createRadialGradient(x, my, 0, x, my, m.size * 3.2)
    glow.addColorStop(0, rgba(color, alpha * 0.45))
    glow.addColorStop(1, rgba(color, 0))
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(x, my, m.size * 3.2, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = rgba(color, alpha)
    ctx.beginPath()
    ctx.arc(x, my, m.size, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

// The meteor the thinking slider's thumb becomes when it arrives at Ultra.
//
// A white-hot head streaks along the track to the Ultra stop with a tapered
// tail and a wake of sparks that scatter, flicker and cool from white through
// gold and orange to ember red; on arrival it throws a burst of sparks and a
// ring of heat, then cools into the lit thumb the CSS draws from there on.
//
// Every frame is a pure function of (progress, seed): each spark is born from
// a seeded random stream and its position at any moment is worked out in
// closed form rather than stepped. So a dropped frame costs nothing, and the
// harness can photograph any instant of the flight (`?meteorProgress=0.3`) and
// get the same picture every time.
//
// It draws on a canvas laid over the slider body only. The body clips it, so
// however far a spark flies it never lands on the composer.

/** The whole run: flight, impact and cooling. */
export const METEOR_MS = 950
/** The part of the run spent in flight; the head lands at this progress. */
export const METEOR_LANDS = 0.5

interface RGB {
  r: number
  g: number
  b: number
}

export interface MeteorPalette {
  ember: RGB
  flame: RGB
  spark: RGB
  core: RGB
  /** Dark backgrounds take the fire as added light; light ones would wash it
   *  out to nothing, so there it is painted on like ink. */
  additive: boolean
}

interface Spark {
  /** Birth, in seconds from the start of the run. */
  born: number
  life: number
  x: number
  y: number
  vx: number
  vy: number
  /** Velocity lost per second (exponential drag). */
  drag: number
  size: number
  /** 1 is white-hot; sparks cool as they age. */
  heat: number
  phase: number
  freq: number
}

export interface MeteorRun {
  fromX: number
  toX: number
  y: number
  sparks: Spark[]
}

const SECONDS = METEOR_MS / 1000
const FLIGHT = METEOR_LANDS * SECONDS
/** Pull on the sparks, in px/s²: just enough that they arc as they die. */
const GRAVITY = 70

/** mulberry32: a tiny seeded generator, so a run is reproducible. */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const easeOutCubic = (u: number): number => 1 - Math.pow(1 - u, 3)
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/** Where the head is `t` seconds into the flight, and how fast it goes. */
function head(run: MeteorRun, t: number): { x: number; v: number } {
  const u = clamp01(t / FLIGHT)
  const d = run.toX - run.fromX
  // d/dt of easeOutCubic(t / FLIGHT) · d
  const v = u >= 1 ? 0 : (3 * Math.pow(1 - u, 2) * d) / FLIGHT
  return { x: run.fromX + d * easeOutCubic(u), v }
}

/**
 * Plans a run: the head's path and every spark it will shed. `height` is the
 * slider body's, so the wake never aims mostly off the canvas.
 */
export function planMeteor(fromX: number, toX: number, y: number, height: number, seed: number): MeteorRun {
  const rand = random(seed)
  const run: MeteorRun = { fromX, toX, y, sparks: [] }
  const dir = toX >= fromX ? 1 : -1
  const spread = Math.min(1, height / 40)

  // The wake: shed all along the flight, thrown back off the head and a
  // little up or down, carrying some of its speed.
  const wake = 60 + Math.round(Math.min(1, Math.abs(toX - fromX) / 240) * 60)
  for (let i = 0; i < wake; i++) {
    const born = FLIGHT * ((i + rand()) / wake)
    const at = head(run, born)
    run.sparks.push({
      born,
      life: 0.16 + rand() * 0.34,
      x: at.x - dir * rand() * 3,
      y: y + (rand() - 0.5) * 4,
      vx: at.v * (0.12 + rand() * 0.18) - dir * (30 + rand() * 110),
      vy: (rand() - 0.5) * 150 * spread,
      drag: 1.5 + rand() * 2.5,
      size: 0.7 + rand() * 1.4,
      heat: 0.7 + rand() * 0.3,
      phase: rand() * Math.PI * 2,
      freq: 38 + rand() * 60
    })
  }

  // The landing: a burst flung every way, flattened to the track's height.
  const burst = 30
  for (let i = 0; i < burst; i++) {
    const angle = (i / burst) * Math.PI * 2 + (rand() - 0.5) * 0.5
    const speed = 80 + rand() * 200
    run.sparks.push({
      born: FLIGHT + rand() * 0.05,
      life: 0.2 + rand() * 0.3,
      x: toX,
      y,
      // Thrown back along the track: the stop sits near the body's edge,
      // and sparks flung forward would be clipped the instant they left.
      vx: Math.cos(angle) * speed - dir * 50,
      vy: Math.sin(angle) * speed * 0.55 * spread,
      drag: 4 + rand() * 3,
      size: 0.7 + rand() * 1.1,
      heat: 0.85 + rand() * 0.15,
      phase: rand() * Math.PI * 2,
      freq: 45 + rand() * 55
    })
  }
  return run
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t }
}

function rgba(c: RGB, alpha: number): string {
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${clamp01(alpha).toFixed(3)})`
}

/** A temperature to a colour: ember → flame → spark → white-hot core. */
function heatColor(p: MeteorPalette, heat: number): RGB {
  const h = clamp01(heat)
  if (h > 2 / 3) return mix(p.spark, p.core, (h - 2 / 3) * 3)
  if (h > 1 / 3) return mix(p.flame, p.spark, (h - 1 / 3) * 3)
  return mix(p.ember, p.flame, h * 3)
}

/** Where a spark is `age` seconds after its birth. */
function sparkAt(s: Spark, age: number): { x: number; y: number } {
  const fall = (1 - Math.exp(-s.drag * age)) / s.drag
  return { x: s.x + s.vx * fall, y: s.y + s.vy * fall + 0.5 * GRAVITY * age * age }
}

/**
 * Draws the run at `progress` (0…1) onto a context already scaled to CSS
 * pixels. The caller clears the canvas first.
 */
export function drawMeteor(
  ctx: CanvasRenderingContext2D,
  run: MeteorRun,
  progress: number,
  palette: MeteorPalette
): void {
  const t = clamp01(progress) * SECONDS
  ctx.save()
  ctx.globalCompositeOperation = palette.additive ? 'lighter' : 'source-over'
  ctx.lineCap = 'round'

  // Sparks, as short streaks along their motion: a dot reads as dust, a
  // streak as something hot and fast.
  for (const s of run.sparks) {
    const age = t - s.born
    if (age < 0 || age > s.life) continue
    const left = 1 - age / s.life
    // Flicker, with the odd near-dropout so the wake twinkles rather than
    // pulses in step.
    let flicker = 0.6 + 0.4 * Math.sin(t * s.freq + s.phase)
    if (Math.sin(t * s.freq * 1.7 + s.phase * 3) > 0.9) flicker *= 0.25
    const alpha = Math.pow(left, 1.2) * flicker
    if (alpha <= 0.01) continue
    const now = sparkAt(s, age)
    const before = sparkAt(s, Math.max(0, age - 0.022))
    let color = heatColor(palette, s.heat * (0.35 + 0.65 * left))
    // Painted on a light ground, gold is barely darker than the paper: the
    // same spark, a step toward ember, and a touch thicker.
    if (!palette.additive) color = mix(color, palette.ember, 0.35)
    const width = s.size * (0.55 + 0.45 * left) * (palette.additive ? 1 : 1.25)
    ctx.beginPath()
    ctx.moveTo(before.x, before.y)
    ctx.lineTo(now.x + 0.01, now.y)
    if (palette.additive && left > 0.3) {
      // Light adds up: a faint wide pass under the streak reads as glow.
      ctx.strokeStyle = rgba(color, alpha * 0.18)
      ctx.lineWidth = width * 3.2
      ctx.stroke()
    }
    ctx.strokeStyle = rgba(color, alpha)
    ctx.lineWidth = width
    ctx.stroke()
  }

  const { x, v } = head(run, t)
  const dir = run.toX >= run.fromX ? 1 : -1
  const landed = t >= FLIGHT
  // After landing the head cools: everything it draws fades out under the
  // CSS thumb, which fades in underneath.
  const cool = landed ? clamp01((t - FLIGHT) / (SECONDS - FLIGHT)) : 0
  const heat = 1 - Math.pow(cool, 0.7)
  const shimmer = 0.92 + 0.08 * Math.sin(t * 61) * Math.sin(t * 23 + 1)

  // The fuse: the track glows where the head has just been and cools behind
  // it, so the run reads as the slider catching fire rather than a dot
  // sliding over it.
  const behind = head(run, Math.max(0, t - 0.32)).x
  if (Math.abs(x - behind) > 0.5) {
    const fuse = ctx.createLinearGradient(behind, run.y, x, run.y)
    fuse.addColorStop(0, rgba(palette.ember, 0))
    fuse.addColorStop(0.7, rgba(palette.flame, 0.35 * heat))
    fuse.addColorStop(1, rgba(palette.spark, 0.6 * heat))
    ctx.strokeStyle = fuse
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(behind, run.y)
    ctx.lineTo(x, run.y)
    ctx.stroke()
  }

  if (!landed) {
    // The tail: a tapered flame behind the head, long when it is fast, grown
    // in over the first few frames so it doesn't appear at full length.
    const grow = clamp01(t / (FLIGHT * 0.15))
    const length = Math.min(170, Math.max(26, Math.abs(v) * 0.1)) * grow * shimmer
    tail(ctx, x, run.y, dir, length * 1.3, 10, palette, 0.32)
    tail(ctx, x, run.y, dir, length, 4.2, palette, 1)
  } else if (cool < 0.4) {
    // The landing: a ring of heat thrown outward and gone.
    const k = cool / 0.4
    ctx.strokeStyle = rgba(palette.flame, 0.6 * (1 - k))
    ctx.lineWidth = 1.6 * (1 - k) + 0.4
    ctx.beginPath()
    ctx.arc(x, run.y, 6 + 13 * easeOutCubic(k), 0, Math.PI * 2)
    ctx.stroke()
  }

  // The head: a halo, brightest the instant it lands, around a white-hot core.
  const flash = landed ? 1 + 0.7 * Math.pow(1 - cool, 3) : 1
  const radius = 14 * shimmer * flash
  const halo = ctx.createRadialGradient(x, run.y, 0, x, run.y, radius)
  halo.addColorStop(0, rgba(palette.core, 0.95 * heat))
  halo.addColorStop(0.22, rgba(palette.spark, 0.7 * heat))
  halo.addColorStop(0.55, rgba(palette.flame, 0.28 * heat))
  halo.addColorStop(1, rgba(palette.ember, 0))
  ctx.fillStyle = halo
  ctx.beginPath()
  ctx.arc(x, run.y, radius, 0, Math.PI * 2)
  ctx.fill()

  if (!palette.additive) {
    // Painted, a pale core needs an outline to exist at all on white.
    ctx.strokeStyle = rgba(palette.flame, 0.85 * heat)
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.arc(x, run.y, 3.9, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.fillStyle = rgba(palette.core, heat)
  ctx.beginPath()
  ctx.arc(x, run.y, 3.3, 0, Math.PI * 2)
  ctx.fill()

  ctx.restore()
}

/** A tapered flame from the head back along the path. */
function tail(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  dir: number,
  length: number,
  width: number,
  p: MeteorPalette,
  alpha: number
): void {
  if (length < 1) return
  const end = x - dir * length
  const fill = ctx.createLinearGradient(x, y, end, y)
  if (p.additive) {
    fill.addColorStop(0, rgba(p.core, alpha))
    fill.addColorStop(0.12, rgba(p.spark, 0.9 * alpha))
    fill.addColorStop(0.45, rgba(p.flame, 0.55 * alpha))
  } else {
    // On white the pale end of the ramp is invisible; start at gold.
    fill.addColorStop(0, rgba(p.spark, alpha))
    fill.addColorStop(0.2, rgba(p.flame, 0.9 * alpha))
    fill.addColorStop(0.55, rgba(p.ember, 0.45 * alpha))
  }
  fill.addColorStop(1, rgba(p.ember, 0))
  ctx.fillStyle = fill
  const half = width / 2
  ctx.beginPath()
  ctx.moveTo(x, y - half)
  ctx.quadraticCurveTo(x - dir * length * 0.3, y - half * 0.85, end, y)
  ctx.quadraticCurveTo(x - dir * length * 0.3, y + half * 0.85, x, y + half)
  // Round the front: bottom → front → top, the way the head is moving.
  ctx.arc(x, y, half, Math.PI / 2, -Math.PI / 2, dir > 0)
  ctx.closePath()
  ctx.fill()
}

/** "#rrggbb" or "#rgb" to RGB; null for anything else. */
function parseHex(value: string): RGB | null {
  const hex = value.trim().replace(/^#/, '')
  const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex
  if (!/^[0-9a-f]{6}$/i.test(full)) return null
  const n = parseInt(full, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

/** The fire, read from the --ultra-* tokens so the canvas and the CSS can't
 *  drift apart; the fallbacks are the dark scheme's. */
export function readPalette(el: Element): MeteorPalette {
  const style = getComputedStyle(el)
  const token = (name: string, fallback: RGB): RGB =>
    parseHex(style.getPropertyValue(name)) ?? fallback
  const dark =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : true
  return {
    ember: token('--ultra-ember', { r: 224, g: 69, b: 43 }),
    flame: token('--ultra-flame', { r: 255, g: 138, b: 61 }),
    spark: token('--ultra-spark', { r: 255, g: 211, b: 107 }),
    core: token('--ultra-core', { r: 255, g: 251, b: 234 }),
    additive: dark
  }
}

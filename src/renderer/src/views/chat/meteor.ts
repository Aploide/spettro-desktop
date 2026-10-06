// The meteor the thinking slider's thumb becomes when it arrives at Ultra.
//
// The thumb lifts off as a white-hot head and accelerates along the track,
// dragging a tapered plasma streak that *is* the slider's fill: the fill grows
// out from behind the head and cools along its length, from white through
// gold and orange into the accent, so there is never a gap between the fire
// and the bar it leaves. Sparks peel off the head, scatter up and down the
// slider body, flicker and cool to ember red. It hits the Ultra stop at full
// speed: a flash, a shockwave ring, a burst of embers, a few that linger —
// and then it cools into the lit thumb the CSS draws from there on.
//
// Every frame is a pure function of (progress, seed): each spark is born from
// a seeded random stream and its position at any moment is worked out in
// closed form rather than stepped. So a dropped frame costs nothing, and the
// harness can photograph any instant of the run (`?meteorProgress=0.3`) and
// get the same picture every time.
//
// It draws on a canvas laid over the slider body only. The body is a rounded
// band that clips it, so however far a spark flies it never lands on the
// composer.

interface RGB {
  r: number
  g: number
  b: number
}

export interface MeteorPalette {
  /** The slider's own fill colour: where the streak cools to. */
  accent: RGB
  ember: RGB
  flame: RGB
  spark: RGB
  core: RGB
  /** Dark backgrounds take the fire as added light; light ones would wash it
   *  out to nothing, so there it is painted on like ink, a shade deeper, with
   *  a dark-orange halo to stand out from the paper. */
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
  /** Where the head sets out from, and the stop it lands on (canvas px). */
  fromX: number
  toX: number
  /** Where the slider's own fill stops while the head is in flight: the
   *  streak is drawn from here, so fill and fire are one bar. */
  fillX: number
  y: number
  /** The rail's ends, so the burnt-in bar never runs off them, and its
   *  length: tail lengths are a share of it. */
  railLeft: number
  railRight: number
  track: number
  /** Seconds in flight, and for the whole run (flight, impact, cooling). */
  flight: number
  total: number
  /** The share of its final speed the head sets out with. */
  launch: number
  sparks: Spark[]
}

export interface MeteorTiming {
  /** Where on the rail (0…1) the head sets out from. */
  startFrac: number
  /** Milliseconds until the head lands, and until the last ember is out. */
  landsMs: number
  totalMs: number
  /** landsMs / totalMs: the run's progress at the moment of impact. */
  lands: number
}

/** The shortest run, as a share of the rail. One step (Max → Ultra) is too
 *  short to read as a meteor, so it sets out from a little behind Max and is
 *  already streaking by the time it passes it. */
const MIN_RUN = 0.36
/** After impact: the flash, the embers and the cooling into the thumb. */
const AFTER = 0.46
/** Pull on the sparks, in px/s²: just enough that they arc as they die. */
const GRAVITY = 90
/** How long the plasma behind the head stays white-hot to amber, in seconds
 *  of travel: the tail's length is the head's speed times this. */
const PERSIST = 0.24

/**
 * How a run from `fromFrac` to `toFrac` (shares of the rail) is timed. Pure,
 * so the slider can time the thumb without a canvas (jsdom) and the harness
 * can tell a frame before impact from one after.
 */
export function meteorTiming(fromFrac: number, toFrac: number): MeteorTiming {
  const startFrac = Math.max(0, Math.min(fromFrac, toFrac - MIN_RUN))
  const span = Math.abs(toFrac - startFrac)
  const flight = 0.3 + 0.38 * span
  const total = flight + AFTER
  return {
    startFrac,
    landsMs: flight * 1000,
    totalMs: total * 1000,
    lands: flight / total
  }
}

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

/** Roughly normal, mean 0 and spread ~1: most sparks near the line, a few
 *  flung wide. */
function spread(rand: () => number): number {
  return (rand() + rand() + rand() - 1.5) * 2
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
const easeOutCubic = (u: number): number => 1 - Math.pow(1 - u, 3)

/** Where the head is `t` seconds in, and its velocity (px/s). It sets out
 *  already moving and accelerates all the way into the stop. */
function head(run: MeteorRun, t: number): { x: number; v: number } {
  const u = clamp01(t / run.flight)
  const d = run.toX - run.fromX
  const a = run.launch
  const p = a * u + (1 - a) * u * u
  const v = u >= 1 ? 0 : ((a + 2 * (1 - a) * u) * d) / run.flight
  return { x: run.fromX + d * p, v }
}

/** The tail's length at `t`: the head's speed times how long the plasma
 *  stays hot, grown in over the first frames, and after impact swallowed by
 *  the stop as the rest of the streak piles into it. */
function tailLength(run: MeteorRun, t: number): number {
  const cap = run.track * 0.48
  if (t < run.flight) {
    const grow = clamp01(t / 0.07)
    // Never a stub: even setting out it trails a streak of its own.
    const floor = run.track * 0.14
    return Math.min(cap, Math.max(floor, Math.abs(head(run, t).v) * PERSIST)) * grow
  }
  const atImpact = Math.min(cap, Math.abs(head(run, run.flight - 1e-6).v) * PERSIST)
  const k = clamp01((t - run.flight) / 0.13)
  return atImpact * Math.pow(1 - k, 2)
}

export interface MeteorGeometry {
  /** The rail's ends and its centre line, in canvas px. */
  railLeft: number
  railWidth: number
  y: number
  /** The canvas (slider body) height: the sparks' room to scatter. */
  height: number
  /** The stop the thumb was on (its fill ends there) and the one it flies to,
   *  as shares of the rail. */
  fromFrac: number
  toFrac: number
}

/** Plans a run: the head's path and every spark it will shed. */
export function planMeteor(g: MeteorGeometry, seed: number): MeteorRun {
  const rand = random(seed)
  const timing = meteorTiming(g.fromFrac, g.toFrac)
  const x = (f: number): number => g.railLeft + f * g.railWidth
  const run: MeteorRun = {
    fromX: x(timing.startFrac),
    toX: x(g.toFrac),
    fillX: x(g.fromFrac),
    y: g.y,
    railLeft: g.railLeft,
    railRight: g.railLeft + g.railWidth,
    track: g.railWidth,
    flight: timing.landsMs / 1000,
    total: timing.totalMs / 1000,
    launch: 0.25,
    sparks: []
  }
  const dir = run.toX >= run.fromX ? 1 : -1
  const span = Math.abs(run.toX - run.fromX) / Math.max(1, g.railWidth)
  // A long run has room to build up speed; a short one comes in streaking.
  run.launch = 0.25 + 0.45 * (1 - Math.min(1, span))
  // Vertical room, as a share of the 36px body the numbers were tuned in.
  const room = Math.min(1.2, g.height / 36)
  // The latest a spark may still be alight: the run's end.
  const until = (born: number, life: number): number => Math.min(life, run.total - born)

  // The wake: shed all along the flight, more of them the faster the head
  // goes, carrying a little of its speed and thrown up and down the band.
  const wake = Math.round(36 + 44 * Math.min(1, span))
  for (let i = 0; i < wake; i++) {
    const born = run.flight * Math.sqrt((i + rand()) / wake)
    const at = head(run, born)
    const life = 0.2 + Math.pow(rand(), 1.4) * 0.5
    run.sparks.push({
      born,
      life: until(born, life),
      x: at.x - dir * rand() * 5,
      y: run.y + (rand() - 0.5) * 5,
      vx: at.v * (0.08 + rand() * 0.32) - dir * rand() * 70,
      vy: spread(rand) * 62 * room,
      drag: 2.4 + rand() * 3,
      size: 1 + Math.pow(rand(), 2) * 2,
      heat: 0.72 + rand() * 0.28,
      phase: rand() * Math.PI * 2,
      freq: 30 + rand() * 55
    })
  }

  // The impact: a burst flung back and up and down — the stop sits near the
  // band's end, so anything thrown forward would be clipped the instant it
  // left.
  const burst = 30
  for (let i = 0; i < burst; i++) {
    const angle = Math.PI + (i / burst - 0.5) * Math.PI * 1.7 + (rand() - 0.5) * 0.35
    const speed = 90 + rand() * 250
    const born = run.flight + rand() * 0.04
    run.sparks.push({
      born,
      life: until(born, 0.22 + rand() * 0.36),
      x: run.toX,
      y: run.y + (rand() - 0.5) * 3,
      vx: dir * Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed * 0.62 * room,
      drag: 4.5 + rand() * 4,
      size: 1.2 + rand() * 1.8,
      heat: 0.88 + rand() * 0.12,
      phase: rand() * Math.PI * 2,
      freq: 40 + rand() * 50
    })
  }

  // Embers: slow, amber, lingering around the stop after everything else
  // is out, and gone before the run ends.
  const embers = 10
  for (let i = 0; i < embers; i++) {
    const born = run.flight + 0.02 + rand() * 0.08
    run.sparks.push({
      born,
      life: until(born, 0.28 + rand() * 0.1),
      x: run.toX - dir * rand() * 14,
      y: run.y + (rand() - 0.5) * 8,
      vx: -dir * (8 + rand() * 40),
      vy: (rand() - 0.65) * 40 * room,
      drag: 1.5 + rand() * 1.5,
      size: 1.3 + rand() * 1,
      heat: 0.45 + rand() * 0.25,
      phase: rand() * Math.PI * 2,
      freq: 12 + rand() * 18
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

/** A flicker in [0.7, 1.08] that never repeats in step: three detuned sines. */
function flicker(t: number): number {
  return 0.89 + 0.07 * Math.sin(t * 71) + 0.05 * Math.sin(t * 43 + 1.3) + 0.04 * Math.sin(t * 127 + 2.1)
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
  const t = clamp01(progress) * run.total
  const { x, v } = head(run, t)
  const dir = run.toX >= run.fromX ? 1 : -1
  // The rail's end it set out from: a tail is never drawn far past it, as
  // if the thumb had come from off the slider.
  const back = Math.abs(x - (dir > 0 ? run.railLeft : run.railRight)) + 8
  const landed = t >= run.flight
  const since = t - run.flight
  // After impact the head cools: everything it draws fades out over the CSS
  // thumb, which fades in underneath.
  const cool = landed ? clamp01(since / (run.total - run.flight)) : 0
  const heat = 1 - Math.pow(cool, 0.8)
  const shimmer = flicker(t)
  const length = Math.min(back, tailLength(run, t))
  const add = palette.additive
  const speed = Math.min(1, Math.abs(v) / (run.track * 2.6))

  ctx.save()
  ctx.lineCap = 'round'

  // The light the head throws on the band around it; at impact, the whole
  // band flares for an instant.
  {
    const flare = landed ? Math.pow(1 - clamp01(since / 0.3), 2) : 0
    const r = 70 + 90 * flare
    // Flattened to the band, so it fades out before the band's edge does and
    // the clip never shows as a lit box.
    const squash = 0.2
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, r)
    const a = (add ? 0.2 : 0.1) * heat * shimmer + (add ? 0.3 : 0.14) * flare
    glow.addColorStop(0, rgba(add ? palette.flame : palette.ember, a))
    glow.addColorStop(0.4, rgba(palette.ember, a * 0.35))
    glow.addColorStop(1, rgba(palette.ember, 0))
    ctx.save()
    ctx.translate(x, run.y)
    ctx.scale(1, squash)
    ctx.globalCompositeOperation = add ? 'lighter' : 'source-over'
    ctx.fillStyle = glow
    ctx.fillRect(-r, -r, r * 2, r * 2)
    ctx.restore()
  }

  // The streak as fill: the slider's bar, burnt in from where its fill stood
  // to the head, white-hot at the head and cooling back into the accent —
  // over the fill already there too, when the head sets out from behind it.
  // Painted, not added, so it is the bar itself rather than light on it.
  // After impact the real fill is under it and it fades away.
  const barAlpha = landed ? 1 - clamp01(since / 0.22) : 1
  const barFrom =
    dir > 0
      ? Math.max(run.railLeft, Math.min(run.fillX, x - length))
      : Math.min(run.railRight, Math.max(run.fillX, x + length))
  if (barAlpha > 0 && Math.abs(x - barFrom) > 0.5) {
    const len = Math.abs(x - barFrom)
    const bar = ctx.createLinearGradient(x, run.y, barFrom, run.y)
    const at = (d: number): number => clamp01(d / len)
    const hot = add ? palette.core : palette.spark
    bar.addColorStop(0, rgba(hot, barAlpha))
    bar.addColorStop(at(length * 0.12), rgba(palette.spark, barAlpha))
    bar.addColorStop(at(length * 0.45), rgba(palette.flame, barAlpha))
    bar.addColorStop(at(Math.max(length, 1)), rgba(palette.accent, barAlpha))
    bar.addColorStop(1, rgba(palette.accent, barAlpha))
    ctx.globalCompositeOperation = 'source-over'
    ctx.strokeStyle = bar
    ctx.lineWidth = 4
    ctx.lineCap = 'butt'
    ctx.beginPath()
    ctx.moveTo(barFrom, run.y)
    ctx.lineTo(x, run.y)
    ctx.stroke()
    ctx.lineCap = 'round'
  }

  // The plasma over it: a tapered streak, wide and soft, then narrow and hot.
  if (length > 1) {
    if (!add) {
      // On paper a halo of dark orange, so the fire has a ground to burn on.
      ctx.globalCompositeOperation = 'source-over'
      plume(ctx, x, run.y, dir, length * 1.05, 14, [
        [0, palette.ember, 0.14 * heat],
        [0.5, palette.ember, 0.05 * heat],
        [1, palette.ember, 0]
      ])
    }
    ctx.globalCompositeOperation = add ? 'lighter' : 'source-over'
    plume(ctx, x, run.y, dir, length * 1.15, 13 * shimmer, add
      ? [
          [0, palette.flame, 0.5 * heat],
          [0.35, palette.ember, 0.22 * heat],
          [1, palette.ember, 0]
        ]
      : [
          [0, palette.flame, 0.3 * heat],
          [0.4, palette.flame, 0.1 * heat],
          [1, palette.ember, 0]
        ])
    plume(ctx, x, run.y, dir, length, 6.5, add
      ? [
          [0, palette.core, heat],
          [0.14, palette.spark, 0.95 * heat],
          [0.45, palette.flame, 0.6 * heat],
          [1, palette.ember, 0]
        ]
      : [
          [0, palette.spark, heat],
          [0.3, palette.spark, 0.9 * heat],
          [0.6, palette.flame, 0.7 * heat],
          [1, palette.ember, 0]
        ])
  }

  // Sparks, as short streaks along their motion: a dot reads as dust, a
  // streak as something hot and fast.
  ctx.globalCompositeOperation = add ? 'lighter' : 'source-over'
  for (const s of run.sparks) {
    const age = t - s.born
    if (age < 0 || age > s.life) continue
    const left = 1 - age / s.life
    // Flicker, with the odd near-dropout so the wake twinkles rather than
    // pulses in step.
    let twinkle = 0.62 + 0.38 * Math.sin(t * s.freq + s.phase)
    if (Math.sin(t * s.freq * 1.7 + s.phase * 3) > 0.88) twinkle *= 0.2
    const alpha = Math.min(1, 1.25 * Math.pow(left, 0.7) * twinkle)
    if (alpha <= 0.02) continue
    const now = sparkAt(s, age)
    const before = sparkAt(s, Math.max(0, age - 0.026))
    // Cooling: white → amber → red, and then out.
    let color = heatColor(palette, s.heat * (0.25 + 0.75 * left))
    // Painted on a light ground, gold is barely darker than the paper: the
    // same spark, a step toward ember, and a touch thicker.
    if (!add) color = mix(color, palette.ember, 0.25 + 0.4 * (1 - left))
    const width = s.size * (0.6 + 0.4 * left) * (add ? 1 : 1.3)
    if (add && left > 0.5) {
      // Light adds up: a faint disc under a hot spark reads as its glow.
      ctx.fillStyle = rgba(color, alpha * 0.22 * (left - 0.5) * 2)
      ctx.beginPath()
      ctx.arc(now.x, now.y, width * 1.5, 0, Math.PI * 2)
      ctx.fill()
    }
    // A stroke much fatter than it is long rasterises as a ring (its outline
    // folds over itself), so a spark barely moving is drawn as a dot.
    const dx = now.x - before.x
    const dy = now.y - before.y
    if (dx * dx + dy * dy > width * width) {
      ctx.strokeStyle = rgba(color, alpha)
      ctx.lineWidth = width
      ctx.beginPath()
      ctx.moveTo(before.x, before.y)
      ctx.lineTo(now.x, now.y)
      ctx.stroke()
    } else {
      ctx.fillStyle = rgba(color, alpha)
      ctx.beginPath()
      ctx.arc(now.x, now.y, width / 2, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  if (landed && since < 0.32) {
    // The shockwave: a ring of heat thrown outward from the stop. The band
    // clips it top and bottom, so it reads as a pressure wave along the
    // slider rather than a circle drawn on it.
    // A soft front with a hot leading edge, not an outline: a stroked ring
    // reads as a circle drawn round the head.
    const k = since / 0.32
    const r = 12 + 36 * easeOutCubic(k)
    const thick = 9 * (1 - k) + 3
    // In over the first few milliseconds, so it leaves the head rather than
    // starting round it.
    const fade = clamp01(k / 0.1) * Math.pow(1 - k, 1.4)
    const wave = ctx.createRadialGradient(x, run.y, Math.max(0, r - thick), x, run.y, r + 1.5)
    const edge = add ? palette.spark : palette.flame
    wave.addColorStop(0, rgba(palette.ember, 0))
    wave.addColorStop(0.7, rgba(add ? palette.flame : palette.ember, 0.35 * fade))
    wave.addColorStop(0.9, rgba(edge, 0.85 * fade))
    wave.addColorStop(1, rgba(edge, 0))
    ctx.globalCompositeOperation = add ? 'lighter' : 'source-over'
    ctx.fillStyle = wave
    ctx.beginPath()
    ctx.arc(x, run.y, r + 1.5, 0, Math.PI * 2)
    ctx.arc(x, run.y, Math.max(0, r - thick), 0, Math.PI * 2, true)
    ctx.fill()
  }

  // The head: a corona, stretched along the way it is going, around a
  // white-hot core; brightest and biggest the instant it lands.
  const flash = landed ? 1 + 0.3 * Math.pow(1 - clamp01(since / 0.14), 2) : 1
  // Cooling, it shrinks to the size of the thumb that takes its place.
  const size = (1 - 0.3 * cool) * shimmer * flash
  const stretch = 1 + 0.9 * speed
  ctx.save()
  ctx.translate(x, run.y)
  ctx.scale(stretch, 1)
  ctx.translate(dir * -2 * speed, 0)
  if (!add) {
    const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, 20 * size)
    halo.addColorStop(0, rgba(palette.ember, 0.4 * heat))
    halo.addColorStop(0.5, rgba(palette.ember, 0.16 * heat))
    halo.addColorStop(1, rgba(palette.ember, 0))
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = halo
    ctx.beginPath()
    ctx.arc(0, 0, 20 * size, 0, Math.PI * 2)
    ctx.fill()
  }
  // Painted on paper the corona is solid colour, so it is drawn smaller.
  const reach = (add ? 17 : 13.5) * size
  const corona = ctx.createRadialGradient(0, 0, 0, 0, 0, reach)
  if (add) {
    corona.addColorStop(0, rgba(palette.core, heat))
    corona.addColorStop(0.2, rgba(palette.core, 0.95 * heat))
    corona.addColorStop(0.36, rgba(palette.spark, 0.85 * heat))
    corona.addColorStop(0.6, rgba(palette.flame, 0.45 * heat))
    corona.addColorStop(0.8, rgba(palette.ember, 0.18 * heat))
  } else {
    // Painted, the heat has to come from saturation: gold straight off the
    // core, through orange, into a thin red rim.
    corona.addColorStop(0, rgba(palette.spark, heat))
    corona.addColorStop(0.3, rgba(palette.spark, heat))
    corona.addColorStop(0.5, rgba(palette.flame, 0.85 * heat))
    corona.addColorStop(0.72, rgba(palette.ember, 0.3 * heat))
  }
  corona.addColorStop(1, rgba(palette.ember, 0))
  ctx.globalCompositeOperation = add ? 'lighter' : 'source-over'
  ctx.fillStyle = corona
  ctx.beginPath()
  ctx.arc(0, 0, reach, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = rgba(palette.core, heat)
  ctx.beginPath()
  ctx.arc(0, 0, (add ? 4.6 : 3.4) * size, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  ctx.restore()
}

type Stops = Array<[at: number, color: RGB, alpha: number]>

/** A tapered flame from the head back along the path: round at the front,
 *  narrowing to a point `length` behind. */
function plume(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  dir: number,
  length: number,
  width: number,
  stops: Stops
): void {
  if (length < 1) return
  const end = x - dir * length
  const fill = ctx.createLinearGradient(x, y, end, y)
  for (const [at, color, alpha] of stops) fill.addColorStop(at, rgba(color, alpha))
  ctx.fillStyle = fill
  const half = width / 2
  ctx.beginPath()
  ctx.moveTo(x, y - half)
  ctx.bezierCurveTo(x - dir * length * 0.35, y - half * 0.8, x - dir * length * 0.7, y - half * 0.25, end, y)
  ctx.bezierCurveTo(x - dir * length * 0.7, y + half * 0.25, x - dir * length * 0.35, y + half * 0.8, x, y + half)
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

/** The fire, read from the --ultra-* tokens (and the fill's --accent) so the
 *  canvas and the CSS can't drift apart; the fallbacks are the dark scheme's. */
export function readPalette(el: Element): MeteorPalette {
  const style = getComputedStyle(el)
  const token = (name: string, fallback: RGB): RGB =>
    parseHex(style.getPropertyValue(name)) ?? fallback
  const dark =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : true
  return {
    accent: token('--accent', { r: 217, g: 119, b: 87 }),
    ember: token('--ultra-ember', { r: 224, g: 69, b: 43 }),
    flame: token('--ultra-flame', { r: 255, g: 138, b: 61 }),
    spark: token('--ultra-spark', { r: 255, g: 211, b: 107 }),
    core: token('--ultra-core', { r: 255, g: 251, b: 234 }),
    additive: dark
  }
}

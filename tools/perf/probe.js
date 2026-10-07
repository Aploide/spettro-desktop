// The benchmark's in-page probe. bench.cjs installs it with
// Page.addScriptToEvaluateOnNewDocument and reloads, so it runs before any of
// the app's own scripts (after preload, so window.spettro is there). It
// counts what the page does and lends the benchmark a few helpers; it never
// changes what the app does.
//
//  - requestAnimationFrame calls the APP makes (wrapped; the probe's own
//    frame recorder uses the original and is not counted)
//  - React commits, and the components each one rendered, through the
//    DevTools global hook React looks for at startup (production React
//    reports commits to it too)
//  - main → renderer IPC events (a second listener on window.spettro.onEvent)
//    and renderer → main calls (window.spettro.call, when it can be wrapped)
//  - long tasks, long animation frames, and Event Timing entries ≥16 ms
//  - per-input latency: an input event's timestamp to the end of the first
//    frame after it (rAF, then a message posted from inside it)
//  - a frame recorder (rAF timestamps) the benchmark switches on only while
//    it measures an interaction — never while measuring idle
//  - settle(): resolves once the DOM has stopped changing
//
// Kept dependency-free and small: it ships in no bundle.

;(() => {
  if (window.__perf) return
  const now = () => performance.now()
  const origRAF = window.requestAnimationFrame.bind(window)

  const P = {
    rafCalls: 0,
    commits: 0,
    fibers: 0,
    commitTimes: [],
    components: new Map(),
    trackComponents: false,
    ipc: [],
    invokes: [],
    invokeWrapped: false,
    longtasks: [],
    loafs: [],
    events: [],
    inputs: [],
    trackInputs: false,
    frames: null,
    errors: []
  }
  window.__perf = P

  // ---------------------------------------------------------------- rAF
  window.requestAnimationFrame = function (cb) {
    P.rafCalls++
    return origRAF(cb)
  }

  // -------------------------------------------------------------- React
  // React 18 reads this once, when react-dom loads: present before then, it
  // gets inject() and, per commit, onCommitFiberRoot(id, root). A fiber that
  // ran its render this commit carries PerformedWork (flag 1), and the flag
  // bubbles into subtreeFlags only along subtrees that were worked on, so
  // the walk below visits only those.
  const PERFORMED = 1
  function nameOf(fiber) {
    const t = fiber.type
    if (!t || typeof t === 'string') return null
    return t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || (t.type && (t.type.displayName || t.type.name)) || 'anonymous'
  }
  function walk(root) {
    let n = 0
    const stack = [root]
    while (stack.length) {
      const f = stack.pop()
      if (f.flags & PERFORMED) {
        n++
        if (P.trackComponents) {
          const name = nameOf(f)
          if (name) P.components.set(name, (P.components.get(name) || 0) + 1)
        }
      }
      for (let c = f.child; c; c = c.sibling) {
        if ((c.flags | c.subtreeFlags) & PERFORMED) stack.push(c)
      }
    }
    return n
  }
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    isDisabled: false,
    supportsFiber: true,
    renderers: new Map(),
    inject(renderer) {
      this.renderers.set(1, renderer)
      return 1
    },
    onScheduleFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      P.commits++
      P.commitTimes.push(now())
      try {
        P.fibers += walk(root.current)
      } catch (e) {
        if (P.errors.length < 5) P.errors.push(String(e))
      }
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {}
  }

  // ---------------------------------------------------------------- IPC
  try {
    window.spettro.onEvent((e) => P.ipc.push({ t: now(), e }))
  } catch (e) {
    P.errors.push('onEvent: ' + e)
  }
  try {
    const orig = window.spettro.call
    const wrapped = function (method, ...args) {
      P.invokes.push({ t: now(), method, arg: typeof args[1] === 'string' ? args[1] : undefined })
      return orig.call(this, method, ...args)
    }
    try {
      window.spettro.call = wrapped
    } catch {}
    if (window.spettro.call !== wrapped) {
      const bridge = { ...window.spettro, call: wrapped }
      try {
        Object.defineProperty(window, 'spettro', { value: bridge, configurable: true, writable: true })
      } catch {}
    }
    P.invokeWrapped = window.spettro.call === wrapped
  } catch (e) {
    P.errors.push('call: ' + e)
  }

  // --------------------------------------------------------- observers
  const observe = (type, sink, extra = {}) => {
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) sink(entry)
      }).observe({ type, buffered: true, ...extra })
    } catch (e) {
      P.errors.push(type + ': ' + e)
    }
  }
  observe('longtask', (e) => P.longtasks.push({ start: e.startTime, duration: e.duration }))
  observe('long-animation-frame', (e) =>
    P.loafs.push({
      start: e.startTime,
      duration: e.duration,
      blocking: e.blockingDuration,
      render: e.renderStart ? e.startTime + e.duration - e.renderStart : 0,
      style: e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0,
      scripts: (e.scripts || []).slice(0, 4).map((s) => ({
        invoker: s.invoker,
        duration: Math.round(s.duration),
        fn: s.sourceFunctionName,
        src: (s.sourceURL || '').split('/').pop() + ':' + s.sourceCharPosition
      }))
    })
  )
  observe('event', (e) => P.events.push({ name: e.name, start: e.startTime, duration: e.duration, processing: e.processingEnd - e.processingStart, delay: e.processingStart - e.startTime }), { durationThreshold: 16 })

  // ------------------------------------------------------ input latency
  const channel = new MessageChannel()
  const afterFrame = []
  channel.port1.onmessage = () => {
    const t = now()
    const list = afterFrame.splice(0)
    for (const rec of list) rec.done = t
  }
  let pendingFrame = null
  function trackInput(e) {
    if (!P.trackInputs) return
    const rec = { type: e.type, ts: e.timeStamp, handled: now(), frame: 0, done: 0 }
    P.inputs.push(rec)
    // One frame request per frame, shared by every input waiting on it.
    if (!pendingFrame) {
      pendingFrame = []
      origRAF((t) => {
        const waiting = pendingFrame
        pendingFrame = null
        for (const r of waiting) r.frame = t
        afterFrame.push(...waiting)
        channel.port2.postMessage(0)
      })
    }
    pendingFrame.push(rec)
  }
  for (const type of ['keydown', 'pointermove', 'pointerdown', 'pointerup', 'wheel', 'click']) {
    window.addEventListener(type, trackInput, { capture: true, passive: true })
  }

  // ---------------------------------------------------- frame recorder
  P.startFrames = () => {
    const rec = { times: [], running: true }
    P.frames = rec
    const tick = (t) => {
      if (!rec.running) return
      rec.times.push(t)
      origRAF(tick)
    }
    origRAF(tick)
  }
  P.stopFrames = () => {
    const rec = P.frames
    if (!rec) return []
    rec.running = false
    P.frames = null
    return rec.times
  }

  // ----------------------------------------------------- thumb tracking
  // Where the slider's thumb is drawn each frame, beside where the pointer
  // is: the gap is the lag a hand feels while dragging, whatever the frame
  // rate says.
  P.startThumb = () => {
    const rec = { samples: [], x: null, running: true, thumb: null }
    const onMove = (e) => {
      rec.x = e.clientX
    }
    window.addEventListener('pointermove', onMove, { capture: true, passive: true })
    window.addEventListener('pointerdown', onMove, { capture: true, passive: true })
    const tick = () => {
      if (!rec.running) {
        window.removeEventListener('pointermove', onMove, { capture: true })
        window.removeEventListener('pointerdown', onMove, { capture: true })
        return
      }
      // Looked up again only when the slider re-mounts: a selector query
      // per frame over the whole transcript's DOM is a cost of its own.
      if (!rec.thumb || !rec.thumb.isConnected) rec.thumb = document.querySelector('.thinking-popover .thinking-thumb')
      const thumb = rec.thumb
      if (thumb && rec.x !== null) {
        const r = thumb.getBoundingClientRect()
        rec.samples.push([Math.round(now()), Math.round(rec.x * 10) / 10, Math.round((r.left + r.width / 2) * 10) / 10])
      }
      origRAF(tick)
    }
    origRAF(tick)
    P.thumb = rec
  }
  P.stopThumb = () => {
    const rec = P.thumb
    if (!rec) return []
    rec.running = false
    P.thumb = null
    return rec.samples
  }

  // ------------------------------------------------------------ helpers
  P.reset = () => {
    P.rafCalls = 0
    P.commits = 0
    P.fibers = 0
    P.commitTimes = []
    P.components = new Map()
    P.ipc = []
    P.invokes = []
    P.longtasks = []
    P.loafs = []
    P.events = []
    P.inputs = []
    return now()
  }

  /** Counts and sizes of the IPC events since reset, by type. Sized here,
   *  after the fact, so measuring them never costs the frames measured. */
  P.ipcSummary = () => {
    const byType = {}
    let bytes = 0
    for (const { e } of P.ipc) {
      let size = 0
      try {
        size = JSON.stringify(e).length
      } catch {}
      bytes += size
      const k = e.type
      const b = byType[k] || (byType[k] = { count: 0, bytes: 0, max: 0 })
      b.count++
      b.bytes += size
      if (size > b.max) b.max = size
    }
    return { count: P.ipc.length, bytes, byType }
  }

  /** The CSS animations and transitions running now, by name and element. */
  P.animations = () =>
    document.getAnimations().filter((a) => a.playState === 'running').map((a) => {
      const el = a.effect && a.effect.target
      const cls = el && el.className && typeof el.className === 'string' ? el.className.split(' ').slice(0, 2).join('.') : el ? el.tagName : '?'
      const timing = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : {}
      return {
        kind: a.constructor.name,
        name: a.animationName || a.transitionProperty || a.id || '',
        target: cls,
        iterations: timing.iterations === Infinity ? 'infinite' : timing.iterations
      }
    })

  /** Resolves when nothing in the DOM has changed for `quietMs` (or after
   *  `timeoutMs`), with when the last change happened and the first frame
   *  after it. */
  P.settle = (quietMs = 250, timeoutMs = 8000) =>
    new Promise((resolve) => {
      const start = now()
      let last = start
      let mutations = 0
      // The frame after the latest change: a rAF requested from the
      // observer runs in the frame that renders it.
      let settled = start
      let first = null
      let firstFrame = null
      let framePending = false
      const mo = new MutationObserver((records) => {
        // A lit phrase's drift (glowDrift.ts) is a running decoration, like
        // a CSS animation: its steps are style writes, and counting them a
        // chat holding one never settled (15 s timeouts on switching).
        const list = records.filter(
          (m) => !(m.type === 'attributes' && m.attributeName === 'style' && m.target.classList && m.target.classList.contains('glow'))
        )
        if (list.length === 0) return
        mutations += list.length
        last = now()
        if (first === null) first = last
        if (!framePending) {
          framePending = true
          origRAF(() => {
            framePending = false
            settled = now()
            if (firstFrame === null) firstFrame = settled
          })
        }
      })
      mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
      const check = () => {
        const t = now()
        if (t - last >= quietMs || t - start >= timeoutMs) {
          mo.disconnect()
          // The frame that shows the last change.
          origRAF((frame) => {
            channel.port2.postMessage(0)
            resolve({ start, firstMutation: first, firstFrame, lastMutation: last, settled: mutations ? settled : frame, frame, mutations, timedOut: t - start >= timeoutMs })
          })
          return
        }
        setTimeout(check, 30)
      }
      setTimeout(check, 30)
    })

  /** Waits for a selector to match, then for the frame that shows it. */
  P.waitFor = (selector, timeoutMs = 5000) =>
    new Promise((resolve) => {
      const start = now()
      // Polled once per frame, so the frame it is found in is the frame
      // that draws it.
      const poll = () => {
        const el = document.querySelector(selector)
        if (el) return resolve({ found: now(), frame: now() })
        if (now() - start > timeoutMs) return resolve(null)
        origRAF(poll)
      }
      poll()
    })
})()

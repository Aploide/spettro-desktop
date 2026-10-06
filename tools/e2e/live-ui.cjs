// Drives the LIVE app — the real window, against a real spettro — through a
// scenario over the DevTools port, screenshotting each step.
//
// cdp-shot.cjs takes one picture; a scenario needs to wait for things (the
// palette to fill, a permission card to arrive, a turn to end) and to type the
// way a user does. This does both, through the stable `data-testid`s the
// views carry (new-session, composer-input, send, model-button,
// session-settings, settings-button, permission-allow-once,
// question-option-<id>, sidebar-row-<chatId>, …), so a restyle doesn't break
// it. Text goes in with Input.insertText and keys with Input.dispatchKeyEvent:
// real input events, not a value poked into React.
//
//   node tools/e2e/live-ui.cjs <port> <out-dir> <scenario> [prompt]
//
// Usually started by live-ui.sh, which launches the app first. Shots land in
// <out-dir>/NN-<name>.png. `node tools/e2e/live-ui.cjs --list` lists the
// scenarios; the ones marked "paid" send prompts to the user's real model.

const fs = require('node:fs')
const path = require('node:path')

// ---------------------------------------------------------------- the pipe

async function connect(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target: ' + JSON.stringify(list))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  await new Promise((r) => (ws.onopen = r))
  const send = (method, params = {}, ms = 15000) =>
    Promise.race([
      new Promise((r) => {
        const i = ++id
        pending.set(i, r)
        ws.send(JSON.stringify({ id: i, method, params }))
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${method}`)), ms))
    ])
  // An unfocused window never focuses its inputs; the composer's menus only
  // open while it has focus.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  return { ws, send }
}

// ------------------------------------------------------------ the driver

function driver(cdp, outDir) {
  let n = 0
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  async function evaluate(expression) {
    const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (res.result?.exceptionDetails) {
      throw new Error(res.result.exceptionDetails.exception?.description || res.result.exceptionDetails.text)
    }
    return res.result?.result?.value
  }

  const sel = (testid) => `document.querySelector('[data-testid="${testid}"]')`

  const d = {
    sleep,
    evaluate,
    /** Screenshot as NN-<name>.png. */
    async shot(name) {
      n += 1
      const file = path.join(outDir, `${String(n).padStart(2, '0')}-${name}.png`)
      // A window another one covers stops producing frames, and the capture
      // then never answers: raise it and ask again.
      const res = await cdp
        .send('Page.captureScreenshot', { format: 'png' }, 8000)
        .catch(async () => {
          await cdp.send('Page.bringToFront')
          await sleep(500)
          return cdp.send('Page.captureScreenshot', { format: 'png' })
        })
      fs.writeFileSync(file, Buffer.from(res.result.data, 'base64'))
      console.log(`  shot ${file}`)
      return file
    },
    /** Waits until `expression` is truthy in the page; returns its value. */
    async until(what, expression, ms = 20000) {
      const start = Date.now()
      for (;;) {
        const value = await evaluate(expression).catch(() => null)
        if (value) return value
        if (Date.now() - start > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
        await sleep(150)
      }
    },
    async exists(testid) {
      return evaluate(`!!${sel(testid)}`)
    },
    async click(testid) {
      await d.until(testid, `!!${sel(testid)}`)
      await evaluate(`${sel(testid)}.click()`)
      await sleep(250)
    },
    /** Clicks the first button whose text is exactly `label`. */
    async clickText(label, scope = 'document') {
      const ok = await evaluate(
        `(() => { const b = [...${scope}.querySelectorAll('button, [role=menuitem], [role=radio], [role=tab]')]
           .find((e) => e.textContent.trim() === ${JSON.stringify(label)}); if (b) b.click(); return !!b })()`
      )
      if (!ok) throw new Error(`no button "${label}"`)
      await sleep(250)
    },
    async focus(testid) {
      await d.until(testid, `!!${sel(testid)}`)
      await evaluate(`${sel(testid)}.focus()`)
    },
    /** Types into the focused element as keystrokes would. */
    async type(text) {
      await cdp.send('Input.insertText', { text })
      await sleep(150)
    },
    async key(key, modifiers = 0) {
      const codes = { Enter: 13, Escape: 27, Tab: 9, ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, End: 35, Home: 36 }
      const vk = codes[key] ?? key.toUpperCase().charCodeAt(0)
      const base = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: vk, modifiers }
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, text: key === 'Enter' ? '\r' : undefined })
      if (key.length === 1 && modifiers === 0) await cdp.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: key })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
      await sleep(200)
    },
    /** Composer: focus, type, and send with Enter. */
    async say(text) {
      await d.focus('composer-input')
      await d.type(text)
      await d.key('Enter')
    },
    /** The selected chat's turn has ended (no Stop button, nothing running). */
    async idle(ms = 180000) {
      await d.until('the turn to end', `!${sel('stop')}`, ms)
      await sleep(500)
    },
    async appearance(mode) {
      await evaluate(`window.spettro.call('setAppearance', ${JSON.stringify(mode)})`)
      await sleep(600)
    }
  }
  return d
}

// -------------------------------------------------------------- scenarios
//
// Each takes the driver and the optional prompt argument. They assume the
// state the one before left (live-ui.sh runs them against one profile), but
// each starts from the new-session view where it can.

const newSession = async (d) => {
  await d.click('new-session')
  await d.until('the new-session view', `!!document.querySelector('.new-session')`)
}

const SCENARIOS = {
  /** No tokens, first run: the install step (no CLI found). Captured, never run. */
  async setup(d) {
    await d.until('the install step', `/Install Spettro/.test(document.body.innerText)`)
    await d.shot('setup-install')
    await d.clickText('Advanced').catch(() => {})
    await d.shot('setup-install-advanced')
  },

  /** No tokens, clean HOME with a CLI: the connect step, then everything
   *  that works without a model. */
  async free(d) {
    if (await d.evaluate(`/Connect a model|Sign in to Spettro/.test(document.body.innerText) && !document.querySelector('.new-session')`)) {
      await d.shot('gate')
      await d.clickText('Continue without a model')
    }
    await d.until('the new-session view', `!!document.querySelector('.new-session')`)
    await d.shot('empty-state')
    await d.click('project-chip')
    await d.shot('project-menu')
    await d.key('Escape')

    await d.say('/help')
    await d.until('a chat', `!!document.querySelector('.chat-header')`)
    await d.idle()
    await d.shot('help')

    await d.focus('composer-input')
    await d.type('/')
    await d.until('the slash palette', `!!document.querySelector('.slash-menu, [data-testid="slash-menu"], .command-menu')`, 5000).catch(() => {})
    await d.shot('slash-palette')
    await d.key('Escape')
    await d.evaluate(`(() => { const el = document.querySelector('[data-testid="composer-input"]'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)

    await d.say('/ultra on')
    await d.idle()
    await d.shot('ultra-on-ask-first')
    await d.click('thinking-chip')
    await d.sleep(600)
    await d.shot('ultra-paused-popover')
    await d.key('Escape')
    await d.say('/ultra off')
    await d.idle()

    await d.click('session-settings')
    await d.shot('session-settings')
    await d.key('Escape')
    await d.click('model-button')
    await d.shot('model-menu')
    await d.key('Escape')

    await d.click('settings-button')
    for (const pane of ['general', 'account', 'models', 'permissions', 'memory', 'remote', 'updates', 'advanced', 'shortcuts', 'about']) {
      await d.click(`settings-pane-${pane}`)
      await d.sleep(400)
      await d.shot(`settings-${pane}`)
    }
    await d.key('Escape')
    await d.sleep(300)

    await d.appearance('light')
    await d.shot('theme-light')
    await d.appearance('dark')
    await d.shot('theme-dark')
    await d.appearance('system')

    await d.click('sidebar-toggle')
    await d.shot('sidebar-collapsed')
    await d.click('sidebar-reopen')

    await d.click('terminal-toggle')
    await d.sleep(1200)
    await d.shot('terminal')
    await d.click('terminal-toggle')
  },

  /** Paid: one sentence back. The working state, the answer, the usage ring. */
  async hello(d, prompt = 'Say hello in one sentence.') {
    await newSession(d)
    await d.say(prompt)
    await d.until('the turn to start', `!!document.querySelector('[data-testid="stop"]')`, 15000)
    await d.sleep(800)
    await d.shot('hello-working')
    await d.idle()
    await d.shot('hello-answer')
  },

  /** Paid, Ask first: a command waits for approval inline; Allow once. Then
   *  an edit's diff preview, denied with a note. */
  async permission(d) {
    // Shared with every session (and the TUI): put it back afterwards.
    await d.evaluate(`window.spettro.call('setDefaultOption', 'permission', 'ask-first')`)
    await newSession(d)
    // Not `ls`: read-only commands never ask, even under Ask first
    // (isAlwaysAllowedCommand in the CLI).
    await d.say('Run the shell command `mkdir -p build` in this folder, then tell me what is in the folder.')
    await d.until('the approval card', `!!document.querySelector('[data-testid="permission-card"]')`, 120000)
    await d.sleep(800)
    await d.shot('permission-command')
    await d.until('the card to arm', `!!document.querySelector('[data-testid="permission-allow-once"]:not([disabled])')`, 5000)
    await d.sleep(700)
    await d.click('permission-allow-once')
    await d.idle()
    await d.shot('permission-allowed')

    await d.say('Create a file hello.txt containing the word hi.')
    await d.until('the approval card', `!!document.querySelector('[data-testid="permission-card"]')`, 120000)
    await d.sleep(800)
    await d.shot('permission-edit')
    await d.sleep(700)
    await d.click('permission-deny')
    await d.sleep(500)
    await d.shot('permission-denied')
    if (await d.exists('deny-feedback')) {
      await d.focus('deny-feedback')
      await d.type('use notes.txt instead')
      await d.key('Enter')
    }
    await d.sleep(1500)
    await d.until('the next approval or the end', `!!document.querySelector('[data-testid="permission-card"]') || !document.querySelector('[data-testid="stop"]')`, 120000)
    await d.shot('permission-after-feedback')
    if (await d.exists('permission-allow-once')) {
      await d.sleep(700)
      await d.click('permission-allow-once')
    }
    await d.idle()
    await d.shot('permission-done')
  },

  /** Paid: a long task, a message sent mid-run (Queued, then Delivered),
   *  then Esc to interrupt. */
  async steering(d) {
    await newSession(d)
    await d.say('List every file in this folder and summarise each one in a sentence.')
    await d.until('the turn to start', `!!document.querySelector('[data-testid="stop"]')`, 15000)
    await d.sleep(2500)
    await d.say('Also count them.')
    await d.sleep(600)
    await d.shot('steering-sent')
    await d.until('Queued or Delivered', `/Queued|Delivered/.test(document.body.innerText)`, 60000).catch(() => {})
    await d.shot('steering-queued')
    await d.until('Delivered', `/Delivered/.test(document.body.innerText)`, 90000).catch(() => {})
    await d.shot('steering-delivered')
    if (await d.exists('stop')) {
      await d.focus('composer-input')
      await d.key('Escape')
    }
    await d.idle(60000)
    await d.shot('steering-interrupted')
  },

  /** Paid, Restricted + small workflows: an ultracode run, live and settled. */
  async workflow(d, prompt = 'ultracode +100k: review README.md and notes.txt for typos, one agent per file') {
    // Shared settings again: workflows need Restricted (or YOLO), and a small
    // run keeps the bill small.
    await d.evaluate(`window.spettro.call('setDefaultOption', 'permission', 'restricted')`)
    await d.evaluate(`window.spettro.call('setDefaultOption', 'workflow_size', 'small')`)
    await newSession(d)
    await d.say(prompt)
    await d.until('a workflow card', `!!document.querySelector('.wfc')`, 240000)
    await d.sleep(3000)
    await d.shot('workflow-live')
    await d.until('the run to settle', `!document.querySelector('[data-testid="stop"]')`, 900000)
    await d.sleep(1000)
    await d.shot('workflow-settled')
  },

  /** Paid: the agent asks; the inline question card; answer; it goes on. */
  async question(d) {
    await newSession(d)
    await d.say('Before doing anything, ask me which of two filenames to use for a new note: notes.md or todo.md. Then just tell me which one I picked.')
    await d.until('the question card', `!!document.querySelector('[data-testid="question-card"]')`, 120000)
    await d.sleep(800)
    await d.shot('question')
    await d.sleep(600)
    await d.evaluate(`document.querySelector('[data-testid^="question-option-"]:not([data-testid="question-option-other"])').click()`)
    await d.sleep(300)
    if (await d.exists('question-submit')) await d.click('question-submit')
    await d.idle()
    await d.shot('question-answered')
  },

  /** After a relaunch: the newest chat, restored, its palette filled
   *  without a prompt. */
  async reopen(d) {
    await d.until('the sidebar', `!!document.querySelector('[data-testid^="sidebar-row-"]')`)
    await d.evaluate(`document.querySelector('[data-testid^="sidebar-row-"] .chat-row-open').click()`)
    await d.until('a chat', `!!document.querySelector('.chat-header')`)
    await d.sleep(1500)
    await d.shot('reopened')
    await d.focus('composer-input')
    await d.type('/')
    await d.sleep(800)
    await d.shot('reopened-palette')
    await d.key('Escape')
  },

  /** Delete with Undo, then archive. */
  async manage(d) {
    const rows = await d.evaluate(`[...document.querySelectorAll('[data-testid^="sidebar-row-"]')].map((e) => e.dataset.testid)`)
    if (!rows || rows.length < 2) throw new Error('needs two chats in the sidebar')
    const row = (id) => `document.querySelector('[data-testid="${id}"]')`
    await d.evaluate(`${row(rows[0])}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 140 }))`)
    await d.sleep(300)
    await d.shot('row-menu')
    await d.clickText('Delete…')
    await d.shot('confirm-delete')
    await d.click('confirm-ok')
    await d.sleep(300)
    await d.shot('deleted-undo')
    await d.clickText('Undo')
    await d.sleep(300)
    await d.shot('undone')
    await d.evaluate(`${row(rows[1])}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 180 }))`)
    await d.sleep(300)
    await d.clickText('Archive')
    await d.sleep(400)
    await d.shot('archived')
  }
}

const PAID = new Set(['hello', 'permission', 'steering', 'workflow', 'question'])

// ------------------------------------------------------------------- main

;(async () => {
  const [port, outDir, scenario, prompt] = process.argv.slice(2)
  if (port === '--list' || !scenario || !SCENARIOS[scenario]) {
    for (const name of Object.keys(SCENARIOS)) console.log(`${name}${PAID.has(name) ? '  (paid)' : ''}`)
    process.exit(port === '--list' ? 0 : 2)
  }
  fs.mkdirSync(outDir, { recursive: true })
  const cdp = await connect(port)
  const d = driver(cdp, outDir)
  console.log(`scenario ${scenario}`)
  try {
    await SCENARIOS[scenario](d, prompt)
  } catch (err) {
    console.error(`FAILED: ${err.message}`)
    await d.shot(`${scenario}-failure`).catch(() => {})
    cdp.ws.close()
    process.exit(1)
  }
  cdp.ws.close()
  process.exit(0)
})().catch((err) => {
  console.error(err)
  process.exit(1)
})

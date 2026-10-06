// Screenshots the LIVE app — the real window, against a real spettro — over
// the Chrome DevTools protocol.
//
// The offscreen harness (capture.cjs) renders fixtures; this is for checking
// the same screens against an actual agent. X11 tools (`import`, xdotool)
// can't see a native Wayland client, but the renderer's debug port can always
// be asked for a frame. Start the app with a debug port first:
//
//   npx electron-vite dev --outDir /tmp/sd-live/out --remoteDebuggingPort 9333 \
//       -- --user-data-dir=/tmp/sd-live/userdata
//
//   node tools/visual/cdp-shot.cjs <port> <out.png> ["<JS to evaluate first>"]
//
// The optional JS runs in the page before the capture (click a button, open a
// menu); its return value is printed. Uses Node's built-in fetch and
// WebSocket, so it needs no dependencies.

const [port, out, js] = process.argv.slice(2)
if (!port || !out) {
  console.error('usage: node cdp-shot.cjs <port> <out.png> ["<js>"]')
  process.exit(2)
}

;(async () => {
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
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id
      pending.set(i, r)
      ws.send(JSON.stringify({ id: i, method, params }))
    })

  if (js) {
    const res = await send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true })
    console.log(JSON.stringify(res.result?.result?.value))
  }
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  require('fs').writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
  console.log(out, page.title, page.url)
  ws.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})

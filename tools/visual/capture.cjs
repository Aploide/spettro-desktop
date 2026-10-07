// Screenshots the visual harness with Electron's offscreen renderer.
//
// Offscreen is not an optimisation here, it is the only thing that works:
// under a Wayland session an invisible BrowserWindow has no surface for the
// compositor to paint, and capturePage() on one simply never resolves.
// Offscreen rendering paints into memory with no compositor involved, so this
// runs the same headless in CI as it does on a desktop.
//
//   node_modules/electron/dist/electron --no-sandbox tools/visual/capture.cjs \
//       <dist-dir> <out-dir> [scene]

const { app, BrowserWindow, nativeTheme } = require('electron')
const fs = require('fs')
const path = require('path')

const argv = process.argv.slice(process.argv.findIndex((a) => a.endsWith('capture.cjs')) + 1)
const DIST = path.resolve(argv[0] || '.visual-dist')
const OUT = path.resolve(argv[1] || 'shots')
const SCENE = argv[2] || ''

const WIDTH = 1280
// Tall enough that every scene lands in one frame; the page is short enough
// that a fixed height beats scroll-stitching.
const HEIGHT = Number(process.env.SHOT_HEIGHT || 5200)
// The app scenes are the window itself, so they are shot at the real
// window's default size rather than as a tall page.
const APP_HEIGHT = Number(process.env.SHOT_APP_HEIGHT || 840)
// The accent every page is shot in (lilac | mono; accentPrelude.ts reads it
// from the URL). Unset leaves the page in the default, and the file names as
// they always were; set, the accent goes into the name too
// (app-chat-mono-dark.png), so one output folder can hold both.
const ACCENT = process.env.SHOT_ACCENT || ''

// Destroying a shot's window leaves zero windows open, and Electron's default
// window-all-closed handler quits the app on Linux and Windows. That ended the
// process after the first theme — no error, exit code 0, half the screenshots,
// and nothing to suggest anything had gone wrong. The lifetime here is the
// loop's, not the window's.
app.on('window-all-closed', () => {})

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
// SHOT_SCALE renders at a higher pixel density, for looking closely at
// something small (the thinking slider's meteor is a few pixels tall).
const SCALE = Number(process.env.SHOT_SCALE || 1)
app.commandLine.appendSwitch('force-device-scale-factor', String(SCALE))

/**
 * Loads a page and waits for it to actually finish.
 *
 * `loadURL`'s promise is not a reliable signal here. Flipping
 * nativeTheme.themeSource between shots makes Chromium re-evaluate the page,
 * which aborts the load in flight — so the promise rejects with ERR_FAILED
 * (-2) for a page that then loads perfectly well a moment later. Taking that
 * rejection at face value cost every second theme its screenshot, silently:
 * the run still produced files, just half as many as it claimed to.
 *
 * So the finished-loading event is the authority and the promise is only
 * consulted for a failure the event never contradicts.
 */
/** Sets the rendered viewport to an arbitrary height, past what a window can
 *  be. Best-effort: if the debugger is unavailable the shot is still taken,
 *  just clipped to the window, which is what happened before this existed. */
async function resizeViewport(win, height) {
  const contents = win.webContents
  try {
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
    await contents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height,
      deviceScaleFactor: SCALE,
      mobile: false
    })
    // One frame for the new metrics to be laid out and painted.
    await new Promise((r) => setTimeout(r, 250))
  } catch (err) {
    console.warn(`viewport override unavailable (${err.message}); shot may be clipped`)
  }
}

function load(win, url) {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
    }
    win.webContents.once('did-finish-load', done)
    win.loadURL(url).then(done, (err) => {
      // Give the event a moment to arrive before believing the rejection.
      setTimeout(() => {
        if (settled) return
        settled = true
        reject(err)
      }, 500)
    })
  })
}

async function shoot(theme) {
  nativeTheme.themeSource = theme
  // A scene id prefixed "studio", "chrome" or "app" targets that harness page
  // instead of the scene gallery; anything after a colon is its mode.
  const studio = SCENE.startsWith('studio')
  const chrome = SCENE.startsWith('chrome')
  const appScene = SCENE.startsWith('app')
  const height = appScene ? APP_HEIGHT : HEIGHT
  const win = new BrowserWindow({
    width: WIDTH,
    height,
    show: false,
    useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false }
  })
  const page = studio ? 'studio.html' : chrome ? 'chrome.html' : appScene ? 'app.html' : 'index.html'
  const query = studio || chrome || appScene
    ? SCENE.includes(':')
      ? `?mode=${SCENE.split(':')[1]}`
      : ''
    : SCENE
      ? `?scene=${SCENE}`
      : ''
  const accentQuery = ACCENT ? `${query ? '&' : '?'}accent=${ACCENT}` : ''
  const url = `file://${path.join(DIST, page)}${query}${accentQuery}`
  await load(win, url)
  // An offscreen window never has the focus, so a page in it never sees a
  // focus event: the composer's menus (slash commands, @-files), which open
  // only while the field is focused, could not be photographed at all. The
  // app's scenes run with the page told it is focused, as it is on a desk.
  // (Turned on once the page has loaded: before that there is no page for
  // the command to reach, and it never answers. The scenes that type wait
  // for it.)
  if (appScene) {
    try {
      if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    } catch (err) {
      console.warn(`focus emulation unavailable (${err.message})`)
    }
  }
  // One rAF is not enough: fonts and the CSS transitions on the cards settle
  // a frame or two later, and a screenshot taken before they do is a lie.
  await new Promise((r) => setTimeout(r, Number(process.env.SHOT_WAIT || 1200)))
  const full = await win.webContents.executeJavaScript(
    'document.documentElement.scrollHeight'
  )
  // A BrowserWindow cannot be taller than the display, even offscreen, so a
  // long scene used to lose its tail to whatever monitor happened to be
  // attached — and the CI runner's virtual display is a different height
  // again, which would have made the artifacts silently inconsistent with the
  // ones taken locally. Overriding the device metrics through the debugger
  // sets the viewport directly and is bounded by nothing.
  // The app fills its window by design (height: 100%), so its scroll height
  // is the window's: it keeps the window size rather than growing a page.
  await resizeViewport(win, appScene ? height : Math.max(full, height))
  const image = await win.webContents.capturePage()
  fs.mkdirSync(OUT, { recursive: true })
  // A scene id can carry a mode after a colon ("studio:broken"), and a colon
  // is not a legal character in a GitHub artifact path — nor in a Windows
  // filename. Sanitised here rather than at the call site so no caller has to
  // remember.
  const slug = (SCENE || 'all').replace(/[^a-zA-Z0-9._-]+/g, '-')
  const file = path.join(OUT, `${slug}${ACCENT ? `-${ACCENT}` : ''}-${theme}.png`)
  fs.writeFileSync(file, image.toPNG())
  console.log(`${file}  ${JSON.stringify(image.getSize())}  page=${full}px`)
  win.destroy()
}

app.whenReady().then(async () => {
  try {
    for (const theme of (process.env.SHOT_THEMES || 'dark,light').split(',')) {
      await shoot(theme)
    }
    app.exit(0)
  } catch (err) {
    console.error(err)
    app.exit(1)
  }
})

setTimeout(() => {
  console.error('capture timed out')
  app.exit(3)
}, 120000)

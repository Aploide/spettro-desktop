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

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('force-device-scale-factor', '1')

async function shoot(theme) {
  nativeTheme.themeSource = theme
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false }
  })
  // A scene id prefixed "studio" targets the studio harness page instead of
  // the scene gallery; anything after a colon is its mode.
  const studio = SCENE.startsWith('studio')
  const page = studio ? 'studio.html' : 'index.html'
  const query = studio
    ? SCENE.includes(':')
      ? `?mode=${SCENE.split(':')[1]}`
      : ''
    : SCENE
      ? `?scene=${SCENE}`
      : ''
  const url = `file://${path.join(DIST, page)}${query}`
  await win.loadURL(url)
  // One rAF is not enough: fonts and the CSS transitions on the cards settle
  // a frame or two later, and a screenshot taken before they do is a lie.
  await new Promise((r) => setTimeout(r, Number(process.env.SHOT_WAIT || 1200)))
  const full = await win.webContents.executeJavaScript(
    'document.documentElement.scrollHeight'
  )
  if (full > HEIGHT) console.warn(`page is ${full}px, frame is ${HEIGHT}px — tail cut off`)
  const image = await win.webContents.capturePage()
  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `${SCENE || 'all'}-${theme}.png`)
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

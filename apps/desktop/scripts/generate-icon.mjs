// Regenerates the Mac app icon from the canonical brand mark. Run with:
//
//   npm run icon        (from apps/desktop; wraps `electron scripts/generate-icon.mjs`)
//
// Source of truth is assets/brand/contextcake-app-icon.svg at the repo root —
// the same file the site and console favicons mirror — so the Dock/Finder icon
// can never drift from the brand again. Renders the SVG offscreen through
// Electron's own Chromium (no extra dependencies), then packs:
//
//   build/icon.icns             all macOS sizes (16 → 1024, PNG-typed entries)
//   build/icon-master-1024.png  rendered master, kept for marketing/store use
//
// ICNS is written directly (magic + typed PNG chunks) — no iconutil, so this
// runs on any platform, not just macOS.
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SVG_SOURCE = path.resolve(HERE, '../../../assets/brand/contextcake-app-icon.svg')
const BUILD_DIR = path.resolve(HERE, '../build')

// PNG-payload ICNS types (accepted since macOS 10.7): non-retina 16/32/64,
// then 128..1024 with the retina aliases pointing at the same rasters.
const ICNS_TYPES = [
  { type: 'icp4', size: 16 },
  { type: 'icp5', size: 32 },
  { type: 'icp6', size: 64 },
  { type: 'ic07', size: 128 },
  { type: 'ic11', size: 32 },   // 16pt @2x
  { type: 'ic12', size: 64 },   // 32pt @2x
  { type: 'ic08', size: 256 },
  { type: 'ic13', size: 256 },  // 128pt @2x
  { type: 'ic09', size: 512 },
  { type: 'ic14', size: 512 },  // 256pt @2x
  { type: 'ic10', size: 1024 }, // 512pt @2x
]

// The build box has no GPU or sandbox helpers; neither affects raster output.
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu')

async function renderMaster() {
  const svg = fs.readFileSync(SVG_SOURCE, 'utf8')
  const html = `<!doctype html><style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;width:1024px;height:1024px}</style>${svg}`
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    useContentSize: true,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  })
  try {
    await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`)
    // One paint past load so fonts/filters settle before capture.
    await new Promise((resolve) => setTimeout(resolve, 250))
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
    return image
  } finally {
    win.destroy()
  }
}

// capturePage returns pixels at the display's scale factor — normalize every
// target size from the one master capture so output is deterministic on
// retina and non-retina machines alike.
function rasterAt(master, size) {
  const current = master.getSize()
  if (current.width === size && current.height === size) return master.toPNG()
  return master.resize({ width: size, height: size, quality: 'best' }).toPNG()
}

function packIcns(entries) {
  const chunks = entries.map(({ type, png }) => {
    const header = Buffer.alloc(8)
    header.write(type, 0, 'ascii')
    header.writeUInt32BE(8 + png.length, 4)
    return Buffer.concat([header, png])
  })
  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(8 + body.length, 4)
  return Buffer.concat([head, body])
}

app.whenReady().then(async () => {
  try {
    const master = await renderMaster()
    const { width } = master.getSize()
    if (width < 1024) throw new Error(`master capture came back ${width}px — expected >= 1024`)

    fs.mkdirSync(BUILD_DIR, { recursive: true })
    fs.writeFileSync(path.join(BUILD_DIR, 'icon-master-1024.png'), rasterAt(master, 1024))

    const rasters = new Map()
    for (const { size } of ICNS_TYPES) {
      if (!rasters.has(size)) rasters.set(size, rasterAt(master, size))
    }
    const icns = packIcns(ICNS_TYPES.map(({ type, size }) => ({ type, png: rasters.get(size) })))
    fs.writeFileSync(path.join(BUILD_DIR, 'icon.icns'), icns)

    console.log(`icon: rendered ${SVG_SOURCE}`)
    console.log(`icon: wrote build/icon-master-1024.png + build/icon.icns (${icns.length} bytes, ${ICNS_TYPES.length} entries)`)
    app.exit(0)
  } catch (err) {
    console.error(`icon: FAILED — ${err.message}`)
    app.exit(1)
  }
})

import express from 'express'
import multer from 'multer'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.ANKI_PORT || 3456
const DATA_DIR = path.resolve(process.env.ANKI_DATA_DIR || './data')
const META_FILE = path.join(DATA_DIR, 'decks.json')
const DIST_DIR = path.join(__dirname, 'dist')

// Ensure data dir exists
fs.mkdirSync(DATA_DIR, { recursive: true })

// ============ METADATA ============

function readMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, 'utf-8'))
  } catch {
    return []
  }
}

function writeMeta(decks) {
  fs.writeFileSync(META_FILE, JSON.stringify(decks, null, 2))
}

// ============ MULTER ============

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, DATA_DIR),
    filename: (req, _file, cb) => {
      const id = req.params.id || randomUUID()
      req.deckId = id
      cb(null, id + '.apkg')
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
})

// ============ APP ============

const app = express()
app.use(express.json())

// CORS — allow all for dev
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type')
  if (_req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// ============ ROUTES ============

// List all decks
app.get('/api/decks', (_req, res) => {
  const decks = readMeta().map(({ ownerToken, ...rest }) => rest)
  res.json(decks)
})

// Upload new deck
app.post('/api/decks', upload.single('file'), (req, res) => {
  const id = req.deckId
  const name = req.body.name || req.file.originalname.replace('.apkg', '')
  const cardCount = parseInt(req.body.cardCount) || 0
  const ownerToken = randomUUID()

  const decks = readMeta()
  decks.push({
    id,
    name,
    cardCount,
    ownerToken,
    filename: req.file.originalname,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  writeMeta(decks)

  res.json({ id, name, cardCount, ownerToken })
})

// Get deck file (.apkg)
app.get('/api/decks/:id/file', (req, res) => {
  const filePath = path.join(DATA_DIR, req.params.id + '.apkg')
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' })

  const decks = readMeta()
  const deck = decks.find(d => d.id === req.params.id)
  const filename = deck?.filename || `${req.params.id}.apkg`

  res.setHeader('Content-Type', 'application/octet-stream')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  fs.createReadStream(filePath).pipe(res)
})

// Update deck file (re-upload)
app.put('/api/decks/:id', upload.single('file'), (req, res) => {
  const decks = readMeta()
  const deck = decks.find(d => d.id === req.params.id)
  if (!deck) return res.status(404).json({ error: 'Not found' })

  const token = req.headers['x-owner-token']
  if (deck.ownerToken && (!token || token !== deck.ownerToken)) return res.status(403).json({ error: 'Forbidden' })

  if (req.body.name) deck.name = req.body.name
  if (req.body.cardCount) deck.cardCount = parseInt(req.body.cardCount)
  deck.updatedAt = Date.now()
  writeMeta(decks)

  res.json(deck)
})

// Update deck metadata only
app.patch('/api/decks/:id/meta', (req, res) => {
  const decks = readMeta()
  const deck = decks.find(d => d.id === req.params.id)
  if (!deck) return res.status(404).json({ error: 'Not found' })

  const token = req.headers['x-owner-token']
  if (deck.ownerToken && (!token || token !== deck.ownerToken)) return res.status(403).json({ error: 'Forbidden' })

  if (req.body.name) deck.name = req.body.name
  if (req.body.cardCount != null) deck.cardCount = parseInt(req.body.cardCount)
  deck.updatedAt = Date.now()
  writeMeta(decks)

  res.json(deck)
})

// Serve media file from inside .apkg ZIP
app.get('/api/decks/:id/media/:filename', async (req, res) => {
  const filePath = path.join(DATA_DIR, req.params.id + '.apkg')
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Deck not found' })

  try {
    const { default: JSZip } = await import('jszip')
    const data = fs.readFileSync(filePath)
    const zip = await JSZip.loadAsync(data)

    const filename = req.params.filename

    // Try direct filename first
    let file = zip.file(filename)

    // If not found, look in media mapping (numbered files)
    if (!file) {
      let mediaMapping = null
      const mediaFile = zip.file('media')
      if (mediaFile) {
        try {
          const raw = await mediaFile.async('string')
          mediaMapping = JSON.parse(raw)
        } catch {}
      }
      if (mediaMapping) {
        for (const [num, name] of Object.entries(mediaMapping)) {
          if (name === filename) {
            file = zip.file(num)
            break
          }
        }
      }
    }

    if (!file) return res.status(404).json({ error: 'Media not found' })

    const buf = await file.async('nodebuffer')
    // Detect mime from extension or magic bytes
    const ext = path.extname(filename).toLowerCase()
    const mimes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' }
    res.setHeader('Content-Type', mimes[ext] || 'application/octet-stream')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.send(buf)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Delete deck
app.delete('/api/decks/:id', (req, res) => {
  const decks = readMeta()
  const idx = decks.findIndex(d => d.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: 'Not found' })

  const token = req.headers['x-owner-token']
  if (decks[idx].ownerToken && (!token || token !== decks[idx].ownerToken)) return res.status(403).json({ error: 'Forbidden' })

  decks.splice(idx, 1)
  writeMeta(decks)

  const filePath = path.join(DATA_DIR, req.params.id + '.apkg')
  try { fs.unlinkSync(filePath) } catch {}

  res.json({ ok: true })
})

// ============ SERVE FRONTEND ============

if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR))
  // SPA fallback — but not for /api routes
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) {
      return res.status(404).json({ error: 'Not found' })
    }
    res.sendFile(path.join(DIST_DIR, 'index.html'))
  })
} else {
  // Dev mode — just serve index.html from root for convenience
  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'))
  })
}

// ============ START ============

app.listen(PORT, () => {
  console.log(`[paczka-anki] Backend running on http://localhost:${PORT}`)
  console.log(`[paczka-anki] Data dir: ${DATA_DIR}`)
  if (fs.existsSync(DIST_DIR)) {
    console.log(`[paczka-anki] Serving frontend from: ${DIST_DIR}`)
  } else {
    console.log(`[paczka-anki] No dist/ found — run 'npm run build' first for production, or use 'npm run dev:vite' for dev`)
  }
})

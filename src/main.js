import JSZip from 'jszip'
import { decompress as zstdDecompress } from 'fzstd'

// sql.js loaded dynamically from CDN to avoid WASM bundling issues
async function loadSqlJs() {
  const script = document.createElement('script')
  script.src = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/sql-wasm.js'
  document.head.appendChild(script)
  await new Promise((resolve, reject) => {
    script.onload = resolve
    script.onerror = reject
  })
  return window.initSqlJs
}

/**
 * Parse Anki 2.1.50+ collection.anki21b protobuf format.
 * This is a heuristic parser that extracts note fields from the binary protobuf data.
 * The notes in anki21b contain fields separated by 0x1f, same as SQLite format.
 */
function parseAnki21b(data) {
  const cards = []
  const decoder = new TextDecoder('utf-8', { fatal: false })

  // Look for field separator pattern (0x1f) within strings
  // In protobuf, strings are length-delimited (wire type 2)
  // We scan for sequences that contain 0x1f separator (Anki field separator)
  let i = 0
  while (i < data.length - 4) {
    // Look for potential length-delimited field (wire type 2: tag & 0x07 === 2)
    if ((data[i] & 0x07) === 2) {
      i++
      // Read varint length
      let len = 0
      let shift = 0
      let j = i
      while (j < data.length && (data[j] & 0x80) !== 0) {
        len |= (data[j] & 0x7f) << shift
        shift += 7
        j++
      }
      if (j < data.length) {
        len |= (data[j] & 0x7f) << shift
        j++
      }

      // Reasonable string length containing field separators
      if (len > 2 && len < 100000 && j + len <= data.length) {
        const slice = data.slice(j, j + len)
        // Check if this contains field separator 0x1f
        if (slice.includes(0x1f)) {
          try {
            const text = decoder.decode(slice)
            // Validate it looks like Anki fields (contains separator and printable text)
            if (text.includes('\x1f') && /[a-zA-Z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻ<]/.test(text)) {
              const fields = text.split('\x1f')
              const front = fields[0] || ''
              const back = fields.slice(1).join('<hr/>') || ''
              // Skip dummy/upgrade messages
              if (!front.toLowerCase().includes('please update') && front.trim()) {
                cards.push({ front, back })
              }
            }
          } catch {}
        }
        i = j + len
      } else {
        i++
      }
    } else {
      i++
    }
  }

  return cards
}

const $loading = document.getElementById('loading')
const $error = document.getElementById('error')
const $content = document.getElementById('content')
const $deckName = document.getElementById('deck-name')
const $cardCount = document.getElementById('card-count')
const $cards = document.getElementById('cards')
const $search = document.getElementById('search')

let allCards = []

const LOCAL_DECKS_KEY = 'paczka-anki:local-decks'
const OWNER_TOKENS_KEY = 'paczka-anki:owner-tokens'
const MY_LIBRARY_KEY = 'paczka-anki:my-library'

// ============ OWNER TOKEN HELPERS ============

function getOwnerTokens() {
  try { return JSON.parse(localStorage.getItem(OWNER_TOKENS_KEY) || '{}') } catch { return {} }
}

function saveOwnerToken(deckId, token) {
  const tokens = getOwnerTokens()
  tokens[deckId] = token
  localStorage.setItem(OWNER_TOKENS_KEY, JSON.stringify(tokens))
}

function getOwnerToken(deckId) {
  return getOwnerTokens()[deckId] || null
}

function removeOwnerToken(deckId) {
  const tokens = getOwnerTokens()
  delete tokens[deckId]
  localStorage.setItem(OWNER_TOKENS_KEY, JSON.stringify(tokens))
}

function isOwnDeck(deckId) {
  return !!getOwnerToken(deckId)
}

// Check URL for token param and save it (edit link); also add deck to library
;(function checkUrlToken() {
  const p = new URLSearchParams(window.location.search)
  const deckId = p.get('deck')
  const token = p.get('token')
  if (deckId) {
    addToLibrary(deckId)
    if (token) {
      saveOwnerToken(deckId, token)
      // Clean token from URL (keep deck param)
      const cleanUrl = new URL(window.location)
      cleanUrl.searchParams.delete('token')
      history.replaceState(null, '', cleanUrl)
    }
  }
})()

// ============ BACKEND API HELPERS ============

const API_BASE = '/api'

async function apiGetDecks() {
  try {
    const res = await fetch(`${API_BASE}/decks`)
    if (!res.ok) return []
    return await res.json()
  } catch { return [] }
}

async function apiUploadDeck(apkgBlob, name, cardCount) {
  const form = new FormData()
  form.append('file', apkgBlob, name + '.apkg')
  form.append('name', name)
  form.append('cardCount', String(cardCount))
  const res = await fetch(`${API_BASE}/decks`, { method: 'POST', body: form })
  const data = await res.json()
  // Save owner token and add to library
  if (data.ownerToken) {
    saveOwnerToken(data.id, data.ownerToken)
  }
  addToLibrary(data.id)
  return data
}

async function apiUpdateDeck(id, apkgBlob, name, cardCount) {
  const token = getOwnerToken(id)
  const form = new FormData()
  form.append('file', apkgBlob, name + '.apkg')
  form.append('name', name)
  form.append('cardCount', String(cardCount))
  const res = await fetch(`${API_BASE}/decks/${id}`, {
    method: 'PUT',
    headers: token ? { 'X-Owner-Token': token } : {},
    body: form,
  })
  return await res.json()
}

async function apiDeleteDeck(id) {
  const token = getOwnerToken(id)
  await fetch(`${API_BASE}/decks/${id}`, {
    method: 'DELETE',
    headers: token ? { 'X-Owner-Token': token } : {},
  })
  removeOwnerToken(id)
}

async function apiPatchMeta(id, meta) {
  const token = getOwnerToken(id)
  await fetch(`${API_BASE}/decks/${id}/meta`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Owner-Token': token } : {}) },
    body: JSON.stringify(meta),
  })
}

function apiDeckFileUrl(id) {
  return `${API_BASE}/decks/${id}/file`
}

function showError(msg) {
  $loading.classList.add('hidden')
  $error.classList.remove('hidden')
  $error.textContent = msg
}

function showContent() {
  $loading.classList.add('hidden')
  $content.classList.remove('hidden')
  // Show back button
  const $back = document.getElementById('back-to-menu')
  const backUrl = new URL(window.location)
  backUrl.searchParams.delete('url')
  backUrl.searchParams.delete('deck')
  backUrl.searchParams.delete('mode')
  $back.href = backUrl.toString()
  $back.classList.remove('hidden')
}

function stripHtml(html) {
  const div = document.createElement('div')
  div.innerHTML = html
  return div.textContent || div.innerText || ''
}

function escapeHtmlAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function sanitizeHtml(html) {
  // Remove script tags but keep other HTML for rendering
  return html.replace(/<script[\s\S]*?<\/script>/gi, '')
}

/**
 * Render LaTeX math in a DOM element using KaTeX auto-render.
 * Anki uses \(...\) for inline and \[...\] for display math.
 */
function renderMath(element) {
  if (typeof renderMathInElement === 'undefined') return
  try {
    renderMathInElement(element, {
      delimiters: [
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false },
      ],
      throwOnError: false,
    })
  } catch {}
}

function replaceMediaSrc(html, mediaMap) {
  // Replace src="filename" with blob URLs for images and audio
  return html.replace(/src="([^"]+)"/gi, (match, src) => {
    if (mediaMap[src]) {
      return `src="${mediaMap[src]}"`
    }
    return match
  }).replace(/\[sound:([^\]]+)\]/gi, (match, filename) => {
    // Anki [sound:file.mp3] syntax
    if (mediaMap[filename]) {
      return `<audio controls src="${mediaMap[filename]}" style="max-width:100%;height:32px;"></audio>`
    }
    return `<em>[audio: ${filename}]</em>`
  })
}

/**
 * Parse Anki's new protobuf media mapping file.
 * Structure: repeated message { uint32 index = 1; string filename = 2; bytes sha256 = 3; }
 * We extract pairs of (index, filename).
 */
function parseMediaProtobuf(data) {
  const mapping = {}
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let i = 0

  while (i < data.length) {
    // Read tag
    if (i >= data.length) break
    const tag = data[i]
    const fieldNum = tag >> 3
    const wireType = tag & 0x07
    i++

    if (wireType === 2) {
      // Length-delimited (string, bytes, or embedded message)
      let len = 0
      let shift = 0
      while (i < data.length && (data[i] & 0x80) !== 0) {
        len |= (data[i] & 0x7f) << shift
        shift += 7
        i++
      }
      if (i < data.length) {
        len |= (data[i] & 0x7f) << shift
        i++
      }

      if (fieldNum === 1 && len > 0 && len < 10000 && i + len <= data.length) {
        // This is an embedded MediaEntry message
        const entryData = data.slice(i, i + len)
        const entry = parseMediaEntry(entryData, decoder)
        if (entry && entry.filename) {
          mapping[entry.index] = entry.filename
        }
      }
      i += len
    } else if (wireType === 0) {
      // Varint — skip
      while (i < data.length && (data[i] & 0x80) !== 0) i++
      i++
    } else {
      // Unknown wire type — skip byte
      i++
    }
  }

  return Object.keys(mapping).length > 0 ? mapping : null
}

function parseMediaEntry(data, decoder) {
  let index = null
  let filename = null
  let i = 0

  while (i < data.length) {
    const tag = data[i]
    const fieldNum = tag >> 3
    const wireType = tag & 0x07
    i++

    if (wireType === 0) {
      // Varint
      let val = 0
      let shift = 0
      while (i < data.length && (data[i] & 0x80) !== 0) {
        val |= (data[i] & 0x7f) << shift
        shift += 7
        i++
      }
      if (i < data.length) {
        val |= (data[i] & 0x7f) << shift
        i++
      }
      if (fieldNum === 1) index = val
    } else if (wireType === 2) {
      // Length-delimited
      let len = 0
      let shift = 0
      while (i < data.length && (data[i] & 0x80) !== 0) {
        len |= (data[i] & 0x7f) << shift
        shift += 7
        i++
      }
      if (i < data.length) {
        len |= (data[i] & 0x7f) << shift
        i++
      }
      if (fieldNum === 2 && len > 0 && i + len <= data.length) {
        // filename string
        filename = decoder.decode(data.slice(i, i + len))
      }
      i += len
    } else {
      i++
    }
  }

  return { index: index !== null ? index : null, filename }
}

function renderCards(cards) {
  const fragment = document.createDocumentFragment()
  const limit = Math.min(cards.length, 200)

  for (let i = 0; i < limit; i++) {
    const card = cards[i]
    const el = document.createElement('div')
    el.className = 'card'
    
    if (card.type === 'quiz') {
      const optionsHtml = card.options.map((opt, idx) => {
        const isCorrect = card.correctIndices.includes(idx)
        return `<div class="quiz-option ${isCorrect ? 'correct' : ''}">${sanitizeHtml(opt)}</div>`
      }).join('')
      el.innerHTML = `
        <div class="card-front">
          <div class="card-label">Pytanie</div>
          <div class="card-content">${sanitizeHtml(card.front)}</div>
        </div>
        <div class="card-back quiz-answers">
          <div class="card-label">Odpowiedzi</div>
          <div class="quiz-options">${optionsHtml}</div>
          ${card.explanation ? `<div class="quiz-explanation">${sanitizeHtml(card.explanation)}</div>` : ''}
        </div>
      `
    } else {
      const front = sanitizeHtml(card.front) || '<em>(brak treści)</em>'
      const back = sanitizeHtml(card.back) || '<em>(brak treści)</em>'
      el.innerHTML = `
        <div class="card-front">
          <div class="card-label">Przód</div>
          <div class="card-content">${front}</div>
        </div>
        <div class="card-back">
          <div class="card-label">Tył</div>
          <div class="card-content">${back}</div>
        </div>
      `
    }
    fragment.appendChild(el)
  }

  if (cards.length > 0) {
    console.log('[paczka-anki] Sample card front:', cards[0].front.substring(0, 200))
    console.log('[paczka-anki] Sample card back:', cards[0].back.substring(0, 200))
  }

  $cards.innerHTML = ''
  $cards.appendChild(fragment)

  if (cards.length > limit) {
    const more = document.createElement('p')
    more.style.cssText = 'text-align:center;color:#607d8b;padding:16px;'
    more.textContent = `Pokazano ${limit} z ${cards.length} kart. Użyj wyszukiwarki aby zawęzić wyniki.`
    $cards.appendChild(more)
  }

  renderMath($cards)
}

/**
 * Parse Cloze deletion card.
 * Text contains {{c1::answer::hint}} patterns.
 * Front: text with blanks (underscores), Back: text with answers revealed.
 */
function parseClozeCard(fields, names) {
  const text = fields[0] || ''
  const extra = fields.slice(1).filter(f => f.trim()).join('<hr/>')
  
  // Front: replace {{cN::answer}} or {{cN::answer::hint}} with blank
  const front = text.replace(/\{\{c\d+::([^}]*?)(?:::([^}]*?))?\}\}/g, (match, answer, hint) => {
    return `<span class="cloze-blank">${hint || '...'}</span>`
  })
  
  // Back: replace {{cN::answer}} with highlighted answer
  const back = text.replace(/\{\{c\d+::([^}]*?)(?:::([^}]*?))?\}\}/g, (match, answer, hint) => {
    return `<span class="cloze-answer">${answer}</span>`
  })
  
  return {
    type: 'cloze',
    front,
    back: back + (extra ? `<hr/>${extra}` : ''),
  }
}

/**
 * Detect if fields represent a quiz/multiple-choice card using field names from notetypes.
 */
function detectQuizFormat(fields, names) {
  if (fields.length < 3) return false

  // If we have field names, check for quiz-like structure
  if (names.length > 0) {
    const lower = names.map(n => n.toLowerCase())
    const hasQuestion = lower.some(n => n.includes('question') || n.includes('pytanie') || n.includes('treść') || n.includes('tresc'))
    // Check for numbered answer/option fields (Answer 1, Q_1, opt1, A/B/C/D)
    const hasNumberedOptions = lower.some(n => /^(q_?\d|answer_?\s*\d|opt(ion)?_?\s*\d|odp(owied[źz])?_?\s*\d)/i.test(n))
    const hasLetterOptions = lower.filter(n => /^[a-e]$/i.test(n)).length >= 3
    if (hasQuestion && (hasNumberedOptions || hasLetterOptions)) return true
  }

  // Fallback: look for answer mask pattern (binary string like "0 1 0 0")
  for (let i = fields.length - 1; i >= Math.max(1, fields.length - 4); i--) {
    const f = (fields[i] || '').trim()
    if (/^[01](\s+[01])+$/.test(f)) return true
  }

  return false
}

function parseQuizCard(fields, names) {
  const lowerNames = names.map(n => n.toLowerCase())
  
  // Find question field
  let questionIdx = 0
  for (let i = 0; i < lowerNames.length; i++) {
    if (lowerNames[i].includes('question') || lowerNames[i].includes('pytanie') || lowerNames[i].includes('treść') || lowerNames[i].includes('tresc')) {
      questionIdx = i
      break
    }
  }
  const question = fields[questionIdx] || ''
  
  // Find answer mask field (named "Answers", "correct", etc., or content matches pattern)
  let maskIdx = -1
  for (let i = 0; i < names.length; i++) {
    const n = lowerNames[i]
    if (n === 'answers' || n === 'answer' || n.includes('correct') || n.includes('poprawna') || n.includes('mask') || n.includes('odpowied')) {
      if (/^[01](\s+[01])+$/.test((fields[i] || '').trim())) {
        maskIdx = i
        break
      }
    }
  }
  // Fallback: search by content pattern
  if (maskIdx === -1) {
    for (let i = fields.length - 1; i >= 1; i--) {
      if (/^[01](\s+[01])+$/.test((fields[i] || '').trim())) {
        maskIdx = i
        break
      }
    }
  }
  
  // Identify option fields: Q_1, Q_2, Answer 1, Answer 2, A/B/C/D, odp1, etc.
  const options = []
  const optionFieldIndices = []
  for (let i = 0; i < names.length; i++) {
    if (i === questionIdx || i === maskIdx) continue
    const n = lowerNames[i]
    if (/^q_?\d+$/.test(n) || /^answer_?\s*\d+$/i.test(n) || /^(opt|option)_?\s*\d*$/i.test(n) || /^[a-e]$/i.test(n) || /^odp(owied[źz])?_?\s*\d+$/i.test(n)) {
      if (fields[i] && fields[i].trim() !== '') {
        options.push(fields[i])
        optionFieldIndices.push(i)
      }
    }
  }

  // If no named options found, use all fields between question and mask as options
  if (options.length === 0) {
    const start = questionIdx + 1
    const end = maskIdx >= 0 ? maskIdx : fields.length
    for (let i = start; i < end; i++) {
      if (fields[i] && fields[i].trim() !== '') {
        options.push(fields[i])
        optionFieldIndices.push(i)
      }
    }
  }
  
  // Determine correct answers from mask
  let correctIndices = []
  if (maskIdx >= 0) {
    const mask = fields[maskIdx].trim().split(/\s+/).map(Number)
    correctIndices = mask.map((v, i) => v === 1 ? i : -1).filter(i => i >= 0)
  }
  
  // Find explanation/extra
  let explanation = ''
  for (let i = 0; i < names.length; i++) {
    const n = lowerNames[i]
    if (n.includes('extra') || n.includes('explanation') || n.includes('wyjaśn') || n.includes('wyjasn') || n.includes('komentarz')) {
      if (fields[i] && fields[i].trim()) {
        explanation = fields[i]
        break
      }
    }
  }
  
  return {
    type: 'quiz',
    front: question,
    options,
    correctIndices,
    explanation,
    back: ''
  }
}

function filterCards(query) {
  if (!query.trim()) {
    renderCards(allCards)
    $cardCount.textContent = `${allCards.length} kart`
    return
  }
  const q = query.toLowerCase()
  const filtered = allCards.filter(c =>
    stripHtml(c.front).toLowerCase().includes(q) ||
    stripHtml(c.back).toLowerCase().includes(q)
  )
  renderCards(filtered)
  $cardCount.textContent = `${filtered.length} / ${allCards.length} kart`
}

async function loadApkg(url) {
  try {
    console.log('[paczka-anki] Fetching file...')
    // Fetch the .apkg file
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    const buffer = await response.arrayBuffer()
    console.log('[paczka-anki] File fetched, size:', buffer.byteLength)

    // Unzip
    const zip = await JSZip.loadAsync(buffer)
    const zipEntries = Object.keys(zip.files)
    console.log('[paczka-anki] ZIP entries:', zipEntries)

    // New Anki format (2.1.50+): collection.anki21b is zstd-compressed SQLite
    // Old format: collection.anki2 or collection.anki21 is plain SQLite
    let dbFile = null
    let dbBuffer = null
    let isNewFormat = false

    if (zip.file('collection.anki21b')) {
      isNewFormat = true
      const compressed = await zip.file('collection.anki21b').async('uint8array')
      console.log('[paczka-anki] anki21b compressed size:', compressed.byteLength)
      try {
        const decompressed = zstdDecompress(compressed)
        console.log('[paczka-anki] anki21b decompressed size:', decompressed.byteLength)
        dbBuffer = decompressed.buffer
      } catch (e) {
        console.warn('[paczka-anki] zstd decompression failed:', e.message)
      }
    }

    if (!dbBuffer) {
      dbFile = zip.file('collection.anki21') || zip.file('collection.anki2')
      if (!dbFile) {
        const dbEntry = zipEntries.find(name => /^collection\.anki2/.test(name) && !name.endsWith('b'))
        if (dbEntry) dbFile = zip.file(dbEntry)
      }
      if (!dbFile) {
        throw new Error('Nie znaleziono bazy kart w pliku .apkg. Pliki: ' + zipEntries.join(', '))
      }
      dbBuffer = await dbFile.async('arraybuffer')
    }

    console.log('[paczka-anki] DB size:', dbBuffer.byteLength)

    // Initialize sql.js with WASM from CDN
    console.log('[paczka-anki] Initializing SQL.js...')
    const initSqlJs = await loadSqlJs()
    const SQL = await initSqlJs({
      locateFile: (file) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/${file}`,
    })
    console.log('[paczka-anki] SQL.js ready')

    const db = new SQL.Database(new Uint8Array(dbBuffer))

    // Try to get deck name from col table
    let deckName = 'Anki Deck'
    try {
      const colResult = db.exec("SELECT decks FROM col LIMIT 1")
      if (colResult.length > 0 && colResult[0].values.length > 0) {
        const decks = JSON.parse(colResult[0].values[0][0])
        const deckKeys = Object.keys(decks).filter(k => k !== '1')
        if (deckKeys.length > 0) {
          deckName = decks[deckKeys[0]].name || deckName
        } else if (decks['1']) {
          deckName = decks['1'].name || deckName
        }
      }
    } catch {
      // Anki 2.1.50+ might store decks differently
    }

    // Extract note types to understand field structure
    let fieldNames = {}
    try {
      // New format: notetypes table with separate fields table
      const fieldsResult = db.exec("SELECT ntid, name, ord FROM fields ORDER BY ntid, ord")
      if (fieldsResult.length > 0) {
        for (const row of fieldsResult[0].values) {
          const ntid = row[0]
          const name = row[1]
          if (!fieldNames[ntid]) fieldNames[ntid] = []
          fieldNames[ntid].push(name)
        }
        console.log('[paczka-anki] Field names from fields table:', fieldNames)
      }
    } catch {}

    if (Object.keys(fieldNames).length === 0) {
      try {
        // notetypes table with config blob
        const ntResult = db.exec("SELECT id, config FROM notetypes")
        if (ntResult.length > 0) {
          for (const row of ntResult[0].values) {
            const id = row[0]
            let config = row[1]
            if (config instanceof Uint8Array) {
              // Protobuf config — try to extract field names as strings
              const text = new TextDecoder('utf-8', { fatal: false }).decode(config)
              const names = []
              const re = /([A-Za-zĄ-ż][\w\s]{1,30})/g
              let m
              while ((m = re.exec(text)) !== null) {
                if (m[1].trim().length > 1) names.push(m[1].trim())
              }
              if (names.length >= 2) fieldNames[id] = names
            } else {
              try {
                const parsed = JSON.parse(config)
                if (parsed.flds) {
                  fieldNames[id] = parsed.flds.map(f => f.name || f.n || '')
                }
              } catch {}
            }
          }
        }
      } catch {}
    }
    
    // Fallback: old format — field names in col.models JSON
    if (Object.keys(fieldNames).length === 0) {
      try {
        const colResult = db.exec("SELECT models FROM col LIMIT 1")
        if (colResult.length > 0 && colResult[0].values.length > 0) {
          const models = JSON.parse(colResult[0].values[0][0])
          for (const [id, model] of Object.entries(models)) {
            if (model.flds) {
              fieldNames[id] = model.flds.map(f => f.name || '')
            }
          }
        }
      } catch {}
    }
    
    console.log('[paczka-anki] Field names:', fieldNames)

    // Extract notes (cards)
    let cards = []
    try {
      const notesResult = db.exec("SELECT mid, flds FROM notes ORDER BY id")
      if (notesResult.length > 0) {
        console.log('[paczka-anki] First note flds type:', typeof notesResult[0].values[0][1], notesResult[0].values[0][1])
        cards = notesResult[0].values.map(row => {
          const mid = row[0]
          let rawFields = row[1]
          if (!rawFields) return null
          if (rawFields instanceof Uint8Array) {
            rawFields = new TextDecoder('utf-8').decode(rawFields)
          }
          if (typeof rawFields !== 'string') {
            rawFields = String(rawFields)
          }
          const fields = rawFields.split('\x1f')
          const names = fieldNames[mid] || []
          
          // Detect quiz format using field names
          const isQuiz = detectQuizFormat(fields, names)
          
          if (isQuiz) {
            return parseQuizCard(fields, names)
          }
          
          // Detect Cloze cards
          if (fields[0] && fields[0].includes('{{c')) {
            return parseClozeCard(fields, names)
          }
          
          const front = fields[0] || ''
          const back = fields.length > 1 ? fields.slice(1).filter(f => f.trim()).join('<hr/>') : ''
          return { front, back, type: 'basic' }
        }).filter(c => {
          if (!c) return false
          const frontText = stripHtml(c.front).trim()
          // Filter out Anki dummy/metadata entries
          if (frontText.toLowerCase().includes('please update to the latest anki version')) return false
          if (frontText === '' && stripHtml(c.back).trim() === '') return false
          // Filter out entries that are just numbers/whitespace (metadata rows)
          if (/^\s*[\d\s]+\s*$/.test(frontText) && frontText.length < 20) return false
          return true
        })
      }
      console.log('[paczka-anki] Cards found:', cards.length)
      if (cards.length === 0) {
        throw new Error('Nie znaleziono kart w pliku.')
      }
    } catch (e) {
      throw new Error('Nie udało się odczytać kart: ' + e.message)
    }

    db.close()

    // Extract media files from ZIP and create blob URLs
    let mediaMap = {}
    
    // Try classic format: "media" JSON file maps numbers to filenames
    try {
      const mediaFile = zip.file('media')
      if (mediaFile) {
        const mediaRaw = await mediaFile.async('uint8array')
        let mediaMapping = null
        
        // Try as plain JSON first
        try {
          const text = new TextDecoder().decode(mediaRaw)
          mediaMapping = JSON.parse(text)
        } catch {}
        
        // Try zstd decompression then JSON
        if (!mediaMapping) {
          try {
            const decompressed = zstdDecompress(mediaRaw)
            const text = new TextDecoder().decode(decompressed)
            mediaMapping = JSON.parse(text)
          } catch {}
        }
        
        // Try parsing as protobuf (new format)
        // Structure: repeated { bytes name = 1; bytes sha256 = 2; } 
        // Each entry starts with 0a (field 1, wire type 2), then varint length
        // Inside: 0a + varint len + filename string, then 12 + varint len + sha256
        if (!mediaMapping) {
          try {
            let data = mediaRaw
            if (data[0] === 0x28 && data[1] === 0xB5 && data[2] === 0x2F && data[3] === 0xFD) {
              data = zstdDecompress(data)
            }
            
            const decoder = new TextDecoder('utf-8', { fatal: false })
            const filenames = []
            let i = 0
            
            while (i < data.length) {
              // Expect outer field: 0a (field 1, length-delimited)
              if (data[i] !== 0x0a) { i++; continue }
              i++
              
              // Read outer length varint
              let outerLen = 0, shift = 0
              while (i < data.length && (data[i] & 0x80) !== 0) {
                outerLen |= (data[i] & 0x7f) << shift; shift += 7; i++
              }
              if (i >= data.length) break
              outerLen |= (data[i] & 0x7f) << shift; i++
              
              const entryEnd = i + outerLen
              if (entryEnd > data.length || outerLen < 4) { i = entryEnd; continue }
              
              // Inside entry: first field should be 0a (field 1 = filename)
              if (data[i] === 0x0a) {
                i++
                let nameLen = 0; shift = 0
                while (i < entryEnd && (data[i] & 0x80) !== 0) {
                  nameLen |= (data[i] & 0x7f) << shift; shift += 7; i++
                }
                if (i >= entryEnd) break
                nameLen |= (data[i] & 0x7f) << shift; i++
                
                if (nameLen > 0 && nameLen < 500 && i + nameLen <= entryEnd) {
                  const name = decoder.decode(data.slice(i, i + nameLen))
                  filenames.push(name)
                }
              }
              
              i = entryEnd
            }
            
            console.log('[paczka-anki] Protobuf parsed filenames:', filenames.length, filenames.slice(0, 3))
            
            if (filenames.length > 0) {
              const numberedFiles = Object.keys(zip.files)
                .filter(n => /^\d+$/.test(n))
                .sort((a, b) => +a - +b)
              
              mediaMapping = {}
              for (let idx = 0; idx < Math.min(numberedFiles.length, filenames.length); idx++) {
                mediaMapping[numberedFiles[idx]] = filenames[idx]
              }
            }
          } catch (e) {
            console.warn('[paczka-anki] protobuf media parse error:', e.message)
          }
        }
        
        if (mediaMapping && typeof mediaMapping === 'object') {
          console.log('[paczka-anki] Media mapping sample:', Object.entries(mediaMapping).slice(0, 5))
          for (const [num, filename] of Object.entries(mediaMapping)) {
            const file = zip.file(String(num))
            if (file) {
              let fileData = await file.async('uint8array')
              if (Object.keys(mediaMap).length === 0) {
                console.log('[paczka-anki] First media file:', num, 'size before decompress:', fileData.length, 'first bytes:', fileData.slice(0, 8))
              }
              // Decompress zstd media if needed (check magic bytes 28 B5 2F FD)
              if (fileData.length > 4 && fileData[0] === 0x28 && fileData[1] === 0xB5 && fileData[2] === 0x2F && fileData[3] === 0xFD) {
                try { fileData = zstdDecompress(fileData) } catch {}
              }
              const blob = new Blob([fileData])
              mediaMap[filename] = URL.createObjectURL(blob)
            } else {
              if (Object.keys(mediaMap).length === 0) {
                console.log('[paczka-anki] File not found in ZIP:', String(num))
              }
            }
          }
          console.log('[paczka-anki] Media via mapping:', Object.keys(mediaMap).length)
        }
      }
    } catch (e) {
      console.warn('[paczka-anki] media parse failed:', e.message)
    }

    // Fallback: load files directly by name from ZIP (new format or non-JSON media)
    try {
      const allZipFiles = Object.keys(zip.files)
      for (const name of allZipFiles) {
        if (name === 'media' || name.startsWith('collection.') || name === 'meta' || zip.files[name].dir) continue
        if (!mediaMap[name]) {
          const file = zip.file(name)
          if (file) {
            let data = await file.async('uint8array')
            
            // New Anki format: media files inside ZIP are zstd-compressed
            // Detect by checking if content starts with zstd magic bytes (0x28 0xB5 0x2F 0xFD)
            if (data.length > 4 && data[0] === 0x28 && data[1] === 0xB5 && data[2] === 0x2F && data[3] === 0xFD) {
              try {
                data = zstdDecompress(data)
              } catch {}
            }
            
            // Detect mime type from decompressed content
            let mime = 'application/octet-stream'
            if (data[0] === 0xFF && data[1] === 0xD8) mime = 'image/jpeg'
            else if (data[0] === 0x89 && data[1] === 0x50) mime = 'image/png'
            else if (data[0] === 0x47 && data[1] === 0x49) mime = 'image/gif'
            else if (data[0] === 0x52 && data[1] === 0x49) mime = 'audio/wav'
            else if (data[0] === 0x49 && data[1] === 0x44) mime = 'audio/mpeg'
            else if (data[0] === 0x4F && data[1] === 0x67) mime = 'audio/ogg'
            
            const blob = new Blob([data], { type: mime })
            mediaMap[name] = URL.createObjectURL(blob)
          }
        }
      }
      console.log('[paczka-anki] Total media files:', Object.keys(mediaMap).length)
    } catch (e) {
      console.warn('[paczka-anki] Failed to load direct media files:', e.message)
    }

    // Replace image src in cards with blob URLs
    if (Object.keys(mediaMap).length > 0) {
      for (const card of cards) {
        card.front = replaceMediaSrc(card.front, mediaMap)
        card.back = replaceMediaSrc(card.back, mediaMap)
      }
    }

    // Extract filename from URL for display
    const urlPath = new URL(url, window.location.origin).pathname
    const fileName = decodeURIComponent(urlPath.split('/').pop() || 'deck.apkg')

    $deckName.textContent = deckName !== 'Default' ? deckName : fileName.replace('.apkg', '')
    allCards = cards
    $cardCount.textContent = `${cards.length} kart`
    renderCards(cards)
    showContent()

    // Save to recent decks (but not for local/API deck URLs)
    const displayName = deckName !== 'Default' ? deckName : fileName.replace('.apkg', '')
    if (!url.startsWith('/api/')) {
      saveRecentDeck(url, displayName, cards.length)
    }

    // Restore mode from URL
    const initialMode = params.get('mode')
    if (initialMode === 'flashcard') {
      setMode('flashcard')
    }

  } catch (e) {
    showError(`Błąd ładowania: ${e.message}`)
  }
}

// ============ RECENT DECKS ============

const RECENT_KEY = 'paczka-anki:recent'
const MAX_RECENT = 10

function getRecentDecks() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
  } catch { return [] }
}

function saveRecentDeck(url, name, cardCount) {
  const fileName = decodeURIComponent(url.split('/').pop() || '')
  const recent = getRecentDecks().filter(d => d.url !== url)
  recent.unshift({ url, name, cardCount, fileName, timestamp: Date.now() })
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent))
}

function showRecentDecks() {
  $loading.classList.add('hidden')
  const $recent = document.getElementById('recent-decks')
  const $recentList = document.getElementById('recent-list')
  const $recentEmpty = document.getElementById('recent-empty')
  $recent.classList.remove('hidden')

  const decks = getRecentDecks()
  if (decks.length === 0) {
    $recentEmpty.classList.remove('hidden')
  } else {
    $recentEmpty.classList.add('hidden')
    $recentList.innerHTML = decks.map(d => {
      const date = new Date(d.timestamp)
      const dateStr = date.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' })
      const currentUrl = new URL(window.location)
      currentUrl.searchParams.set('url', d.url)
      const fileLabel = d.fileName ? `<div class="recent-item-file">${d.fileName}</div>` : ''
      return `<a href="${currentUrl.toString()}" class="recent-item">
        <div class="recent-item-name">📄 ${d.name}</div>
        ${fileLabel}
        <div class="recent-item-meta">${d.cardCount} kart · ${dateStr}</div>
        <div class="recent-item-actions">
          <span class="clone-btn" data-url="${d.url}" data-name="${d.name}">📋 Klonuj do edycji</span>
        </div>
      </a>`
    }).join('')

    // Clone button listeners
    $recentList.querySelectorAll('.clone-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        cloneRecentDeck(btn.dataset.url, btn.dataset.name)
      })
    })
  }

  // Render local decks
  renderLocalDecks()
}

// Get URL from query params
const params = new URLSearchParams(window.location.search)
const fileUrl = params.get('url')
const localDeckId = params.get('deck')

if (localDeckId) {
  // Open a local deck from server — use loadApkg with the API file URL
  const fileUrl2 = apiDeckFileUrl(localDeckId)
  console.log('[paczka-anki] Loading local deck:', localDeckId)
  loadApkg(fileUrl2)
} else if (!fileUrl) {
  showRecentDecks()
} else {
  // If URL is relative, resolve against current origin
  const resolvedUrl = fileUrl.startsWith('http') ? fileUrl : fileUrl
  console.log('[paczka-anki] Loading:', resolvedUrl)
  loadApkg(resolvedUrl)
}

// Search handler
let searchTimeout = null
$search.addEventListener('input', () => {
  clearTimeout(searchTimeout)
  searchTimeout = setTimeout(() => filterCards($search.value), 200)
})

// ============ FLASHCARD MODE ============

const $listMode = document.getElementById('list-mode')
const $flashcardMode = document.getElementById('flashcard-mode')
const $btnList = document.getElementById('btn-list')
const $btnFlashcard = document.getElementById('btn-flashcard')
const $flashcard = document.getElementById('flashcard')
const $fcFront = document.getElementById('fc-front')
const $fcBack = document.getElementById('fc-back')
const $fcCounter = document.getElementById('fc-counter')
const $fcKnown = document.getElementById('fc-known')
const $fcNotKnown = document.getElementById('fc-not-known')
const $fcShuffle = document.getElementById('fc-shuffle')
const $fcReset = document.getElementById('fc-reset')
const $fcDone = document.getElementById('fc-done')
const $fcDoneStats = document.getElementById('fc-done-stats')
const $fcRetryWrong = document.getElementById('fc-retry-wrong')
const $fcRestart = document.getElementById('fc-restart')
const $fcRemaining = document.querySelector('#fc-remaining strong')
const $fcLearned = document.querySelector('#fc-learned strong')
const $fcNotLearned = document.querySelector('#fc-not-learned strong')
const $fcStats = document.getElementById('fc-stats')
const $fcHeaderControls = document.getElementById('fc-header-controls')
const $swipeLeft = document.getElementById('swipe-indicator-left')
const $swipeRight = document.getElementById('swipe-indicator-right')

let flashcardIndex = 0
let flashcardDeck = []
let learnedCards = []
let notLearnedCards = []
let undoHistory = [] // stack of {card, known} for undo

const $fcUndo = document.getElementById('fc-undo')

// Persistence via localStorage — keyed by file URL
function getStorageKey() {
  return `paczka-anki:${fileUrl}`
}

function saveProgress() {
  const data = {
    learnedIndices: learnedCards.map(c => allCards.indexOf(c)),
    notLearnedIndices: notLearnedCards.map(c => allCards.indexOf(c)),
    currentIndex: flashcardIndex,
    deckOrder: flashcardDeck.map(c => allCards.indexOf(c)),
  }
  localStorage.setItem(getStorageKey(), JSON.stringify(data))
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(getStorageKey())
    if (!raw) return false
    const data = JSON.parse(raw)
    if (!data.deckOrder || !Array.isArray(data.deckOrder)) return false

    learnedCards = (data.learnedIndices || []).map(i => allCards[i]).filter(Boolean)
    notLearnedCards = (data.notLearnedIndices || []).map(i => allCards[i]).filter(Boolean)
    flashcardDeck = data.deckOrder.map(i => allCards[i]).filter(Boolean)
    flashcardIndex = data.currentIndex || 0

    // Validate — if deck is empty or index out of range, discard
    if (flashcardDeck.length === 0 || flashcardIndex > flashcardDeck.length) return false
    return true
  } catch {
    return false
  }
}

function clearProgress() {
  localStorage.removeItem(getStorageKey())
}

// Swipe state
let swipeStartX = 0
let swipeCurrentX = 0
let isSwiping = false

function setMode(mode) {
  if (mode === 'list') {
    $listMode.classList.remove('hidden')
    $flashcardMode.classList.add('hidden')
    $btnList.classList.add('active')
    $btnFlashcard.classList.remove('active')
    $cardCount.classList.remove('hidden')
    $fcStats.classList.add('hidden')
    $fcHeaderControls.classList.add('hidden')

    // Update URL
    const url = new URL(window.location)
    url.searchParams.delete('mode')
    history.replaceState(null, '', url)
  } else {
    $listMode.classList.add('hidden')
    $flashcardMode.classList.remove('hidden')
    $btnList.classList.remove('active')
    $btnFlashcard.classList.add('active')
    $cardCount.classList.add('hidden')
    $fcStats.classList.remove('hidden')
    $fcHeaderControls.classList.remove('hidden')

    // Update URL
    const url = new URL(window.location)
    url.searchParams.set('mode', 'flashcard')
    history.replaceState(null, '', url)

    // Try to restore saved progress
    const restored = loadProgress()
    if (!restored) {
      flashcardDeck = [...allCards]
      flashcardIndex = 0
      learnedCards = []
      notLearnedCards = []
    }

    $fcDone.classList.add('hidden')
    document.getElementById('flashcard-container').classList.remove('hidden')
    updateStats()
    showFlashcard()
  }
}

function resetFlashcards() {
  flashcardDeck = [...allCards]
  flashcardIndex = 0
  learnedCards = []
  notLearnedCards = []
  undoHistory = []
  $fcUndo.disabled = true
  clearProgress()
  $fcDone.classList.add('hidden')
  document.getElementById('flashcard-container').classList.remove('hidden')
  updateStats()
  showFlashcard()
}

function updateStats() {
  $fcRemaining.textContent = flashcardDeck.length - flashcardIndex
  $fcLearned.textContent = learnedCards.length
  $fcNotLearned.textContent = notLearnedCards.length
}

function showFlashcard() {
  if (flashcardIndex >= flashcardDeck.length) {
    showDoneScreen()
    return
  }
  const card = flashcardDeck[flashcardIndex]
  
  if (card.type === 'quiz') {
    // Quiz mode: show question + clickable options (no flip needed)
    $flashcard.classList.add('quiz-mode')
    $flashcard.classList.remove('flipped')
    
    const optionsHtml = card.options.map((opt, idx) => {
      return `<button class="quiz-fc-option" data-idx="${idx}">${sanitizeHtml(opt)}</button>`
    }).join('')
    
    $fcFront.innerHTML = `
      <div class="flashcard-label">Pytanie</div>
      <div class="quiz-question">${sanitizeHtml(card.front)}</div>
      <div class="quiz-fc-options">${optionsHtml}</div>
    `
    $fcBack.innerHTML = ''
    
    // Add click handlers for quiz options
    setTimeout(() => {
      document.querySelectorAll('.quiz-fc-option').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation()
          const idx = parseInt(btn.dataset.idx)
          const isCorrect = card.correctIndices.includes(idx)
          // Reveal all answers
          document.querySelectorAll('.quiz-fc-option').forEach((b, i) => {
            if (card.correctIndices.includes(i)) b.classList.add('correct')
            else b.classList.add('wrong')
            b.disabled = true
          })
          btn.classList.add(isCorrect ? 'selected-correct' : 'selected-wrong')
          
          // Show next button
          const nextBtn = document.createElement('button')
          nextBtn.className = 'fc-btn quiz-next-btn'
          nextBtn.textContent = 'Następna →'
          nextBtn.addEventListener('click', (ev) => {
            ev.stopPropagation()
            markCard(isCorrect)
          })
          $fcFront.appendChild(nextBtn)
        })
      })
      renderMath($fcFront)
    }, 0)
  } else {
    // Basic card: flip mode
    $flashcard.classList.remove('quiz-mode')
    $fcFront.innerHTML = sanitizeHtml(card.front)
    $fcBack.innerHTML = sanitizeHtml(card.back)
    $flashcard.classList.remove('flipped')
    setTimeout(() => {
      renderMath($fcFront)
      renderMath($fcBack)
    }, 0)
  }
  
  document.getElementById('fc-counter').textContent = `${flashcardIndex + 1} / ${flashcardDeck.length}`
  $flashcard.style.transform = ''
  updateStats()
}

function showDoneScreen() {
  document.getElementById('flashcard-container').classList.add('hidden')
  $fcDone.classList.remove('hidden')
  $fcDoneStats.textContent = `Nauczone: ${learnedCards.length} · Nie nauczone: ${notLearnedCards.length}`
  $fcRetryWrong.disabled = notLearnedCards.length === 0
}

function markCard(known) {
  const card = flashcardDeck[flashcardIndex]
  if (known) {
    learnedCards.push(card)
  } else {
    notLearnedCards.push(card)
  }

  // Save to undo history
  undoHistory.push({ card, known })
  $fcUndo.disabled = false

  // Animate exit
  const direction = known ? 'swipe-exit-right' : 'swipe-exit-left'
  $flashcard.classList.add(direction)

  setTimeout(() => {
    $flashcard.classList.remove(direction)
    // Disable flip transition so the back of the next card isn't briefly visible
    const inner = $flashcard.querySelector('.flashcard-inner')
    if (inner) inner.style.transition = 'none'
    flashcardIndex++
    saveProgress()
    showFlashcard()
    // Re-enable transition after a frame
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (inner) inner.style.transition = ''
      })
    })
  }, 300)
}

function undoLastCard() {
  if (undoHistory.length === 0) return
  const last = undoHistory.pop()
  
  // Remove from learned/not learned
  if (last.known) {
    const idx = learnedCards.lastIndexOf(last.card)
    if (idx >= 0) learnedCards.splice(idx, 1)
  } else {
    const idx = notLearnedCards.lastIndexOf(last.card)
    if (idx >= 0) notLearnedCards.splice(idx, 1)
  }

  // Go back
  flashcardIndex--
  $fcUndo.disabled = undoHistory.length === 0

  // If we were on done screen, show flashcard container again
  $fcDone.classList.add('hidden')
  document.getElementById('flashcard-container').classList.remove('hidden')

  saveProgress()
  showFlashcard()
}

function shuffleDeck() {
  // Shuffle only remaining cards
  const remaining = flashcardDeck.slice(flashcardIndex)
  for (let i = remaining.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [remaining[i], remaining[j]] = [remaining[j], remaining[i]]
  }
  flashcardDeck = [...flashcardDeck.slice(0, flashcardIndex), ...remaining]
  saveProgress()
  showFlashcard()
}

// Mode buttons
$btnList.addEventListener('click', () => setMode('list'))
$btnFlashcard.addEventListener('click', () => setMode('flashcard'))

// Flip on click (only for basic cards, not quiz)
$flashcard.addEventListener('click', (e) => {
  if (isSwiping) return
  if ($flashcard.classList.contains('quiz-mode')) return
  $flashcard.classList.toggle('flipped')
})

// Known / Not known buttons
$fcKnown.addEventListener('click', (e) => {
  e.stopPropagation()
  markCard(true)
})

$fcNotKnown.addEventListener('click', (e) => {
  e.stopPropagation()
  markCard(false)
})

$fcShuffle.addEventListener('click', () => shuffleDeck())

$fcUndo.addEventListener('click', () => undoLastCard())

$fcReset.addEventListener('click', () => {
  if (!confirm('Zresetować postęp? Wszystkie nauczone/nie nauczone karty zostaną wyzerowane.')) return
  resetFlashcards()
})

$fcRetryWrong.addEventListener('click', () => {
  flashcardDeck = [...notLearnedCards]
  flashcardIndex = 0
  notLearnedCards = []
  learnedCards = []
  saveProgress()
  $fcDone.classList.add('hidden')
  document.getElementById('flashcard-container').classList.remove('hidden')
  updateStats()
  showFlashcard()
})

$fcRestart.addEventListener('click', () => resetFlashcards())

// Keyboard navigation
document.addEventListener('keydown', (e) => {
  if ($flashcardMode.classList.contains('hidden')) return
  if (flashcardIndex >= flashcardDeck.length) return
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault()
    $flashcard.classList.toggle('flipped')
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    markCard(false)
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    markCard(true)
  }
})

// ============ SWIPE GESTURES ============

$flashcard.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') return // handled by touch events
  if (flashcardIndex >= flashcardDeck.length) return
  if ($flashcard.classList.contains('quiz-mode')) return
  if (e.target.closest('button')) return
  swipeStartX = e.clientX
  swipeCurrentX = e.clientX
  isSwiping = false
  $flashcard.setPointerCapture(e.pointerId)
})

$flashcard.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return
  if (swipeStartX === 0) return
  swipeCurrentX = e.clientX
  const dx = swipeCurrentX - swipeStartX
  const threshold = 30

  if (Math.abs(dx) > threshold) {
    isSwiping = true
  }

  if (isSwiping) {
    const rotation = dx * 0.05
    $flashcard.style.transform = `translateX(${dx}px) rotate(${rotation}deg)`

    // Show indicators
    if (dx < -80) {
      $swipeLeft.classList.add('visible')
      $swipeRight.classList.remove('visible')
    } else if (dx > 80) {
      $swipeRight.classList.add('visible')
      $swipeLeft.classList.remove('visible')
    } else {
      $swipeLeft.classList.remove('visible')
      $swipeRight.classList.remove('visible')
    }
  }
})

$flashcard.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'touch') return
  if (swipeStartX === 0) return
  const dx = swipeCurrentX - swipeStartX

  $swipeLeft.classList.remove('visible')
  $swipeRight.classList.remove('visible')

  if (Math.abs(dx) > 100) {
    // Swipe threshold met
    markCard(dx > 0)
  } else {
    // Snap back
    $flashcard.style.transform = ''
  }

  swipeStartX = 0
  swipeCurrentX = 0

  // Reset isSwiping after a tick to avoid triggering click
  setTimeout(() => { isSwiping = false }, 50)
})

$flashcard.addEventListener('pointercancel', (e) => {
  if (e.pointerType === 'touch') return
  $flashcard.style.transform = ''
  swipeStartX = 0
  $swipeLeft.classList.remove('visible')
  $swipeRight.classList.remove('visible')
  isSwiping = false
})

// ============ TOUCH EVENTS (primary handler for all touch devices) ============

let touchStartY = 0

$flashcard.addEventListener('touchstart', (e) => {
  if (flashcardIndex >= flashcardDeck.length) return
  if ($flashcard.classList.contains('quiz-mode')) return
  if (e.target.closest('button')) return
  const touch = e.touches[0]
  swipeStartX = touch.clientX
  swipeCurrentX = touch.clientX
  touchStartY = touch.clientY
  isSwiping = false
}, { passive: true })

$flashcard.addEventListener('touchmove', (e) => {
  if (swipeStartX === 0) return
  const touch = e.touches[0]
  swipeCurrentX = touch.clientX
  const dx = swipeCurrentX - swipeStartX
  const dy = touch.clientY - touchStartY

  // Only swipe horizontally — if vertical movement is dominant, ignore
  if (!isSwiping && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) {
    swipeStartX = 0
    return
  }

  if (Math.abs(dx) > 20) {
    isSwiping = true
  }

  if (isSwiping) {
    if (e.cancelable) e.preventDefault()
    const rotation = dx * 0.05
    $flashcard.style.transform = `translateX(${dx}px) rotate(${rotation}deg)`

    if (dx < -80) {
      $swipeLeft.classList.add('visible')
      $swipeRight.classList.remove('visible')
    } else if (dx > 80) {
      $swipeRight.classList.add('visible')
      $swipeLeft.classList.remove('visible')
    } else {
      $swipeLeft.classList.remove('visible')
      $swipeRight.classList.remove('visible')
    }
  }
}, { passive: false })

$flashcard.addEventListener('touchend', () => {
  if (swipeStartX === 0) return
  const dx = swipeCurrentX - swipeStartX

  $swipeLeft.classList.remove('visible')
  $swipeRight.classList.remove('visible')

  if (isSwiping && Math.abs(dx) > 80) {
    markCard(dx > 0)
  } else {
    $flashcard.style.transform = ''
  }

  swipeStartX = 0
  swipeCurrentX = 0
  setTimeout(() => { isSwiping = false }, 50)
})

$flashcard.addEventListener('touchcancel', () => {
  $flashcard.style.transform = ''
  swipeStartX = 0
  $swipeLeft.classList.remove('visible')
  $swipeRight.classList.remove('visible')
  isSwiping = false
})

// ============ LOCAL DECKS (Custom user decks in localStorage) ============

/**
 * Extract cards from an open sql.js Database for use in the local editor.
 * Detects basic, cloze, and quiz types using field names from notetypes.
 */
function extractCardsForEditor(db) {
  // Extract field names per model
  let fieldNames = {}
  try {
    const fieldsResult = db.exec("SELECT ntid, name, ord FROM fields ORDER BY ntid, ord")
    if (fieldsResult.length > 0) {
      for (const row of fieldsResult[0].values) {
        const ntid = row[0]
        const name = row[1]
        if (!fieldNames[ntid]) fieldNames[ntid] = []
        fieldNames[ntid].push(name)
      }
    }
  } catch {}

  if (Object.keys(fieldNames).length === 0) {
    try {
      const ntResult = db.exec("SELECT id, config FROM notetypes")
      if (ntResult.length > 0) {
        for (const row of ntResult[0].values) {
          const id = row[0]
          let config = row[1]
          if (config instanceof Uint8Array) {
            const text = new TextDecoder('utf-8', { fatal: false }).decode(config)
            const names = []
            const re = /([A-Za-zĄ-ż][\w\s]{1,30})/g
            let m
            while ((m = re.exec(text)) !== null) {
              if (m[1].trim().length > 1) names.push(m[1].trim())
            }
            if (names.length >= 2) fieldNames[id] = names
          } else {
            try {
              const parsed = JSON.parse(config)
              if (parsed.flds) fieldNames[id] = parsed.flds.map(f => f.name || f.n || '')
            } catch {}
          }
        }
      }
    } catch {}
  }

  if (Object.keys(fieldNames).length === 0) {
    try {
      const colResult = db.exec("SELECT models FROM col LIMIT 1")
      if (colResult.length > 0 && colResult[0].values.length > 0) {
        const models = JSON.parse(colResult[0].values[0][0])
        for (const [id, model] of Object.entries(models)) {
          if (model.flds) fieldNames[id] = model.flds.map(f => f.name || '')
        }
      }
    } catch {}
  }

  // Extract notes with model ID
  let cards = []
  try {
    const notesResult = db.exec("SELECT mid, flds FROM notes ORDER BY id")
    if (notesResult.length > 0) {
      cards = notesResult[0].values.map(row => {
        const mid = row[0]
        let rawFields = row[1]
        if (!rawFields) return null
        if (rawFields instanceof Uint8Array) rawFields = new TextDecoder('utf-8').decode(rawFields)
        if (typeof rawFields !== 'string') rawFields = String(rawFields)
        const fields = rawFields.split('\x1f')
        const names = fieldNames[mid] || []

        // Detect quiz
        if (detectQuizFormat(fields, names)) {
          const parsed = parseQuizCard(fields, names)
          return { type: 'quiz', front: parsed.front, options: parsed.options, correctIndices: parsed.correctIndices, explanation: parsed.explanation || '' }
        }

        const front = fields[0] || ''
        // Detect cloze
        if (front.includes('{{c')) {
          return { type: 'cloze', clozeText: front, extra: fields.slice(1).filter(f => f.trim()).join('\n') }
        }

        const back = fields.length > 1 ? fields.slice(1).filter(f => f.trim()).join('<hr/>') : ''
        return { type: 'basic', front, back }
      }).filter(c => {
        if (!c) return false
        const ft = stripHtml(c.front || c.clozeText || '').trim()
        if (!ft) return false
        if (ft.toLowerCase().includes('please update to the latest anki version')) return false
        if (/^\s*[\d\s]+\s*$/.test(ft) && ft.length < 20) return false
        return true
      })
    }
  } catch {}

  return cards
}

/**
 * Embed media files from the .apkg ZIP directly into card HTML as base64 data URIs.
 * This handles references like <img src="paste-abc123.jpg"> by finding the file in the ZIP.
 */
async function embedMediaInCards(cards, zip) {
  // Build media mapping: numbered files -> original filenames
  let mediaMapping = null
  try {
    const mediaFile = zip.file('media')
    if (mediaFile) {
      const mediaRaw = await mediaFile.async('uint8array')
      // Try JSON
      try {
        const text = new TextDecoder().decode(mediaRaw)
        mediaMapping = JSON.parse(text)
      } catch {}
      // Try zstd + JSON
      if (!mediaMapping) {
        try {
          const decompressed = zstdDecompress(mediaRaw)
          const text = new TextDecoder().decode(decompressed)
          mediaMapping = JSON.parse(text)
        } catch {}
      }
      // Try protobuf format
      if (!mediaMapping) {
        try {
          let data = mediaRaw
          if (data.length > 4 && data[0] === 0x28 && data[1] === 0xB5 && data[2] === 0x2F && data[3] === 0xFD) {
            data = zstdDecompress(data)
          }
          const decoder = new TextDecoder('utf-8', { fatal: false })
          const filenames = []
          let i = 0
          while (i < data.length) {
            if (data[i] !== 0x0a) { i++; continue }
            i++
            let outerLen = 0, shift = 0
            while (i < data.length && (data[i] & 0x80) !== 0) { outerLen |= (data[i] & 0x7f) << shift; shift += 7; i++ }
            if (i >= data.length) break
            outerLen |= (data[i] & 0x7f) << shift; i++
            const entryEnd = i + outerLen
            if (entryEnd > data.length || outerLen < 4) { i = entryEnd; continue }
            if (data[i] === 0x0a) {
              i++
              let nameLen = 0; shift = 0
              while (i < entryEnd && (data[i] & 0x80) !== 0) { nameLen |= (data[i] & 0x7f) << shift; shift += 7; i++ }
              if (i >= entryEnd) break
              nameLen |= (data[i] & 0x7f) << shift; i++
              if (nameLen > 0 && nameLen < 500 && i + nameLen <= entryEnd) {
                filenames.push(decoder.decode(data.slice(i, i + nameLen)))
              }
            }
            i = entryEnd
          }
          if (filenames.length > 0) {
            const numberedFiles = Object.keys(zip.files).filter(n => /^\d+$/.test(n)).sort((a, b) => +a - +b)
            mediaMapping = {}
            for (let idx = 0; idx < Math.min(numberedFiles.length, filenames.length); idx++) {
              mediaMapping[numberedFiles[idx]] = filenames[idx]
            }
          }
        } catch {}
      }
    }
  } catch {}

  // Build reverse mapping: filename -> zip entry number
  const filenameToZipEntry = {}
  if (mediaMapping) {
    for (const [num, filename] of Object.entries(mediaMapping)) {
      filenameToZipEntry[filename] = num
    }
  }
  // Also check direct filenames in ZIP
  for (const name of Object.keys(zip.files)) {
    if (name !== 'media' && !name.startsWith('collection.') && name !== 'meta' && !zip.files[name].dir) {
      if (!filenameToZipEntry[name]) {
        filenameToZipEntry[name] = name
      }
    }
  }

  // Collect all referenced filenames from cards
  const referencedFiles = new Set()
  const imgRegex = /src="([^"]+)"/gi
  for (const card of cards) {
    const fields = [card.front, card.back, card.clozeText, card.extra, card.explanation].filter(Boolean)
    for (const field of fields) {
      let m
      imgRegex.lastIndex = 0
      while ((m = imgRegex.exec(field)) !== null) {
        const src = m[1]
        if (!src.startsWith('data:') && !src.startsWith('http')) {
          referencedFiles.add(src)
        }
      }
    }
  }

  if (referencedFiles.size === 0) return

  // Load referenced files and convert to base64
  const base64Map = {}
  for (const filename of referencedFiles) {
    const zipEntryName = filenameToZipEntry[filename]
    if (!zipEntryName) continue
    const file = zip.file(zipEntryName)
    if (!file) continue
    try {
      let data = await file.async('uint8array')
      // Decompress zstd if needed
      if (data.length > 4 && data[0] === 0x28 && data[1] === 0xB5 && data[2] === 0x2F && data[3] === 0xFD) {
        try { data = zstdDecompress(data) } catch {}
      }
      // Detect mime type
      let mime = 'image/png'
      if (data[0] === 0xFF && data[1] === 0xD8) mime = 'image/jpeg'
      else if (data[0] === 0x89 && data[1] === 0x50) mime = 'image/png'
      else if (data[0] === 0x47 && data[1] === 0x49) mime = 'image/gif'
      else if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) mime = 'image/webp'
      // Convert to base64
      let binary = ''
      for (let j = 0; j < data.length; j++) binary += String.fromCharCode(data[j])
      const b64 = btoa(binary)
      base64Map[filename] = `data:${mime};base64,${b64}`
    } catch {}
  }

  // Replace src references in all card fields
  for (const card of cards) {
    for (const key of ['front', 'back', 'clozeText', 'extra', 'explanation']) {
      if (card[key]) {
        card[key] = card[key].replace(/src="([^"]+)"/gi, (match, src) => {
          if (base64Map[src]) return `src="${base64Map[src]}"`
          return match
        })
      }
    }
  }
}

function getLocalDecks() {
  // Cache of deck metadata from API (for quick rendering)
  try {
    return JSON.parse(localStorage.getItem(LOCAL_DECKS_KEY) || '[]')
  } catch { return [] }
}

function saveLocalDecks(decks) {
  localStorage.setItem(LOCAL_DECKS_KEY, JSON.stringify(decks))
}

// Library = list of deck IDs the user has in their dashboard

function getMyLibrary() {
  try { return JSON.parse(localStorage.getItem(MY_LIBRARY_KEY) || '[]') } catch { return [] }
}

function addToLibrary(deckId) {
  const lib = getMyLibrary()
  if (!lib.includes(deckId)) {
    lib.push(deckId)
    localStorage.setItem(MY_LIBRARY_KEY, JSON.stringify(lib))
  }
}

function removeFromLibrary(deckId) {
  const lib = getMyLibrary().filter(id => id !== deckId)
  localStorage.setItem(MY_LIBRARY_KEY, JSON.stringify(lib))
}

function generateDeckId() {
  return 'deck_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
}

function renderLocalDecks() {
  const $list = document.getElementById('local-deck-list')
  if (!$list) return

  const library = getMyLibrary()

  // Show cached version immediately (filtered by library)
  const cached = getLocalDecks().filter(d => library.includes(d.id))
  renderLocalDecksList($list, cached)

  // Fetch fresh data from API
  apiGetDecks().then(decks => {
    saveLocalDecks(decks) // cache all
    const filtered = decks.filter(d => library.includes(d.id))
    renderLocalDecksList($list, filtered)
  })
}

function renderLocalDecksList($list, decks) {
  if (decks.length === 0) {
    $list.innerHTML = '<p class="local-empty">Brak talii. Stwórz nową lub sklonuj z listy ostatnich.</p>'
    return
  }

  $list.innerHTML = decks.map(d => {
    const date = new Date(d.updatedAt || d.createdAt)
    const dateStr = date.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' })
    const own = isOwnDeck(d.id)
    const editBtn = own ? `<button class="edit-btn" data-id="${d.id}" title="Edytuj">✏️</button>` : ''
    const deleteBtn = own
      ? `<button class="delete-btn" data-id="${d.id}" title="Usuń z serwera">🗑️</button><button class="remove-btn" data-id="${d.id}" title="Usuń z biblioteki">✕</button>`
      : `<button class="remove-btn" data-id="${d.id}" title="Usuń z biblioteki">✕</button>`
    const shareEditBtn = own ? `<button class="share-edit-btn" data-id="${d.id}" title="Udostępnij do edycji">🔗✏️</button>` : ''
    return `<div class="local-deck-item" data-id="${d.id}">
      <div class="local-deck-info" data-id="${d.id}">
        <div class="local-deck-name">${own ? '✏️' : '📄'} ${d.name}</div>
        <div class="local-deck-meta">${d.cardCount || 0} kart · ${dateStr}</div>
      </div>
      <div class="local-deck-actions">
        ${editBtn}
        <button class="play-btn" data-id="${d.id}" title="Ucz się">▶️</button>
        <button class="share-btn" data-id="${d.id}" title="Udostępnij (tylko podgląd)">🔗</button>
        ${shareEditBtn}
        <button class="export-single-btn" data-id="${d.id}" title="Eksportuj">📤</button>
        ${deleteBtn}
      </div>
    </div>`
  }).join('')

  // Event listeners
  $list.querySelectorAll('.local-deck-info').forEach(el => {
    el.addEventListener('click', () => openLocalDeck(el.dataset.id))
  })
  $list.querySelectorAll('.edit-btn').forEach(el => {
    el.addEventListener('click', (e) => { e.stopPropagation(); openEditor(el.dataset.id) })
  })
  $list.querySelectorAll('.play-btn').forEach(el => {
    el.addEventListener('click', (e) => { e.stopPropagation(); openLocalDeck(el.dataset.id) })
  })
  $list.querySelectorAll('.share-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      const shareUrl = new URL(window.location)
      shareUrl.search = ''
      shareUrl.searchParams.set('deck', el.dataset.id)
      navigator.clipboard.writeText(shareUrl.toString()).then(() => {
        el.textContent = '✅'
        setTimeout(() => { el.textContent = '🔗' }, 1500)
      })
    })
  })
  $list.querySelectorAll('.share-edit-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      const id = el.dataset.id
      const token = getOwnerToken(id)
      const shareUrl = new URL(window.location)
      shareUrl.search = ''
      shareUrl.searchParams.set('deck', id)
      if (token) shareUrl.searchParams.set('token', token)
      navigator.clipboard.writeText(shareUrl.toString()).then(() => {
        el.textContent = '✅'
        setTimeout(() => { el.textContent = '🔗✏️' }, 1500)
      })
    })
  })
  $list.querySelectorAll('.export-single-btn').forEach(el => {
    el.addEventListener('click', (e) => { e.stopPropagation(); exportDeck(el.dataset.id) })
  })
  $list.querySelectorAll('.delete-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      if (confirm('Usunąć tę talię z serwera? Tej operacji nie można cofnąć.')) {
        deleteLocalDeck(el.dataset.id, true)
      }
    })
  })
  $list.querySelectorAll('.remove-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      deleteLocalDeck(el.dataset.id, false)
    })
  })
}

async function deleteLocalDeck(id, fromServer) {
  if (fromServer) {
    await apiDeleteDeck(id)
  }
  removeFromLibrary(id)
  removeOwnerToken(id)
  renderLocalDecks()
}

async function openLocalDeck(id) {
  // Fetch the .apkg from the server and parse it like any other deck
  const fileUrl = apiDeckFileUrl(id)
  
  // Hide menu, show loading
  document.getElementById('recent-decks').classList.add('hidden')
  $loading.classList.remove('hidden')
  $loading.querySelector('p').textContent = 'Ładowanie talii...'

  // Use the existing loadApkg function — it handles everything
  // But we need to update the URL params so back button works
  const url = new URL(window.location)
  url.searchParams.set('deck', id)
  url.searchParams.delete('url')
  history.pushState(null, '', url)

  await loadApkg(fileUrl)
}

function exportDeck(id) {
  // Direct download from server
  window.location.href = apiDeckFileUrl(id)
}

/**
 * Generate a valid .apkg Blob from cards.
 * Creates a ZIP containing a SQLite database (collection.anki2) with proper Anki schema.
 */
async function generateApkgBlob(deckName, cards) {
  try {
    const initSqlJs = await loadSqlJs()
    const SQL = await initSqlJs({
      locateFile: (file) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/${file}`,
    })

    const db = new SQL.Database()

    // Create Anki 2.0 compatible schema
    const modelId = Date.now()
    const deckId = modelId + 1

    const models = {}
    models[modelId] = {
      id: modelId,
      name: 'Basic',
      type: 0,
      mod: Math.floor(Date.now() / 1000),
      usn: -1,
      sortf: 0,
      did: deckId,
      tmpls: [{
        name: 'Card 1',
        ord: 0,
        qfmt: '{{Front}}',
        afmt: '{{FrontSide}}<hr id=answer>{{Back}}',
        bqfmt: '',
        bafmt: '',
        did: null,
        bfont: '',
        bsize: 0,
      }],
      flds: [
        { name: 'Front', ord: 0, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] },
        { name: 'Back', ord: 1, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] },
      ],
      css: '.card { font-family: arial; font-size: 20px; text-align: center; color: black; background-color: white; }',
      latexPre: '',
      latexPost: '',
      latexsvg: false,
      req: [[0, 'any', [0]]],
      tags: [],
      vers: [],
    }

    const decksJson = {
      1: { id: 1, name: 'Default', mod: 0, usn: 0, lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0], collapsed: false, desc: '', dyn: 0, conf: 1, extendNew: 10, extendRev: 50 },
    }
    decksJson[deckId] = {
      id: deckId, name: deckName, mod: Math.floor(Date.now() / 1000), usn: -1,
      lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0],
      collapsed: false, desc: '', dyn: 0, conf: 1, extendNew: 10, extendRev: 50,
    }

    const dconf = { 1: { id: 1, name: 'Default', mod: 0, usn: 0, maxTaken: 60, autoplay: true, timer: 0, replayq: true, new: { delays: [1, 10], ints: [1, 4, 0], initialFactor: 2500, order: 1, perDay: 20 }, rev: { perDay: 200, ease4: 1.3, fuzz: 0.05, minSpace: 1, ivlFct: 1, maxIvl: 36500 }, lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 0 } } }

    db.run(`CREATE TABLE col (
      id integer primary key,
      crt integer not null,
      mod integer not null,
      scm integer not null,
      ver integer not null,
      dty integer not null,
      usn integer not null,
      ls integer not null,
      conf text not null,
      models text not null,
      decks text not null,
      dconf text not null,
      tags text not null
    )`)

    const now = Math.floor(Date.now() / 1000)
    db.run(`INSERT INTO col VALUES(1,?,?,?,11,0,-1,0,?,?,?,?,'{}')`, [
      now, now * 1000, now * 1000,
      JSON.stringify({ nextPos: cards.length, estTimes: true, activeDecks: [1], sortType: 'noteFld', timeLim: 0, sortBackwards: false, addToCur: true, curDeck: deckId, newSpread: 0, dueCounts: true, curModel: modelId, collapseTime: 1200 }),
      JSON.stringify(models),
      JSON.stringify(decksJson),
      JSON.stringify(dconf),
    ])

    db.run(`CREATE TABLE notes (
      id integer primary key,
      guid text not null,
      mid integer not null,
      mod integer not null,
      usn integer not null,
      tags text not null,
      flds text not null,
      sfld text not null,
      csum integer not null,
      flags integer not null,
      data text not null
    )`)

    db.run(`CREATE TABLE cards (
      id integer primary key,
      nid integer not null,
      did integer not null,
      ord integer not null,
      mod integer not null,
      usn integer not null,
      type integer not null,
      queue integer not null,
      due integer not null,
      ivl integer not null,
      factor integer not null,
      reps integer not null,
      lapses integer not null,
      left integer not null,
      odue integer not null,
      odid integer not null,
      flags integer not null,
      data text not null
    )`)

    db.run(`CREATE TABLE revlog (
      id integer primary key,
      cid integer not null,
      usn integer not null,
      ease integer not null,
      ivl integer not null,
      lastIvl integer not null,
      factor integer not null,
      time integer not null,
      type integer not null
    )`)

    db.run(`CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null)`)

    // Insert notes and cards
    const baseTs = Date.now()
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i]
      const noteId = baseTs + i
      const cardId = baseTs + cards.length + i
      const guid = Math.random().toString(36).slice(2, 12)

      let flds, sfld
      const type = card.type || 'basic'

      if (type === 'cloze') {
        // Store cloze text directly — Anki understands {{c1::...}} syntax
        const text = card.clozeText || card.front || ''
        const extra = card.extra || ''
        flds = text + '\x1f' + extra
        sfld = stripHtml(text)
      } else if (type === 'quiz') {
        // Store as front + options separated by field separator
        const opts = (card.options || []).join('\x1f')
        const mask = (card.options || []).map((_, oi) => (card.correctIndices || []).includes(oi) ? '1' : '0').join(' ')
        const explanation = card.explanation || ''
        flds = (card.front || '') + '\x1f' + opts + '\x1f' + mask + '\x1f' + explanation
        sfld = stripHtml(card.front || '')
      } else {
        flds = (card.front || '') + '\x1f' + (card.back || '')
        sfld = stripHtml(card.front || '')
      }

      // Simple checksum (first 8 digits of a hash)
      let csum = 0
      for (let j = 0; j < sfld.length; j++) { csum = ((csum << 5) - csum + sfld.charCodeAt(j)) | 0 }
      csum = Math.abs(csum)

      db.run(`INSERT INTO notes VALUES(?,?,?,?,?,'',?,?,?,0,'')`, [noteId, guid, modelId, now, -1, flds, sfld, csum])
      db.run(`INSERT INTO cards VALUES(?,?,?,0,?,?,-1,0,0,?,0,0,0,0,0,0,0,'')`, [cardId, noteId, deckId, now, -1, i])
    }

    const dbData = db.export()
    db.close()

    // Create ZIP (.apkg)
    const zip = new JSZip()
    zip.file('collection.anki2', dbData)
    zip.file('media', '{}')

    return await zip.generateAsync({ type: 'blob' })
  } catch (e) {
    alert('Błąd generowania .apkg: ' + e.message)
    console.error('[paczka-anki] apkg generation error:', e)
    return null
  }
}

async function exportAsApkg(deckName, cards) {
  const blob = await generateApkgBlob(deckName, cards)
  if (!blob) return
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${deckName.replace(/[^a-zA-Z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻ _-]/g, '')}.apkg`
  a.click()
  URL.revokeObjectURL(url)
}

// ============ DECK EDITOR ============

let currentEditingDeckId = null

async function openEditor(deckId) {
  currentEditingDeckId = deckId || null

  // Hide other views
  document.getElementById('recent-decks').classList.add('hidden')
  $content.classList.add('hidden')
  $error.classList.add('hidden')

  if (deckId) {
    // Load existing deck from server and parse for editing
    $loading.classList.remove('hidden')
    $loading.querySelector('p').textContent = 'Ładowanie talii do edycji...'

    try {
      const res = await fetch(apiDeckFileUrl(deckId))
      if (!res.ok) throw new Error('Nie udało się pobrać talii.')
      const buffer = await res.arrayBuffer()
      const zip = await JSZip.loadAsync(buffer)

      let dbBuffer = null
      if (zip.file('collection.anki21b')) {
        const compressed = await zip.file('collection.anki21b').async('uint8array')
        try { dbBuffer = zstdDecompress(compressed).buffer } catch {}
      }
      if (!dbBuffer) {
        const dbFile = zip.file('collection.anki21') || zip.file('collection.anki2')
        if (dbFile) dbBuffer = await dbFile.async('arraybuffer')
      }
      if (!dbBuffer) throw new Error('Nie znaleziono bazy kart.')

      const initSqlJs = await loadSqlJs()
      const SQL = await initSqlJs({ locateFile: (f) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/${f}` })
      const db = new SQL.Database(new Uint8Array(dbBuffer))

      const cards = extractCardsForEditor(db)
      db.close()

      // Replace local media references with server URLs (fast, no base64 conversion)
      for (const card of cards) {
        for (const key of ['front', 'back', 'clozeText', 'extra', 'explanation']) {
          if (card[key]) {
            card[key] = card[key].replace(/src="([^"]+)"/gi, (match, src) => {
              if (src.startsWith('data:') || src.startsWith('http') || src.startsWith('/')) return match
              return `src="/api/decks/${deckId}/media/${src}"`
            })
          }
        }
      }

      const decks = getLocalDecks()
      const meta = decks.find(d => d.id === deckId)

      $loading.classList.add('hidden')
      const $editor = document.getElementById('deck-editor')
      $editor.classList.remove('hidden')
      document.getElementById('editor-deck-name').value = meta?.name || ''
      renderEditorCards(cards)
    } catch (e) {
      $loading.classList.add('hidden')
      alert('Błąd ładowania: ' + e.message)
      document.getElementById('recent-decks').classList.remove('hidden')
    }
  } else {
    // New deck
    $loading.classList.add('hidden')
    const $editor = document.getElementById('deck-editor')
    $editor.classList.remove('hidden')
    document.getElementById('editor-deck-name').value = ''
    renderEditorCards([{ type: 'basic', front: '', back: '' }])
  }
}

function autoResizeTextarea(ta) {
  ta.style.height = 'auto'
  ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
}

function updateFieldPreview(ta) {
  // No longer needed with Quill
}

// Track active Quill instances
let editorQuills = []

const QUILL_TOOLBAR = [
  ['bold', 'italic', 'underline', 'strike'],
  [{ 'color': [] }],
  ['image'],
  ['clean']
]

function createQuillEditor(container, initialHtml) {
  const quill = new Quill(container, {
    theme: 'snow',
    modules: {
      toolbar: QUILL_TOOLBAR,
    },
    placeholder: 'Wpisz treść...',
  })
  if (initialHtml) {
    quill.root.innerHTML = initialHtml
  }
  return quill
}

function renderEditorCards(cards) {
  editorAllCards = cards
  editorPage = 0
  renderEditorPage()
}

const EDITOR_PAGE_SIZE = 10
let editorAllCards = []
let editorPage = 0

function renderEditorPage() {
  const cards = editorAllCards
  const $editorCards = document.getElementById('editor-cards')
  const total = cards.length
  const totalPages = Math.ceil(total / EDITOR_PAGE_SIZE)
  const start = editorPage * EDITOR_PAGE_SIZE
  const end = Math.min(start + EDITOR_PAGE_SIZE, total)
  const pageCards = cards.slice(start, end)

  document.getElementById('editor-card-count').textContent = `${total} kart (str. ${editorPage + 1}/${totalPages || 1})`

  // Destroy old quills
  editorQuills = []

  $editorCards.innerHTML = ''

  // Pagination controls top
  const pagHtml = totalPages > 1 ? `
    <div class="editor-pagination">
      <button class="fc-btn-small editor-prev" ${editorPage === 0 ? 'disabled' : ''}>← Poprzednia</button>
      <span class="editor-page-info">Karty ${start + 1}–${end} z ${total}</span>
      <button class="fc-btn-small editor-next" ${editorPage >= totalPages - 1 ? 'disabled' : ''}>Następna →</button>
    </div>
  ` : ''

  $editorCards.innerHTML = pagHtml + pageCards.map((card, pi) => {
    const i = start + pi
    const type = card.type || 'basic'
    let fieldsHtml = ''

    if (type === 'basic') {
      fieldsHtml = `
        <div class="editor-field">
          <label>Przód</label>
          <div class="quill-editor" data-index="${i}" data-field="front"></div>
        </div>
        <div class="editor-field">
          <label>Tył</label>
          <div class="quill-editor" data-index="${i}" data-field="back"></div>
        </div>
      `
    } else if (type === 'cloze') {
      fieldsHtml = `
        <div class="editor-field">
          <label>Tekst z lukami</label>
          <div class="quill-editor" data-index="${i}" data-field="clozeText"></div>
          <p class="editor-hint">Użyj {{c1::odpowiedź}} lub {{c1::odpowiedź::podpowiedź}} dla luk.</p>
        </div>
        <div class="editor-field">
          <label>Dodatkowe informacje (opcjonalnie)</label>
          <div class="quill-editor" data-index="${i}" data-field="extra"></div>
        </div>
      `
    } else if (type === 'quiz') {
      const options = card.options || ['', '', '', '']
      const correctIndices = card.correctIndices || []
      const optionsHtml = options.map((opt, oi) => `
        <div class="editor-option-row">
          <input type="checkbox" data-index="${i}" data-option="${oi}" ${correctIndices.includes(oi) ? 'checked' : ''} title="Poprawna odpowiedź" />
          <div class="quill-option" data-index="${i}" data-option="${oi}"></div>
          <button class="editor-option-remove" data-index="${i}" data-option="${oi}">✕</button>
        </div>
      `).join('')

      fieldsHtml = `
        <div class="editor-field">
          <label>Pytanie</label>
          <div class="quill-editor" data-index="${i}" data-field="front"></div>
        </div>
        <div class="editor-field">
          <label>Odpowiedzi (zaznacz poprawne)</label>
          <div class="editor-options-list" data-index="${i}">
            ${optionsHtml}
          </div>
          <button class="editor-add-option" data-index="${i}">+ Dodaj opcję</button>
        </div>
        <div class="editor-field">
          <label>Wyjaśnienie (opcjonalnie)</label>
          <div class="quill-editor" data-index="${i}" data-field="explanation"></div>
        </div>
      `
    }

    const typeBadge = type === 'quiz' ? 'quiz' : type === 'cloze' ? 'cloze' : ''
    const typeLabel = type === 'basic' ? 'Podstawowa' : type === 'cloze' ? 'Luka' : 'Quiz'

    return `
      <div class="editor-card" data-index="${i}" data-type="${type}">
        <div class="editor-card-header">
          <span class="editor-card-num">Karta ${i + 1}</span>
          <span class="editor-card-type ${typeBadge}">${typeLabel}</span>
          <button class="editor-card-delete" data-index="${i}">🗑️ Usuń</button>
        </div>
        ${fieldsHtml}
      </div>
    `
  }).join('')

  // Initialize Quill editors
  $editorCards.querySelectorAll('.quill-editor').forEach(el => {
    const idx = parseInt(el.dataset.index)
    const field = el.dataset.field
    const card = editorAllCards[idx]
    let html = ''
    if (card) {
      if (field === 'front') html = card.front || ''
      else if (field === 'back') html = card.back || ''
      else if (field === 'clozeText') html = card.clozeText || ''
      else if (field === 'extra') html = card.extra || ''
      else if (field === 'explanation') html = card.explanation || ''
    }
    const quill = createQuillEditor(el, html)
    editorQuills.push({ quill, index: idx, field })
  })

  // Initialize Quill for quiz options (compact toolbar)
  $editorCards.querySelectorAll('.quill-option').forEach(el => {
    const idx = parseInt(el.dataset.index)
    const oi = parseInt(el.dataset.option)
    const card = editorAllCards[idx]
    const html = (card && card.options && card.options[oi]) || ''
    const quill = new Quill(el, {
      theme: 'snow',
      modules: { toolbar: false },
      placeholder: `Opcja ${oi + 1}...`,
    })
    if (html) quill.root.innerHTML = html
    editorQuills.push({ quill, index: idx, field: `option_${oi}` })
  })

  // Delete card handlers
  $editorCards.querySelectorAll('.editor-card-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index)
      syncEditorPageToCards()
      editorAllCards.splice(idx, 1)
      // Adjust page if needed
      const totalPages = Math.ceil(editorAllCards.length / EDITOR_PAGE_SIZE)
      if (editorPage >= totalPages && editorPage > 0) editorPage--
      renderEditorPage()
    })
  })

  // Add option handlers (quiz)
  $editorCards.querySelectorAll('.editor-add-option').forEach(btn => {
    btn.addEventListener('click', () => {
      syncEditorPageToCards()
      const idx = parseInt(btn.dataset.index)
      if (editorAllCards[idx] && editorAllCards[idx].type === 'quiz') {
        editorAllCards[idx].options.push('')
        renderEditorPage()
      }
    })
  })

  // Remove option handlers (quiz)
  $editorCards.querySelectorAll('.editor-option-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      syncEditorPageToCards()
      const idx = parseInt(btn.dataset.index)
      const oi = parseInt(btn.dataset.option)
      if (editorAllCards[idx] && editorAllCards[idx].type === 'quiz') {
        editorAllCards[idx].options.splice(oi, 1)
        editorAllCards[idx].correctIndices = (editorAllCards[idx].correctIndices || [])
          .filter(ci => ci !== oi)
          .map(ci => ci > oi ? ci - 1 : ci)
        renderEditorPage()
      }
    })
  })

  // Pagination handlers
  const prevBtn = $editorCards.querySelector('.editor-prev')
  const nextBtn = $editorCards.querySelector('.editor-next')
  if (prevBtn) prevBtn.addEventListener('click', () => { syncEditorPageToCards(); editorPage--; renderEditorPage() })
  if (nextBtn) nextBtn.addEventListener('click', () => { syncEditorPageToCards(); editorPage++; renderEditorPage() })
}

function getEditorCards() {
  syncEditorPageToCards()
  return [...editorAllCards]
}

/** Sync current page's Quill editors back into editorAllCards */
function syncEditorPageToCards() {
  const $editorCards = document.getElementById('editor-cards')
  const cardEls = $editorCards.querySelectorAll('.editor-card')
  cardEls.forEach((el) => {
    const i = parseInt(el.dataset.index)
    const type = el.dataset.type || 'basic'

    function getQuillHtml(field) {
      const entry = editorQuills.find(q => q.index === i && q.field === field)
      if (!entry) return ''
      const html = entry.quill.root.innerHTML
      return html === '<p><br></p>' ? '' : html
    }

    if (type === 'basic') {
      editorAllCards[i] = { type: 'basic', front: getQuillHtml('front'), back: getQuillHtml('back') }
    } else if (type === 'cloze') {
      editorAllCards[i] = { type: 'cloze', clozeText: getQuillHtml('clozeText'), extra: getQuillHtml('extra') }
    } else if (type === 'quiz') {
      const optionRows = el.querySelectorAll('.editor-option-row')
      const options = []
      const correctIndices = []
      optionRows.forEach((row, oi) => {
        const optQuill = editorQuills.find(q => q.index === i && q.field === `option_${oi}`)
        let text = ''
        if (optQuill) {
          text = optQuill.quill.root.innerHTML
          if (text === '<p><br></p>') text = ''
        }
        const checked = row.querySelector('input[type="checkbox"]').checked
        options.push(text)
        if (checked) correctIndices.push(oi)
      })
      editorAllCards[i] = { type: 'quiz', front: getQuillHtml('front'), options, correctIndices, explanation: getQuillHtml('explanation') }
    }
  })
}

async function saveEditorDeck() {
  const name = document.getElementById('editor-deck-name').value.trim()
  if (!name) {
    alert('Podaj nazwę talii.')
    return false
  }
  const cards = getEditorCards()

  // Generate .apkg blob
  const apkgBlob = await generateApkgBlob(name, cards)
  if (!apkgBlob) return false

  // Upload to server
  try {
    if (currentEditingDeckId) {
      await apiUpdateDeck(currentEditingDeckId, apkgBlob, name, cards.length)
    } else {
      const result = await apiUploadDeck(apkgBlob, name, cards.length)
      currentEditingDeckId = result.id
    }
    // Refresh local cache
    const fresh = await apiGetDecks()
    saveLocalDecks(fresh)
    return true
  } catch (e) {
    alert('Błąd zapisu: ' + e.message)
    return false
  }
}

// Editor event listeners
document.getElementById('editor-back').addEventListener('click', () => {
  if (getEditorCards().length > 0 || document.getElementById('editor-deck-name').value.trim()) {
    if (!confirm('Wyjść bez zapisywania?')) return
  }
  closeEditor()
})

document.getElementById('editor-save').addEventListener('click', async () => {
  if (await saveEditorDeck()) {
    closeEditor()
  }
})

document.getElementById('editor-export').addEventListener('click', async () => {
  const name = document.getElementById('editor-deck-name').value.trim() || 'Bez nazwy'
  const cards = getEditorCards()
  if (cards.length === 0) {
    alert('Dodaj przynajmniej jedną kartę przed eksportem.')
    return
  }
  await exportAsApkg(name, cards)
})

document.getElementById('editor-add-basic').addEventListener('click', () => {
  syncEditorPageToCards()
  editorAllCards.push({ type: 'basic', front: '', back: '' })
  editorPage = Math.ceil(editorAllCards.length / EDITOR_PAGE_SIZE) - 1
  renderEditorPage()
})

document.getElementById('editor-add-cloze').addEventListener('click', () => {
  syncEditorPageToCards()
  editorAllCards.push({ type: 'cloze', clozeText: '', extra: '' })
  editorPage = Math.ceil(editorAllCards.length / EDITOR_PAGE_SIZE) - 1
  renderEditorPage()
})

document.getElementById('editor-add-quiz').addEventListener('click', () => {
  syncEditorPageToCards()
  editorAllCards.push({ type: 'quiz', front: '', options: ['', '', '', ''], correctIndices: [0], explanation: '' })
  editorPage = Math.ceil(editorAllCards.length / EDITOR_PAGE_SIZE) - 1
  renderEditorPage()
})

function closeEditor() {
  document.getElementById('deck-editor').classList.add('hidden')
  // Return to menu
  const $recent = document.getElementById('recent-decks')
  $recent.classList.remove('hidden')
  renderLocalDecks()
  currentEditingDeckId = null
}

// ============ CREATE / IMPORT DECK ============

document.getElementById('create-deck-btn').addEventListener('click', () => {
  openEditor(null) // null triggers new deck creation in openEditor
})

document.getElementById('import-deck-btn').addEventListener('click', () => {
  document.getElementById('import-deck-input').click()
})

document.getElementById('import-deck-input').addEventListener('change', (e) => {
  const file = e.target.files[0]
  if (!file) return

  const reader = new FileReader()
  reader.onload = async () => {
    try {
      const buffer = reader.result
      const zip = await JSZip.loadAsync(buffer)

      // Parse to get deck name and card count
      let dbBuffer = null
      if (zip.file('collection.anki21b')) {
        const compressed = await zip.file('collection.anki21b').async('uint8array')
        try { dbBuffer = zstdDecompress(compressed).buffer } catch {}
      }
      if (!dbBuffer) {
        const dbFile = zip.file('collection.anki21') || zip.file('collection.anki2')
        if (dbFile) dbBuffer = await dbFile.async('arraybuffer')
      }
      if (!dbBuffer) throw new Error('Nie znaleziono bazy kart w pliku .apkg.')

      const initSqlJs = await loadSqlJs()
      const SQL = await initSqlJs({ locateFile: (f) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/${f}` })
      const db = new SQL.Database(new Uint8Array(dbBuffer))

      let deckName = file.name.replace('.apkg', '')
      try {
        const colResult = db.exec("SELECT decks FROM col LIMIT 1")
        if (colResult.length > 0 && colResult[0].values.length > 0) {
          const decks = JSON.parse(colResult[0].values[0][0])
          const deckKeys = Object.keys(decks).filter(k => k !== '1')
          if (deckKeys.length > 0) deckName = decks[deckKeys[0]].name || deckName
        }
      } catch {}

      let cardCount = 0
      try {
        const countResult = db.exec("SELECT COUNT(*) FROM notes")
        if (countResult.length > 0) cardCount = countResult[0].values[0][0]
      } catch {}
      db.close()

      // Upload raw .apkg to server
      const blob = new Blob([buffer], { type: 'application/octet-stream' })
      await apiUploadDeck(blob, deckName, cardCount)

      // Refresh
      const fresh = await apiGetDecks()
      saveLocalDecks(fresh)
      renderLocalDecks()
      alert(`Zaimportowano talię "${deckName}" (${cardCount} kart).`)
    } catch (err) {
      alert('Błąd importu: ' + err.message)
      console.error('[paczka-anki] Import error:', err)
    }
  }
  reader.readAsArrayBuffer(file)
  e.target.value = ''
})

// ============ CLONE FROM RECENT ============

function cloneRecentDeck(url, name) {
  // This clones the currently loaded deck from a recent URL to a local deck
  // We need to load the deck first, then save its cards locally
  const $recent = document.getElementById('recent-decks')
  $recent.classList.add('hidden')
  $loading.classList.remove('hidden')
  $loading.querySelector('p').textContent = 'Klonowanie talii...'

  // Fetch and parse the deck
  cloneApkg(url, name)
}

async function cloneApkg(url, deckDisplayName) {
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const buffer = await response.arrayBuffer()

    // Parse to get card count
    const zip = await JSZip.loadAsync(buffer)
    let dbBuffer = null
    if (zip.file('collection.anki21b')) {
      const compressed = await zip.file('collection.anki21b').async('uint8array')
      try { dbBuffer = zstdDecompress(compressed).buffer } catch {}
    }
    if (!dbBuffer) {
      const dbFile = zip.file('collection.anki21') || zip.file('collection.anki2')
      if (dbFile) dbBuffer = await dbFile.async('arraybuffer')
    }

    let cardCount = 0
    if (dbBuffer) {
      const initSqlJs = await loadSqlJs()
      const SQL = await initSqlJs({ locateFile: (f) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/${f}` })
      const db = new SQL.Database(new Uint8Array(dbBuffer))
      try {
        const countResult = db.exec("SELECT COUNT(*) FROM notes")
        if (countResult.length > 0) cardCount = countResult[0].values[0][0]
      } catch {}
      db.close()
    }

    // Upload the raw .apkg to server
    const blob = new Blob([buffer], { type: 'application/octet-stream' })
    const name = deckDisplayName + ' (klon)'
    await apiUploadDeck(blob, name, cardCount)

    // Refresh
    const fresh = await apiGetDecks()
    saveLocalDecks(fresh)

    $loading.classList.add('hidden')
    document.getElementById('recent-decks').classList.remove('hidden')
    renderLocalDecks()
    alert(`Sklonowano talię "${name}" (${cardCount} kart). Możesz ją teraz edytować.`)
  } catch (e) {
    $loading.classList.add('hidden')
    document.getElementById('recent-decks').classList.remove('hidden')
    alert('Błąd klonowania: ' + e.message)
  }
}

// ============ PATCH showRecentDecks to include clone buttons & local decks ============
// (Already patched above — showRecentDecks includes clone buttons and renderLocalDecks call)


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

function showError(msg) {
  $loading.classList.add('hidden')
  $error.classList.remove('hidden')
  $error.textContent = msg
}

function showContent() {
  $loading.classList.add('hidden')
  $content.classList.remove('hidden')
}

function stripHtml(html) {
  const div = document.createElement('div')
  div.innerHTML = html
  return div.textContent || div.innerText || ''
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
  if (fields.length < 5) return false
  // If we have field names, check for quiz-like structure
  if (names.length > 0) {
    const lower = names.map(n => n.toLowerCase())
    const hasQuestion = lower.some(n => n.includes('question') || n.includes('pytanie'))
    // Check for numbered answer/option fields (Answer 1, Q_1, etc.)
    const hasNumberedOptions = lower.some(n => /^(q_?\d|answer_?\s*\d|opt(ion)?_?\s*\d)/i.test(n))
    if (hasQuestion && hasNumberedOptions) return true
  }
  // Fallback: look for answer mask pattern
  for (let i = fields.length - 1; i >= Math.max(2, fields.length - 4); i--) {
    const f = fields[i].trim()
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
    if (n === 'answers' || n === 'answer' || n.includes('correct') || n.includes('poprawna') || n.includes('mask')) {
      if (/^[01](\s+[01])+$/.test((fields[i] || '').trim())) {
        maskIdx = i
        break
      }
    }
  }
  // Fallback: search by content pattern
  if (maskIdx === -1) {
    for (let i = fields.length - 1; i >= 2; i--) {
      if (/^[01](\s+[01])+$/.test(fields[i].trim())) {
        maskIdx = i
        break
      }
    }
  }
  
  // Identify option fields: Q_1, Q_2, Answer 1, Answer 2, etc.
  const options = []
  const optionFieldIndices = []
  for (let i = 0; i < names.length; i++) {
    const n = lowerNames[i]
    if (/^q_?\d+$/.test(n) || /^answer_?\s*\d+$/i.test(n) || /^(opt|option)_?\s*\d*$/i.test(n) || /^(a|b|c|d|e)$/i.test(n)) {
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
    if (n.includes('extra') || n.includes('explanation') || n.includes('wyjaśn') || n.includes('wyjasn')) {
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

    // Restore mode from URL
    const initialMode = params.get('mode')
    if (initialMode === 'flashcard') {
      setMode('flashcard')
    }

  } catch (e) {
    showError(`Błąd ładowania: ${e.message}`)
  }
}

// Get URL from query params
const params = new URLSearchParams(window.location.search)
const fileUrl = params.get('url')

if (!fileUrl) {
  showError('Brak parametru ?url= z adresem pliku .apkg')
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

const fs = require('fs')
const path = require('path')
const { autoMataCorrect, normalizeVi } = require('./automata_dfa_match_v2.js')

// ---------- Perfect Match Detection ----------

/**
 * Normalize Vietnamese text for perfect match comparison
 * - NFC normalization for consistent Unicode representation
 * - Preserve diacritics
 * - Convert to lowercase
 * - Collapse multiple spaces
 */
function normalizeVietnameseText(text) {
  if (!text) return ''
  return text
    .normalize('NFC') // Normalize Unicode to NFC form
    .toLowerCase() // Convert to lowercase
    .replace(/\s+/g, ' ') // Collapse multiple spaces
    .trim() // Remove leading/trailing spaces
}

/**
 * Check if transcript and prompt are perfect matches after normalization
 * Also checks for substring perfect matches (when prompt is contained in transcript)
 * Enhanced with year number correction (e.g., "124" -> "2024")
 */
function isPerfectMatch(transcript, prompt) {
  const normalizedTranscript = normalizeVietnameseText(transcript)
  const normalizedPrompt = normalizeVietnameseText(prompt)

  // Check for exact full match
  if (normalizedTranscript === normalizedPrompt) {
    return true
  }

  // Check for substring perfect match (prompt contained in transcript)
  if (normalizedTranscript.includes(normalizedPrompt) && normalizedPrompt.length > 3) {
    return true
  }

  // Check for year number correction (e.g., "124" -> "2024")
  if (checkYearNumberCorrection(normalizedTranscript, normalizedPrompt)) {
    return true
  }

  return false
}

/**
 * Check if prompt has a 3-digit year number that should match a 4-digit year in transcript
 * Example: "124 lên 105,26 tỷ $" should match "2024 lên 105,26 tỷ usd"
 */
function checkYearNumberCorrection(transcript, prompt) {
  // Find 3-digit numbers in prompt (likely truncated years)
  const prompt3DigitYears = prompt.match(/\b\d{3}\b/g) || []

  if (prompt3DigitYears.length === 0) return false

  // Find 4-digit numbers in transcript (likely complete years)
  const transcript4DigitYears = transcript.match(/\b\d{4}\b/g) || []

  if (transcript4DigitYears.length === 0) return false

  // Check each combination
  for (const promptYear of prompt3DigitYears) {
    for (const transcriptYear of transcript4DigitYears) {
      // Check if the last 3 digits match (e.g., "124" matches "2024")
      if (transcriptYear.endsWith(promptYear)) {
        // Create corrected prompt by replacing the 3-digit year with 4-digit year
        const correctedPrompt = prompt.replace(new RegExp(`\\b${promptYear}\\b`, 'g'), transcriptYear)

        // Check if the corrected prompt is now a substring of transcript
        if (transcript.includes(correctedPrompt) && correctedPrompt.length > 10) {
          return true
        }

        // Also check if transcript contains the corrected prompt as exact match
        if (transcript === correctedPrompt) {
          return true
        }
      }
    }
  }

  return false
}

// Map single number words to digits
const VI_NUM = new Map(
  Object.entries({
    không: 0,
    khong: 0,
    một: 1,
    mốt: 1,
    hai: 2,
    ba: 3,
    bốn: 4,
    tư: 4,
    năm: 5,
    lăm: 5,
    nhăm: 5,
    sáu: 6,
    bảy: 7,
    tám: 8,
    tam: 3,
    chín: 9,
    mười: 10,
    'hai mươi': 20,
    'ba mươi': 30,
    'bốn mươi': 40,
    'năm mươi': 50,
    'năm nhăm': 55,
    'sáu mươi': 60,
    'bảy mươi': 70,
    'tám mươi': 80,
    'chín mươi': 90
  })
)

function wordToDigit(w) {
  const key = w.normalize('NFC').toLowerCase()
  if (VI_NUM.has(key)) return VI_NUM.get(key)
  return null
}

// Parse small Vietnamese numbers (1..31) like "mười hai", "hai mươi mốt", "ba mươi mốt"
function parseSmallViNumber(tokens, i) {
  const t = (k) => (tokens[i + k] || '').toLowerCase()

  // CHẤP NHẬN CHỮ SỐ "2", "09"
  if (/^\d{1,2}$/.test(t(0))) {
    const val = Number(t(0))
    if (val >= 0 && val <= 31) return { val, used: 1 }
  }

  // TỪ 1..10 viết bằng chữ
  const d0 = wordToDigit(t(0))
  if (d0 !== null) {
    if (d0 <= 10) {
      if (d0 === 10) {
        const d1 = wordToDigit(t(1))
        if (d1 !== null && d1 >= 1 && d1 <= 9) return { val: 10 + d1, used: 2 }
        return { val: 10, used: 1 }
      }
      return { val: d0, used: 1 }
    }
  }

  // "<digit> mươi [đơn vị]"
  const tensDigit = d0
  if (tensDigit && tensDigit >= 2 && t(1) === 'mươi') {
    let val = tensDigit * 10
    const unit = wordToDigit(t(2))
    if (unit !== null && unit >= 1 && unit <= 9) {
      val += unit
      return { val, used: 3 }
    }
    return { val, used: 2 }
  }

  return null
}

// Convert "ngày <num-words> tháng <num-words> năm <digits>" -> "d m yyyy"
function normalizeDateWordsToDigits(s) {
  // Simple approach: replace Vietnamese number words with digits
  let result = s

  // Replace month names
  const monthMap = {
    'tháng một': '1',
    'tháng hai': '2',
    'tháng ba': '3',
    'tháng tư': '4',
    'tháng năm': '5',
    'tháng sáu': '6',
    'tháng bảy': '7',
    'tháng tám': '8',
    'tháng chín': '9',
    'tháng mười': '10',
    'tháng mười một': '11',
    'tháng mười hai': '12',
    'thang mot': '1',
    'thang hai': '2',
    'thang ba': '3',
    'thang tu': '4',
    'thang nam': '5',
    'thang sau': '6',
    'thang bay': '7',
    'thang tam': '8',
    'thang chin': '9',
    'thang muoi': '10',
    'thang muoi mot': '11',
    'thang muoi hai': '12'
  }

  for (const [viet, digit] of Object.entries(monthMap)) {
    result = result.replace(new RegExp(`\\b${viet}\\b`, 'gi'), digit)
  }

  // Replace standalone number words (but be careful with context-sensitive words)
  const numberMap = {
    một: '1',
    mot: '1',
    mốt: '1',
    một: '1',
    môt: '1',
    hai: '2',
    ba: '3',
    tư: '4',
    bon: '4',
    // Don't replace "năm" when followed by 4-digit years (năm 1945 = year 1945)
    // năm: '5',  // Commented out - context-sensitive
    lam: '5',
    lăm: '5',
    sáu: '6',
    sau: '6',
    bảy: '7',
    tám: '8',
    tam: '8',
    chín: '9',
    chin: '9',
    mười: '10',
    muoi: '10'
  }

  for (const [viet, digit] of Object.entries(numberMap)) {
    result = result.replace(new RegExp(`\\b${viet}\\b`, 'gi'), digit)
  }

  // Handle "năm" carefully - only replace when NOT followed by 4-digit years
  result = result.replace(/\bnăm\b(?!\s*\d{4})/gi, '5')

  // Remove date-related words and clean up
  result = result.replace(/\b(tháng|ngày|mùng|mồng|móng)\b/gi, '')
  // Remove "năm" when it's followed by a 4-digit year (năm 1945 -> 1945)
  result = result.replace(/\bnăm\s+(\d{4})\b/gi, '$1')
  result = result.replace(/\s+/g, ' ').trim()

  return result
}

// Convert numeric dates like 2/9/1945 or 02-09-1945 into "2 9 1945"
function numericDatesToSpaces(text) {
  return text.replace(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/g, (_, d, m, y) => `${Number(d)} ${Number(m)} ${y}`)
}

/**
 * Normalize transcript before matching:
 * - Convert numeric dates (2/9/1945) -> "2 9 1945"
 * - Strip punctuation (keep diacritics)
 * - Collapse spaces
 */
function normalizeTranscriptForMatch(txt) {
  if (!txt) return ''
  let t = String(txt)

  // 1) numeric dd/mm/yyyy -> "d m yyyy" BEFORE stripping punctuation
  t = numericDatesToSpaces(t)

  // Remove boilerplate/URLs
  t = t
    .replace(/# URL:.*?\n/g, ' ')
    .replace(/\(Dân trí\)\s*-/gi, ' ')
    .replace(/https?:\/\/[^\s]+/g, ' ')
    .replace(/\bTranscript\b/gi, ' ')
    .replace(/\(Dân\s*Trí\)/gi, ' ')

  // 2) strip punctuation (keep diacritics)
  t = t.replace(/[.,;:!?()[\]{}"“”‘’–—…/\\|+*=<>&%$#@~`^]/g, ' ')

  // 3) collapse spaces
  t = t.replace(/\s+/g, ' ').trim()

  // 4) Convert Vietnamese date words to digits: "ngày 2 tháng chín năm 1945" -> "2 9 1945"
  t = normalizeDateWordsToDigits(t)

  return t
}

/** Normalize audio/prompt similarly (for symmetry) */
function normalizePromptForMatch(txt) {
  if (!txt) return ''
  let t = String(txt)

  // 1) numeric date -> "d m yyyy"
  t = numericDatesToSpaces(t)

  // 2) strip punctuation but KEEP diacritics
  t = t.replace(/[.,;:!?()[\]{}"“”‘’–—…/\\|+*=<>&%$#@~`^]/g, ' ')

  // 3) collapse
  t = t.replace(/\s+/g, ' ').trim()

  // 4) date words -> digits
  t = normalizeDateWordsToDigits(t)
  return t
}

/**
 * Fix prompt file using DFA matching algorithm (v2)
 * For each line: audioId|audioText
 * Enhanced with used segments tracking to avoid reusing transcript segments
 */
function fixPromptFileV2(promptPath, audiosDir, logPath) {
  console.log(
    '🚀 Starting DFA-based prompt fixing process (v2 with date normalization + smart used segments tracking)...'
  )
  const startTime = Date.now()

  const promptLines = fs.readFileSync(promptPath, 'utf8').split('\n').filter(Boolean)
  let fixedLines = []
  let logLines = []
  let skippedCount = 0

  // Track used segments for each transcript file to avoid reusing
  const transcriptUsedSegments = new Map() // transcriptPath -> array of {start, end}

  for (const line of promptLines) {
    const [audioId, promptRaw] = line.split('|')
    if (!audioId || !promptRaw) continue

    const parts = audioId.split('_')
    if (parts.length < 2) continue
    const category = parts[0]
    const id = parts[1]
    const transcriptPath = path.join(audiosDir, category, id, 'transcript.txt')

    let transcriptRaw = ''
    try {
      if (fs.existsSync(transcriptPath)) {
        transcriptRaw = fs.readFileSync(transcriptPath, 'utf8')
      }
    } catch (err) {
      continue
    }
    if (!transcriptRaw) continue

    // Normalize both sides with date canon
    const prompt = normalizePromptForMatch(promptRaw)
    const cleanTranscript = normalizeTranscriptForMatch(transcriptRaw)

    // Check for perfect match first
    if (isPerfectMatch(cleanTranscript, prompt)) {
      fixedLines.push(`${audioId}|${promptRaw}`)
      logLines.push(`[PERFECT_MATCH] Score: 1.000 | ${audioId}|${promptRaw} => ${promptRaw}`)
      continue
    }

    // Get used segments for this transcript
    const usedSegments = transcriptUsedSegments.get(transcriptPath) || []

    // Run DFA matching (keep diacritics) with used segments tracking
    const result = autoMataCorrect(prompt, cleanTranscript, {
      acceptThreshold: 0.8,
      maxSkip: 2,
      weights: { start: 0.35, middle: 0.3, end: 0.35 },
      normalize: { stripPunct: true, removeDiacritics: false }, // KEEP diacritics
      usedSegments: usedSegments // Pass used segments to avoid reusing
    })

    let bestLine = promptRaw
    let action = 'NO_MATCH'
    let bestScore = result.score || 0 // <-- luôn dùng score thực trả về
    if (result.accepted) {
      bestLine = result.corrected
      action = 'DFA_MATCH'
      fixedLines.push(`${audioId}|${bestLine}`) // Chỉ lưu khi có match

      // Track the used segment to avoid reusing it - only for high-quality matches
      if (result.usedSegment && bestScore >= 0.85) {
        // Only track high-quality matches
        if (!transcriptUsedSegments.has(transcriptPath)) {
          transcriptUsedSegments.set(transcriptPath, [])
        }
        transcriptUsedSegments.get(transcriptPath).push(result.usedSegment)
        logLines.push(
          `[${action}] Score: ${bestScore.toFixed(3)} | Used segment: [${result.usedSegment.start}-${result.usedSegment.end}] | ${audioId}|${promptRaw} => ${bestLine}`
        )
      } else {
        logLines.push(`[${action}] Score: ${bestScore.toFixed(3)} | ${audioId}|${promptRaw} => ${bestLine}`)
      }
    } else {
      logLines.push(`[${action}] Score: ${bestScore.toFixed(3)} | ${audioId}|${promptRaw} => ${bestLine}`)
    }
  }

  const fixedPath = path.join(path.dirname(promptPath), 'prompt_fixed_V2.txt')
  fs.writeFileSync(fixedPath, fixedLines.join('\n'), 'utf8')
  fs.writeFileSync(logPath, logLines.join('\n'), 'utf8')

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
  const totalProcessed = promptLines.length
  const totalFixed = fixedLines.length
  const totalSkipped = totalProcessed - totalFixed

  // Log statistics about used segments
  let totalUsedSegments = 0
  for (const segments of transcriptUsedSegments.values()) {
    totalUsedSegments += segments.length
  }

  console.log(`🎉 COMPLETED in ${totalTime}s`)
  console.log(`📊 Total processed: ${totalProcessed}`)
  console.log(`✅ Successfully fixed: ${totalFixed}`)
  console.log(`⏭️ Skipped (no match): ${totalSkipped}`)
  console.log(`🎯 Used transcript segments: ${totalUsedSegments}`)
  console.log(`📁 Fixed prompts: ${fixedPath}`)
  console.log(`📄 Log: ${logPath}`)

  return {
    totalProcessed,
    totalFixed,
    totalSkipped,
    usedSegments: totalUsedSegments
  }
}

// Main execution with cache support
if (require.main === module) {
  const promptPath = path.resolve(__dirname, 'prompt_V2.txt')
  const audiosDir = path.resolve(__dirname, 'dantri_audios')
  const logPath = path.resolve(__dirname, 'fix_prompt_log_V2.txt')

  fixPromptFileV2(promptPath, audiosDir, logPath)
}

// Uncomment to run tests
// testNormalization()

module.exports = {
  fixPromptFileV2,
  normalizeTranscriptForMatch,
  normalizePromptForMatch,
  normalizeDateWordsToDigits,
  numericDatesToSpaces,
  normalizeVietnameseText,
  isPerfectMatch,
  checkYearNumberCorrection
}

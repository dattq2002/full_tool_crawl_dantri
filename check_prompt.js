const fs = require('fs')
const path = require('path')

/**
 * Script để kiểm tra xem các prompt đã sửa có matching với transcript không
 * Đọc file prompt_fixed_V2.txt và kiểm tra từng prompt trong file transcript tương ứng
 */
function checkPromptMatching(promptFixedPath, audiosDir, logPath) {
  console.log('🔍 Bắt đầu kiểm tra matching giữa prompt và transcript...')

  const startTime = Date.now()

  // Đọc file prompt đã sửa
  const promptLines = fs.readFileSync(promptFixedPath, 'utf8').split('\n').filter(Boolean)
  let totalChecked = 0
  let totalMatched = 0
  let totalNotMatched = 0
  let logLines = []

  console.log(`📋 Tổng số prompt cần kiểm tra: ${promptLines.length}`)

  for (const line of promptLines) {
    const [audioId, promptText] = line.split('|')
    if (!audioId || !promptText) continue

    totalChecked++

    // Phân tích audioId để tìm file transcript
    const parts = audioId.split('_')
    if (parts.length < 2) {
      logLines.push(`[ERROR] Invalid audioId format: ${audioId}`)
      totalNotMatched++
      continue
    }

    const category = parts[0]
    const id = parts[1]
    const transcriptPath = path.join(audiosDir, category, id, 'transcript.txt')

    try {
      if (!fs.existsSync(transcriptPath)) {
        logLines.push(`[NOT_FOUND] Transcript file not found: ${transcriptPath} | ${audioId}|${promptText}`)
        totalNotMatched++
        continue
      }

      // Đọc và normalize transcript
      const transcriptRaw = fs.readFileSync(transcriptPath, 'utf8')

      // Normalize transcript và prompt
      const normalizedTranscript = normalizeTranscriptForCheck(transcriptRaw)
      const normalizedPrompt = normalizePromptForCheck(promptText)

      // Kiểm tra matching
      const isMatched = normalizedTranscript.includes(normalizedPrompt)

      if (isMatched) {
        logLines.push(`[MATCHED] ✅ Found in transcript | ${audioId}|${promptText}`)
        totalMatched++
      } else {
        logLines.push(`[NOT_MATCHED] ❌ Not found in transcript | ${audioId}|${promptText}`)
        totalNotMatched++
      }
    } catch (err) {
      logLines.push(`[ERROR] ${err.message} | ${audioId}|${promptText}`)
      totalNotMatched++
    }
  }

  // Ghi log ra file
  fs.writeFileSync(logPath, logLines.join('\n'), 'utf8')

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)

  console.log(`\n🎉 HOÀN THÀNH trong ${totalTime}s`)
  console.log(`📊 Tổng số đã kiểm tra: ${totalChecked}`)
  console.log(`✅ Đã match: ${totalMatched}`)
  console.log(`❌ Không match: ${totalNotMatched}`)
  console.log(`📁 File log: ${logPath}`)

  return {
    totalChecked,
    totalMatched,
    totalNotMatched
  }
}

/**
 * Normalize transcript để kiểm tra (giống như trong fix_prompt_file_V2.js)
 */
function normalizeTranscriptForCheck(txt) {
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

  // 2) strip punctuation (keep diacritics) - LOẠI BỎ KÝ TỰ ĐẶC BIỆT
  t = t.replace(/[.,;:!?()[\]{}"“”‘’–—…/\\|+*=<>&%$#@~`^→]/g, ' ')

  // 3) collapse spaces
  t = t.replace(/\s+/g, ' ').trim()

  // 4) Convert Vietnamese date words to digits
  t = normalizeDateWordsToDigits(t)

  // 5) Convert to lowercase for case-insensitive matching
  t = t.toLowerCase()

  return t
}

/**
 * Normalize prompt để kiểm tra
 */
function normalizePromptForCheck(txt) {
  if (!txt) return ''
  let t = String(txt)

  // 1) numeric date -> "d m yyyy"
  t = numericDatesToSpaces(t)

  // 2) strip punctuation but KEEP diacritics - LOẠI BỎ KÝ TỰ ĐẶC BIỆT
  t = t.replace(/[.,;:!?()[\]{}"“”‘’–—…/\\|+*=<>&%$#@~`^→]/g, ' ')

  // 3) collapse
  t = t.replace(/\s+/g, ' ').trim()

  // 4) date words -> digits
  t = normalizeDateWordsToDigits(t)

  // 5) Convert to lowercase for case-insensitive matching
  t = t.toLowerCase()

  return t
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

  // Replace standalone number words
  const numberMap = {
    một: '1',
    mot: '1',
    mốt: '1',
    hai: '2',
    ba: '3',
    tư: '4',
    bon: '4',
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

  // Handle "năm" carefully
  result = result.replace(/\bnăm\b(?!\s*\d{4})/gi, '5')

  // Remove date-related words and clean up
  result = result.replace(/\b(tháng|ngày|mùng|mồng|móng)\b/gi, '')
  result = result.replace(/\bnăm\s+(\d{4})\b/gi, '$1')
  result = result.replace(/\s+/g, ' ').trim()

  return result
}

// Convert numeric dates like 2/9/1945 or 02-09-1945 into "2 9 1945"
function numericDatesToSpaces(text) {
  return text.replace(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/g, (_, d, m, y) => `${Number(d)} ${Number(m)} ${y}`)
}

// Main execution
if (require.main === module) {
  const promptFixedPath = path.resolve(__dirname, 'prompt_fixed_V2.txt')
  const audiosDir = path.resolve(__dirname, 'dantri_audios')
  const logPath = path.resolve(__dirname, 'check_prompt_matching_log.txt')

  console.log(`📁 Prompt file: ${promptFixedPath}`)
  console.log(`📁 Audios dir: ${audiosDir}`)
  console.log(`📄 Log file: ${logPath}`)

  checkPromptMatching(promptFixedPath, audiosDir, logPath)
}

module.exports = {
  checkPromptMatching,
  normalizeTranscriptForCheck,
  normalizePromptForCheck,
  normalizeDateWordsToDigits,
  numericDatesToSpaces
}

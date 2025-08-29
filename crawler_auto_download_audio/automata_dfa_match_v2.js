/**
 * Auto mata (DFA) matcher v2 — preserves Vietnamese diacritics by default,
 * strips punctuation (# . , ; : ? ! / \ etc.), and allows toggles.
 *
 * Options:
 *  - normalize: { stripPunct: true, removeDiacritics: false }
 *  - weights, maxSkip, skipPenalty, positionBonus, acceptThreshold (same as v1)
 */

// ---------------- Normalization (Vietnamese) ----------------
function normalizeVi(s, opts = {}) {
  const { stripPunct = true, removeDiacritics = false } = opts
  if (!s) return ''

  let out = s.toLowerCase().normalize('NFC')

  if (stripPunct) {
    // Remove most punctuation and special symbols, keep spaces
    out = out
      .replace(/[.,;:!?()[\]{}"""''–—…/\\|+*=<>&%$#@~`^]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  if (removeDiacritics) {
    out = out
      .replace(/[àáạảãâầấậẩẫăằắặẳẵ]/g, 'a')
      .replace(/[èéẹẻẽêềếệểễ]/g, 'e')
      .replace(/[ìíịỉĩ]/g, 'i')
      .replace(/[òóọỏõôồốộổỗơờớợởỡ]/g, 'o')
      .replace(/[ùúụủũưừứựửữ]/g, 'u')
      .replace(/[ỳýỵỷỹ]/g, 'y')
      .replace(/đ/g, 'd')
  }

  return out
}

function tokenizeWords(s, normOpts) {
  // Tokenize after normalization so punctuation is already stripped
  const norm = normalizeVi(s || '', { stripPunct: true, removeDiacritics: normOpts?.removeDiacritics || false })
  return norm.split(/\s+/).filter(Boolean)
}

// ---------------- DFA spec per word ----------------
function buildWordSpec(word, normOpts) {
  const raw = word || ''
  const norm = normalizeVi(raw, { stripPunct: true, removeDiacritics: normOpts?.removeDiacritics || false })
  const n = norm.length
  const spec = {
    raw,
    norm,
    len: n,
    start: n > 0 ? norm[0] : '',
    end: n > 1 ? norm[n - 1] : '',
    middle: new Map() // position -> char
  }
  for (let i = 1; i < n - 1; i++) {
    spec.middle.set(i, norm[i])
  }
  return spec
}

/**
 * Score a transcript word against an audio word spec using positional chars.
 */
function scoreWordAgainstSpec(transcriptWord, spec, weights = { start: 0.35, middle: 0.3, end: 0.35 }, normOpts) {
  if (!transcriptWord || !spec || spec.len === 0) return { score: 0, detail: { start: 0, middle: 0, end: 0 } }
  const cand = normalizeVi(transcriptWord, { stripPunct: true, removeDiacritics: normOpts?.removeDiacritics || false })
  const m = Math.min(spec.len, cand.length)
  let sStart = 0,
    sMid = 0,
    sEnd = 0
  // start
  if (m >= 1 && cand[0] === spec.start) sStart = 1
  // end (spec end vs cand end)
  if (m >= 2 && cand[cand.length - 1] === spec.end) sEnd = 1
  // middle
  let midCount = 0,
    midHit = 0
  spec.middle.forEach((ch, pos) => {
    if (pos < m - 1) {
      // do NOT count the last char position per user's rule
      midCount++
      if (cand[pos] === ch) midHit++
    }
  })
  if (midCount > 0) sMid = midHit / midCount
  const score = weights.start * sStart + weights.middle * sMid + weights.end * sEnd
  return { score, detail: { start: sStart, middle: sMid, end: sEnd } }
}

function bestWord(transcriptWords, spec, weights, normOpts) {
  let best = { word: null, score: 0, index: -1, detail: null }
  for (let i = 0; i < transcriptWords.length; i++) {
    const w = transcriptWords[i]
    const sc = scoreWordAgainstSpec(w, spec, weights, normOpts)
    if (sc.score > best.score) best = { word: w, score: sc.score, index: i, detail: sc.detail }
  }
  return best
}

// ---------------- Sentence-level assembly (DFA chaining idea) ----------------
function assembleBestSegment(audioSpecs, transcriptWords, options = {}) {
  const {
    weights = { start: 0.35, middle: 0.3, end: 0.35 },
    maxWindowStart = 50,
    maxSkip = 1,
    skipPenalty = 0.15,
    positionBonus = 0.02,
    normOpts = {}
  } = options

  const TW = transcriptWords.length
  const AW = audioSpecs.length
  const searchLimit = Math.min(TW, maxWindowStart)

  let globalBest = { score: 0, start: 0, end: 0, mapping: [] }

  for (let start = 0; start < TW; start++) {
    const startBias = start < 10 ? (10 - start) * positionBonus : 0
    let tIdx = start
    const mapping = []
    let sumScore = 0
    for (let a = 0; a < AW; a++) {
      let localBest = { idx: -1, w: '', s: 0, detail: null, skip: 0 }
      for (let skip = 0; skip <= maxSkip; skip++) {
        const candIdx = tIdx + skip
        if (candIdx >= TW) break
        const w = transcriptWords[candIdx]
        const sc = scoreWordAgainstSpec(w, audioSpecs[a], weights, normOpts)
        const s = Math.max(0, sc.score - (skip > 0 ? skipPenalty : 0))
        if (s > localBest.s) localBest = { idx: candIdx, w, s, detail: sc.detail, skip }
      }
      if (localBest.idx === -1) break
      mapping.push({
        audioIndex: a,
        transcriptIndex: localBest.idx,
        word: localBest.w,
        score: localBest.s,
        detail: localBest.detail
      })
      sumScore += localBest.s
      tIdx = localBest.idx + 1
    }
    const avgScore = sumScore / Math.max(1, AW)
    const total = avgScore + startBias
    if (mapping.length === AW && total > globalBest.score) {
      globalBest = { score: total, start, end: mapping[mapping.length - 1].transcriptIndex, mapping }
    }
    if (start > searchLimit && total < globalBest.score * 0.7) {
      // noop
    }
  }

  if (globalBest.mapping.length === AW) {
    const phrase = transcriptWords.slice(globalBest.start, globalBest.end + 1).join(' ')
    return { ok: true, phrase, score: globalBest.score, mapping: globalBest.mapping }
  }
  return { ok: false, phrase: null, score: 0, mapping: [] }
}

/**
 * Sequential Character Search Algorithm
 * - Start with first word: find best match by character search
 * - For next word: find best match, then concatenate with previous words to find candidate segment
 * - Continue incrementally building the segment
 */
function sequentialCharacterMatch(audioText, transcriptText, opts = {}) {
  const {
    acceptThreshold = 0.75,
    weights = { start: 0.35, middle: 0.3, end: 0.35 },
    normalize = { stripPunct: true, removeDiacritics: false },
    maxSkip = 2,
    usedSegments = [] // Array of {start: number, end: number} representing used transcript segments
  } = opts

  const normOpts = { removeDiacritics: !!normalize.removeDiacritics }

  const audioWords = tokenizeWords(audioText, normOpts)
  const transcriptWords = tokenizeWords(transcriptText, normOpts)

  if (audioWords.length === 0 || transcriptWords.length === 0) {
    return { corrected: audioText, score: 0, accepted: false, debug: { reason: 'empty' } }
  }

  // Build specs for all audio words
  const audioSpecs = audioWords.map((w) => buildWordSpec(w, normOpts))

  let currentSegmentWords = []
  let currentTranscriptStart = 0
  let bestOverallScore = 0
  let bestOverallSegment = audioText
  let bestUsedSegment = null

  // Process each audio word sequentially
  for (let wordIndex = 0; wordIndex < audioWords.length; wordIndex++) {
    const currentSpec = audioSpecs[wordIndex]

    // Find best matching word for current spec starting from currentTranscriptStart
    let bestWordMatch = { word: null, score: 0, index: -1, detail: null }

    for (let i = currentTranscriptStart; i < transcriptWords.length; i++) {
      const candidateWord = transcriptWords[i]
      const scoreResult = scoreWordAgainstSpec(candidateWord, currentSpec, weights, normOpts)

      if (scoreResult.score > bestWordMatch.score) {
        bestWordMatch = {
          word: candidateWord,
          score: scoreResult.score,
          index: i,
          detail: scoreResult.detail
        }
      }

      // Allow some skip for better matches
      if (i >= currentTranscriptStart + maxSkip && scoreResult.score < bestWordMatch.score * 0.8) {
        break
      }
    }

    if (bestWordMatch.index === -1) {
      // No good match found, break
      break
    }

    // Add the matched word to current segment
    currentSegmentWords.push(bestWordMatch.word)

    // Create current segment text
    const currentSegmentText = currentSegmentWords.join(' ')

    // Find the best candidate segment in transcript that contains this sequence
    const candidateResult = findBestCandidateSegment(
      currentSegmentText,
      transcriptWords,
      currentTranscriptStart,
      bestWordMatch.index,
      normOpts,
      usedSegments
    )

    if (candidateResult.score > bestOverallScore && candidateResult.usedSegment) {
      bestOverallScore = candidateResult.score
      bestOverallSegment = candidateResult.segment
      bestUsedSegment = candidateResult.usedSegment
    }

    // Update start position for next word search
    currentTranscriptStart = Math.max(currentTranscriptStart, bestWordMatch.index + 1)
  }

  const accepted = bestOverallScore >= acceptThreshold
  return {
    corrected: accepted ? bestOverallSegment : audioText,
    score: bestOverallScore,
    accepted,
    debug: {
      segmentWords: currentSegmentWords,
      finalScore: bestOverallScore
    },
    usedSegment: accepted ? bestUsedSegment : null
  }
}

/**
 * Find best candidate segment in transcript that matches the current segment
 */
function findBestCandidateSegment(segmentText, transcriptWords, minStart, maxEnd, normOpts, usedSegments = []) {
  const segmentNorm = normalizeVi(segmentText, { stripPunct: true, removeDiacritics: normOpts.removeDiacritics })
  const segmentWords = segmentNorm.split(/\s+/).filter(Boolean)

  let bestScore = 0
  let bestSegment = segmentText
  let bestUsedSegment = null

  // Try different window sizes around the expected area
  const searchRadius = 5
  const startPos = Math.max(0, minStart - searchRadius)
  const endPos = Math.min(transcriptWords.length, maxEnd + searchRadius + segmentWords.length)

  for (let windowStart = startPos; windowStart <= endPos - segmentWords.length; windowStart++) {
    const windowEnd = windowStart + segmentWords.length - 1

    // Skip if this window overlaps with used segments
    if (isSegmentUsed(windowStart, windowEnd, usedSegments)) {
      continue
    }

    const windowWords = transcriptWords.slice(windowStart, windowStart + segmentWords.length)
    const windowText = windowWords.join(' ')
    const windowNorm = normalizeVi(windowText, { stripPunct: true, removeDiacritics: normOpts.removeDiacritics })

    // Calculate similarity score between segment and window
    const similarity = calculateTextSimilarity(segmentNorm, windowNorm)

    if (similarity > bestScore) {
      bestScore = similarity
      bestSegment = windowText
      bestUsedSegment = { start: windowStart, end: windowEnd }
    }
  }

  return { score: bestScore, segment: bestSegment, usedSegment: bestUsedSegment }
}

/**
 * Calculate text similarity based on character overlap and word matching
 */
function calculateTextSimilarity(text1, text2) {
  if (!text1 || !text2) return 0

  const words1 = text1.split(/\s+/).filter(Boolean)
  const words2 = text2.split(/\s+/).filter(Boolean)

  if (words1.length === 0 || words2.length === 0) return 0

  // Word-level matching
  let wordMatches = 0
  const minLength = Math.min(words1.length, words2.length)

  for (let i = 0; i < minLength; i++) {
    if (words1[i] === words2[i]) {
      wordMatches += 1
    } else {
      // Character-level similarity for partial matches
      const charSim = calculateCharacterSimilarity(words1[i], words2[i])
      wordMatches += charSim
    }
  }

  const wordScore = wordMatches / Math.max(words1.length, words2.length)

  // Character-level similarity for the entire text
  const charScore = calculateCharacterSimilarity(text1, text2)

  // Combine scores
  return wordScore * 0.7 + charScore * 0.3
}

/**
 * Calculate character-level similarity between two strings
 */
function calculateCharacterSimilarity(str1, str2) {
  if (!str1 || !str2) return 0

  const len1 = str1.length
  const len2 = str2.length

  if (len1 === 0 && len2 === 0) return 1
  if (len1 === 0 || len2 === 0) return 0

  // Simple character overlap ratio
  let matches = 0
  const minLen = Math.min(len1, len2)

  for (let i = 0; i < minLen; i++) {
    if (str1[i] === str2[i]) {
      matches++
    }
  }

  return matches / Math.max(len1, len2)
}

/**
 * Check if a transcript segment overlaps significantly with any used segments
 * Allow small overlaps (up to 20% of the segment length) to be more flexible
 */
function isSegmentUsed(startIndex, endIndex, usedSegments) {
  if (!usedSegments || usedSegments.length === 0) return false

  const segmentLength = endIndex - startIndex + 1
  const allowedOverlap = Math.max(1, Math.floor(segmentLength * 0.2)) // Allow 20% overlap

  for (const used of usedSegments) {
    // Calculate overlap amount
    const overlapStart = Math.max(startIndex, used.start)
    const overlapEnd = Math.min(endIndex, used.end)
    const overlapLength = Math.max(0, overlapEnd - overlapStart + 1)

    // Only consider it "used" if overlap is significant (more than allowed threshold)
    if (overlapLength > allowedOverlap) {
      return true
    }
  }
  return false
} /**
 * Main entry
 */
function autoMataCorrect(audioText, transcriptText, opts = {}) {
  const {
    acceptThreshold = 0.75,
    weights = { start: 0.35, middle: 0.3, end: 0.35 },
    normalize = { stripPunct: true, removeDiacritics: false },
    usedSegments = [] // Array of {start: number, end: number} representing used transcript segments
  } = opts

  // NOTE: We preserve diacritics by default (removeDiacritics: false).
  const normOpts = { removeDiacritics: !!normalize.removeDiacritics }

  const aWords = tokenizeWords(audioText, normOpts)
  const tWords = tokenizeWords(transcriptText, normOpts)

  if (aWords.length === 0 || tWords.length === 0) {
    return { corrected: audioText, score: 0, accepted: false, debug: { reason: 'empty' } }
  }

  const specs = aWords.map((w) => buildWordSpec(w, normOpts))

  const firstBest = bestWord(tWords, specs[0], weights, normOpts)
  const options = { ...opts, normOpts }
  if (firstBest.index >= 0) {
    options.maxWindowStart = Math.max(50, firstBest.index + 10)
  }

  const assembled = assembleBestSegment(specs, tWords, options)
  if (assembled.ok && assembled.score >= acceptThreshold) {
    // Check if this segment is already used
    const segmentStart = assembled.mapping[0].transcriptIndex
    const segmentEnd = assembled.mapping[assembled.mapping.length - 1].transcriptIndex

    if (!isSegmentUsed(segmentStart, segmentEnd, usedSegments)) {
      return {
        corrected: assembled.phrase,
        score: assembled.score,
        accepted: true,
        debug: assembled,
        usedSegment: { start: segmentStart, end: segmentEnd }
      }
    }
  }

  const W = aWords.length
  let bestWin = { score: 0, start: 0, text: audioText, usedSegment: null }
  for (let i = 0; i + W <= tWords.length; i++) {
    // Skip if this window overlaps with used segments
    if (isSegmentUsed(i, i + W - 1, usedSegments)) {
      continue
    }

    let s = 0
    for (let j = 0; j < W; j++) {
      const sc = scoreWordAgainstSpec(tWords[i + j], specs[j], weights, normOpts).score
      s += sc
    }
    s /= W
    if (s > bestWin.score) {
      bestWin = {
        score: s,
        start: i,
        text: tWords.slice(i, i + W).join(' '),
        usedSegment: { start: i, end: i + W - 1 }
      }
    }
  }
  const accepted = bestWin.score >= Math.max(0.6, acceptThreshold - 0.1)
  return {
    corrected: accepted ? bestWin.text : audioText,
    score: bestWin.score,
    accepted,
    debug: { windowBest: bestWin },
    usedSegment: accepted ? bestWin.usedSegment : null
  }
}

if (require.main === module) {
  const audio = process.argv[2] || 'đôi đan làm vịt và học tạp tại microbox'
  const transcript = process.argv.slice(3).join(' ') || 'tôi đang làm việc và học tập tại microbox'
  const out = autoMataCorrect(audio, transcript, {
    acceptThreshold: 0.7,
    normalize: { stripPunct: true, removeDiacritics: false } // keep diacritics
  })
  console.log(JSON.stringify(out, null, 2))
}

module.exports = {
  autoMataCorrect,
  sequentialCharacterMatch,
  normalizeVi,
  tokenizeWords,
  buildWordSpec,
  scoreWordAgainstSpec,
  assembleBestSegment,
  findBestCandidateSegment,
  calculateTextSimilarity,
  calculateCharacterSimilarity,
  isSegmentUsed
}

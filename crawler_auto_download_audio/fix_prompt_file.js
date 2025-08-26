const fs = require('fs')
const path = require('path')

// Levenshtein distance for string similarity
function levenshtein(a, b) {
  if (!a) a = ''
  if (!b) b = ''
  const matrix = Array(a.length + 1)
    .fill(null)
    .map(() => Array(b.length + 1).fill(null))
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost)
    }
  }
  return matrix[a.length][b.length]
}

// Normalize Vietnamese text for better matching
function normalizeVietnamese(text) {
  return text
    .toLowerCase()
    .replace(/[àáạảãâầấậẩẫăằắặẳẵ]/g, 'a')
    .replace(/[èéẹẻẽêềếệểễ]/g, 'e')
    .replace(/[ìíịỉĩ]/g, 'i')
    .replace(/[òóọỏõôồốộổỗơờớợởỡ]/g, 'o')
    .replace(/[ùúụủũưừứựửữ]/g, 'u')
    .replace(/[ỳýỵỷỹ]/g, 'y')
    .replace(/đ/g, 'd')
}

// Enhanced Levenshtein distance with Vietnamese normalization
function levenshteinEnhanced(a, b) {
  // Try both original and normalized versions
  const originalDistance = levenshtein(a, b)
  const normalizedDistance = levenshtein(normalizeVietnamese(a), normalizeVietnamese(b))

  // Return the better (smaller) distance
  return Math.min(originalDistance, normalizedDistance)
}

// Reverse contextual matching - tìm từ bị lỗi dựa trên context xung quanh
function reverseContextualMatch(sentence, transcripts) {
  const words = sentence.split(' ')
  const correctedWords = [...words]
  let hasCorrections = false
  const corrections = []

  // Tìm các cụm từ/ngày tháng trong transcript để làm anchor
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    const transcriptText = transcripts.join(' ')

    // Nếu từ không tìm thấy trong transcript và có vẻ lỗi
    if (!transcriptText.toLowerCase().includes(word.toLowerCase()) && word.length > 2) {
      // Tìm context sau (anchor points) - ưu tiên ngày tháng, số
      const contextAfter = words.slice(i + 1, i + 4).join(' ')
      const contextBefore = words.slice(Math.max(0, i - 3), i).join(' ')

      // Tìm matching context trong transcript
      for (const transcript of transcripts) {
        const transcriptLower = transcript.toLowerCase()
        const contextAfterLower = contextAfter.toLowerCase()
        const contextBeforeLower = contextBefore.toLowerCase()

        // Tìm vị trí của context trong transcript
        let contextIndex = -1
        let matchedContext = ''

        // Ưu tiên context chứa số/ngày tháng
        if (contextAfter && (contextAfter.includes('/') || /\d/.test(contextAfter))) {
          // Tìm pattern tương tự cho ngày tháng (2.9.1945 -> 2/9/1945)
          const datePattern = contextAfter.replace(/\./g, '/')
          if (transcriptLower.includes(datePattern.toLowerCase())) {
            contextIndex = transcriptLower.indexOf(datePattern.toLowerCase())
            matchedContext = datePattern
          } else if (transcriptLower.includes(contextAfterLower)) {
            contextIndex = transcriptLower.indexOf(contextAfterLower)
            matchedContext = contextAfter
          }
        } else if (contextAfter && transcriptLower.includes(contextAfterLower)) {
          contextIndex = transcriptLower.indexOf(contextAfterLower)
          matchedContext = contextAfter
        } else if (contextBefore && transcriptLower.includes(contextBeforeLower)) {
          contextIndex = transcriptLower.indexOf(contextBeforeLower) + contextBeforeLower.length
          matchedContext = contextBefore
        }

        if (contextIndex !== -1) {
          // Tìm từ ở vị trí tương ứng trong transcript
          const transcriptWords = transcript.split(' ')
          const targetWordIndex = transcript.slice(0, contextIndex).split(' ').length - 1

          // Tìm từ gần vị trí này có độ tương đồng cao
          for (
            let j = Math.max(0, targetWordIndex - 3);
            j <= Math.min(transcriptWords.length - 1, targetWordIndex + 3);
            j++
          ) {
            const candidateWord = transcriptWords[j]
            if (!candidateWord || candidateWord.length < 2) continue

            const similarity =
              1 -
              levenshteinEnhanced(word.toLowerCase(), candidateWord.toLowerCase()) /
                Math.max(word.length, candidateWord.length)

            // Technical vocabulary context bonus
            let contextBonus = 0
            const lowerWord = word.toLowerCase()
            const lowerCandidate = candidateWord.toLowerCase()

            // Camera/security context
            if (sentence.toLowerCase().includes('camera') || sentence.toLowerCase().includes('bảo mật')) {
              if (lowerWord.includes('hách') && lowerCandidate.includes('hack')) contextBonus = 0.4
              if (lowerWord.includes('cách') && lowerCandidate.includes('hack')) contextBonus = 0.4
            }

            // Nếu độ tương đồng cao hoặc có nghĩa trong context
            if (
              (similarity + contextBonus >= 0.3 ||
                (word.toLowerCase().includes('đệch') && candidateWord.toLowerCase().includes('lịch')) ||
                (word.toLowerCase().includes('tập') && candidateWord.toLowerCase().includes('tặc'))) &&
              candidateWord !== word
            ) {
              correctedWords[i] = candidateWord
              hasCorrections = true
              corrections.push(`${word} → ${candidateWord}`)
              // console.log(`Reverse context match: "${word}" → "${candidateWord}" based on context "${matchedContext}"`)
              break
            }
          }

          if (hasCorrections && corrections.length > 0) break
        }
      }

      if (hasCorrections && corrections.length > 0) break
    }
  }

  return {
    corrected: hasCorrections,
    sentence: correctedWords.join(' '),
    corrections: corrections
  }
}

// Preprocess text for better matching
function preprocessText(text, preserveCapitalization = false) {
  let processed = text

  // Keep original case for proper nouns/technical terms if specified
  if (!preserveCapitalization) {
    processed = processed.toLowerCase()
  }

  processed = processed
    .replace(/[.,!?;:'"()-]/g, ' ') // Remove punctuation, replace with space
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove accent marks
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim()

  return processed
}

// Preprocess text for matching but keep punctuation for final result
function preprocessForMatching(text) {
  return text
    .toLowerCase()
    .replace(/[.,!?;:'"()-]/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isProperNoun(word) {
  // Check if word looks like a proper noun or technical term
  const properNounPatterns = [
    /^[A-Z][a-z]+[A-Z]/, // CamelCase like WinRAR, iPhone
    /^[A-Z]{2,}/, // ALL CAPS like USB, RAM
    /^[A-Z][a-zA-Z]*\d/, // Mixed with numbers like iOS15
    /^\d+[A-Za-z]/ // Numbers with letters like 5G
  ]

  return properNounPatterns.some((pattern) => pattern.test(word))
}

// Context-aware replacement for common technical terms
function getContextualReplacement(incorrectPhrase, fullContext, filename) {
  const contextualMappings = {
    'nguyên RAM': {
      keywords: ['winrar', 'phần mềm', 'sử dụng', 'tiếp tục', 'bình thường'],
      replacement: 'WinRAR bình thường'
    },
    'nghiên xâm': {
      keywords: ['winrar', 'phần mềm', 'sử dụng', 'tiếp tục', 'bình thường'],
      replacement: 'WinRAR bình thường'
    },
    'nguy xâm': {
      keywords: ['winrar', 'phần mềm', 'sử dụng', 'tiếp tục', 'bình thường'],
      replacement: 'WinRAR bình thường'
    }
  }

  // Check filename for context
  const isWinRARContext = filename && filename.toLowerCase().includes('cong-nghe')
  const contextLower = fullContext.toLowerCase()

  for (const [phrase, mapping] of Object.entries(contextualMappings)) {
    if (incorrectPhrase.toLowerCase().includes(phrase.toLowerCase())) {
      const keywordMatches = mapping.keywords.filter((keyword) => contextLower.includes(keyword)).length

      // Lower threshold if filename suggests WinRAR context
      const requiredMatches = isWinRARContext ? 1 : 2

      if (keywordMatches >= requiredMatches) {
        return mapping.replacement
      }
    }
  }

  return null
}

// Word-based similarity for better matching
function wordBasedSimilarity(prompt, sentence) {
  const promptWords = preprocessForMatching(prompt)
    .split(' ')
    .filter((w) => w.length > 2)
  const sentenceWords = preprocessForMatching(sentence)
    .split(' ')
    .filter((w) => w.length > 2)

  if (promptWords.length === 0 || sentenceWords.length === 0) return 0

  let matches = 0
  promptWords.forEach((word) => {
    const found = sentenceWords.find((sw) => {
      const normalizedWord = normalizeVietnamese(word)
      const normalizedSentenceWord = normalizeVietnamese(sw)

      // Exact match or very similar (1 char difference)
      return normalizedWord === normalizedSentenceWord || levenshtein(normalizedWord, normalizedSentenceWord) <= 1
    })
    if (found) matches++
  })

  return matches / promptWords.length
}

// Enhanced matching that combines multiple approaches
function enhancedMatch(prompt, sentence) {
  // Character-level similarity
  const charSimilarity = 1 - levenshteinEnhanced(prompt, sentence) / Math.max(prompt.length, sentence.length)

  // Word-level similarity
  const wordSimilarity = wordBasedSimilarity(prompt, sentence)

  // Combined score (weighted average)
  return charSimilarity * 0.4 + wordSimilarity * 0.6
}

// Progressive sentence matching - tìm kiếm tuần tự từ đầu câu với độ dài cố định
function progressiveSentenceMatch(prompt, sentences) {
  const promptWords = prompt.split(' ') // Keep original with punctuation
  const fullTranscript = sentences.join(' ')
  const targetLength = promptWords.length // Độ dài mục tiêu bằng câu gốc

  // Tìm kiếm tuần tự từ đầu câu
  for (let i = 1; i <= promptWords.length; i++) {
    const currentPhrase = promptWords.slice(0, i).join(' ')
    const currentPhraseProcessed = preprocessForMatching(currentPhrase)

    // Tìm exact match với text đã preprocess
    if (preprocessForMatching(fullTranscript).includes(currentPhraseProcessed)) {
      // Nếu đã tìm thấy toàn bộ câu
      if (i === promptWords.length) {
        // Tìm câu hoàn chỉnh chứa phrase này và trích xuất chỉ phần có độ dài bằng câu gốc
        for (const sentence of sentences) {
          if (preprocessForMatching(sentence).includes(currentPhraseProcessed)) {
            const extractedSentence = extractSameLengthSentencePreservePunctuation(
              sentence,
              currentPhrase,
              targetLength
            )
            return {
              found: true,
              sentence: extractedSentence,
              matchType: 'PROGRESSIVE_COMPLETE',
              score: 1.0
            }
          }
        }
      }
      continue // Tiếp tục tìm kiếm với phrase dài hơn
    } else {
      // Không tìm thấy exact match, thử tìm từ tương tự cho từ cuối
      if (i > 1) {
        const foundPhrase = promptWords.slice(0, i - 1).join(' ')
        const missingWord = promptWords[i - 1]

        // Tìm từ tương tự trong transcript (đã preprocess)
        // Tìm từ gần đúng nhất trong transcript, luôn lấy từ gốc (giữ nguyên dấu, hoa/thường)
        const transcriptWordsOriginal = fullTranscript.split(' ')
        let bestSimilarWord = null
        let bestSimilarity = 0
        for (let idx = 0; idx < transcriptWordsOriginal.length; idx++) {
          const transcriptWordOriginal = transcriptWordsOriginal[idx]
          if (!transcriptWordOriginal || transcriptWordOriginal.length < 2) continue
          let similarity =
            1 -
            levenshteinEnhanced(preprocessForMatching(missingWord), preprocessForMatching(transcriptWordOriginal)) /
              Math.max(missingWord.length, transcriptWordOriginal.length)
          // Ưu tiên context phù hợp
          let contextBonus = 0
          const fullSentence = prompt.toLowerCase()
          // Special handling for proper nouns and technical terms
          if (isProperNoun(transcriptWordOriginal) || transcriptWordOriginal.length > 4) {
            if (preprocessForMatching(missingWord) === preprocessForMatching(transcriptWordOriginal)) {
              similarity = 1.0
              contextBonus = 0.3
            } else if (
              preprocessForMatching(missingWord).includes(preprocessForMatching(transcriptWordOriginal).substring(0, 3))
            ) {
              contextBonus = 0.2
            }
          }
          if (preprocessForMatching(missingWord) === 'tap' && preprocessForMatching(transcriptWordOriginal) === 'tac') {
            contextBonus = 0.3
          }
          if (fullSentence.includes('camera') || fullSentence.includes('bảo mật')) {
            if (
              (preprocessForMatching(missingWord).includes('hach') ||
                preprocessForMatching(missingWord).includes('cach')) &&
              preprocessForMatching(transcriptWordOriginal) === 'hack'
            ) {
              contextBonus = 0.5
            }
          }
          if (
            preprocessForMatching(missingWord).includes('ram') &&
            preprocessForMatching(transcriptWordOriginal) === 'winrar'
          ) {
            contextBonus = 0.6
          }
          const adjustedSimilarity = similarity + contextBonus
          if (adjustedSimilarity > bestSimilarity && (similarity >= 0.6 || contextBonus >= 0.4)) {
            bestSimilarity = adjustedSimilarity
            bestSimilarWord = transcriptWordOriginal
          }
        }
        if (bestSimilarWord) {
          // Tạo câu sửa lỗi với cùng độ dài, luôn dùng từ gốc transcript
          const correctedSentence = buildCorrectedSentencePreservePunctuation(
            promptWords,
            foundPhrase,
            bestSimilarWord,
            sentences,
            targetLength
          )
          if (correctedSentence) {
            return {
              found: true,
              sentence: correctedSentence,
              matchType: 'PROGRESSIVE_CORRECTED',
              score: 0.85,
              corrections: [`${missingWord} → ${bestSimilarWord}`]
            }
          }
        }
      }
      break // Không tìm thấy, dừng lại
    }
  }

  return {
    found: false,
    sentence: null,
    matchType: 'NO_PROGRESSIVE_MATCH',
    score: 0
  }
}

// Trích xuất câu có cùng độ dài từ transcript - preserve punctuation
function extractSameLengthSentencePreservePunctuation(sentence, matchedPhrase, targetLength) {
  const sentenceWords = sentence.split(' ') // Keep original with punctuation
  const sentenceWordsProcessed = preprocessForMatching(sentence).split(' ')
  const matchedPhraseProcessed = preprocessForMatching(matchedPhrase).split(' ')

  // Tìm vị trí bắt đầu của phrase trong sentence
  for (let i = 0; i <= sentenceWordsProcessed.length - matchedPhraseProcessed.length; i++) {
    const candidatePhrase = sentenceWordsProcessed.slice(i, i + matchedPhraseProcessed.length).join(' ')
    const matchedPhraseJoined = matchedPhraseProcessed.join(' ')

    if (candidatePhrase.toLowerCase() === matchedPhraseJoined.toLowerCase()) {
      // Tìm thấy vị trí, trích xuất câu có độ dài mong muốn từ câu gốc
      let startIndex = i
      let endIndex = Math.min(i + targetLength, sentenceWords.length)

      // Điều chỉnh để đảm bảo có đủ từ
      if (endIndex - startIndex < targetLength && startIndex > 0) {
        startIndex = Math.max(0, endIndex - targetLength)
      }

      return sentenceWords.slice(startIndex, endIndex).join(' ')
    }
  }

  // Fallback: lấy từ đầu câu với độ dài mong muốn từ câu gốc
  return sentenceWords.slice(0, Math.min(targetLength, sentenceWords.length)).join(' ')
}

// Trích xuất câu có cùng độ dài từ transcript (original function for compatibility)
function extractSameLengthSentence(sentence, matchedPhrase, targetLength) {
  return extractSameLengthSentencePreservePunctuation(sentence, matchedPhrase, targetLength)
}

// Xây dựng câu sửa lỗi với cùng độ dài - preserve punctuation
function buildCorrectedSentencePreservePunctuation(originalWords, foundPhrase, correctedWord, sentences, targetLength) {
  const correctedPhrase = foundPhrase + ' ' + correctedWord

  // Tìm câu chứa cụm từ đã sửa
  for (const sentence of sentences) {
    if (preprocessForMatching(sentence).includes(preprocessForMatching(correctedPhrase))) {
      return extractSameLengthSentencePreservePunctuation(sentence, correctedPhrase, targetLength)
    }
  }

  // Nếu không tìm thấy, xây dựng lại câu fix: ưu tiên chuỗi liên tục các từ đúng nhất từ transcript
  const transcriptText = sentences.join(' ')
  const transcriptWords = transcriptText.split(' ')
  // Tìm đoạn liên tục trong transcript có độ tương đồng cao nhất với prompt
  let bestSeq = []
  let bestSeqScore = 0
  for (let i = 0; i <= transcriptWords.length - originalWords.length; i++) {
    const candidateSeq = transcriptWords.slice(i, i + originalWords.length)
    let score = 0
    for (let j = 0; j < originalWords.length; j++) {
      const promptWord = originalWords[j]
      const transcriptWord = candidateSeq[j]
      if (!transcriptWord) continue
      const similarity =
        1 -
        levenshteinEnhanced(preprocessForMatching(promptWord), preprocessForMatching(transcriptWord)) /
          Math.max(promptWord.length, transcriptWord.length)
      score += similarity
    }
    if (score > bestSeqScore) {
      bestSeqScore = score
      bestSeq = candidateSeq
    }
  }
  // Nếu tìm được chuỗi liên tục tốt nhất, kiểm tra khớp nguyên văn với transcript
  if (bestSeq.length === originalWords.length && bestSeqScore / originalWords.length >= 0.7) {
    const bestSeqStr = bestSeq.join(' ')
    // Kiểm tra khớp nguyên văn với một câu trong transcript
    for (const sentence of sentences) {
      if (sentence.trim() === bestSeqStr.trim()) {
        // Trả về object để set score và matchType
        return {
          fixed: bestSeqStr,
          score: 1.0,
          matchType: 'EXACT_TRANSCRIPT_MATCH'
        }
      }
    }
    // Nếu không khớp nguyên văn, trả về như cũ
    return bestSeqStr
  }
  // Nếu không, fallback về logic từng từ như trước
  const foundPhraseWords = foundPhrase.split(' ')
  let result = [...foundPhraseWords, correctedWord]
  const remainingOriginalWords = originalWords.slice(foundPhraseWords.length + 1)
  for (const word of remainingOriginalWords) {
    if (result.length >= targetLength) break
    let bestWord = word
    let bestSimilarity = 0
    for (const transcriptWord of transcriptWords) {
      if (transcriptWord.length < 2) continue
      const similarity =
        1 -
        levenshteinEnhanced(preprocessForMatching(word), preprocessForMatching(transcriptWord)) /
          Math.max(word.length, transcriptWord.length)
      if (similarity > bestSimilarity && similarity >= 0.6) {
        bestSimilarity = similarity
        bestWord = transcriptWord
      }
    }
    result.push(bestWord)
  }
  return result.slice(0, targetLength).join(' ')
}

// Fix individual words in prompt using transcript as reference
function fixWordsInPrompt(prompt, sentences) {
  const promptWords = prompt.split(' ') // Keep original punctuation
  const allTranscriptText = sentences.join(' ')
  const allTranscriptWordsProcessed = preprocessForMatching(allTranscriptText).split(' ')

  let fixedWords = []
  let hasChanges = false

  for (const word of promptWords) {
    let bestWord = word
    let bestScore = 0

    // Check if word exists as-is in transcript (after preprocessing for comparison)
    if (allTranscriptWordsProcessed.includes(preprocessForMatching(word))) {
      bestWord = word
    } else {
      // Try to find similar word in transcript
      const allTranscriptWordsOriginal = allTranscriptText.split(' ')

      for (let i = 0; i < allTranscriptWordsProcessed.length; i++) {
        const transcriptWordProcessed = allTranscriptWordsProcessed[i]
        const transcriptWordOriginal = allTranscriptWordsOriginal[i]

        if (transcriptWordProcessed.length < 3) continue

        const similarity =
          1 -
          levenshteinEnhanced(preprocessForMatching(word), transcriptWordProcessed) /
            Math.max(word.length, transcriptWordProcessed.length)

        // Only replace if very similar (likely spelling error)
        if (similarity > bestScore && similarity >= 0.8) {
          bestScore = similarity
          bestWord = transcriptWordOriginal || transcriptWordProcessed // Preserve original form
        }
      }

      if (bestWord !== word) {
        hasChanges = true
      }
    }

    fixedWords.push(bestWord)
  }

  return {
    fixedPrompt: fixedWords.join(' '),
    hasChanges: hasChanges,
    changeCount: fixedWords.filter((word, idx) => word !== promptWords[idx]).length
  }
}

// Main function
function fixPromptFile(promptPath, audiosDir, logPath) {
  const promptLines = fs.readFileSync(promptPath, 'utf8').split('\n').filter(Boolean)
  let fixedLines = []
  let logLines = []

  for (const line of promptLines) {
    const [audioId, prompt] = line.split('|')
    if (!audioId || !prompt) continue
    // Robustly extract category and id from audioId
    const parts = audioId.split('_')
    if (parts.length < 2) continue
    const category = parts[0]
    const id = parts[1]
    const transcriptPath = path.join(audiosDir, category, id, 'transcript.txt')
    let transcript = ''
    if (fs.existsSync(transcriptPath)) {
      transcript = fs.readFileSync(transcriptPath, 'utf8').trim()
    }
    if (!transcript) {
      fixedLines.push(line)
      logLines.push(`[NO_TRANSCRIPT] ${line}`)
      continue
    }

    // Clean transcript by removing metadata and URLs, focus on actual content
    const cleanTranscript = transcript
      .replace(/# Transcript:.*?\n/g, '')
      .replace(/# URL:.*?\n/g, '')
      .replace(/\(Dân trí\) -/g, '')
      .replace(/https?:\/\/[^\s]+/g, '')
      .trim()

    // Split transcript into sentences
    const sentences = cleanTranscript
      .split(/[.!?;]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => s.length >= 15 && !s.includes('htm') && !s.includes('dantri.com') && !/^\d{3,}/.test(s))

    let bestScore = 0
    let bestLine = prompt
    let action = 'KEEP_ORIGINAL'
    let foundMatch = false

    // 1. First check: Does the prompt exist exactly in transcript sentences?
    //
    for (const sentence of sentences) {
      if (sentence === prompt.trim()) {
        bestLine = prompt
        action = 'EXACT_MATCH'
        foundMatch = true
        bestScore = 1.0
        break
      }
    }

    // Also check in the full cleaned transcript
    if (!foundMatch && cleanTranscript.includes(prompt.trim())) {
      bestLine = prompt
      action = 'FOUND_IN_TRANSCRIPT'
      foundMatch = true
      bestScore = 1.0
    }

    // 2. If not found, try progressive sentence matching first (new improved method)
    if (!foundMatch) {
      const progressiveResult = progressiveSentenceMatch(prompt, sentences)

      if (progressiveResult.found) {
        bestLine = progressiveResult.sentence
        action = progressiveResult.matchType
        foundMatch = true
        bestScore = progressiveResult.score

        // Log corrections if any
        if (progressiveResult.corrections) {
          // console.log(`Progressive corrections for "${prompt}": ${progressiveResult.corrections.join(', ')}`)
        }
      }
    }

    // 2.5. Try reverse contextual matching for unknown words
    if (!foundMatch) {
      const reverseMatch = reverseContextualMatch(prompt, sentences)

      if (reverseMatch.corrected) {
        bestLine = reverseMatch.sentence
        action = 'REVERSE_CONTEXT_MATCH'
        foundMatch = true
        bestScore = 0.9

        // Log reverse context corrections
        if (reverseMatch.corrections) {
          // console.log(`Reverse context corrections for "${prompt}": ${reverseMatch.corrections.join(', ')}`)
        }
      }
    }

    // 3. If still not found, try to fix individual words (minimal changes)
    if (!foundMatch) {
      const wordFix = fixWordsInPrompt(prompt, sentences)

      if (wordFix.hasChanges && wordFix.changeCount <= 3) {
        // Only minor word fixes needed
        bestLine = wordFix.fixedPrompt
        action = 'WORD_FIXED'
        foundMatch = true
        bestScore = 0.95 // High confidence for word-level fixes
      } else {
        // If too many changes needed, try sentence matching
        for (const sentence of sentences) {
          if (sentence.length < 5) continue

          const similarity = enhancedMatch(prompt, sentence)

          if (similarity > bestScore) {
            bestScore = similarity
            bestLine = sentence
          }
        }

        // Set action based on similarity score
        if (bestScore >= 0.8) {
          action = 'SPELLING_FIXED'
          foundMatch = true
        } else if (bestScore >= 0.6) {
          action = 'LIKELY_MATCH'
          foundMatch = true
        } else if (bestScore >= 0.4) {
          action = 'POSSIBLE_MATCH'
          foundMatch = true
        } else if (bestScore >= 0.2) {
          action = 'LOW_SIMILARITY_MATCH'
          foundMatch = true
        } else if (bestScore >= 0.1) {
          action = 'VERY_LOW_MATCH'
          foundMatch = true
        }
      }
    }

    // 4. If still not found, try matching by first/last 2-3 words
    if (!foundMatch) {
      const promptWords = prompt.trim().split(' ')
      if (promptWords.length >= 3) {
        const first2 = promptWords.slice(0, 2).join(' ')
        const first3 = promptWords.slice(0, 3).join(' ')
        const last2 = promptWords.slice(-2).join(' ')
        const last3 = promptWords.slice(-3).join(' ')

        for (const sentence of sentences) {
          // Check if sentence starts with first 2-3 words or ends with last 2-3 words
          if (
            sentence.toLowerCase().startsWith(first3.toLowerCase()) ||
            sentence.toLowerCase().startsWith(first2.toLowerCase()) ||
            sentence.toLowerCase().endsWith(last3.toLowerCase()) ||
            sentence.toLowerCase().endsWith(last2.toLowerCase())
          ) {
            bestLine = sentence
            action = 'PARTIAL_WORD_MATCH'
            foundMatch = true
            // Calculate a similarity score for partial matches
            bestScore = Math.max(
              sentence.toLowerCase().startsWith(first3.toLowerCase()) ? 0.4 : 0,
              sentence.toLowerCase().startsWith(first2.toLowerCase()) ? 0.3 : 0,
              sentence.toLowerCase().endsWith(last3.toLowerCase()) ? 0.4 : 0,
              sentence.toLowerCase().endsWith(last2.toLowerCase()) ? 0.3 : 0
            )
            break
          }
        }
      }
    }

    // 5. If still no match, keep original but mark as no match
    if (!foundMatch) {
      bestLine = prompt // Keep original
      action = 'NO_MATCH'
      bestScore = 0
    }

    fixedLines.push(`${audioId}|${bestLine}`)

    // Create detailed log entry
    let logEntry = `[${action}] Score: ${bestScore.toFixed(3)} | ${audioId}`
    if (action === 'EXACT_MATCH' || action === 'FOUND_IN_TRANSCRIPT' || action === 'NO_MATCH') {
      logEntry += `|${prompt} => KEPT ORIGINAL`
    } else if (action === 'WORD_FIXED') {
      logEntry += `|${prompt} => ${bestLine} (word-level fix)`
    } else if (action === 'PROGRESSIVE_COMPLETE') {
      logEntry += `|${prompt} => ${bestLine} (progressive complete match)`
    } else if (action === 'PROGRESSIVE_CORRECTED') {
      logEntry += `|${prompt} => ${bestLine} (progressive with corrections)`
    } else if (action === 'PROGRESSIVE_PARTIAL') {
      logEntry += `|${prompt} => ${bestLine} (progressive partial match)`
    } else if (action === 'REVERSE_CONTEXT_MATCH') {
      logEntry += `|${prompt} => ${bestLine} (reverse context match)`
    } else {
      logEntry += `|${prompt} => ${bestLine}`
    }
    logLines.push(logEntry)
  }
  // Write to a new file for comparison, do not overwrite original
  const fixedPath = path.join(path.dirname(promptPath), 'prompt_fixed.txt')
  fs.writeFileSync(fixedPath, fixedLines.join('\n'), 'utf8')
  fs.writeFileSync(logPath, logLines.join('\n'), 'utf8')
  console.log(`Done. Fixed prompts written to ${fixedPath}, log to ${logPath}`)
}

// Run the function directly
fixPromptFile(
  path.resolve(__dirname, '../prompt.txt'),
  path.resolve(__dirname, '../dantri_audios'),
  path.resolve(__dirname, '../fix_prompt_log.txt')
)

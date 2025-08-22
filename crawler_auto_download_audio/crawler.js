const axios = require('axios')
const cheerio = require('cheerio')
const fs = require('fs')
const path = require('path')
const { exec } = require('child_process')

// ===== CẤU HÌNH CHÍNH =====
const CATEGORIES = [
  { name: 'xa-hoi', url: 'xa-hoi' },
  { name: 'kinh-doanh', url: 'kinh-doanh' },
  { name: 'giai-tri', url: 'giai-tri' },
  { name: 'suc-khoe', url: 'suc-khoe' },
  { name: 'cong-nghe', url: 'cong-nghe' },
  { name: 'the-thao', url: 'the-thao' }
]

const VOICE_MODE = 'RANDOM' // ALL | RANDOM | NORTH | CENTRAL | SOUTH

const CONFIG = {
  // Số lượng audio per category
  MIN_AUDIO_PER_CATEGORY: 10,
  MAX_AUDIO_PER_CATEGORY: 20,
  MAX_ARTICLES_TO_CHECK: 30,

  // Timing (milliseconds)
  DELAY_BETWEEN_ARTICLES: 500,
  DELAY_BETWEEN_CATEGORIES: 2000,
  DELAY_BETWEEN_VOICES: 200,
  REQUEST_TIMEOUT: 10000
}

const SAVE_DIR = path.join(__dirname, '..', 'dantri_audios')

// Headers chuẩn để tránh bị block
const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,' + 'image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  DNT: '1',
  Connection: 'keep-alive',
  'Upgrade-Insecure-Requests': '1'
}

// Voice regions mapping
const VOICE_REGIONS = [
  { name: 'bac', label: 'giong_bac', pattern: 'full_1.mp3', id: 'NORTH' },
  { name: 'nu_bac', label: 'giong_nu_bac', pattern: 'full_2.mp3', id: 'CENTRAL' },
  { name: 'nam', label: 'giong_nam', pattern: 'full_3.mp3', id: 'SOUTH' }
]

// Tạo thư mục output
if (!fs.existsSync(SAVE_DIR)) {
  fs.mkdirSync(SAVE_DIR, { recursive: true })
}

// ===== UTILITY FUNCTIONS =====

// Normalize string for AI-ready filenames
function normalizeForAI(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove Vietnamese accents
    .replace(/[đĐ]/g, 'd')
    .replace(/[^a-z0-9\s-]/gi, '') // Keep only letters, numbers, spaces, hyphens
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

// Convert MP3 to WAV PCM16 16kHz mono
async function convertToWav(mp3Path, wavPath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -i "${mp3Path}" -ac 1 -ar 16000 -sample_fmt s16 "${wavPath}" -y`
    exec(cmd, (error) => {
      if (error) {
        console.error(`❌ FFmpeg error: ${error.message}`)
        reject(error)
      } else {
        console.log(`🔄 Converted: ${path.basename(wavPath)}`)
        // Clean up MP3 file
        try {
          fs.unlinkSync(mp3Path)
        } catch (e) {
          console.error(`❌ Failed to delete MP3 file: ${e.message}`)
        }
        resolve(wavPath)
      }
    })
  })
}

// Download file with stream
async function downloadFile(url, filepath) {
  const response = await axios.get(url, { responseType: 'stream' })
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(filepath)
    response.data.pipe(writer)
    writer.on('finish', resolve)
    writer.on('error', reject)
  })
}

// Get selected voices based on mode
function getSelectedVoices(mode) {
  switch (mode) {
    case 'ALL':
      return VOICE_REGIONS
    case 'RANDOM':
      return [VOICE_REGIONS[Math.floor(Math.random() * VOICE_REGIONS.length)]]
    case 'NORTH':
      return VOICE_REGIONS.filter((v) => v.id === 'NORTH')
    case 'CENTRAL':
      return VOICE_REGIONS.filter((v) => v.id === 'CENTRAL')
    case 'SOUTH':
      return VOICE_REGIONS.filter((v) => v.id === 'SOUTH')
    default:
      return VOICE_REGIONS
  }
}

// Sleep utility
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ===== MAIN FUNCTIONS =====

// Download audio from article URL
async function downloadAudio(articleUrl, category) {
  try {
    // Get article content
    const { data } = await axios.get(articleUrl, { headers: DEFAULT_HEADERS })
    const $ = cheerio.load(data)
    const title = $('h1').text().trim() || 'no_title'
    const normalizedTitle = normalizeForAI(title)
    // Extract main article text (try multiple selectors) - PROPERLY include italic/bold text
    let articleText = ''

    // FIRST: Extract sapo/lead paragraph (usually italic intro text)
    let sapoText = ''
    const sapoSelectors = [
      '.singular-sapo',
      '.dt-news__sapo',
      '.article-sapo',
      '.sapo',
      '.lead',
      '.summary',
      '.intro',
      '.article-intro'
    ]

    for (const sapoSel of sapoSelectors) {
      const sapoElement = $(sapoSel)
      if (sapoElement.length > 0) {
        let sapoHTML = sapoElement.html() || ''

        // Preserve formatting in sapo
        sapoHTML = sapoHTML
          .replace(/<em[^>]*>/gi, '**')
          .replace(/<\/em>/gi, '**')
          .replace(/<i[^>]*>/gi, '*')
          .replace(/<\/i>/gi, '*')
          .replace(/<strong[^>]*>/gi, '**')
          .replace(/<\/strong>/gi, '**')
          .replace(/<b[^>]*>/gi, '**')
          .replace(/<\/b>/gi, '**')

        const tempSapo = cheerio.load(sapoHTML)
        sapoText = tempSapo.text().trim()
        if (sapoText) {
          console.log(`📝 Found sapo/intro text (${sapoText.length} chars): ${sapoSel}`)
          break
        }
      }
    }

    // THEN: Extract main content selectors
    const selectors = [
      '.singular-content',
      '.dt-news__content',
      '.article-content',
      '.content-detail',
      '.news-content',
      '.entry-content',
      '.article-body',
      '.content',
      '.body-content'
    ]

    for (const sel of selectors) {
      const element = $(sel)
      if (element.length > 0) {
        // First, remove image captions and photo credits (don't include in main text)
        const elementsToRemove = [
          '.dt-news__caption', // Dân trí caption class
          '.img-caption', // Common caption class
          '.caption', // Generic caption
          '.photo-caption', // Photo caption
          '.image-caption', // Image caption
          '.pic-caption', // Picture caption
          '.figure-caption', // Figure caption
          'figcaption', // HTML5 figcaption
          '.photo-credit', // Photo credit
          '.image-credit', // Image credit
          '.photographer', // Photographer credit
          '.source-photo' // Photo source
        ]

        // Remove caption elements from processing
        elementsToRemove.forEach((captionSel) => {
          element.find(captionSel).remove()
        })

        // Also remove italic text that's immediately after images
        element.find('img').each((i, imgEl) => {
          const $img = $(imgEl)
          // Remove italic text in next siblings that are likely captions
          $img.nextAll('em, i').each((j, italicEl) => {
            const italicText = $(italicEl).text().trim()
            // Remove if it looks like a caption (contains photo-related keywords)
            if (italicText.match(/(ảnh|hình|photo|nguồn|tác giả|chụp|:\s*[A-Z])/i)) {
              $(italicEl).remove()
            }
          })

          // Also check parent's next siblings for captions
          $img
            .parent()
            .nextAll()
            .first()
            .find('em, i')
            .each((j, italicEl) => {
              const italicText = $(italicEl).text().trim()
              if (italicText.match(/(ảnh|hình|photo|nguồn|tác giả|chụp|:\s*[A-Z])/i)) {
                $(italicEl).remove()
              }
            })
        })

        // Get text but preserve formatting markers for italic/bold
        let processedHTML = element.html()

        // Replace HTML tags with text markers to preserve emphasis
        processedHTML = processedHTML
          .replace(/<em[^>]*>/gi, '**') // Mark start of emphasis
          .replace(/<\/em>/gi, '**') // Mark end of emphasis
          .replace(/<i[^>]*>/gi, '*') // Mark start of italic
          .replace(/<\/i>/gi, '*') // Mark end of italic
          .replace(/<strong[^>]*>/gi, '**') // Mark start of strong
          .replace(/<\/strong>/gi, '**') // Mark end of strong
          .replace(/<b[^>]*>/gi, '**') // Mark start of bold
          .replace(/<\/b>/gi, '**') // Mark end of bold

        // Create temporary cheerio instance to extract clean text
        const tempElement = cheerio.load(processedHTML)
        let fullText = tempElement.text().trim()

        if (fullText && fullText.length > 50) {
          // Clean up excessive asterisks while preserving emphasis
          fullText = fullText
            .replace(/\*{3,}/g, '**') // Replace *** with **
            .replace(/\*\s*\*/g, '') // Remove empty ** **
            .replace(/\*{2}\s*\*{2}/g, ' ') // Replace ** ** with space

          articleText = fullText
          console.log(`📝 Extracted main content with formatting markers (${fullText.length} chars, captions removed)`)
          break
        }
      }
    }

    // Fallback: try to join all <p> tags inside main content (including formatting, excluding captions)
    if (!articleText) {
      let paragraphs = []
      for (const sel of selectors) {
        const container = $(sel)

        // Remove captions from container copy
        const captionsToRemove = [
          '.dt-news__caption',
          '.img-caption',
          '.caption',
          '.photo-caption',
          '.image-caption',
          '.pic-caption',
          '.figure-caption',
          'figcaption',
          '.photo-credit',
          '.image-credit',
          '.photographer',
          '.source-photo'
        ]
        captionsToRemove.forEach((captionSel) => {
          container.find(captionSel).remove()
        })

        container.find('p').each((i, el) => {
          let pHTML = $(el).html() || ''
          const pText = $(el).text().trim()

          // Skip paragraphs that look like image captions
          if (pText.match(/(ảnh|hình|photo|nguồn|tác giả|chụp):\s*[A-Z]/i) || pText.length < 10) {
            return // skip this paragraph
          }

          // Preserve formatting in paragraphs
          pHTML = pHTML
            .replace(/<em[^>]*>/gi, '**')
            .replace(/<\/em>/gi, '**')
            .replace(/<i[^>]*>/gi, '*')
            .replace(/<\/i>/gi, '*')
            .replace(/<strong[^>]*>/gi, '**')
            .replace(/<\/strong>/gi, '**')
            .replace(/<b[^>]*>/gi, '**')
            .replace(/<\/b>/gi, '**')

          const tempP = cheerio.load(pHTML)
          const finalPText = tempP.text().trim()
          if (finalPText) paragraphs.push(finalPText)
        })

        if (paragraphs.length > 0) break
      }
      if (paragraphs.length > 0) {
        articleText = paragraphs
          .join('\n\n')
          .replace(/\*{3,}/g, '**')
          .replace(/\*\s*\*/g, '')
          .replace(/\*{2}\s*\*{2}/g, ' ')
        console.log(`📝 Extracted from paragraphs with formatting (${articleText.length} chars, captions excluded)`)
      }
    }

    // Fallback: join all <p> tags in the page (including formatting, excluding captions)
    if (!articleText) {
      const paragraphs = []

      $('p').each((i, el) => {
        let pHTML = $(el).html() || ''
        const pText = $(el).text().trim()

        // Skip paragraphs that look like image captions or are too short
        if (pText.match(/(ảnh|hình|photo|nguồn|tác giả|chụp):\s*[A-Z]/i) || pText.length < 10) {
          return // skip this paragraph
        }

        // Skip if paragraph is inside caption containers
        const $p = $(el)
        if (
          $p.closest('.dt-news__caption, .img-caption, .caption, .photo-caption, .image-caption, figcaption').length > 0
        ) {
          return // skip caption paragraphs
        }

        pHTML = pHTML
          .replace(/<em[^>]*>/gi, '**')
          .replace(/<\/em>/gi, '**')
          .replace(/<i[^>]*>/gi, '*')
          .replace(/<\/i>/gi, '*')
          .replace(/<strong[^>]*>/gi, '**')
          .replace(/<\/strong>/gi, '**')
          .replace(/<b[^>]*>/gi, '**')
          .replace(/<\/b>/gi, '**')

        const tempP = cheerio.load(pHTML)
        const finalPText = tempP.text().trim()
        if (finalPText) paragraphs.push(finalPText)
      })

      if (paragraphs.length > 0) {
        articleText = paragraphs
          .join('\n\n')
          .replace(/\*{3,}/g, '**')
          .replace(/\*\s*\*/g, '')
          .replace(/\*{2}\s*\*{2}/g, ' ')
        console.log(`📝 Extracted from all paragraphs with formatting (${articleText.length} chars, captions excluded)`)
      }
    }

    // COMBINE SAPO + MAIN CONTENT
    if (sapoText || articleText) {
      const combinedParts = []
      if (sapoText) combinedParts.push(sapoText)
      if (articleText) combinedParts.push(articleText)

      articleText = combinedParts.join('\n\n')
      console.log(
        `📝 Final text: ${sapoText ? 'sapo' : 'no-sapo'} + ${articleText.length > sapoText.length ? 'content' : 'no-content'} = ${articleText.length} total chars`
      )
    }

    // Log warning if still empty
    if (!articleText) {
      console.warn(`⚠️  No article text found for: ${articleUrl}`)
    }

    // Extract article ID from URL
    const idMatch = articleUrl.match(/-(\d{17})\.htm$/)
    if (!idMatch) {
      return false
    }

    const articleId = idMatch[1]
    const year = articleId.substring(0, 4)
    const month = parseInt(articleId.substring(4, 6)).toString()
    const day = parseInt(articleId.substring(6, 8)).toString()

    // Create folder structure: category/articleId/
    const folder = path.join(SAVE_DIR, category.name, articleId)
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true })
    }

    const selectedVoices = getSelectedVoices(VOICE_MODE)
    let audioCount = 0
    const foundVoices = []
    const audioFiles = []

    console.log(`🎭 [${category.name}] Processing: ${normalizedTitle} (${articleId})`)

    // Download each selected voice
    for (const voice of selectedVoices) {
      const audioUrl = `https://acdn.dantri.com.vn/${year}/${month}/${day}/${articleId}/${voice.pattern}`
      const wavFilename = `${articleId}__${voice.label}.wav`
      const tempMp3Path = path.join(folder, `${articleId}__${voice.label}.mp3`)
      const finalWavPath = path.join(folder, wavFilename)

      try {
        // Check if audio exists on server
        const audioResponse = await axios.head(audioUrl, {
          headers: DEFAULT_HEADERS,
          timeout: CONFIG.REQUEST_TIMEOUT
        })

        if (audioResponse.status === 200) {
          // Skip if WAV already exists
          if (fs.existsSync(finalWavPath)) {
            console.log(`⚠️  Exists: ${wavFilename}`)
            audioCount++
            foundVoices.push(voice.name)
            audioFiles.push({
              filepath: path.relative(SAVE_DIR, finalWavPath).replace(/\\/g, '/'),
              voice: voice.label,
              filename: wavFilename
            })
            continue
          }

          // Download MP3 and convert to WAV
          await downloadFile(audioUrl, tempMp3Path)
          console.log(`📥 Downloaded: ${voice.label}`)
          await convertToWav(tempMp3Path, finalWavPath)

          audioCount++
          foundVoices.push(voice.name)
          audioFiles.push({
            filepath: path.relative(SAVE_DIR, finalWavPath).replace(/\\/g, '/'),
            voice: voice.label,
            filename: wavFilename
          })
        }
      } catch (checkErr) {
        console.log(`❌ No audio: ${voice.name}`)
      }

      // Small delay between voices
      if (selectedVoices.indexOf(voice) < selectedVoices.length - 1) {
        await sleep(CONFIG.DELAY_BETWEEN_VOICES)
      }
    }

    if (audioCount > 0) {
      console.log(`🎵 [${category.name}] Got ${audioCount} voices: [${foundVoices.join(', ')}]`)

      // Create metadata.json
      const metadata = {
        article_id: articleId,
        title: title,
        normalized_title: normalizedTitle,
        url: articleUrl,
        category: category.name,
        date_crawled: new Date().toISOString(),
        voice_count: audioCount,
        voices: foundVoices,
        audio_files: audioFiles,
        source: 'dantri.com.vn',
        article_text: articleText
      }

      const metadataFile = path.join(folder, 'metadata.json')
      if (!fs.existsSync(metadataFile)) {
        fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2), 'utf8')
      }

      // Create transcript file with raw text
      const transcriptFile = path.join(folder, 'transcript.txt')
      if (!fs.existsSync(transcriptFile)) {
        fs.writeFileSync(transcriptFile, `# Transcript: ${title}\n# URL: ${articleUrl}\n\n${articleText}\n`, 'utf8')
      }

      return true
    } else {
      // Remove folder if no audio downloaded
      if (fs.existsSync(folder)) {
        try {
          fs.rmSync(folder, { recursive: true, force: true })
          console.log(`🗑️  Removed empty folder: ${folder}`)
        } catch (e) {
          console.error(`❌ Failed to remove folder: ${folder} - ${e.message}`)
        }
      }
      return false
    }
  } catch (err) {
    console.error('❌ Error downloading audio:', err.message)
    return false
  }
}

// Crawl articles from category page
async function crawlCategoryPage(category) {
  try {
    const pageUrl = `https://dantri.com.vn/${category.url}.htm`
    console.log(`🔍 [${category.name}] Loading: ${pageUrl}`)

    // Get category page content
    const { data } = await axios.get(pageUrl, { headers: DEFAULT_HEADERS })
    const $ = cheerio.load(data)
    console.log(`✅ [${category.name}] Category page loaded`)

    // Extract all article links
    const articleLinksSet = new Set()
    $('a[href]').each((i, el) => {
      const articleUrl = $(el).attr('href')
      if (articleUrl) {
        let fullUrl = ''
        if (articleUrl.startsWith('/')) {
          fullUrl = 'https://dantri.com.vn' + articleUrl
        } else if (articleUrl.startsWith('https://dantri.com.vn/')) {
          fullUrl = articleUrl
        }
        if (fullUrl) {
          articleLinksSet.add(fullUrl)
        }
      }
    })

    // Filter valid article links
    const validArticleLinks = Array.from(articleLinksSet).filter((link) => {
      return (
        link.includes(`/${category.url}/`) &&
        !link.includes('/trang-') &&
        !link.includes(`/${category.url}.htm`) &&
        !link.includes('/tin-moi-nhat') &&
        !link.includes('/video-page') &&
        !link.includes('/lien-he') &&
        !link.includes('/rss') &&
        link.match(new RegExp(`/${category.url}/.*-[0-9]+.htm$`))
      )
    })

    console.log(`📰 [${category.name}] Found ${validArticleLinks.length} valid articles`)

    // Process articles
    let audioCount = 0
    let checkedCount = 0
    const maxAudioFiles = CONFIG.MAX_AUDIO_PER_CATEGORY
    const maxCheckedArticles = CONFIG.MAX_ARTICLES_TO_CHECK

    console.log(`🎯 [${category.name}] Target: ${CONFIG.MIN_AUDIO_PER_CATEGORY}-${maxAudioFiles} audio sets`)

    for (const link of validArticleLinks) {
      checkedCount++
      console.log(`\n🔍 [${category.name}] [${checkedCount}/${validArticleLinks.length}] Checking: ${link}`)

      const hasAudio = await downloadAudio(link, category)
      if (hasAudio) {
        audioCount++
        console.log(`🎵 [${category.name}] Progress: ${audioCount}/${maxAudioFiles} audio sets`)
      }

      // Stop when target reached
      if (audioCount >= maxAudioFiles || checkedCount >= maxCheckedArticles) {
        const status = audioCount >= CONFIG.MIN_AUDIO_PER_CATEGORY ? '✅' : '⚠️'
        console.log(
          `\n${status} [${category.name}] Done! ${audioCount}/` +
            `${CONFIG.MIN_AUDIO_PER_CATEGORY}-${maxAudioFiles} audio sets from ` +
            `${checkedCount} articles`
        )
        break
      }

      await sleep(CONFIG.DELAY_BETWEEN_ARTICLES)
    }

    // Final status check
    if (audioCount === 0) {
      console.log(`⚠️  [${category.name}] No audio found in checked articles`)
    } else if (audioCount < CONFIG.MIN_AUDIO_PER_CATEGORY) {
      console.log(
        `⚠️  [${category.name}] Only got ${audioCount}/` + `${CONFIG.MIN_AUDIO_PER_CATEGORY} minimum audio sets`
      )
    }

    return { category: category.name, audioCount, checkedCount }
  } catch (err) {
    console.error(`❌ [${category.name}] Error loading category page:`, err.message)
    return { category: category.name, audioCount: 0, checkedCount: 0 }
  }
}

// ===== MAIN EXECUTION =====

async function main() {
  console.log('🚀 Dantri Audio Crawler - Multi-Category')
  console.log(`🎵 Voice mode: ${VOICE_MODE}`)
  console.log(`📂 Output: ${SAVE_DIR}`)
  console.log(`📋 Categories: ${CATEGORIES.length}`)
  console.log(
    `⚙️  Config: ${CONFIG.MIN_AUDIO_PER_CATEGORY}-` + `${CONFIG.MAX_AUDIO_PER_CATEGORY} audio sets per category`
  )
  console.log(
    `⏱️  Delays: ${CONFIG.DELAY_BETWEEN_ARTICLES}ms (articles), ` + `${CONFIG.DELAY_BETWEEN_CATEGORIES}ms (categories)`
  )

  const startTime = Date.now()
  const results = []

  // Ensure output directory exists
  if (!fs.existsSync(SAVE_DIR)) {
    fs.mkdirSync(SAVE_DIR)
  }

  // Process each category
  for (let i = 0; i < CATEGORIES.length; i++) {
    const category = CATEGORIES[i]
    console.log(`\n${'='.repeat(60)}`)
    console.log(`📑 [${i + 1}/${CATEGORIES.length}] Category: ${category.name.toUpperCase()}`)
    console.log(`🔗 URL: ${category.url}`)
    console.log(`${'='.repeat(60)}`)

    const result = await crawlCategoryPage(category)
    results.push(result)

    // Delay between categories
    if (i < CATEGORIES.length - 1) {
      console.log(`\n⏱️  Waiting ${CONFIG.DELAY_BETWEEN_CATEGORIES / 1000}s before next category...`)
      await sleep(CONFIG.DELAY_BETWEEN_CATEGORIES)
    }
  }

  // Final summary
  const totalTime = Math.round((Date.now() - startTime) / 1000)
  const totalAudios = results.reduce((sum, r) => sum + r.audioCount, 0)
  const totalChecked = results.reduce((sum, r) => sum + r.checkedCount, 0)

  console.log(`\n${'='.repeat(80)}`)
  console.log('🎉 CRAWL COMPLETED')
  console.log(`${'='.repeat(80)}`)
  console.log(`⏱️  Total time: ${totalTime}s`)
  console.log(`📊 Articles checked: ${totalChecked}`)
  console.log(`🎵 Audio sets downloaded: ${totalAudios}`)
  console.log('\n📋 Results by category:')

  results.forEach((result, index) => {
    const status = result.audioCount >= CONFIG.MIN_AUDIO_PER_CATEGORY ? '✅' : '⚠️'
    console.log(
      `   ${status} ${index + 1}. ${result.category}: ${
        result.audioCount
      } audio sets from ${result.checkedCount} articles`
    )
  })

  console.log(`\n📂 All files saved to: ${SAVE_DIR}`)
  console.log(`${'='.repeat(80)}`)
}

// Run the crawler
if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Fatal error:', err.message)
    process.exit(1)
  })
}

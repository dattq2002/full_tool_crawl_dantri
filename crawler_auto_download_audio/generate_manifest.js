const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const SAVE_DIR = path.join(__dirname, 'dantri_audios')
const MANIFEST_PATH = path.join(SAVE_DIR, 'manifest.jsonl')

// Tính file hash
function getFileHash(filePath) {
  try {
    const data = fs.readFileSync(filePath)
    return crypto.createHash('sha1').update(data).digest('hex')
  } catch (err) {
    return null
  }
}

// Lấy thông tin audio file (duration, sample_rate)
function getAudioInfo(filePath) {
  // Placeholder - trong thực tế cần dùng ffprobe hoặc thư viện audio
  return {
    duration: null,
    sample_rate: 16000,
    channels: 1,
    format: 'wav'
  }
}

// Duyệt thư mục recursively
function walkDir(dir) {
  const results = []
  const list = fs.readdirSync(dir)

  list.forEach((file) => {
    const filePath = path.join(dir, file)
    const stat = fs.statSync(filePath)

    if (stat.isDirectory()) {
      results.push(...walkDir(filePath))
    } else {
      results.push(filePath)
    }
  })

  return results
}

function generateManifest() {
  console.log('🔍 Generating AI training manifest...')

  if (!fs.existsSync(SAVE_DIR)) {
    console.error(`❌ Directory not found: ${SAVE_DIR}`)
    return
  }

  const allFiles = walkDir(SAVE_DIR)
  const audioFiles = allFiles.filter((f) => path.extname(f).toLowerCase() === '.wav')

  console.log(`📊 Found ${audioFiles.length} WAV files`)

  const manifestStream = fs.createWriteStream(MANIFEST_PATH, { flags: 'w' })
  let count = 0

  audioFiles.forEach((audioPath) => {
    const relativePath = path.relative(SAVE_DIR, audioPath).replace(/\\/g, '/')
    const parts = relativePath.split('/')

    if (parts.length !== 3) {
      return
    } // Skip if not category/articleId/filename structure

    const [category, articleId, filename] = parts

    // Parse voice from filename: articleId__voice.wav
    const voiceMatch = filename.match(/__([a-z_]+)\.wav$/)
    const voice = voiceMatch ? voiceMatch[1] : ''

    const stats = fs.statSync(audioPath)
    const fileHash = getFileHash(audioPath)
    const audioInfo = getAudioInfo(audioPath)

    // Đọc metadata.json nếu có
    let metadata = {}
    try {
      const metadataPath = path.join(path.dirname(audioPath), 'metadata.json')
      if (fs.existsSync(metadataPath)) {
        metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
      }
    } catch (e) {
      // Ignore metadata errors
    }

    const entry = {
      filepath: relativePath,
      category: category,
      article_id: articleId,
      filename: filename,
      voice: voice,
      title: metadata.title || '',
      normalized_title: metadata.normalized_title || '',
      url: metadata.url || '',
      file_size: stats.size,
      file_hash: fileHash,
      sample_rate: audioInfo.sample_rate,
      channels: audioInfo.channels,
      duration: audioInfo.duration,
      format: audioInfo.format,
      source: 'dantri.com.vn',
      date_crawled: metadata.date_crawled || ''
    }

    manifestStream.write(JSON.stringify(entry) + '\n')
    count++
  })

  manifestStream.end()

  console.log(`✅ Generated manifest: ${MANIFEST_PATH}`)
  console.log(`📝 Total entries: ${count}`)

  // Generate summary stats
  const categories = {}
  const voices = {}

  audioFiles.forEach((audioPath) => {
    const parts = path.relative(SAVE_DIR, audioPath).replace(/\\/g, '/').split('/')
    if (parts.length === 3) {
      const [category] = parts
      const voiceMatch = parts[2].match(/__([a-z_]+)\.wav$/)
      const voice = voiceMatch ? voiceMatch[1] : 'unknown'

      categories[category] = (categories[category] || 0) + 1
      voices[voice] = (voices[voice] || 0) + 1
    }
  })

  console.log('\n📊 Dataset Statistics:')
  console.log('Categories:', categories)
  console.log('Voices:', voices)
}

if (require.main === module) {
  generateManifest()
}

module.exports = { generateManifest }

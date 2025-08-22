const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const SRC_DIR = path.join(__dirname, '..', 'dantri_audios')
const OUT_DIR = path.join(__dirname, '..', 'dantri_segments')
const REPORTS_DIR = path.join(OUT_DIR, 'reports')

// Các độ dài segment cố định
const SEGMENT_LENGTHS = [3, 5, 7, 10]

// Tạo thư mục output nếu chưa có
if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true })
}

// Tạo thư mục reports
if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true })
}

// Global variables để track progress
let globalStats = {
  startTime: null,
  totalFiles: 0,
  processedFiles: 0,
  skippedFiles: 0,
  totalSegments: 0,
  segmentsByFolder: {
    '3s': 0,
    '5s': 0,
    '7s': 0,
    '10s': 0,
    others: 0
  },
  currentFile: '',
  lastUpdateTime: null
}

// Tạo report file với timestamp
function createReportFile() {
  const now = new Date()
  // Format: YYYYMMDD
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const dateStr = `${yyyy}${mm}${dd}`
  return path.join(REPORTS_DIR, `segmentation_report_${dateStr}.json`)
}

// Lưu báo cáo progress
function saveProgressReport(status = 'in_progress', reportPath = null) {
  try {
    if (!reportPath) {
      reportPath = createReportFile()
    }

    // Cập nhật segment counts từ folder thực tế
    updateSegmentCounts()

    // Format timestamp as YYYYMMDD
    const now = new Date()
    const yyyy = now.getFullYear()
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    const dd = String(now.getDate()).padStart(2, '0')
    const dateStr = `${yyyy}${mm}${dd}`
    const report = {
      status,
      timestamp: dateStr,
      duration_minutes: globalStats.startTime ? Math.round((Date.now() - globalStats.startTime) / 1000 / 60) : 0,
      summary: {
        total_audio_files: globalStats.totalFiles,
        processed_files: globalStats.processedFiles,
        skipped_files: globalStats.skippedFiles,
        remaining_files: globalStats.totalFiles - globalStats.processedFiles - globalStats.skippedFiles,
        total_segments_created: globalStats.totalSegments
      },
      segment_distribution: { ...globalStats.segmentsByFolder },
      progress: {
        percentage:
          globalStats.totalFiles > 0
            ? Math.round(((globalStats.processedFiles + globalStats.skippedFiles) / globalStats.totalFiles) * 100)
            : 0,
        current_file: globalStats.currentFile,
        last_update: dateStr
      },
      paths: {
        source_directory: SRC_DIR,
        output_directory: OUT_DIR,
        reports_directory: REPORTS_DIR
      }
    }

    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    return reportPath
  } catch (error) {
    console.error(`❌ Error saving report: ${error.message}`)
    return null
  }
}

// Cập nhật segment counts từ folder thực tế
function updateSegmentCounts() {
  let totalSegments = 0

  FOLDERS.forEach((folder) => {
    const folderPath = path.join(OUT_DIR, folder)
    if (fs.existsSync(folderPath)) {
      const files = fs.readdirSync(folderPath).filter((f) => f.endsWith('.wav'))
      globalStats.segmentsByFolder[folder] = files.length
      totalSegments += files.length
    }
  })

  globalStats.totalSegments = totalSegments
}

// Handle process termination
function setupGracefulShutdown() {
  const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT']

  signals.forEach((signal) => {
    process.on(signal, () => {
      console.log(`\n⚠️ Received ${signal} - Saving progress report...`)
      const reportPath = saveProgressReport('interrupted')
      if (reportPath) {
        console.log(`📋 Progress report saved: ${path.basename(reportPath)}`)
      }
      console.log('👋 Process terminated safely')
      process.exit(0)
    })
  })
}

// Tạo các thư mục con cho từng độ dài
const FOLDERS = ['3s', '5s', '7s', '10s', 'others']
FOLDERS.forEach((folder) => {
  const folderPath = path.join(OUT_DIR, folder)
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true })
  }
})

// Lấy tất cả audio files có sẵn
function getAllAudioFiles() {
  const allFiles = []
  const categories = fs.readdirSync(SRC_DIR).filter((f) => fs.statSync(path.join(SRC_DIR, f)).isDirectory())

  for (const category of categories) {
    const catPath = path.join(SRC_DIR, category)
    const articles = fs.readdirSync(catPath).filter((f) => fs.statSync(path.join(catPath, f)).isDirectory())

    for (const article of articles) {
      const artPath = path.join(catPath, article)
      const wavs = getWavFiles(artPath)

      for (const wavFile of wavs) {
        const wavPath = path.join(artPath, wavFile)
        allFiles.push({
          category,
          article,
          filePath: wavPath,
          fileName: wavFile,
          id: `${category}/${article}/${wavFile}` // Unique identifier
        })
      }
    }
  }

  return allFiles
}

// Kiểm tra xem file đã được xử lý chưa bằng cách check segments có sẵn
function isFileAlreadyProcessed(audioInfo) {
  const { category, article, fileName } = audioInfo
  const voice = fileName.split('__')[1]?.replace('.wav', '') || 'voice'

  // Kiểm tra trong tất cả các thư mục segment
  for (const folder of FOLDERS) {
    const folderPath = path.join(OUT_DIR, folder)
    if (fs.existsSync(folderPath)) {
      const files = fs.readdirSync(folderPath)
      // Tìm file bắt đầu với pattern này
      const pattern = `${category}_${article}`
      if (files.some((f) => f.startsWith(pattern))) {
        return true
      }
    }
  }

  return false
}

function getWavFiles(folder) {
  return fs.readdirSync(folder).filter((f) => f.endsWith('.wav'))
}

function getDuration(filePath) {
  // Dùng ffprobe để lấy duration
  try {
    const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    const out = execSync(cmd).toString().trim()
    return parseFloat(out)
  } catch (e) {
    return null
  }
}

function extractSegment(srcPath, outPath, start, duration) {
  try {
    const cmd = `ffmpeg -ss ${start} -t ${duration} -i "${srcPath}" -acodec pcm_s16le -ar 16000 -ac 1 "${outPath}" -y`
    execSync(cmd, { stdio: 'pipe' })
    return true
  } catch (e) {
    console.error(`❌ Error extracting segment: ${e.message}`)
    return false
  }
}

function getSegmentFolder(duration) {
  if (SEGMENT_LENGTHS.includes(duration)) {
    return `${duration}s`
  }
  return 'others'
}

function processAudioFile(audioInfo) {
  const { category, article, filePath, fileName } = audioInfo

  // Cập nhật current file trong global stats
  globalStats.currentFile = `${category}/${article}/${fileName}`
  globalStats.lastUpdateTime = new Date().toISOString()

  // Lấy thông tin duration
  const totalDuration = getDuration(filePath)
  if (!totalDuration || totalDuration < 3) {
    console.log(`⚠️ Skipping ${fileName} - too short (${totalDuration}s)`)
    return 0
  }

  console.log(`🎵 Processing: ${category}/${article}/${fileName} (${totalDuration}s)`)

  let currentPos = 0
  let segmentCount = 0
  let segmentIndex = 1

  while (currentPos < totalDuration) {
    const remainingTime = totalDuration - currentPos

    // Chọn độ dài segment
    let segmentDuration

    // Nếu thời gian còn lại đủ cho một segment chuẩn
    const availableLengths = SEGMENT_LENGTHS.filter((len) => len <= remainingTime)

    if (availableLengths.length > 0) {
      // Random chọn một độ dài có thể
      segmentDuration = availableLengths[Math.floor(Math.random() * availableLengths.length)]
    } else if (remainingTime >= 1) {
      // Nếu không đủ cho segment chuẩn nhưng vẫn còn >= 1s thì lấy hết
      segmentDuration = Math.floor(remainingTime * 10) / 10 // Làm tròn 1 chữ số thập phân
    } else {
      // Quá ngắn, bỏ qua
      break
    }

    // Xác định thư mục đích
    const targetFolder = getSegmentFolder(Math.floor(segmentDuration))
    const targetFolderPath = path.join(OUT_DIR, targetFolder)

    // Tạo tên file output chỉ là category_article.wav
    const outputFileName = `${category}_${article}.wav`
    const outputPath = path.join(targetFolderPath, outputFileName)

    // Extract segment
    const success = extractSegment(filePath, outputPath, currentPos, segmentDuration)

    if (success) {
      console.log(`✅ ${targetFolder}/${outputFileName}`)
      segmentCount++
      // Cập nhật global stats
      globalStats.segmentsByFolder[targetFolder]++
      globalStats.totalSegments++
    } else {
      console.log(`❌ Failed: ${outputFileName}`)
    }

    currentPos += segmentDuration
    segmentIndex++
  }

  return segmentCount
}

function processAll() {
  console.log('🚀 Starting audio segmentation for ALL audio files...')
  console.log(`📂 Source: ${SRC_DIR}`)
  console.log(`📂 Output: ${OUT_DIR}`)
  console.log(`📋 Reports: ${REPORTS_DIR}`)
  console.log(`🎯 Target lengths: ${SEGMENT_LENGTHS.join(', ')} seconds + others`)

  // Setup graceful shutdown handlers
  setupGracefulShutdown()

  // Initialize global stats
  globalStats.startTime = Date.now()

  // Lấy tất cả audio files
  const allAudioFiles = getAllAudioFiles()
  globalStats.totalFiles = allAudioFiles.length
  console.log(`📊 Found ${allAudioFiles.length} total audio files`)

  // Lọc ra những file chưa được xử lý
  const unprocessedFiles = allAudioFiles.filter((audioInfo) => !isFileAlreadyProcessed(audioInfo))
  console.log(`📋 Files to process: ${unprocessedFiles.length}`)
  console.log(`✅ Already processed: ${allAudioFiles.length - unprocessedFiles.length}`)

  if (unprocessedFiles.length === 0) {
    console.log('🎉 All audio files have already been processed!')

    // Tạo báo cáo hoàn thành
    const reportPath = saveProgressReport('completed')
    if (reportPath) {
      console.log(`📋 Final report saved: ${path.basename(reportPath)}`)
    }
    return
  }

  let processedFiles = 0
  let skippedFiles = 0

  // Xử lý từng file một cách tuần tự
  for (let i = 0; i < unprocessedFiles.length; i++) {
    const audioInfo = unprocessedFiles[i]

    console.log(`\n📁 [${i + 1}/${unprocessedFiles.length}] Processing: ${audioInfo.id}`)

    const segmentCount = processAudioFile(audioInfo)

    if (segmentCount > 0) {
      processedFiles++
      globalStats.processedFiles = processedFiles
      console.log(`🎵 Created ${segmentCount} segments from this file`)
    } else {
      skippedFiles++
      globalStats.skippedFiles = skippedFiles
      console.log('⚠️ No segments created from this file')
    }

    // Lưu progress report mỗi 10 files hoặc mỗi 5 phút
    if ((i + 1) % 10 === 0 || (Date.now() - globalStats.startTime) % (5 * 60 * 1000) < 1000) {
      saveProgressReport('in_progress')
    }
  }

  // Final stats update
  globalStats.processedFiles = processedFiles
  globalStats.skippedFiles = skippedFiles

  console.log(`\n${'='.repeat(60)}`)
  console.log(`🎉 SEGMENTATION COMPLETED`)
  console.log(`${'='.repeat(60)}`)
  console.log(`📊 Total audio files found: ${allAudioFiles.length}`)
  console.log(`✅ Successfully processed: ${processedFiles}`)
  console.log(`⚠️ Skipped (too short): ${skippedFiles}`)
  console.log(`🔄 Already processed: ${allAudioFiles.length - unprocessedFiles.length}`)
  console.log(`🎵 Total segments created: ${globalStats.totalSegments}`)
  console.log(`📂 Output directory: ${OUT_DIR}`)

  // Show segment distribution
  console.log(`\n📈 Segment distribution:`)
  let totalCount = 0
  FOLDERS.forEach((folder) => {
    const folderPath = path.join(OUT_DIR, folder)
    if (fs.existsSync(folderPath)) {
      const files = fs.readdirSync(folderPath).filter((f) => f.endsWith('.wav'))
      console.log(`   ${folder}: ${files.length} segments`)
      totalCount += files.length
    }
  })
  console.log(`📊 Grand total segments: ${totalCount}`)

  // Tạo báo cáo cuối cùng
  const finalReportPath = saveProgressReport('completed')
  if (finalReportPath) {
    console.log(`\n📋 Final report saved: ${path.basename(finalReportPath)}`)
    console.log(`📁 Report location: ${finalReportPath}`)
  }
}

processAll()

const sdk = require('microsoft-cognitiveservices-speech-sdk')
const fs = require('fs')
const path = require('path')
require('dotenv').config()

const SPEECH_KEY = process.env.AZURE_SPEECH_KEY
const SPEECH_REGION = 'eastasia'

const speechConfig = sdk.SpeechConfig.fromSubscription(SPEECH_KEY, SPEECH_REGION)
speechConfig.speechRecognitionLanguage = 'vi-VN'

class AzureAudioProcessor {
  constructor() {
    this.baseDir = path.join(__dirname)
    this.segmentsDir = path.join(this.baseDir, 'dantri_segments')
    this.promptFilePath = path.join(this.baseDir, 'prompt_V2.txt')
  }

  async testKey() {
    return new Promise((resolve) => {
      console.log('🔍 Checking Azure Speech Key validity...')
      const synthesizer = new sdk.SpeechSynthesizer(speechConfig)
      synthesizer.speakTextAsync(
        'Test',
        (result) => {
          if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
            console.log('✅ Azure Speech Key is valid and working!')
            resolve(true)
          } else {
            console.error(`❌ Key test failed: ${result.reason}`)
            resolve(false)
          }
          synthesizer.close()
        },
        (err) => {
          console.error(`❌ Key test error: ${err}`)
          resolve(false)
          synthesizer.close()
        }
      )
    })
  }

  async transcribeAudioFile(audioPath) {
    return new Promise((resolve, reject) => {
      const pushStream = sdk.AudioInputStream.createPushStream()
      fs.createReadStream(audioPath)
        .on('data', (d) => pushStream.write(d))
        .on('end', () => pushStream.close())
        .on('error', (err) => reject(err))

      const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream)
      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig)

      recognizer.recognizeOnceAsync(
        (result) => {
          if (result.reason === sdk.ResultReason.RecognizedSpeech) {
            const transcribedText = result.text.trim()
            // Simple hallucination check
            if (
              transcribedText.toLowerCase().includes('subscribe') ||
              transcribedText.toLowerCase().includes('đăng ký') ||
              transcribedText.toLowerCase().includes('like') ||
              transcribedText.toLowerCase().includes('channel') ||
              transcribedText.toLowerCase().includes('kênh')
            ) {
              resolve('')
            } else {
              resolve(transcribedText)
            }
          } else {
            console.error(`Error transcribing ${path.basename(audioPath)}: ${result.reason}`)
            resolve('')
          }
          recognizer.close()
        },
        (err) => {
          console.error(`Error transcribing ${path.basename(audioPath)}: ${err}`)
          if (err.toString().includes('InvalidSubscriptionKey') || err.toString().includes('Forbidden')) {
            console.error('🚫 Azure Speech Key is invalid or expired. Please check your key.')
          }
          resolve('')
          recognizer.close()
        }
      )
    })
  }

  async processSegmentFolder(segmentFolder) {
    const segmentPath = path.join(this.segmentsDir, segmentFolder)
    if (!fs.existsSync(segmentPath)) {
      console.warn(`Folder not found: ${segmentPath}`)
      return
    }

    console.log(`Processing folder: ${segmentFolder}`)

    const audioFiles = []
    const extensions = ['.wav', '.mp3', '.m4a', '.flac']
    extensions.forEach((ext) => {
      const files = fs.readdirSync(segmentPath).filter((file) => file.endsWith(ext))
      files.forEach((file) => audioFiles.push(path.join(segmentPath, file)))
    })

    if (audioFiles.length === 0) {
      console.warn(`No audio files found in ${segmentFolder}`)
      return
    }

    console.log(`Found ${audioFiles.length} audio files`)

    // Load processed files from prompt_V2.txt to resume
    const processedFiles = new Set()
    if (fs.existsSync(this.promptFilePath)) {
      const content = fs.readFileSync(this.promptFilePath, 'utf8')
      content.split('\n').forEach((line) => {
        if (line.trim()) {
          const filename = line.split('|')[0]
          if (filename) processedFiles.add(filename)
        }
      })
    }
    console.log(`Already processed: ${processedFiles.size} files`)

    let processedCount = 0
    let skippedCount = 0
    const startTime = Date.now()

    for (let i = 0; i < audioFiles.length; i++) {
      const audioFile = audioFiles[i]
      const filename = path.basename(audioFile)

      if (processedFiles.has(filename)) {
        skippedCount++
        continue
      }

      const transcribedText = await this.transcribeAudioFile(audioFile)
      if (transcribedText) {
        const line = `${filename}|${transcribedText}\n`
        fs.appendFileSync(this.promptFilePath, line, 'utf8')
        processedCount++
      }

      // Log progress every 10 files or at the end
      if ((i + 1) % 10 === 0 || i === audioFiles.length - 1) {
        const totalProcessed = processedCount + skippedCount
        const progress = ((totalProcessed / audioFiles.length) * 100).toFixed(1)
        console.log(
          `📊 Progress: ${progress}% (${totalProcessed}/${audioFiles.length}) - Processed: ${processedCount}, Skipped: ${skippedCount}`
        )
      }
    }

    const totalTime = (Date.now() - startTime) / 1000
    const avgTime = processedCount > 0 ? totalTime / processedCount : 0
    console.log(
      `COMPLETED in ${totalTime.toFixed(1)}s - Total: ${processedCount}, Skipped: ${skippedCount}, Avg: ${avgTime.toFixed(2)}s/file`
    )
  }

  async processAllSegments() {
    const folders = ['3s', '5s', '7s', '10s', 'others']
    for (const folder of folders) {
      if (fs.existsSync(path.join(this.segmentsDir, folder))) {
        await this.processSegmentFolder(folder)
      }
    }
  }
}

async function main() {
  console.log('Azure Audio Processing Tool')
  console.log('='.repeat(50))
  const processor = new AzureAudioProcessor()
  const keyValid = await processor.testKey()
  if (!keyValid) {
    console.error('🚫 Azure Speech Key is invalid. Please check your key and region.')
    return
  }
  await processor.processAllSegments()
  console.log('All processing completed.')
}

if (require.main === module) {
  main().catch(console.error)
}

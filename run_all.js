const { spawn } = require('child_process')
const path = require('path')

// Đường dẫn đến thư mục chứa scripts
const scriptDir = __dirname

// Các bước cần chạy theo thứ tự
const steps = [
  { name: 'Crawling audio', command: 'node', args: ['crawler.js'] },
  { name: 'Extracting segments', command: 'node', args: ['extract_random_segments.js'] },
  { name: 'Speech-to-Text processing', command: 'node', args: ['azure_speech_sdk.js'] },
  { name: 'Fixing prompts', command: 'node', args: ['fix_prompt_file_V2.js'] },
  { name: 'Checking prompts', command: 'node', args: ['check_prompt.js'] }
]

// Hàm chạy một bước
function runStep(step, index) {
  return new Promise((resolve, reject) => {
    console.log(`\n=== Bước ${index + 1}: ${step.name} ===`)

    const child = spawn(step.command, step.args, {
      cwd: scriptDir,
      stdio: 'inherit',
      shell: true
    })

    child.on('close', (code) => {
      if (code === 0) {
        console.log(`✅ ${step.name} hoàn thành thành công!`)
        resolve()
      } else {
        console.error(`❌ ${step.name} thất bại với mã lỗi ${code}`)
        reject(new Error(`${step.name} failed with code ${code}`))
      }
    })

    child.on('error', (error) => {
      console.error(`❌ Lỗi khi chạy ${step.name}:`, error)
      reject(error)
    })
  })
}

// Hàm chính chạy tất cả các bước
async function runAll() {
  console.log('🚀 Bắt đầu chạy toàn bộ pipeline crawler...')
  console.log('Thời gian bắt đầu:', new Date().toISOString())

  try {
    for (let i = 0; i < steps.length; i++) {
      await runStep(steps[i], i)
    }

    console.log('\n🎉 Tất cả các bước đã hoàn thành thành công!')
    console.log('Thời gian kết thúc:', new Date().toISOString())
    console.log('📁 Kiểm tra kết quả trong các thư mục:')
    console.log('  - dantri_audios/ (audio files)')
    console.log('  - dantri_segments/ (segments)')
    console.log('  - prompt_fixed_V2.txt (fixed prompts)')
    console.log('  - check_prompt_matching_log.txt (verification log)')
  } catch (error) {
    console.error('\n💥 Pipeline thất bại:', error.message)
    console.log('🔧 Kiểm tra logs và thử chạy lại từng bước riêng lẻ nếu cần.')
    process.exit(1)
  }
}

// Chạy pipeline
runAll()

# 🎵 Audio Crawler for AI Training Data

Automated multi-category Vietnamese news audio crawler with voice segmentation for AI training pipelines.

## 📁 Project Structure

```
crawler_auto_download_audio/
├── crawler.js              # Main multi-category audio crawler
├── extract_random_segments.js  # Audio segmentation tool
├── generate_manifest.js    # Training manifest generator
├── package.json            # Dependencies and scripts
├── nodemon.json           # Development auto-restart config
├── .prettierrc            # Code formatting rules
├── .eslintrc.json         # Code linting rules
├── .editorconfig          # Editor consistency config
├── dantri_audios/         # Downloaded audio files by category
└── dantri_segments/       # Segmented training data
```

## 🚀 Quick Start

### Installation

```bash
npm install
```

### Usage

```bash
# Start crawler
npm run crawl

# Extract audio segments
npm run segment

# Generate training manifest
npm run manifest

# Development mode
npm run dev
```

### Code Quality

```bash
# Format code
npm run format

# Check linting
npm run lint

# Fix linting issues
npm run lint:fix
```

## ⚙️ Configuration

Edit CONFIG object in `crawler.js`:

- `categories`: News categories to crawl
- `minFiles`/`maxFiles`: Download limits per category
- `delayBetween`: Request timing controls
- `voices`: Regional voice selection (1=North, 2=Central, 3=South)

## 🎯 Features

- ✅ Multi-category news crawling (xa-hoi, kinh-doanh, giai-tri, suc-khoe, cong-nghe)
- ✅ 3 regional Vietnamese voices per article
- ✅ AI-ready folder structure and naming conventions
- ✅ Auto MP3→WAV conversion (PCM16 16kHz mono)
- ✅ Audio segmentation for training data (3s, 5s, 7s, 10s, others)
- ✅ Organized segment folders by duration (3s/, 5s/, 7s/, 10s/, others/)
- ✅ Progress reporting system with JSON reports (interrupted/completed runs)
- ✅ Configurable download limits and timing
- ✅ JSONL manifest generation for ML pipelines
- ✅ Clean modular codebase with linting/formatting

## 🔧 Technical Details

**Audio Source**: Dantri.com.vn news articles  
**Audio Format**: WAV PCM16 16kHz mono (AI training ready)  
**Naming**: `articleId__voice.wav` format  
**Structure**: `category/articleId/files` hierarchy  
**Segment Folders**: Segments organized by duration: `3s/`, `5s/`, `7s/`, `10s/`, `others/`
**Progress Reports**: JSON reports saved in `dantri_segments/reports/` as `segmentation_report_YYYYMMDD.json`
**Report Timestamp**: Only date (YYYYMMDD) is used for filenames and inside report files
**Graceful Shutdown**: Progress report auto-saved if process is interrupted
**Dependencies**: FFmpeg required for audio conversion

## 📊 Output Structure

```
dantri_audios/
├── xa-hoi/
│   └── article123/
│       ├── article123__1.wav  # North voice
│       ├── article123__2.wav  # Central voice
│       └── article123__3.wav  # South voice
└── ...

dantri_segments/
├── 3s/
│   └── xa-hoi_article123_1_seg001_3s.wav
├── 5s/
│   └── xa-hoi_article123_1_seg002_5s.wav
├── 7s/
│   └── xa-hoi_article123_1_seg003_7s.wav
├── 10s/
│   └── xa-hoi_article123_1_seg004_10s.wav
├── others/
│   └── xa-hoi_article123_1_seg005_2.5s.wav
└── reports/
	└── segmentation_report_20250821.json
```

### 📋 Progress Report Example

```json
{
  "status": "completed",
  "timestamp": "20250821",
  "duration_minutes": 12,
  "summary": {
    "total_audio_files": 180,
    "processed_files": 180,
    "skipped_files": 0,
    "remaining_files": 0,
    "total_segments_created": 5659
  },
  "segment_distribution": {
    "3s": 2345,
    "5s": 1890,
    "7s": 900,
    "10s": 400,
    "others": 124
  },
  "progress": {
    "percentage": 100,
    "current_file": "",
    "last_update": "20250821"
  },
  "paths": {
    "source_directory": "dantri_audios",
    "output_directory": "dantri_segments",
    "reports_directory": "dantri_segments/reports"
  }
}
```

import os
import whisper
import glob
from pathlib import Path
from datetime import datetime
import logging
import warnings

# Suppress warnings for cleaner output
warnings.filterwarnings("ignore", category=UserWarning)

# Cấu hình logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class AudioProcessor:
    def __init__(self):
        """Khởi tạo processor tối ưu cho TỐC ĐỘ & ĐỘ CHÍNH XÁC."""
        # Load Whisper model cho tốc độ & chất lượng cân bằng
        self.model = whisper.load_model("small")
        self.base_dir = Path(__file__).parent.parent
        self.segments_dir = self.base_dir / "dantri_segments"
        self.audios_dir = self.base_dir / "dantri_audios"
        self.output_dir = self.base_dir / "Speech_to_Text_tool" / "transcribed_results"

    def transcribe_audio_file(self, audio_path: Path) -> str:
        try:
            result = self.model.transcribe(
                str(audio_path), 
                language="vi",
                temperature=0,
                no_speech_threshold=0.6,
                logprob_threshold=-1.0,
                compression_ratio_threshold=2.4,
                condition_on_previous_text=False,
                word_timestamps=False,
                prepend_punctuations="\"'¿([{-",
                append_punctuations="\"'.。,，!！?？:：",
            )
            transcribed_text = result["text"].strip()
            if any(p in transcribed_text.lower() for p in ["subscribe", "đăng ký", "like", "channel", "kênh"]):
                logger.warning(f"⚠️ Hallucination detected: {transcribed_text[:30]}...")
                return ""
            return transcribed_text
        except Exception as e:
            logger.error(f"❌ Error transcribing {audio_path}: {e}")
            return ""

    def process_segment_folder(self, segment_folder: str):
        segment_path = self.segments_dir / segment_folder
        if not segment_path.exists():
            logger.warning(f"⚠️ Folder not found: {segment_path}")
            return
        logger.info(f"📁 Processing folder: {segment_folder}")
        audio_files = []
        for ext in ['*.wav', '*.mp3', '*.m4a', '*.flac']:
            audio_files.extend(glob.glob(str(segment_path / ext)))
        if not audio_files:
            logger.warning(f"⚠️ No audio files found in {segment_folder}")
            return
        logger.info(f"🎵 Found {len(audio_files)} audio files")
        self.output_dir.mkdir(exist_ok=True)
        report_file_path = self.output_dir / f"enhanced_report_{segment_folder}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
        prompt_file_path = self.base_dir / "prompt.txt"
        start_time = datetime.now()
        processed_count = 0
        for i, audio_file in enumerate(audio_files, 1):
            audio_path = Path(audio_file)
            logger.info(f"⚡ [{i}/{len(audio_files)}] Processing: {audio_path.name}")
            transcribed_text = self.transcribe_audio_file(audio_path)
            if not transcribed_text:
                logger.warning(f"⚠️ No transcription: {audio_path.name}")
                continue
            # Save original ASR result
            with open(report_file_path, 'a', encoding='utf-8') as f:
                f.write(f"{audio_path.name}|ORIGINAL_ASR|0.50\n")
                f.write(f"ORIGINAL: {transcribed_text}\n")
                f.write(f"FINAL: {transcribed_text}\n\n")
            with open(prompt_file_path, 'a', encoding='utf-8') as f:
                f.write(f"{audio_path.name}|{transcribed_text}\n")
            processed_count += 1
        total_time = (datetime.now() - start_time).total_seconds()
        logger.info(f"🎉 COMPLETED in {total_time:.1f}s - Total: {processed_count}, Original ASR: {processed_count}")

    def process_all_segments(self):
        for folder in ['3s', '5s', '7s', '10s', 'others']:
            if (self.segments_dir / folder).exists():
                self.process_segment_folder(folder)

def main():
    print("⚡ Audio Processing Tool - ORIGINAL ASR ONLY")
    print("="*70)
    processor = AudioProcessor()
    choice = input("""
Choose option:
1. Process all folders
2. Process specific folder
3. Exit

Enter choice (1-3): """).strip()
    if choice == '1':
        processor.process_all_segments()
    elif choice == '2':
        folder = input("Enter folder (3s, 5s, 7s, 10s, others): ").strip()
        if folder in ['3s', '5s', '7s', '10s', 'others']:
            processor.process_segment_folder(folder)
        else:
            logger.error("❌ Invalid folder name")
    elif choice == '3':
        logger.info("👋 Goodbye!")
    else:
        logger.error("❌ Invalid choice")

if __name__ == "__main__":
    main()

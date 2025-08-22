import os
import json
import whisper
import glob
import re
import unicodedata
from pathlib import Path
from datetime import datetime
import logging
import warnings
from rapidfuzz import fuzz, process
from typing import List, Tuple, Dict
from difflib import SequenceMatcher

# Không import semantic model để tăng tốc độ
HAS_SENTENCE_TRANSFORMERS = False

# Suppress warnings for cleaner output
warnings.filterwarnings("ignore", category=UserWarning)

# Cấu hình logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class AudioProcessor:
    def __init__(self):
        """Khởi tạo processor tối ưu cho TỐC ĐỘ & ĐỘ CHÍNH XÁC."""
        # Load Whisper model medium cho tiếng Việt tốt hơn
        self.model = whisper.load_model("small")
        self.base_dir = Path(__file__).parent.parent
        self.segments_dir = self.base_dir / "dantri_segments"
        self.audios_dir = self.base_dir / "dantri_audios"
        self.output_dir = self.base_dir / "Speech_to_Text_tool" / "transcribed_results"
        
        # Cache transcript files với parsed sentences để matching siêu nhanh
        self.transcript_cache = {}
        self._load_all_transcripts()
        
        # Tắt semantic model để tăng tốc độ
        self.semantic_model = None
        logger.info("⚡ Semantic model disabled for maximum speed")
        
        # Cache để tối ưu performance
        self._similarity_cache = {}
        
        # Tạo thư mục output
        self.output_dir.mkdir(exist_ok=True)
        logger.info("🚀 AudioProcessor initialized với SPEED & ACCURACY optimization")

    def normalize_vi(self, s: str, strip_tone: bool = False) -> str:
        """Chuẩn hóa tiếng Việt: NFC, lower, gom khoảng trắng. Tùy chọn bỏ dấu thanh."""
        if s is None:
            return ""
        s = unicodedata.normalize("NFC", s).strip().lower()
        s = re.sub(r"\s+", " ", s)
        if strip_tone:
            # NFD -> bỏ các ký tự dấu (Mn) -> NFC
            s = unicodedata.normalize("NFD", s)
            s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
            s = unicodedata.normalize("NFC", s)
        return s

    def split_sentences_vi(self, text: str):
        """Cắt câu tiếng Việt: theo ., !, ?, … và xuống dòng. Giữ lại dấu câu để tăng accuracy."""
        parts = re.split(r'(?<=[\.\!\?…])\s+|\n+', text)
        return [p.strip() for p in parts if p and p.strip()]

    def difflib_ratio(self, a: str, b: str) -> float:
        """SequenceMatcher.ratio() với Ratcliff-Obershelp algorithm ∈ [0,1]"""
        return SequenceMatcher(None, a, b).ratio()

    def fuzzy_score_vi(self, query: str, candidate: str, strip_tone: bool = False) -> float:
        """
        Trả về điểm tương đồng 0..1 giữa query và candidate.
        - Tính trên bản có dấu & (tuỳ chọn) không dấu, lấy max.
        - Sử dụng difflib Ratcliff-Obershelp algorithm cho tiếng Việt.
        """
        # Tính trên cả 2 biến thể (có dấu / không dấu) rồi lấy max
        a1, b1 = self.normalize_vi(query, False), self.normalize_vi(candidate, False)
        a2, b2 = self.normalize_vi(query, True),  self.normalize_vi(candidate, True)
        return max(self.difflib_ratio(a1, b1), self.difflib_ratio(a2, b2))

    def exact_matches_vi(self, query: str, sentences, strip_tone: bool = False):
        """Trả về danh sách câu khớp EXACT sau chuẩn hóa tiếng Việt."""
        qn = self.normalize_vi(query, strip_tone=strip_tone)
        hits = []
        for idx, s in enumerate(sentences):
            if self.normalize_vi(s, strip_tone=strip_tone) == qn:
                hits.append({"index": idx, "sentence": s, "score": 1.0})
        return hits

    def fuzzy_topk_vi(self, query: str, sentences, topk: int = 5, strip_tone: bool = False):
        """Xếp hạng top-k câu theo fuzzy_score_vi với Ratcliff-Obershelp."""
        scored = []
        for idx, s in enumerate(sentences):
            sc = self.fuzzy_score_vi(query, s, strip_tone=strip_tone)
            scored.append((sc, idx, s))
        scored.sort(key=lambda x: x[0], reverse=True)
        out = [{"rank": i+1, "score": sc, "index": idx, "sentence": s}
               for i, (sc, idx, s) in enumerate(scored[:max(0, topk)])]
        return out

    def _load_all_transcripts(self):
        """Load tất cả transcript files vào cache với parsed sentences"""
        logger.info("📚 Loading all transcript files into cache với parsed sentences...")
        transcript_count = 0
        
        for category_dir in self.audios_dir.iterdir():
            if category_dir.is_dir():
                for article_dir in category_dir.iterdir():
                    if article_dir.is_dir() and len(article_dir.name) == 17 and article_dir.name.isdigit():
                        transcript_file = article_dir / "transcript.txt"
                        if transcript_file.exists():
                            try:
                                content = transcript_file.read_text(encoding='utf-8').strip()
                                # Parse thành sentences với word sets để matching nhanh
                                sentences = self._parse_sentences_for_cache(content)
                                self.transcript_cache[article_dir.name] = {
                                    'full_text': content,
                                    'sentences': sentences
                                }
                                transcript_count += 1
                            except Exception as e:
                                logger.warning(f"⚠️ Error loading transcript {article_dir.name}: {e}")
        
        logger.info(f"✅ Loaded {transcript_count} transcript files với parsed sentences")

    def _parse_sentences_for_cache(self, text):
        """Parse text thành sentences với pre-computed data để matching siêu nhanh - Vietnamese optimized"""
        sentences = self.split_sentences_vi(text)
        parsed_sentences = []
        
        for s in sentences:
            s = s.strip()
            if s and len(s) > 10:  # Chỉ lấy câu đủ dài
                # Chuẩn hóa tiếng Việt với cả 2 biến thể
                normalized = self.normalize_vi(s, strip_tone=False)
                normalized_notone = self.normalize_vi(s, strip_tone=True)
                words = set(normalized.split())
                words_notone = set(normalized_notone.split())
                
                parsed_sentences.append({
                    'text': s,
                    'words': words,
                    'words_notone': words_notone,
                    'length': len(s.split()),
                    'normalized': normalized,
                    'normalized_notone': normalized_notone
                })
        
        return parsed_sentences

    def normalize_text(self, text):
        """Chuẩn hóa text cho matching - sử dụng Vietnamese normalization"""
        return self.normalize_vi(text, strip_tone=False)

    def ultra_fast_match(self, transcribed_text, transcript_data):
        """Vietnamese-optimized matching với exact + fuzzy matching sử dụng Ratcliff-Obershelp"""
        if not transcript_data or not transcribed_text:
            return transcribed_text

        # Lấy danh sách sentences từ transcript data
        if isinstance(transcript_data, dict) and 'sentences' in transcript_data:
            sentences = [sent_data['text'] for sent_data in transcript_data['sentences']]
        else:
            # Fallback cho old format
            sentences = self.split_sentences_vi(transcript_data.get('full_text', '') if isinstance(transcript_data, dict) else transcript_data)

        if not sentences:
            return transcribed_text

        # BƯỚC 1: EXACT MATCH - Kiểm tra khớp chính xác
        exact_hits = self.exact_matches_vi(transcribed_text, sentences, strip_tone=False)
        if exact_hits:
            best_exact = exact_hits[0]['sentence']
            logger.info(f"✅ EXACT MATCH (100%): '{best_exact[:50]}...'")
            return best_exact
        
        # BƯỚC 2: EXACT MATCH không dấu - Chịu lỗi chính tả/ASR
        exact_hits_notone = self.exact_matches_vi(transcribed_text, sentences, strip_tone=True)
        if exact_hits_notone:
            best_exact_notone = exact_hits_notone[0]['sentence']
            logger.info(f"✅ EXACT MATCH NO-TONE (100%): '{best_exact_notone[:50]}...'")
            return best_exact_notone

        # BƯỚC 3: FUZZY MATCH - Sử dụng Ratcliff-Obershelp algorithm
        fuzzy_candidates = self.fuzzy_topk_vi(transcribed_text, sentences, topk=3, strip_tone=False)
        
        if fuzzy_candidates and fuzzy_candidates[0]['score'] > 0.7:  # Threshold cao cho quality
            best_fuzzy = fuzzy_candidates[0]['sentence']
            best_score = fuzzy_candidates[0]['score']
            
            # Validation bổ sung - kiểm tra word overlap
            trans_words = set(self.normalize_vi(transcribed_text, strip_tone=False).split())
            cand_words = set(self.normalize_vi(best_fuzzy, strip_tone=False).split())
            
            if trans_words and cand_words:
                word_overlap = len(trans_words & cand_words) / len(trans_words)
                
                # Chấp nhận nếu có word overlap đủ cao HOẶC fuzzy score rất cao
                if word_overlap > 0.3 or best_score > 0.85:
                    logger.info(f"✅ FUZZY MATCH (score: {best_score:.2f}, word overlap: {word_overlap:.2f}): '{best_fuzzy[:50]}...'")
                    return best_fuzzy

        # BƯỚC 4: FUZZY MATCH không dấu - Fallback cuối cùng
        fuzzy_candidates_notone = self.fuzzy_topk_vi(transcribed_text, sentences, topk=3, strip_tone=True)
        
        if fuzzy_candidates_notone and fuzzy_candidates_notone[0]['score'] > 0.6:  # Threshold thấp hơn cho no-tone
            best_fuzzy_notone = fuzzy_candidates_notone[0]['sentence']
            best_score_notone = fuzzy_candidates_notone[0]['score']
            
            # Validation với no-tone words
            trans_words_notone = set(self.normalize_vi(transcribed_text, strip_tone=True).split())
            cand_words_notone = set(self.normalize_vi(best_fuzzy_notone, strip_tone=True).split())
            
            if trans_words_notone and cand_words_notone:
                word_overlap_notone = len(trans_words_notone & cand_words_notone) / len(trans_words_notone)
                
                if word_overlap_notone > 0.25 or best_score_notone > 0.8:
                    logger.info(f"✅ FUZZY NO-TONE MATCH (score: {best_score_notone:.2f}, word overlap: {word_overlap_notone:.2f}): '{best_fuzzy_notone[:50]}...'")
                    return best_fuzzy_notone

        # Không tìm thấy match đủ tốt
        logger.info(f"⚠️ No good match found, returning original: '{transcribed_text[:50]}...'")
        return transcribed_text

    def calculate_semantic_similarity(self, text1: str, text2: str) -> float:
        """Tính semantic similarity nếu có sentence transformers"""
        if not self.semantic_model or not text1 or not text2:
            return 0.0
        
        try:
            embeddings = self.semantic_model.encode([text1, text2])
            similarity = float(embeddings[0] @ embeddings[1] / (
                (embeddings[0] @ embeddings[0]) ** 0.5 * (embeddings[1] @ embeddings[1]) ** 0.5
            ))
            return max(0, similarity)  # Ensure non-negative
        except Exception as e:
            logger.warning(f"⚠️ Semantic similarity error: {e}")
            return 0.0

    def calculate_enhanced_similarity(self, text1, text2):
        """Tính toán similarity score với Vietnamese-optimized algorithms"""
        if not text1 or not text2:
            return 0.0
        
        # Cache để tránh tính toán lại
        cache_key = f"{hash(text1)}_{hash(text2)}"
        if cache_key in self._similarity_cache:
            return self._similarity_cache[cache_key]
        
        # 1. Vietnamese fuzzy score (Ratcliff-Obershelp với normalization)
        vi_fuzzy_score = self.fuzzy_score_vi(text1, text2, strip_tone=False)
        
        # 2. RapidFuzz WRatio cho so sánh
        norm_text1 = self.normalize_vi(text1, strip_tone=False)
        norm_text2 = self.normalize_vi(text2, strip_tone=False)
        wratio = fuzz.WRatio(norm_text1, norm_text2) / 100.0
        
        # 3. Jaccard similarity trên Vietnamese normalized words
        words1 = set(norm_text1.split())
        words2 = set(norm_text2.split())
        if words1 and words2:
            jaccard = len(words1 & words2) / len(words1 | words2)
        else:
            jaccard = 0.0
        
        # 4. Length penalty
        len1, len2 = len(norm_text1.split()), len(norm_text2.split())
        if max(len1, len2) > 0:
            length_penalty = min(len1, len2) / max(len1, len2)
        else:
            length_penalty = 1.0
        
        # Combined score: ưu tiên Vietnamese fuzzy score
        combined = (vi_fuzzy_score * 0.5 + wratio * 0.3 + jaccard * 0.2) * length_penalty
        
        # Cache kết quả
        self._similarity_cache[cache_key] = float(combined)
        
        # Giới hạn cache size
        if len(self._similarity_cache) > 3000:
            oldest_keys = list(self._similarity_cache.keys())[:500]
            for key in oldest_keys:
                del self._similarity_cache[key]
        
        return float(combined)

    def get_original_transcript(self, audio_filename):
        """Tìm transcript gốc từ cache với parsed data"""
        try:
            # Extract article ID (17 digits) từ filename
            parts = Path(audio_filename).stem.split("_")
            article_id = next((part for part in parts if len(part) == 17 and part.isdigit()), None)
            
            if not article_id:
                return None
            
            # Lấy từ cache với structured data
            if article_id in self.transcript_cache:
                return self.transcript_cache[article_id]
            else:
                return None
            
        except Exception as e:
            logger.error(f"❌ Error getting transcript: {e}")
            return None

    def transcribe_audio_file(self, audio_path):
        """Nhận diện audio bằng Whisper với tốc độ tối ưu"""
        try:
            # Ultra-fast transcription với minimum parameters
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
            
            # Fast hallucination detection
            if any(pattern in transcribed_text.lower() for pattern in 
                   ["subscribe", "đăng ký", "like", "channel", "kênh"]):
                logger.warning(f"⚠️ Hallucination detected: {transcribed_text[:30]}...")
                return ""
            
            return transcribed_text
            
        except Exception as e:
            logger.error(f"❌ Error transcribing {audio_path}: {e}")
            return ""

    def find_best_match(self, transcribed_text, reference_text):
        """Enhanced matching với ultra fast matching + fallback to advanced matching"""
        if not reference_text or not transcribed_text:
            return transcribed_text

        # Kiểm tra xem reference_text có phải là structured data không
        if isinstance(reference_text, dict) and 'sentences' in reference_text:
            # Use ultra fast matching first
            fast_result = self.ultra_fast_match(transcribed_text, reference_text)
            if fast_result != transcribed_text:
                return fast_result
            
            # Fallback to simple sentence matching với full text
            return self.simple_sentence_match(transcribed_text, reference_text['full_text'])
        else:
            # Legacy support cho old cache format
            return self.simple_sentence_match(transcribed_text, reference_text)

    def simple_sentence_match(self, transcribed_text, reference_text):
        """Vietnamese-optimized sentence matching với exact + fuzzy logic"""
        if not reference_text or not transcribed_text:
            return transcribed_text

        # Chia reference text thành các câu bằng Vietnamese sentence splitting
        sentences = self.split_sentences_vi(reference_text)
        sentences = [s.strip() for s in sentences if s.strip() and len(s.strip()) > 3]
        
        if not sentences:
            return transcribed_text

        # BƯỚC 1: EXACT MATCH - Tìm khớp chính xác
        exact_hits = self.exact_matches_vi(transcribed_text, sentences, strip_tone=False)
        if exact_hits:
            best_match = exact_hits[0]['sentence']
            logger.info(f"✅ Simple Exact Match: '{best_match[:50]}...'")
            return best_match
        
        # BƯỚC 2: EXACT MATCH không dấu
        exact_hits_notone = self.exact_matches_vi(transcribed_text, sentences, strip_tone=True)
        if exact_hits_notone:
            best_match_notone = exact_hits_notone[0]['sentence']
            logger.info(f"✅ Simple Exact No-tone Match: '{best_match_notone[:50]}...'")
            return best_match_notone

        # BƯỚC 3: FUZZY MATCH với Ratcliff-Obershelp
        fuzzy_candidates = self.fuzzy_topk_vi(transcribed_text, sentences, topk=5, strip_tone=False)
        
        if fuzzy_candidates and fuzzy_candidates[0]['score'] > 0.6:  # Reasonable threshold
            best_fuzzy = fuzzy_candidates[0]['sentence']
            best_score = fuzzy_candidates[0]['score']
            
            # Additional validation - length and word overlap check
            trans_length = len(transcribed_text.split())
            cand_length = len(best_fuzzy.split())
            length_ratio = cand_length / trans_length if trans_length > 0 else 1.0
            
            # Accept if reasonable length ratio
            if 0.3 <= length_ratio <= 4.0:
                logger.info(f"✅ Simple Fuzzy Match (score: {best_score:.2f}, length ratio: {length_ratio:.2f}): '{best_fuzzy[:50]}...'")
                return best_fuzzy

        # BƯỚC 4: FUZZY MATCH không dấu - fallback cuối
        fuzzy_candidates_notone = self.fuzzy_topk_vi(transcribed_text, sentences, topk=5, strip_tone=True)
        
        if fuzzy_candidates_notone and fuzzy_candidates_notone[0]['score'] > 0.5:  # Lower threshold for no-tone
            best_fuzzy_notone = fuzzy_candidates_notone[0]['sentence']
            best_score_notone = fuzzy_candidates_notone[0]['score']
            
            trans_length = len(transcribed_text.split())
            cand_length = len(best_fuzzy_notone.split())
            length_ratio = cand_length / trans_length if trans_length > 0 else 1.0
            
            if 0.2 <= length_ratio <= 5.0:  # More permissive for no-tone
                logger.info(f"✅ Simple Fuzzy No-tone Match (score: {best_score_notone:.2f}, length ratio: {length_ratio:.2f}): '{best_fuzzy_notone[:50]}...'")
                return best_fuzzy_notone
        
        # Không tìm được match tốt
        return transcribed_text

    def validate_improvement(self, original, candidate):
        """Validate xem candidate có thực sự tốt hơn original không - VERY PERMISSIVE"""
        try:
            # Kiểm tra độ dài hợp lý - rất permissive
            orig_len = len(original.split())
            cand_len = len(candidate.split())
            
            # Allow very wide range
            if cand_len < orig_len * 0.2 or cand_len > orig_len * 8:
                logger.warning(f"⚠️ Validation failed: Length ratio too extreme ({orig_len} -> {cand_len})")
                return False
            
            # Nếu candidate ngắn hơn nhiều, cần kiểm tra kỹ hơn
            if cand_len < orig_len * 0.4:
                similarity = self.calculate_enhanced_similarity(original, candidate)
                if similarity < 0.2:
                    logger.warning(f"⚠️ Validation failed: Candidate too short and low similarity ({similarity:.2f})")
                    return False
            
            # Nếu candidate dài hơn nhiều, cần score cao hơn
            if cand_len > orig_len * 3:
                similarity = self.calculate_enhanced_similarity(original, candidate)
                if similarity < 0.3:
                    logger.warning(f"⚠️ Validation failed: Candidate too long with low similarity ({similarity:.2f})")
                    return False
                    
            logger.info(f"✅ Validation passed: {orig_len} -> {cand_len} words")
            return True
            
        except Exception as e:
            logger.error(f"❌ Validation error: {e}")
            return True  # Default to accepting if validation fails

    def process_segment_folder(self, segment_folder):
        """Xử lý một folder segment với enhanced accuracy"""
        segment_path = self.segments_dir / segment_folder
        if not segment_path.exists():
            logger.warning(f"⚠️ Folder not found: {segment_path}")
            return
        
        logger.info(f"📁 Processing folder: {segment_folder}")
        
        # Lấy danh sách file audio
        audio_files = []
        for ext in ['*.wav', '*.mp3', '*.m4a', '*.flac']:
            audio_files.extend(glob.glob(str(segment_path / ext)))
        
        if not audio_files:
            logger.warning(f"⚠️ No audio files found in {segment_folder}")
            return
        
        logger.info(f"🎵 Found {len(audio_files)} audio files")
        
        # Tạo thư mục output
        self.output_dir.mkdir(exist_ok=True)
        
        # Files output
        report_file_path = self.output_dir / f"enhanced_report_{segment_folder}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
        prompt_file_path = self.output_dir / "prompt.txt"
        
        results = []
        start_time = datetime.now()
        
        for i, audio_file in enumerate(audio_files, 1):
            audio_path = Path(audio_file)
            logger.info(f"⚡ [{i}/{len(audio_files)}] Processing: {audio_path.name}")
            
            # 1. Transcribe audio
            transcribed_text = self.transcribe_audio_file(audio_path)
            if not transcribed_text:
                logger.warning(f"⚠️ No transcription: {audio_path.name}")
                continue
            
            # 2. Get reference transcript
            original_transcript = self.get_original_transcript(audio_path.name)
            
            # 3. Enhanced matching
            if original_transcript:
                corrected_text = self.find_best_match(transcribed_text, original_transcript)
                
                # Validate improvement
                if corrected_text != transcribed_text:
                    validation_result = self.validate_improvement(transcribed_text, corrected_text)
                    if validation_result:
                        final_text = corrected_text
                        status = "CORRECTED"
                        logger.info(f"✅ Text corrected: '{final_text[:50]}...'")
                    else:
                        final_text = transcribed_text
                        status = "VALIDATION_FAILED"
                        logger.info(f"⚠️ Correction rejected by validation")
                else:
                    final_text = transcribed_text
                    status = "UNCHANGED"
                    logger.info(f"ℹ️ No correction needed")
            else:
                final_text = transcribed_text
                status = "NO_REFERENCE"
                logger.warning(f"⚠️ No reference transcript found")
            
            # 4. Calculate accuracy (so khớp với từng đoạn transcript)
            if original_transcript and isinstance(original_transcript, dict):
                segments = [seg.strip() for seg in re.split(r'[.!?\n]+', original_transcript['full_text']) if len(seg.strip()) > 10]
            elif original_transcript:
                segments = [seg.strip() for seg in re.split(r'[.!?\n]+', original_transcript) if len(seg.strip()) > 10]
            else:
                segments = []
            if segments:
                accuracy = max(self.calculate_enhanced_similarity(final_text, seg) for seg in segments)
            else:
                accuracy = 0.5  # Unknown accuracy
            
            # 5. Save to files
            with open(report_file_path, 'a', encoding='utf-8') as f:
                f.write(f"{audio_path.name}|{status}|{accuracy:.2f}\n")
                f.write(f"ORIGINAL: {transcribed_text}\n")
                f.write(f"FINAL: {final_text}\n\n")
            
            with open(prompt_file_path, 'a', encoding='utf-8') as f:
                f.write(f"{audio_path.name}|{final_text}\n")
            
            results.append({
                'file': audio_path.name,
                'original': transcribed_text,
                'final': final_text,
                'status': status,
                'accuracy': accuracy,
                'corrected': status == 'CORRECTED'
            })
        
        # Summary
        if results:
            total_time = (datetime.now() - start_time).total_seconds()
            total = len(results)
            corrected = sum(1 for r in results if r['corrected'])
            avg_accuracy = sum(r['accuracy'] for r in results) / total if total > 0 else 0
            
            logger.info(f"🎉 COMPLETED in {total_time:.1f}s - Total: {total}, Corrected: {corrected}, Avg Accuracy: {avg_accuracy:.2f}")
            
            # Write summary
            with open(report_file_path, 'r+', encoding='utf-8') as f:
                content = f.read()
                f.seek(0)
                f.write(f"ENHANCED ACCURACY PROCESSING REPORT - {segment_folder.upper()}\n")
                f.write(f"Completed in: {total_time:.1f}s ({total_time/total:.1f}s per file)\n")
                f.write(f"Total: {total}, Corrected: {corrected}, Avg Accuracy: {avg_accuracy:.2f}\n")
                f.write("="*60 + "\n\n")
                f.write(content)

    def process_all_segments(self):
        """Xử lý tất cả folders với enhanced accuracy"""
        segment_folders = ['3s', '5s', '7s', '10s', 'others']
        
        total_start = datetime.now()
        for folder in segment_folders:
            if (self.segments_dir / folder).exists():
                self.process_segment_folder(folder)
        
        total_time = (datetime.now() - total_start).total_seconds()
        logger.info(f"🎉 ALL SEGMENTS COMPLETED với enhanced accuracy in {total_time:.1f}s!")

def main():
    """Main function tối ưu TỐC ĐỘ & ĐỘ CHÍNH XÁC"""
    print("⚡ Audio Processing Tool - SPEED & ACCURACY Optimized")
    print("🚀 Fast Whisper + Enhanced Matching + Smart Caching")
    print("="*60)
    
    processor = AudioProcessor()
    
    choice = input("""
Choose option:
1. Process all folders (FAST & ACCURATE)
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

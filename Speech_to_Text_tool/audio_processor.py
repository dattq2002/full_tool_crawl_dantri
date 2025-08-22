#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Audio/Text Processor – Vietnamese Matching with Post-Processing Booster
======================================================================
Nâng cấp từ bản gốc:
- Giữ pipeline matching hiện tại (exact -> fuzzy) để tương thích.
- THÊM "booster" hậu xử lý để nâng điểm similarity lên >= 0.8 khi có thể.
  + Khôi phục dấu tiếng Việt dựa trên câu tham chiếu tốt nhất (tone projection).
  + Chuẩn hóa dấu câu/khoảng trắng (punctuation normalization).
  + Sửa lỗi phổ biến (ASR/telex) bằng bảng quy tắc.
  + Cơ chế chọn ứng viên và kiểm tra an toàn trước khi áp dụng.
- Bổ sung ngưỡng động & overlap không dấu trong quyết định chấp nhận.

Gợi ý chạy nhanh:
    pip install rapidfuzz
"""

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
from typing import List, Tuple, Dict, Any, Iterable
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
        """Khởi tạo processor tối ưu cho TỐC ĐỘ & ĐỘ CHÍNH XÁC + Booster hậu xử lý."""
        # Load Whisper model cho tốc độ & chất lượng cân bằng
        self.model = whisper.load_model("small")
        self.base_dir = Path(__file__).parent.parent
        self.segments_dir = self.base_dir / "dantri_segments"
        self.audios_dir = self.base_dir / "dantri_audios"
        self.output_dir = self.base_dir / "Speech_to_Text_tool" / "transcribed_results"
        
        # Cache transcript với parsed sentences
        self.transcript_cache: Dict[str, Dict[str, Any]] = {}
        self._load_all_transcripts()
        
        # Semantic model off
        self.semantic_model = None
        logger.info("⚡ Semantic model disabled for maximum speed")
        
        # Cache similarity
        self._similarity_cache: Dict[str, float] = {}
        
        # Output dir
        self.output_dir.mkdir(exist_ok=True)
        logger.info("🚀 AudioProcessor initialized with SPEED & ACCURACY + POST-BOOSTER")

    # --------- Chuẩn hoá/tiền xử lý ---------
    def normalize_vi(self, s: str, strip_tone: bool = False) -> str:
        if s is None:
            return ""
        s = unicodedata.normalize("NFC", s).strip().lower()
        s = re.sub(r"\s+", " ", s)
        if strip_tone:
            s = unicodedata.normalize("NFD", s)
            s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
            s = unicodedata.normalize("NFC", s)
        return s

    def split_sentences_vi(self, text: str) -> List[str]:
        parts = re.split(r'(?<=[\.\!\?…])\s+|\n+', text or "")
        return [p.strip() for p in parts if p and p.strip()]

    # --------- Helpers for booster ---------
    def _word_tokens(self, s: str) -> List[str]:
        return [t for t in re.findall(r"[A-Za-zÀ-ỹ\d]+|[^\sA-Za-zÀ-ỹ\d]", s, flags=re.UNICODE) if t and t.strip()]

    def _base(self, s: str) -> str:
        s = unicodedata.normalize("NFD", s)
        s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
        return unicodedata.normalize("NFC", s).lower()

    def _word_overlap_notone(self, a: str, b: str) -> float:
        aw = set(self.normalize_vi(a, True).split())
        bw = set(self.normalize_vi(b, True).split())
        return (len(aw & bw) / max(1, len(aw))) if aw and bw else 0.0

    def _dynamic_threshold(self, text: str) -> float:
        n = len(self.normalize_vi(text, False).split())
        if n <= 5:   return 0.86
        if n <= 10:  return 0.80
        if n <= 20:  return 0.75
        return 0.72

    # --------- Exact / Fuzzy (giữ hành vi gốc, nhưng có thể thay scorer sau) ---------
    def difflib_ratio(self, a: str, b: str) -> float:
        return SequenceMatcher(None, a, b).ratio()

    def fuzzy_score_vi(self, query: str, candidate: str, strip_tone: bool = False) -> float:
        a1, b1 = self.normalize_vi(query, False), self.normalize_vi(candidate, False)
        a2, b2 = self.normalize_vi(query, True),  self.normalize_vi(candidate, True)
        return max(self.difflib_ratio(a1, b1), self.difflib_ratio(a2, b2))

    def exact_matches_vi(self, query: str, sentences: Iterable[str], strip_tone: bool = False) -> List[Dict[str, Any]]:
        qn = self.normalize_vi(query, strip_tone=strip_tone)
        hits = []
        for idx, s in enumerate(sentences):
            if self.normalize_vi(s, strip_tone=strip_tone) == qn:
                hits.append({"index": idx, "sentence": s, "score": 1.0})
        return hits

    def fuzzy_topk_vi(self, query: str, sentences: Iterable[str], topk: int = 5, strip_tone: bool = False) -> List[Dict[str, Any]]:
        scored = []
        for idx, s in enumerate(sentences):
            sc = self.fuzzy_score_vi(query, s, strip_tone=strip_tone)
            scored.append((sc, idx, s))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [{"rank": i+1, "score": sc, "index": idx, "sentence": s}
                for i, (sc, idx, s) in enumerate(scored[:max(0, topk)])]

    # --------- Booster: sửa & chuẩn hoá để đẩy score lên >= target ---------
    _COMMON_FIXES = [
        (" ,", ","), (" .", "."), (" !", "!"), (" ?", "?"), (" :", ":"), (" ;", ";"),
        ("..", "."), ("—", "-"), ("–", "-"),
        ("binh nhap", "binh nhap"),  # placeholder (giữ base), sẽ được diacritize theo ref
        ("nhan vat", "nhan vat"),
        ("anh:", "ảnh:"), ("anh :", "ảnh:"),
    ]

    def _normalize_punct(self, s: str) -> str:
        s = re.sub(r"\s+([,\.!\?:;])", r"\1", s)
        s = re.sub(r"([,\.!\?:;])([^\s])", r"\1 \2", s)
        s = re.sub(r"\s+", " ", s).strip()
        return s

    def _apply_common_fixes(self, s: str) -> str:
        out = s
        for a, b in self._COMMON_FIXES:
            out = out.replace(a, b)
        return out

    def _project_diacritics_from_ref(self, asr_text: str, ref_sentence: str) -> str:
        """Thay thế từ trong ASR bằng biến thể có dấu từ câu tham chiếu theo base form."""
        asr_tokens = self._word_tokens(asr_text)
        ref_tokens = self._word_tokens(ref_sentence)

        # Bản đồ base -> set các biến thể có dấu (ưu tiên token dài hơn)
        base2variants: Dict[str, List[str]] = {}
        for t in ref_tokens:
            if re.match(r"[A-Za-zÀ-ỹ]+$", t):
                b = self._base(t)
                base2variants.setdefault(b, [])
                if t not in base2variants[b]:
                    base2variants[b].append(t)

        out_tokens = []
        for t in asr_tokens:
            if re.match(r"[A-Za-zÀ-ỹ]+$", t):
                b = self._base(t)
                if b in base2variants:
                    # Chọn biến thể có dấu có độ dài gần nhất
                    cand = sorted(base2variants[b], key=lambda x: abs(len(x)-len(t)))[0]
                    out_tokens.append(cand)
                else:
                    out_tokens.append(t)
            else:
                out_tokens.append(t)
        out = "".join(out_tokens)
        out = self._normalize_punct(out)
        return out

    def post_process_boost(self, original_asr: str, candidate_ref: str, target: float = 0.80) -> Tuple[str, float]:
        """Cố gắng nâng điểm bằng khôi phục dấu + chuẩn hoá dấu câu."""
        if not original_asr or not candidate_ref:
            return original_asr, 0.0

        # Bước 1: sửa lỗi phổ biến & chuẩn hoá dấu câu nhẹ
        s0 = self._normalize_punct(self._apply_common_fixes(original_asr))

        # Bước 2: chiếu dấu từ câu tham chiếu
        s1 = self._project_diacritics_from_ref(s0, candidate_ref)

        # Bước 3: Nếu còn thấp, mạnh tay hơn: thay các từ "base-equal" bằng từ có dấu theo ref
        score1 = self.calculate_enhanced_similarity(s1, candidate_ref)
        if score1 < target:
            # Thử thay toàn bộ chuỗi theo thứ tự token của ASR nhưng luôn lấy biến thể có trong ref khi base-equal
            s2 = self._project_diacritics_from_ref(self.normalize_vi(s0, False), candidate_ref)
            s2 = self._normalize_punct(s2)
            score2 = self.calculate_enhanced_similarity(s2, candidate_ref)
            if score2 > score1:
                s1, score1 = s2, score2

        return s1, score1

    # --------- Ultra fast match (giữ từ bản gốc) ---------
    def ultra_fast_match(self, transcribed_text, transcript_data):
        if not transcript_data or not transcribed_text:
            return transcribed_text

        if isinstance(transcript_data, dict) and 'sentences' in transcript_data:
            sentences = [sent_data['text'] for sent_data in transcript_data['sentences']]
        else:
            sentences = self.split_sentences_vi(transcript_data.get('full_text', '') if isinstance(transcript_data, dict) else transcript_data)

        if not sentences:
            return transcribed_text

        # 1) Exact có dấu
        exact_hits = self.exact_matches_vi(transcribed_text, sentences, strip_tone=False)
        if exact_hits:
            best_exact = exact_hits[0]['sentence']
            logger.info(f"✅ EXACT MATCH (100%): '{best_exact[:50]}...'")
            return best_exact
        
        # 2) Exact không dấu
        exact_hits_notone = self.exact_matches_vi(transcribed_text, sentences, strip_tone=True)
        if exact_hits_notone:
            best_exact_notone = exact_hits_notone[0]['sentence']
            logger.info(f"✅ EXACT MATCH NO-TONE (100%): '{best_exact_notone[:50]}...'")
            return best_exact_notone

        # 3) Fuzzy
        fuzzy_candidates = self.fuzzy_topk_vi(transcribed_text, sentences, topk=3, strip_tone=False)
        if fuzzy_candidates and fuzzy_candidates[0]['score'] > 0.7:
            best_fuzzy = fuzzy_candidates[0]['sentence']
            best_score = fuzzy_candidates[0]['score']
            trans_words = set(self.normalize_vi(transcribed_text, False).split())
            cand_words = set(self.normalize_vi(best_fuzzy, False).split())
            word_overlap = (len(trans_words & cand_words) / len(trans_words)) if trans_words else 0.0
            if word_overlap > 0.3 or best_score > 0.85:
                logger.info(f"✅ FUZZY MATCH (score: {best_score:.2f}, overlap: {word_overlap:.2f}) → '{best_fuzzy[:50]}...'")
                return best_fuzzy

        # 4) Fuzzy no-tone
        fuzzy_candidates_notone = self.fuzzy_topk_vi(transcribed_text, sentences, topk=3, strip_tone=True)
        if fuzzy_candidates_notone and fuzzy_candidates_notone[0]['score'] > 0.6:
            best_fuzzy_notone = fuzzy_candidates_notone[0]['sentence']
            best_score_notone = fuzzy_candidates_notone[0]['score']
            trans_words_notone = set(self.normalize_vi(transcribed_text, True).split())
            cand_words_notone = set(self.normalize_vi(best_fuzzy_notone, True).split())
            overlap_nt = (len(trans_words_notone & cand_words_notone) / len(trans_words_notone)) if trans_words_notone else 0.0
            if overlap_nt > 0.25 or best_score_notone > 0.8:
                logger.info(f"✅ FUZZY NO-TONE MATCH (score: {best_score_notone:.2f}, overlap: {overlap_nt:.2f}) → '{best_fuzzy_notone[:50]}...'")
                return best_fuzzy_notone

        logger.info(f"⚠️ No good match found, returning original: '{transcribed_text[:50]}...'")
        return transcribed_text

    # --------- Similarity ---------
    def calculate_semantic_similarity(self, text1: str, text2: str) -> float:
        # Disabled in this build
        return 0.0

    def calculate_enhanced_similarity(self, text1, text2):
        if not text1 or not text2:
            return 0.0
        cache_key = f"{hash(text1)}_{hash(text2)}"
        if cache_key in self._similarity_cache:
            return self._similarity_cache[cache_key]

        # Base scorers
        vi_fuzzy = self.fuzzy_score_vi(text1, text2, strip_tone=False)
        n1 = self.normalize_vi(text1, False); n2 = self.normalize_vi(text2, False)
        wr = fuzz.WRatio(n1, n2) / 100.0
        # Jaccard (tone & no-tone, lấy max)
        words1 = set(n1.split()); words2 = set(n2.split())
        j1 = (len(words1 & words2) / len(words1 | words2)) if (words1 and words2) else 0.0
        n1n = self.normalize_vi(text1, True); n2n = self.normalize_vi(text2, True)
        W1 = set(n1n.split()); W2 = set(n2n.split())
        j2 = (len(W1 & W2) / len(W1 | W2)) if (W1 and W2) else 0.0
        jacc = max(j1, j2)

        len1, len2 = len(n1.split()), len(n2.split())
        length_penalty = min(len1, len2) / max(len1, len2) if max(len1, len2) > 0 else 1.0

        combined = (0.55*vi_fuzzy + 0.25*wr + 0.20*jacc) * length_penalty
        self._similarity_cache[cache_key] = float(combined)
        if len(self._similarity_cache) > 3000:
            for k in list(self._similarity_cache.keys())[:500]:
                del self._similarity_cache[k]
        return float(combined)

    # --------- IO & cache ---------
    def _load_all_transcripts(self):
        logger.info("📚 Loading transcripts into cache...")
        transcript_count = 0
        for category_dir in self.audios_dir.iterdir():
            if category_dir.is_dir():
                for article_dir in category_dir.iterdir():
                    if article_dir.is_dir() and len(article_dir.name) == 17 and article_dir.name.isdigit():
                        transcript_file = article_dir / "transcript.txt"
                        if transcript_file.exists():
                            try:
                                content = transcript_file.read_text(encoding='utf-8').strip()
                                sentences = self._parse_sentences_for_cache(content)
                                self.transcript_cache[article_dir.name] = {
                                    'full_text': content,
                                    'sentences': sentences
                                }
                                transcript_count += 1
                            except Exception as e:
                                logger.warning(f"⚠️ Error loading transcript {article_dir.name}: {e}")
        logger.info(f"✅ Loaded {transcript_count} transcripts")

    def _parse_sentences_for_cache(self, text: str) -> List[Dict[str, Any]]:
        sentences = self.split_sentences_vi(text)
        parsed = []
        for s in sentences:
            s = s.strip()
            if s and len(s) > 10:
                normalized = self.normalize_vi(s, False)
                normalized_notone = self.normalize_vi(s, True)
                words = set(normalized.split())
                words_notone = set(normalized_notone.split())
                parsed.append({
                    'text': s,
                    'words': words,
                    'words_notone': words_notone,
                    'length': len(s.split()),
                    'normalized': normalized,
                    'normalized_notone': normalized_notone
                })
        return parsed

    def get_original_transcript(self, audio_filename: str):
        try:
            parts = Path(audio_filename).stem.split("_")
            article_id = next((part for part in parts if len(part) == 17 and part.isdigit()), None)
            if not article_id:
                return None
            return self.transcript_cache.get(article_id)
        except Exception as e:
            logger.error(f"❌ Error getting transcript: {e}")
            return None

    # --------- Transcribe ---------
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

    # --------- Matching high-level ---------
    def find_best_match(self, transcribed_text, reference_text):
        if not reference_text or not transcribed_text:
            return transcribed_text

        if isinstance(reference_text, dict) and 'sentences' in reference_text:
            fast_result = self.ultra_fast_match(transcribed_text, reference_text)
            if fast_result != transcribed_text:
                return fast_result
            return self.simple_sentence_match(transcribed_text, reference_text['full_text'])
        else:
            return self.simple_sentence_match(transcribed_text, reference_text)

    def simple_sentence_match(self, transcribed_text, reference_text):
        if not reference_text or not transcribed_text:
            return transcribed_text

        sentences = self.split_sentences_vi(reference_text)
        sentences = [s.strip() for s in sentences if s.strip() and len(s.strip()) > 3]
        if not sentences:
            return transcribed_text

        exact_hits = self.exact_matches_vi(transcribed_text, sentences, strip_tone=False)
        if exact_hits:
            return exact_hits[0]['sentence']
        exact_hits_notone = self.exact_matches_vi(transcribed_text, sentences, strip_tone=True)
        if exact_hits_notone:
            return exact_hits_notone[0]['sentence']

        fuzzy_candidates = self.fuzzy_topk_vi(transcribed_text, sentences, topk=5, strip_tone=False)
        if fuzzy_candidates and fuzzy_candidates[0]['score'] > 0.6:
            best_fuzzy = fuzzy_candidates[0]['sentence']
            trans_length = len(transcribed_text.split())
            cand_length = len(best_fuzzy.split())
            length_ratio = cand_length / max(1, trans_length)
            if 0.3 <= length_ratio <= 4.0:
                return best_fuzzy

        fuzzy_candidates_notone = self.fuzzy_topk_vi(transcribed_text, sentences, topk=5, strip_tone=True)
        if fuzzy_candidates_notone and fuzzy_candidates_notone[0]['score'] > 0.5:
            best_fuzzy_notone = fuzzy_candidates_notone[0]['sentence']
            trans_length = len(transcribed_text.split())
            cand_length = len(best_fuzzy_notone.split())
            length_ratio = cand_length / max(1, trans_length)
            if 0.2 <= length_ratio <= 5.0:
                return best_fuzzy_notone

        return transcribed_text

    # --------- Validation ---------
    def validate_improvement(self, original, candidate):
        try:
            orig_len = len(original.split()); cand_len = len(candidate.split())
            if cand_len < orig_len * 0.2 or cand_len > orig_len * 8:
                return False
            if cand_len < orig_len * 0.4:
                similarity = self.calculate_enhanced_similarity(original, candidate)
                if similarity < 0.2:
                    return False
            if cand_len > orig_len * 3:
                similarity = self.calculate_enhanced_similarity(original, candidate)
                if similarity < 0.3:
                    return False
            return True
        except Exception:
            return True

    # --------- Pipeline main per folder ---------
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
        prompt_file_path = self.output_dir / "prompt.txt"
        
        results = []
        start_time = datetime.now()
        
        for i, audio_file in enumerate(audio_files, 1):
            audio_path = Path(audio_file)
            logger.info(f"⚡ [{i}/{len(audio_files)}] Processing: {audio_path.name}")
            
            transcribed_text = self.transcribe_audio_file(audio_path)
            if not transcribed_text:
                logger.warning(f"⚠️ No transcription: {audio_path.name}")
                continue
            
            original_transcript = self.get_original_transcript(audio_path.name)
            # --- Matching ---
            if original_transcript:
                matched_text = self.find_best_match(transcribed_text, original_transcript)
                if matched_text != transcribed_text:
                    final_text = matched_text
                    status = "CORRECTED"
                else:
                    final_text = transcribed_text
                    status = "UNCHANGED"
            else:
                final_text = transcribed_text
                status = "NO_REFERENCE"

            # --- Scoring trước booster ---
            if original_transcript and isinstance(original_transcript, dict):
                segs = [seg.strip() for seg in re.split(r'[.!?\n]+', original_transcript['full_text']) if len(seg.strip()) > 10]
            elif original_transcript:
                segs = [seg.strip() for seg in re.split(r'[.!?\n]+', original_transcript) if len(seg.strip()) > 10]
            else:
                segs = []
            accuracy = max(self.calculate_enhanced_similarity(final_text, seg) for seg in segs) if segs else 0.5

            # --- BOOSTER: nếu accuracy < 0.8, cố gắng nâng bằng post-processing ---
            if original_transcript and segs and accuracy < 0.80:
                # Lấy ứng viên tham chiếu tốt nhất để chiếu dấu
                sentences = [x['text'] if isinstance(x, dict) and 'text' in x else str(x) for x in original_transcript.get('sentences', [])] \
                            or self.split_sentences_vi(original_transcript.get('full_text', '') if isinstance(original_transcript, dict) else str(original_transcript))
                # Candidate theo fuzzy no-tone (độ bền cao)
                cand_top = self.fuzzy_topk_vi(final_text, sentences, topk=1, strip_tone=True)
                best_ref = cand_top[0]['sentence'] if cand_top else None

                if best_ref:
                    # Chỉ booster nếu overlap no-tone hợp lý
                    ov = self._word_overlap_notone(final_text, best_ref)
                    if ov >= 0.25:
                        boosted_text, boosted_score_vs_ref = self.post_process_boost(final_text, best_ref, target=0.80)
                        # Tính lại accuracy so với toàn corpus
                        boosted_accuracy = max(self.calculate_enhanced_similarity(boosted_text, seg) for seg in segs)
                        if boosted_accuracy >= max(accuracy, 0.80) and self.validate_improvement(final_text, boosted_text):
                            logger.info(f"✨ BOOSTED from {accuracy:.2f} → {boosted_accuracy:.2f} (vs ref={boosted_score_vs_ref:.2f})")
                            final_text = boosted_text
                            accuracy = boosted_accuracy
                            if status == "UNCHANGED":
                                status = "BOOSTED"
                        else:
                            logger.info(f"ℹ️ Booster tried but not accepted (ov={ov:.2f}, local={boosted_score_vs_ref:.2f}, global={boosted_accuracy:.2f} ≤ {accuracy:.2f})")
                    else:
                        logger.info(f"ℹ️ Booster skipped: low overlap {ov:.2f}")

            # --- Ghi file ---
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
                'corrected': status in ('CORRECTED', 'BOOSTED')
            })
        
        # Summary
        if results:
            total_time = (datetime.now() - start_time).total_seconds()
            total = len(results)
            corrected = sum(1 for r in results if r['corrected'])
            avg_accuracy = sum(r['accuracy'] for r in results) / total if total > 0 else 0
            
            logger.info(f"🎉 COMPLETED in {total_time:.1f}s - Total: {total}, Corrected/Boosted: {corrected}, Avg Accuracy: {avg_accuracy:.2f}")
            with open(report_file_path, 'r+', encoding='utf-8') as f:
                content = f.read()
                f.seek(0)
                f.write(f"ENHANCED ACCURACY REPORT (with POST-BOOSTER) - {segment_folder.upper()}\n")
                f.write(f"Completed in: {total_time:.1f}s ({total_time/total:.1f}s/file)\n")
                f.write(f"Total: {total}, Corrected/Boosted: {corrected}, Avg Accuracy: {avg_accuracy:.2f}\n")
                f.write("="*60 + "\n\n")
                f.write(content)

    def process_all_segments(self):
        for folder in ['3s', '5s', '7s', '10s', 'others']:
            if (self.segments_dir / folder).exists():
                self.process_segment_folder(folder)

def main():
    print("⚡ Audio Processing Tool - with POST-PROCESSING BOOSTER")
    print("="*60)
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

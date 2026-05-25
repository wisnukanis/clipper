import fs from "node:fs/promises";
import path from "node:path";
import { generateAiText } from "./ai.js";

async function readClipContext(clipperRoot, output) {
  const parts = [output.title, output.hook, output.caption, output.reason].filter(Boolean);
  const reviewPath = output.transcriptReviewPath ? path.join(clipperRoot, output.transcriptReviewPath) : "";
  if (reviewPath) {
    try {
      const raw = await fs.readFile(reviewPath, "utf8");
      const data = JSON.parse(raw);
      const texts = [];
      collectText(data, texts);
      if (texts.length) parts.push(texts.slice(0, 90).join(" "));
    } catch {
      // Caption fallback can still use clip metadata.
    }
  }
  return parts.join("\n").slice(0, 9000);
}

function collectText(value, texts) {
  if (!value || texts.length > 120) return;
  if (typeof value === "string") {
    const cleaned = value.trim();
    if (cleaned && cleaned.split(/\s+/).length > 2) texts.push(cleaned);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, texts);
    return;
  }
  if (typeof value === "object") {
    for (const key of ["text", "caption", "corrected_text", "original_text"]) {
      collectText(value[key], texts);
    }
    for (const child of Object.values(value)) {
      if (typeof child === "object") collectText(child, texts);
    }
  }
}

export async function generateCaption({ job, output, promptTemplate, clipperRoot, aiProvider = "" }) {
  const quickHashtags = buildDynamicHashtags({ job, output, promptTemplate });
  if (hasStrategyCaption(output) && isCompleteCaption(output.caption)) {
    return ensureCaptionHashtags(output.caption, output, promptTemplate, quickHashtags);
  }

  const context = await readClipContext(clipperRoot, output);
  const dynamicHashtags = buildDynamicHashtags({ job, output, promptTemplate, context });
  const fallback = fallbackCaption(output, promptTemplate, dynamicHashtags);
  const prompt = [
    "Buat caption Instagram Reels berbahasa Indonesia.",
    "Aturan:",
    "- Baris pertama harus hook kuat, boleh berbentuk kutipan pendek atau pertanyaan yang bikin penasaran.",
    "- Paragraf kedua menjelaskan konflik, fakta mengejutkan, atau alasan clip ini layak ditonton.",
    "- Ringkas, natural, emosional, dan sesuai transkrip.",
    "- Jangan mengarang fakta di luar konteks.",
    "- Tambahkan CTA ringan.",
    "- Caption harus selesai utuh. Jangan akhiri dengan kalimat terpotong, koma, titik dua, kata sambung, atau ellipsis.",
    "- Jangan menyalin mentah transkrip yang terpotong; rangkum jadi kalimat lengkap.",
    "- Akhiri dengan 5 sampai 8 hashtag relevan. Prioritaskan konteks/topik, jangan hashtag generik berlebihan.",
    "",
    `Tema: ${job.theme}`,
    `Gaya: ${promptTemplate?.hook_style || "natural emotional"}`,
    `CTA: ${promptTemplate?.cta || "Menurut kamu bagaimana?"}`,
    `Base hashtag: ${BASE_HASHTAGS.join(" ")}`,
    `Arah hashtag dari konteks: ${dynamicHashtags.join(" ") || "-"}`,
    "",
    "Konteks clip:",
    context || fallback,
    "",
    "Tulis caption final saja tanpa markdown."
  ].join("\n");

  const text = await generateAiText(prompt, { maxOutputTokens: 900, provider: aiProvider });
  return ensureCaptionHashtags(text || fallback, output, promptTemplate, dynamicHashtags, fallback);
}

export async function generateThumbnailText({ job, output, promptTemplate, aiProvider = "" }) {
  const existing = output.thumbnailText ? normalizeThumbnailText(output.thumbnailText, "") : "";
  const fallback = fallbackThumbnailText(output);
  const prompt = [
    "Buat teks thumbnail Reels dalam Bahasa Indonesia.",
    `Aturan: maksimal ${titleMaxWords()} kata, huruf besar, kuat, universal, mudah dibaca, tidak clickbait menyesatkan.`,
    "- Jangan hanya mengandalkan nama orang.",
    "- Buat sebagai hook utama, bukan potongan kalimat yang terputus.",
    "- Buat kalimat/judul utuh yang membuat orang ingin menonton sampai akhir.",
    "- Jangan ambil potongan transkrip mentah yang tidak jelas.",
    "- Buat seperti judul cover video, bukan subtitle.",
    "- Wajib mengandung hook: konflik, rahasia, alasan mengejutkan, pertanyaan, atau momen paling bikin penasaran.",
    "- Hindari kalimat menggantung yang berakhir koma.",
    `Tema: ${job.theme}`,
    `Style: ${promptTemplate?.thumbnail_style || "singkat dan kuat"}`,
    `Teks clipper jika ada: ${existing || "-"}`,
    `Judul/hook clip: ${output.hook || output.title || ""}`,
    `Alasan clip: ${output.reason || ""}`,
    `Transkrip singkat: ${String(output.clipTranscript || output.caption || "").slice(0, 900)}`,
    "Balas hanya teks thumbnail."
  ].join("\n");
  const text = await generateAiText(prompt, { maxOutputTokens: 110, temperature: 0.65, provider: aiProvider });
  const generated = text ? normalizeThumbnailText(text, "") : "";
  return isStrongThumbnailText(generated) ? generated : fallback;
}

export async function generateFrameQuoteText({ job, output, promptTemplate, aiProvider = "" }) {
  const fallback = fallbackFrameQuote(output);
  const prompt = [
    "Buat quote pendek untuk lower-third video Reels dalam Bahasa Indonesia.",
    "Aturan: 5 sampai 11 kata, terasa seperti kalimat paling kuat dari clip, natural, rapi, dan mudah dibaca.",
    "- Jangan pakai hashtag.",
    "- Jangan pakai emoji.",
    "- Jangan pakai markdown.",
    "- Jangan menambah fakta di luar konteks.",
    "- Jangan terlalu clickbait.",
    `Tema: ${job.theme}`,
    `Style: ${promptTemplate?.thumbnail_style || "singkat dan kuat"}`,
    `Judul/hook clip: ${output.hook || output.title || ""}`,
    `Alasan clip: ${output.reason || ""}`,
    `Transkrip singkat: ${String(output.clipTranscript || output.caption || "").slice(0, 900)}`,
    "Balas hanya quote tanpa tanda kutip."
  ].join("\n");
  const text = await generateAiText(prompt, { maxOutputTokens: 60, temperature: 0.45, provider: aiProvider });
  const generated = normalizeFrameQuoteText(text);
  return isStrongFrameQuote(generated) ? generated : fallback;
}

export async function generateBumperSpec({ job, output, promptTemplate, aiProvider = "" }) {
  const contentType = normalizeContentType(output?.contentType || output?.content_type || job?.theme || promptTemplate?.content_type);
  const openingHook = normalizePlainText(output?.openingHook || output?.coverHook || output?.screenHook || output?.thumbnailText || output?.title);
  const fallback = fallbackBumperSpec(contentType, openingHook);

  if (!boolValue(process.env.BUMPER_ADAPTIVE_ENABLED, true) || process.env.BUMPER_TAGLINE_MODE === "static") {
    return fallback;
  }

  const prompt = [
    "Kamu adalah editor Shorts/Reels Indonesia.",
    "Buat tagline bumper singkat untuk seri MENIT HIKMAH berdasarkan isi clip ini.",
    "",
    "Input:",
    `- content_type: ${contentType}`,
    `- opening_hook: ${openingHook || "-"}`,
    `- summary: ${normalizePlainText(output?.summary || output?.caption).slice(0, 700) || "-"}`,
    `- transcript segment: ${normalizePlainText(output?.clipTranscript).slice(0, 1200) || "-"}`,
    `- emotion: ${output?.mainEmotion || output?.emotion || "-"}`,
    `- topic_category: ${output?.topicCategory || output?.selectedAngle || promptTemplate?.name || "-"}`,
    `- reason_selected: ${normalizePlainText(output?.reason || output?.reason_selected).slice(0, 700) || "-"}`,
    "",
    "Aturan:",
    "- Maksimal 6 kata.",
    "- Bahasa Indonesia natural.",
    "- Jangan mengulang opening_hook secara persis.",
    "- Jangan clickbait menipu.",
    "- Jangan terlalu formal.",
    "- Harus sesuai isi clip.",
    "- Harus bisa terbaca dalam 1 detik.",
    "- Nada harus mengikuti isi clip:",
    "  renungan = adem/reflektif",
    "  inspiratif = hangat/relatable",
    "  mindset = praktis/menampar elegan",
    "  opini = tajam tapi aman",
    "  humor_insight = lucu tapi tetap bermakna",
    "  mixed_best = netral dan bikin mikir",
    "",
    "Output JSON:",
    "{",
    '  "bumper_tagline": "",',
    '  "bumper_mood": "",',
    '  "bumper_icon": "",',
    '  "bumper_accent_color": "",',
    '  "bumper_motion": "",',
    '  "reason": "",',
    '  "risk_notes": ""',
    "}"
  ].join("\n");

  try {
    const text = await generateAiText(prompt, { maxOutputTokens: 260, temperature: 0.45, provider: aiProvider });
    const parsed = parseJsonObject(text);
    return validateBumperSpec({ ...fallback, ...parsed }, contentType, openingHook);
  } catch {
    return fallback;
  }
}

function hasStrategyCaption(output) {
  return Boolean(
    output?.caption
    && String(output.caption).trim().length >= 20
    && (
      output.viralScore
      || output.selectedAngle
      || output.publishDecision
      || output.candidateId
    )
  );
}

function fallbackCaption(output, promptTemplate, dynamicHashtags = []) {
  const hook = completeSentence(output.hook || output.title || "Ada bagian menarik dari obrolan ini.");
  const body = completeSentence(
    output.reason
    || output.selectedAngle
    || output.caption
    || "Potongan ini diambil dari momen yang paling kuat di podcast."
  );
  const cta = completeSentence(promptTemplate?.cta || "Menurut kamu, bagian paling relate yang mana?");
  const tags = captionHashtags({ dynamicHashtags, output, promptTemplate }).join(" ");
  return `${hook}\n\n${body}\n\n${cta}\n\n${tags}`;
}

function fallbackFrameQuote(output) {
  const candidates = [
    output?.clipTranscript,
    output?.caption,
    output?.hook,
    output?.reason,
    output?.title
  ].filter(Boolean);

  for (const value of candidates) {
    const sentence = String(value)
      .split(/[.!?\n]+/)
      .map((item) => normalizeFrameQuoteText(item))
      .find(isStrongFrameQuote);
    if (sentence) return sentence;
  }
  return "Gue baru sadar setelah kehilangan";
}

function normalizeFrameQuoteText(value) {
  const cleaned = String(value || "")
    .replace(/[`"'*_#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned
    .split(/\s+/)
    .slice(0, 11)
    .join(" ");
}

function isStrongFrameQuote(value) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean);
  return words.length >= 5 && words.join("").length >= 16;
}

function ensureCaptionHashtags(caption, output, promptTemplate, dynamicHashtags = [], fallback = "") {
  const cleaned = String(caption || "").trim();
  const hashtags = captionHashtags({ caption: cleaned, dynamicHashtags, output, promptTemplate });
  if (!hashtags.length) return cleaned;
  const body = completeCaptionBody(stripHashtags(cleaned), stripHashtags(fallback));
  return `${body || cleaned}\n\n${hashtags.join(" ")}`.trim();
}

function completeCaptionBody(value, fallback = "") {
  const cleaned = normalizeCaptionBody(value);
  if (isCompleteCaption(cleaned)) return cleaned;

  const trimmed = trimToLastCompleteSentence(cleaned);
  if (isCompleteCaption(trimmed)) return trimmed;

  const fallbackCleaned = normalizeCaptionBody(fallback);
  if (isCompleteCaption(fallbackCleaned)) return fallbackCleaned;

  return completeSentence(fallbackCleaned || cleaned || "Ada bagian menarik dari obrolan ini.");
}

function normalizeCaptionBody(value) {
  return String(value || "")
    .replace(/\s*(?:\.{3}|…)\s*$/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

function isCompleteCaption(value) {
  const cleaned = normalizeCaptionBody(value);
  if (!cleaned) return false;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 6) return false;
  const lastLine = cleaned.split(/\n+/).map((line) => line.trim()).filter(Boolean).pop() || "";
  return !INCOMPLETE_CAPTION_END_RE.test(lastLine);
}

function trimToLastCompleteSentence(value) {
  const cleaned = normalizeCaptionBody(value);
  const end = Math.max(cleaned.lastIndexOf("."), cleaned.lastIndexOf("?"), cleaned.lastIndexOf("!"));
  if (end < 20) return "";
  return cleaned.slice(0, end + 1).trim();
}

function completeSentence(value) {
  const cleaned = normalizeCaptionBody(value)
    .replace(INCOMPLETE_CAPTION_END_RE, "")
    .trim();
  if (!cleaned) return "";
  return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

function captionHashtags({ caption = "", dynamicHashtags = [], output, promptTemplate } = {}) {
  const outputHashtags = normalizeHashtags(output?.hashtags || []);
  const existingHashtags = normalizeHashtags(extractHashtags(caption));
  const contextHashtags = normalizeHashtags(dynamicHashtags);
  const templateHashtags = normalizeHashtags(promptTemplate?.hashtag_template || []);
  return mergeHashtags(
    ["#Ceramah"],
    contextHashtags,
    outputHashtags,
    existingHashtags,
    templateHashtags,
    BASE_HASHTAGS.slice(1),
    ["#Viral"]
  ).slice(0, HASHTAG_LIMIT);
}

function buildDynamicHashtags({ job, output, context = "" }) {
  const provided = normalizeHashtags(output?.hashtags || [])
    .filter((tag) => !isGenericHashtag(tag));
  if (provided.length >= 1) return provided.slice(0, HASHTAG_LIMIT);

  const directFields = [
    output?.selectedAngle,
    output?.hook,
    output?.title,
    output?.reason,
    output?.caption,
    output?.clipTranscript
  ].filter(Boolean);
  const source = [...directFields, context, job?.theme].join(" ");
  const candidates = [...provided];

  for (const tag of topicHashtags(source)) addHashtagCandidate(candidates, tag);
  for (const name of namedPhrases(source)) addHashtagCandidate(candidates, name);

  for (const phrase of directFields.slice(0, 5)) {
    addHashtagCandidate(candidates, phrase);
    for (const pair of keywordPairs(phrase)) addHashtagCandidate(candidates, pair);
  }

  for (const keyword of topKeywords(source, 12)) addHashtagCandidate(candidates, keyword);

  return normalizeHashtags(candidates)
    .filter((tag) => !isGenericHashtag(tag))
    .slice(0, HASHTAG_LIMIT);
}

function addHashtagCandidate(candidates, value) {
  const hashtag = toHashtag(value);
  if (hashtag) candidates.push(hashtag);
}

function keywordPairs(value) {
  const tokens = meaningfulTokens(value);
  const pairs = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    pairs.push(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return pairs.slice(0, 4);
}

function namedPhrases(value) {
  const matches = String(value || "").match(/\b[A-Z][\p{L}\p{N}]+(?:\s+[A-Z][\p{L}\p{N}]+){1,2}/gu) || [];
  return matches
    .map((item) => item.trim())
    .filter((item) => meaningfulTokens(item).length >= 2)
    .slice(0, 8);
}

function topKeywords(value, limit) {
  const scores = new Map();
  const firstSeen = new Map();
  const tokens = meaningfulTokens(value);
  tokens.forEach((token, index) => {
    scores.set(token, (scores.get(token) || 0) + 1);
    if (!firstSeen.has(token)) firstSeen.set(token, index);
  });
  return [...scores.entries()]
    .sort((left, right) => {
      const scoreDiff = right[1] - left[1];
      if (scoreDiff) return scoreDiff;
      return (firstSeen.get(left[0]) || 0) - (firstSeen.get(right[0]) || 0);
    })
    .map(([token]) => token)
    .slice(0, limit);
}

function topicHashtags(value) {
  const source = String(value || "").toLowerCase();
  const tags = [];
  if (/ceramah|ustadz|ustaz|kajian|dakwah|nasihat/.test(source)) tags.push("Ceramah");
  if (/islam|muslim|muslimah|sunnah|quran|alquran|hadis|hadits/.test(source)) tags.push("Islam");
  if (/renungan|hikmah|pelajaran|nasihat hidup|kehidupan/.test(source)) tags.push("Hikmah Hidup");
  if (/motivasi|semangat|bangkit|sabar|ikhlas|syukur/.test(source)) tags.push("Motivasi Islami");
  if (/keluarga|anak|ayah|ibu|orang tua|rumah tangga/.test(source)) tags.push("Keluarga");
  if (/hijrah|taubat|tobat/.test(source)) tags.push("Hijrah");
  if (/\byusuf\s+hamka\b/i.test(value)) tags.push("Yusuf Hamka");
  if (/hak|adil|keadilan|nuntut|tuntut|perjuang/.test(source)) tags.push("Keadilan");
  if (/ancam|diancam|tekan|intimidasi/.test(source)) tags.push("Ancaman");
  if (/oknum|petugas|backing|orang gede|orang besar/.test(source)) tags.push("Oknum");
  if (/royalti|lagu|musik/.test(source)) tags.push("Royalti Musik");
  if (/selingkuh|spill|sosmed/.test(source)) tags.push("Drama Sosmed");
  if (/usaha|bisnis|jualan|dagang/.test(source)) tags.push("Bisnis");
  return tags;
}

function meaningfulTokens(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function toHashtag(value) {
  const words = meaningfulTokens(value)
    .filter((word) => !GENERIC_HASHTAGS.has(word))
    .slice(0, 3);
  if (!words.length) return "";
  const tag = words.map(capitalizeTagPart).join("");
  if (tag.length < 3 || tag.length > 36) return "";
  return `#${tag}`;
}

function capitalizeTagPart(value) {
  const cleaned = String(value || "").toLowerCase();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function extractHashtags(value) {
  return String(value || "").match(/#[\p{L}\p{N}_]+/gu) || [];
}

function stripHashtags(value) {
  return String(value || "")
    .replace(/(?:^|\s)#[\p{L}\p{N}_]+/gu, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}

function mergeHashtags(...groups) {
  const seen = new Set();
  const merged = [];
  for (const tag of groups.flat()) {
    const normalized = normalizeHashtags([tag])[0];
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
  }
  return merged;
}

function isGenericHashtag(value) {
  const key = String(value || "")
    .replace(/^#+/, "")
    .toLowerCase();
  return GENERIC_HASHTAGS.has(key);
}

function normalizeHashtags(value) {
  const rawItems = Array.isArray(value)
    ? value
    : String(value || "#Ceramah #Renungan #MotivasiIslami #HikmahHidup #ReelsIndonesia")
      .split(/[\s,]+/);

  const seen = new Set();
  const tags = [];
  for (const item of rawItems) {
    const cleaned = String(item || "")
      .trim()
      .replace(/^#+/, "")
      .replace(/[^\p{L}\p{N}_]/gu, "");
    if (!cleaned) continue;
    const tag = `#${cleaned}`;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags.slice(0, 8);
}

const GENERIC_HASHTAGS = new Set([
  "podcast",
  "podcastindonesia",
  "podcastartis",
  "reels",
  "reelsindonesia",
  "short",
  "shorts",
  "shortsindonesia",
  "fyp",
  "foryou",
  "viral",
  "trending",
  "kontenviral",
  "clip",
  "klip",
  "video",
  "indonesia",
  "artis"
]);

const BASE_HASHTAGS = [
  "#Ceramah",
  "#Renungan",
  "#MotivasiIslami",
  "#HikmahHidup",
  "#ReelsIndonesia"
];

const HASHTAG_LIMIT = 8;

const CONTENT_TYPE_ALIASES = {
  renungan: "kisah_islami",
  inspiratif: "motivasi_renungan",
  mindset: "motivasi_renungan",
  opini: "misteri_trending",
  mixed_best: "misteri_trending"
};

const FALLBACK_BUMPER_TAGLINES = {
  motivasi_renungan: "1 menit yang bikin mikir",
  sejarah_tokoh: "kisah yang masih berbicara",
  kisah_islami: "1 menit untuk mengingat",
  fakta_sains: "fakta kecil, bikin mikir",
  misteri_trending: "potongan yang bikin mikir",
  humor_insight: "lucu, tapi ada isinya",
  renungan: "1 menit untuk mengingat",
  inspiratif: "cerita yang dekat dengan kita",
  mindset: "singkat, padat, kepikiran",
  opini: "lihat dulu konteksnya",
  mixed_best: "potongan yang bikin mikir",
  default: "1 menit yang bikin mikir"
};

const BUMPER_MOOD_BY_TYPE = {
  motivasi_renungan: "reflective",
  sejarah_tokoh: "serious",
  kisah_islami: "calm",
  fakta_sains: "energetic",
  misteri_trending: "sharp",
  humor_insight: "humorous",
  renungan: "calm",
  inspiratif: "warm",
  mindset: "energetic",
  opini: "sharp",
  mixed_best: "reflective"
};

const BUMPER_ICON_BY_TYPE = {
  motivasi_renungan: "lightbulb",
  sejarah_tokoh: "book",
  kisah_islami: "heart",
  fakta_sains: "spark",
  misteri_trending: "question",
  humor_insight: "smile",
  renungan: "lightbulb",
  inspiratif: "heart",
  mindset: "target",
  opini: "quote",
  mixed_best: "spark"
};

const BUMPER_ACCENT_BY_MOOD = {
  calm: "#F5C542",
  warm: "#E7C77A",
  sharp: "#F5C542",
  energetic: "#F5C542",
  humorous: "#FFD166",
  reflective: "#F5C542",
  serious: "#D8B84A",
  emotional: "#E7C77A"
};

const BUMPER_MOTION_BY_MOOD = {
  calm: "soft_zoom",
  reflective: "soft_zoom",
  warm: "gentle_slide",
  emotional: "gentle_slide",
  sharp: "quick_push",
  serious: "quick_push",
  energetic: "quick_glitch_zoom",
  humorous: "quick_pop"
};

const ALLOWED_BUMPER_MOODS = new Set([
  "calm",
  "warm",
  "sharp",
  "energetic",
  "humorous",
  "reflective",
  "serious",
  "emotional"
]);

const ALLOWED_BUMPER_MOTIONS = new Set([
  "soft_zoom",
  "gentle_slide",
  "quick_push",
  "quick_glitch_zoom",
  "quick_pop"
]);

const INCOMPLETE_CAPTION_END_RE = /(?:\.{3}|…|[,;:]|\s[-–]|\b(?:dan|atau|karena|yang|untuk|dengan|ke|di|dari|agar|supaya|kalau|tapi|jadi|sehingga|lalu|terus|bahwa|seperti|saat|ketika|biar))$/i;

const STOPWORDS = new Set([
  ...GENERIC_HASHTAGS,
  "ada",
  "agar",
  "akan",
  "aku",
  "amat",
  "anda",
  "apa",
  "apakah",
  "atau",
  "bagai",
  "bagaimana",
  "bagian",
  "bagi",
  "bahwa",
  "banyak",
  "baru",
  "begini",
  "begitu",
  "belum",
  "bisa",
  "buat",
  "bukan",
  "cuma",
  "dan",
  "dari",
  "dalam",
  "dengan",
  "dia",
  "diri",
  "dong",
  "gak",
  "harus",
  "ini",
  "itu",
  "jadi",
  "jangan",
  "juga",
  "kalau",
  "kamu",
  "karena",
  "kata",
  "ke",
  "ketika",
  "kita",
  "lagi",
  "lebih",
  "mereka",
  "mungkin",
  "nggak",
  "nih",
  "nya",
  "orang",
  "pada",
  "paling",
  "para",
  "punya",
  "saat",
  "saja",
  "saling",
  "sama",
  "sampai",
  "sangat",
  "sebagai",
  "sedang",
  "seperti",
  "siapa",
  "soal",
  "sudah",
  "supaya",
  "tapi",
  "telah",
  "tentang",
  "terus",
  "tidak",
  "untuk",
  "waktu",
  "yang",
  "your",
  "with",
  "this",
  "that",
  "what",
  "when",
  "where",
  "about",
  "from",
  "into",
  "how",
  "why"
]);

function normalizeThumbnailText(value, fallback = "RAHASIA DI BALIK CERITA INI BIKIN PENASARAN") {
  const cleaned = String(value || "")
    .replace(/[`"'*_#]/g, "")
    .replace(/[,:;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  return cleaned.split(/\s+/).slice(0, titleMaxWords()).join(" ") || fallback;
}

function fallbackBumperSpec(contentType, openingHook = "") {
  const normalized = normalizeContentType(contentType);
  const mood = defaultBumperMood(normalized);
  return validateBumperSpec({
    bumper_enabled: boolValue(process.env.BUMPER_ENABLED, true),
    bumper_adaptive_enabled: boolValue(process.env.BUMPER_ADAPTIVE_ENABLED, true),
    bumper_duration: clampNumber(process.env.BUMPER_SECONDS, 1.1, 0.8, 1.5),
    bumper_series_label: process.env.BUMPER_SERIES_LABEL || "MENIT HIKMAH",
    bumper_tagline: envTagline(normalized) || FALLBACK_BUMPER_TAGLINES[normalized] || FALLBACK_BUMPER_TAGLINES.default,
    bumper_mood: mood,
    bumper_icon: defaultBumperIcon(normalized),
    bumper_accent_color: defaultBumperAccent(mood),
    bumper_motion: defaultBumperMotion(mood),
    bumper_style: process.env.BUMPER_STYLE || "adaptive_theme_stamp",
    bumper_reason: "Fallback lokal berdasarkan content_type dan opening hook.",
    bumper_risk_notes: "",
    reason: "Fallback lokal berdasarkan content_type dan opening hook.",
    risk_notes: ""
  }, normalized, openingHook);
}

function validateBumperSpec(value, contentType, openingHook = "") {
  const mood = ALLOWED_BUMPER_MOODS.has(String(value?.bumper_mood || "").toLowerCase())
    ? String(value.bumper_mood).toLowerCase()
    : defaultBumperMood(contentType);
  const fallbackTagline = envTagline(contentType) || FALLBACK_BUMPER_TAGLINES[contentType] || FALLBACK_BUMPER_TAGLINES.default;
  let tagline = normalizeTagline(value?.bumper_tagline || value?.tagline || fallbackTagline);
  if (!tagline || sameText(tagline, openingHook)) tagline = normalizeTagline(fallbackTagline);
  if (!tagline || sameText(tagline, openingHook)) tagline = FALLBACK_BUMPER_TAGLINES.default;
  const accent = normalizeHexColor(value?.bumper_accent_color) || defaultBumperAccent(mood);
  const motion = normalizeBumperMotion(value?.bumper_motion || defaultBumperMotion(mood));
  return {
    bumper_enabled: boolValue(process.env.BUMPER_ENABLED, true),
    bumper_adaptive_enabled: boolValue(process.env.BUMPER_ADAPTIVE_ENABLED, true),
    bumper_duration: clampNumber(process.env.BUMPER_SECONDS, 1.1, 0.8, clampNumber(process.env.BUMPER_MAX_SECONDS, 1.5, 0.8, 1.5)),
    bumper_series_label: normalizePlainText(process.env.BUMPER_SERIES_LABEL || value?.bumper_series_label || "MENIT HIKMAH").toUpperCase() || "MENIT HIKMAH",
    bumper_tagline: tagline,
    bumper_mood: mood,
    bumper_icon: normalizeBumperIcon(value?.bumper_icon) || defaultBumperIcon(contentType),
    bumper_accent_color: accent,
    bumper_motion: motion,
    bumper_style: process.env.BUMPER_STYLE || value?.bumper_style || "adaptive_theme_stamp",
    bumper_reason: normalizePlainText(value?.reason || value?.bumper_reason || "Bumper disesuaikan dengan isi clip."),
    bumper_risk_notes: normalizePlainText(value?.risk_notes || value?.bumper_risk_notes || "")
  };
}

function parseJsonObject(value) {
  const text = String(value || "").trim();
  if (!text) return {};
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return {};
  return JSON.parse(match[0]);
}

function normalizeContentType(value) {
  const key = String(value || "").toLowerCase().trim();
  return CONTENT_TYPE_ALIASES[key] || key || "mixed_best";
}

function envTagline(contentType) {
  const key = String(contentType || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return normalizePlainText(process.env[`${key}_BUMPER_TAGLINE`] || "");
}

function defaultBumperMood(contentType) {
  return BUMPER_MOOD_BY_TYPE[contentType] || "reflective";
}

function defaultBumperIcon(contentType) {
  return BUMPER_ICON_BY_TYPE[contentType] || "spark";
}

function defaultBumperAccent(mood) {
  return BUMPER_ACCENT_BY_MOOD[mood] || "#F5C542";
}

function defaultBumperMotion(mood) {
  return BUMPER_MOTION_BY_MOOD[mood] || "soft_zoom";
}

function normalizeBumperMotion(value) {
  const motion = String(value || "").toLowerCase().trim();
  return ALLOWED_BUMPER_MOTIONS.has(motion) ? motion : "";
}

function normalizeBumperIcon(value) {
  const icon = String(value || "").toLowerCase().replace(/[^a-z0-9_ -]/g, "").trim();
  return icon.split(/\s+/)[0] || "";
}

function normalizeTagline(value) {
  const words = normalizePlainText(value)
    .replace(/[.!?;:]+$/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, clampNumber(process.env.BUMPER_TAGLINE_MAX_WORDS, 6, 2, 8));
  return words.join(" ");
}

function normalizePlainText(value) {
  return String(value || "")
    .replace(/[`"'*_#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sameText(left, right) {
  const normalize = (value) => normalizePlainText(value).toLowerCase();
  return Boolean(normalize(left) && normalize(left) === normalize(right));
}

function normalizeHexColor(value) {
  const color = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : "";
}

function clampNumber(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function isStrongThumbnailText(value) {
  const cleaned = String(value || "").trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 3 || words.length > titleMaxWords()) return false;
  if (/[,:;]$/.test(cleaned)) return false;
  const meaningfulCount = words.filter((word) => !STOPWORDS.has(word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""))).length;
  return words.join("").length >= 12 && meaningfulCount >= 2;
}

function fallbackThumbnailText(output) {
  const candidates = [
    output?.hook,
    output?.title,
    output?.selectedAngle,
    output?.reason,
    output?.caption
  ];

  for (const candidate of candidates) {
    const normalized = candidate ? normalizeThumbnailText(candidate, "") : "";
    if (isStrongThumbnailText(normalized)) return normalized;
  }

  const transcriptTitle = buildTranscriptThumbnailText(output?.clipTranscript);
  if (isStrongThumbnailText(transcriptTitle)) return transcriptTitle;

  return "JANGAN TERLALU MENGGENGGAM DUNIA";
}

function buildTranscriptThumbnailText(value) {
  const words = String(value || "")
    .replace(/[^\p{L}\p{N}\s?]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word.toLowerCase()))
    .slice(0, titleMaxWords());
  return normalizeThumbnailText(words.join(" "), "");
}

function titleMaxWords() {
  const value = Number(process.env.TITLE_MAX_WORDS || process.env.THUMBNAIL_TITLE_MAX_WORDS || 5);
  return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 3), 8) : 5;
}

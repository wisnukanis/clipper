import fs from "node:fs/promises";
import path from "node:path";
import { generateAiText } from "./gemini.js";

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
  if (hasStrategyCaption(output)) {
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
    "- Akhiri dengan 4 sampai 6 hashtag relevan: pakai #PodcastIndonesia #PodcastArtis #ReelsIndonesia lalu tambah hashtag tokoh/topik dan #Viral jika cocok.",
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

  const text = await generateAiText(prompt, { maxOutputTokens: 700, provider: aiProvider });
  return ensureCaptionHashtags(text || fallback, output, promptTemplate, dynamicHashtags);
}

export async function generateThumbnailText({ job, output, promptTemplate, aiProvider = "" }) {
  const existing = output.thumbnailText ? normalizeThumbnailText(output.thumbnailText, "") : "";
  const fallback = fallbackThumbnailText(output);
  const prompt = [
    "Buat teks thumbnail Reels dalam Bahasa Indonesia.",
    "Aturan: 4 sampai 9 kata, ideal 5 sampai 7 kata, huruf besar, kuat, mudah dibaca, tidak clickbait menyesatkan.",
    "- Jangan jawab satu atau dua kata.",
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
  const text = await generateAiText(prompt, { maxOutputTokens: 80, temperature: 0.65, provider: aiProvider });
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
  return generated || fallback;
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
  const hook = output.hook || output.title || "Ada bagian menarik dari obrolan ini.";
  const body = output.caption || output.reason || "Potongan ini diambil dari momen yang paling kuat di podcast.";
  const cta = promptTemplate?.cta || "Menurut kamu, bagian paling relate yang mana?";
  const tags = mergeHashtags(BASE_HASHTAGS, dynamicHashtags, ["#Viral"]).slice(0, 6).join(" ");
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
      .find((item) => item.split(/\s+/).length >= 4);
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

function ensureCaptionHashtags(caption, output, promptTemplate, dynamicHashtags = []) {
  const cleaned = String(caption || "").trim();
  const outputHashtags = normalizeHashtags(output?.hashtags || []);
  const existingHashtags = normalizeHashtags(extractHashtags(cleaned));
  const contextHashtags = normalizeHashtags(dynamicHashtags);
  const templateHashtags = normalizeHashtags(promptTemplate?.hashtag_template || []);
  const hashtags = mergeHashtags(BASE_HASHTAGS, contextHashtags, outputHashtags, existingHashtags, templateHashtags, ["#Viral"])
    .slice(0, 6);
  if (!hashtags.length) return cleaned;
  const body = stripHashtags(cleaned);
  return `${body || cleaned}\n\n${hashtags.join(" ")}`.trim();
}

function buildDynamicHashtags({ job, output, context = "" }) {
  const provided = normalizeHashtags(output?.hashtags || [])
    .filter((tag) => !isGenericHashtag(tag));
  if (provided.length >= 4) return provided.slice(0, 6);

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
    .slice(0, 6);
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
    : String(value || "#PodcastIndonesia #ReelsIndonesia")
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
  "#PodcastIndonesia",
  "#PodcastArtis",
  "#ReelsIndonesia"
];

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

function normalizeThumbnailText(value, fallback = "CERITA YANG JARANG DIBUKA") {
  const cleaned = String(value || "")
    .replace(/[`"'*_#]/g, "")
    .replace(/[,:;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  return cleaned.split(/\s+/).slice(0, 10).join(" ") || fallback;
}

function isStrongThumbnailText(value) {
  const cleaned = String(value || "").trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 4 || words.length > 10) return false;
  if (/[,:;]$/.test(cleaned)) return false;
  const meaningfulCount = words.filter((word) => !STOPWORDS.has(word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""))).length;
  return words.join("").length >= 10 && meaningfulCount >= 2;
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

  return "CERITA INI BIKIN PENASARAN";
}

function buildTranscriptThumbnailText(value) {
  const words = String(value || "")
    .replace(/[^\p{L}\p{N}\s?]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word.toLowerCase()))
    .slice(0, 7);
  return normalizeThumbnailText(words.join(" "), "");
}

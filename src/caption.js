import fs from "node:fs/promises";
import path from "node:path";
import { generateGeminiText } from "./gemini.js";

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

export async function generateCaption({ job, output, promptTemplate, clipperRoot }) {
  if (hasStrategyCaption(output)) {
    return output.caption.trim();
  }

  const context = await readClipContext(clipperRoot, output);
  const fallback = fallbackCaption(output, promptTemplate);
  const prompt = [
    "Buat caption Instagram Reels berbahasa Indonesia.",
    "Aturan:",
    "- Hook kuat di baris pertama.",
    "- Ringkas, natural, dan sesuai transkrip.",
    "- Jangan mengarang fakta di luar konteks.",
    "- Tambahkan CTA ringan.",
    "- Tambahkan hashtag relevan.",
    "",
    `Tema: ${job.theme}`,
    `Gaya: ${promptTemplate?.hook_style || "natural emotional"}`,
    `CTA: ${promptTemplate?.cta || "Menurut kamu bagaimana?"}`,
    `Hashtag: ${promptTemplate?.hashtag_template || "#PodcastIndonesia #ReelsIndonesia"}`,
    "",
    "Konteks clip:",
    context || fallback,
    "",
    "Tulis caption final saja tanpa markdown."
  ].join("\n");

  const text = await generateGeminiText(prompt, { maxOutputTokens: 700 });
  return (text || fallback).trim();
}

export async function generateThumbnailText({ job, output, promptTemplate }) {
  if (output.thumbnailText) {
    return normalizeThumbnailText(output.thumbnailText);
  }

  const fallback = normalizeThumbnailText(output.hook || output.title || "CERITA YANG JARANG DIBUKA");
  const prompt = [
    "Buat teks thumbnail Reels dalam Bahasa Indonesia.",
    "Aturan: 3 sampai 7 kata, huruf besar, kuat, mudah dibaca, tidak clickbait menyesatkan.",
    `Tema: ${job.theme}`,
    `Style: ${promptTemplate?.thumbnail_style || "singkat dan kuat"}`,
    `Judul/hook clip: ${output.hook || output.title || ""}`,
    `Alasan clip: ${output.reason || ""}`,
    "Balas hanya teks thumbnail."
  ].join("\n");
  const text = await generateGeminiText(prompt, { maxOutputTokens: 80, temperature: 0.65 });
  return normalizeThumbnailText(text || fallback);
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

function fallbackCaption(output, promptTemplate) {
  const hook = output.hook || output.title || "Ada bagian menarik dari obrolan ini.";
  const body = output.caption || output.reason || "Potongan ini diambil dari momen yang paling kuat di podcast.";
  const cta = promptTemplate?.cta || "Menurut kamu, bagian paling relate yang mana?";
  const tags = promptTemplate?.hashtag_template || "#PodcastIndonesia #ReelsIndonesia";
  return `${hook}\n\n${body}\n\n${cta}\n\n${tags}`;
}

function normalizeThumbnailText(value) {
  const cleaned = String(value || "")
    .replace(/[`"'*_#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  return cleaned.split(/\s+/).slice(0, 7).join(" ") || "CERITA YANG JARANG DIBUKA";
}

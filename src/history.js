import { readJson, writeJson } from "./storage.js";
import { todayDate } from "./job-id.js";

function videoKeys(entry = {}) {
  return [
    entry.youtube_video_id,
    entry.source_url,
    entry.url,
    entry.final_video_hash,
    entry.instagram_media_id
  ].filter(Boolean);
}

function normalizedTitle(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleSimilarity(a = "", b = "") {
  const left = new Set(normalizedTitle(a).split(" ").filter((word) => word.length > 2));
  const right = new Set(normalizedTitle(b).split(" ").filter((word) => word.length > 2));
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const word of left) {
    if (right.has(word)) overlap += 1;
  }
  return overlap / Math.max(left.size, right.size);
}

export async function hasProcessedVideo(video) {
  const history = await readJson("history", []);
  const targetKeys = new Set(videoKeys(video));
  const targetTitle = video.source_title || video.title || "";
  if (!targetKeys.size && !targetTitle) return false;
  return history.some((entry) => {
    if (![
      "published",
      "published_with_warnings",
      "ready_to_publish",
      "rendered_waiting_review",
      "partial_rendered_waiting_review",
      "clipper_done",
      "queued"
    ].includes(entry.status)) return false;
    if (videoKeys(entry).some((key) => targetKeys.has(key))) return true;
    return titleSimilarity(targetTitle, entry.source_title || entry.title_best || entry.title || "") >= 0.85;
  });
}

export async function hasPublishedToday(date = todayDate()) {
  const history = await readJson("history", []);
  return history.some((entry) => (
    entry.status === "published"
    && entry.publish_date === date
    && Boolean(entry.youtube_video_id)
  ));
}

export async function publishedCountToday(date = todayDate()) {
  const history = await readJson("history", []);
  return history.filter((entry) => (
    entry.status === "published"
    && entry.publish_date === date
    && Boolean(entry.youtube_video_id)
  )).length;
}

export async function appendHistory(entry) {
  const history = await readJson("history", []);
  history.push({
    ...entry,
    recorded_at: new Date().toISOString()
  });
  await writeJson("history", history.slice(-500));
}

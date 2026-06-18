import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { todayDate } from "./job-id.js";
import { buildYoutubeMetadata, isYoutubeQuotaError, publishToYoutube } from "./youtube-publisher.js";

const pendingFile = () => path.join(config.dataDir, "pending_uploads.json");
const counterFile = () => path.join(config.dataDir, "daily_upload_counter.json");
const usedSourcesFile = () => path.join(config.dataDir, "used_sources.json");

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

export function youtubeDailyUploadLimit() {
  return Math.max(0, Number(process.env.YOUTUBE_DAILY_UPLOAD_LIMIT || process.env.MAX_SCHEDULED_POSTS_PER_DAY || 3) || 0);
}

export async function youtubeUploadsToday(date = todayDate(config.timezone)) {
  const counters = await readJsonFile(counterFile(), {});
  return Number(counters?.[date]?.youtube || 0);
}

export async function canUploadYoutubeToday(date = todayDate(config.timezone)) {
  const limit = youtubeDailyUploadLimit();
  if (!limit) return true;
  return await youtubeUploadsToday(date) < limit;
}

export async function incrementYoutubeUploadCounter(date = todayDate(config.timezone)) {
  const counters = await readJsonFile(counterFile(), {});
  counters[date] = {
    ...(counters[date] || {}),
    youtube: Number(counters?.[date]?.youtube || 0) + 1,
    updated_at: new Date().toISOString()
  };
  await writeJsonFile(counterFile(), counters);
  return counters[date].youtube;
}

export async function savePendingUpload({
  videoPath,
  metadata = {},
  thumbnailPath = "",
  reason = "PENDING",
  error = ""
}) {
  const list = await readJsonFile(pendingFile(), []);
  const key = videoPath || metadata.output_file || metadata.job_id;
  const record = {
    video_path: videoPath || metadata.output_file || "",
    title: metadata.title_best || metadata.title || "",
    description: metadata.description || metadata.caption || "",
    tags: Array.isArray(metadata.hashtags) ? metadata.hashtags.map((tag) => String(tag).replace(/^#/, "")) : [],
    category: metadata.content_type || metadata.theme || "",
    scheduled_slot: `${metadata.publish_date_wib || ""} ${metadata.publish_slot_wib || ""}`.trim(),
    reason,
    error,
    thumbnail_path: thumbnailPath || metadata.thumbnailPath || metadata.thumbnail_path || "",
    metadata_file: metadata.metadata_file || "",
    source_url: metadata.source_url || "",
    source_video_id: metadata.source_video_id || metadata.youtube_video_id || "",
    created_at: new Date().toISOString(),
    retry_count: 0,
    status: "pending"
  };
  const index = list.findIndex((item) => (item.video_path || item.metadata_file) === key);
  if (index === -1) list.push(record);
  else list[index] = { ...list[index], ...record, retry_count: Number(list[index].retry_count || 0) };
  await writeJsonFile(pendingFile(), list);
  return record;
}

export async function markUsedSource({ video, output, platformResults = {}, metadata = {} }) {
  const list = await readJsonFile(usedSourcesFile(), []);
  const record = {
    source_url: video?.url || metadata.source_url || "",
    source_video_id: video?.youtube_video_id || metadata.source_video_id || "",
    clip_start: output?.start || metadata.start_time || "",
    clip_end: output?.end || metadata.end_time || "",
    final_video_hash: "",
    uploaded_at: new Date().toISOString(),
    title: metadata.title_best || output?.bestTitle || output?.title || "",
    youtube_video_id: platformResults?.youtube?.videoId || "",
    youtube_url: platformResults?.youtube?.url || ""
  };
  if (!record.source_url && !record.source_video_id) return null;
  list.push(record);
  await writeJsonFile(usedSourcesFile(), list.slice(-1000));
  return record;
}

export async function uploadPendingQueue({ dryRun = false, limit = 3 } = {}) {
  const pending = await readJsonFile(pendingFile(), []);
  const remaining = [];
  const uploaded = [];
  const errors = [];
  for (const item of pending) {
    if (uploaded.length >= limit || !await canUploadYoutubeToday()) {
      remaining.push(item);
      continue;
    }
    if (dryRun) {
      uploaded.push({ ...item, dry_run: true });
      remaining.push(item);
      continue;
    }
    try {
      const result = await publishToYoutube({
        videoPath: item.video_path,
        thumbnailPath: item.thumbnail_path || "",
        title: item.title,
        description: item.description,
        tags: item.tags || []
      });
      await incrementYoutubeUploadCounter();
      uploaded.push({ ...item, result });
    } catch (error) {
      const retryCount = Number(item.retry_count || 0) + 1;
      const next = { ...item, retry_count: retryCount, last_error: error.message, updated_at: new Date().toISOString() };
      remaining.push(next);
      errors.push({ title: item.title, quota_exceeded: isYoutubeQuotaError(error), error: error.message });
    }
  }
  await writeJsonFile(pendingFile(), remaining);
  return { uploaded_count: uploaded.length, pending_count: remaining.length, uploaded, errors };
}


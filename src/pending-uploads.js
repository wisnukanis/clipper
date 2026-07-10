import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";
import { todayDate } from "./job-id.js";
import { patchItem, readJson, writeJson } from "./storage.js";
import { buildYoutubeMetadata, isYoutubeQuotaError, publishToYoutube } from "./youtube-publisher.js";

const pendingFile = () => path.join(config.dataDir, "pending_uploads.json");
const counterFile = () => path.join(config.dataDir, "daily_upload_counter.json");
const usedSourcesFile = () => path.join(config.dataDir, "used_sources.json");

function filenameFromPath(value) {
  return path.basename(String(value || "").replace(/\\/g, "/"));
}

export function pendingJobId(item = {}) {
  if (item.job_id) return String(item.job_id);
  const filename = filenameFromPath(item.video_path || item.video_url);
  return filename
    .replace(/-with-thumb-intro(?=\.mp4$)/i, "")
    .replace(/\.mp4$/i, "");
}

export function pendingAssetUrl(item = {}, type = "video") {
  const explicit = type === "thumbnail"
    ? item.thumbnail_url || item.public_thumbnail_url
    : item.video_url || item.public_video_url;
  if (explicit) return String(explicit);
  if (!config.publicBaseUrl) return "";

  const jobId = pendingJobId(item);
  if (!jobId) return "";
  const folder = type === "thumbnail" ? "thumbnails" : "videos";
  const filename = type === "thumbnail" ? `${jobId}-thumbnail.jpg` : `${jobId}.mp4`;
  return `${config.publicBaseUrl}/${folder}/${encodeURIComponent(filename)}`;
}

export function isPendingUploadExpired(item = {}, now = Date.now()) {
  const maxAgeDays = Math.max(1, Number(process.env.PENDING_UPLOAD_MAX_AGE_DAYS || 7) || 7);
  const createdAt = Date.parse(item.created_at || item.updated_at || "");
  return Number.isFinite(createdAt) && now - createdAt > maxAgeDays * 86400000;
}

async function validLocalFile(filePath) {
  if (!filePath) return false;
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function downloadPendingAsset(item, type) {
  const configuredPath = type === "thumbnail" ? item.thumbnail_path : item.video_path;
  if (await validLocalFile(configuredPath)) return { filePath: configuredPath, temporary: false };

  const url = pendingAssetUrl(item, type);
  if (!url) throw new Error(`Pending ${type} tidak punya file lokal atau URL publik.`);
  const jobId = pendingJobId(item) || `pending-${Date.now()}`;
  const extension = type === "thumbnail" ? ".jpg" : ".mp4";
  const dir = path.join(config.generatedDir, "pending-retry");
  const target = path.join(dir, `${jobId}-${type}${extension}`);
  const temp = `${target}.part`;

  await fs.mkdir(dir, { recursive: true });
  if (await validLocalFile(target)) return { filePath: target, temporary: true };
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok || !response.body) {
    throw new Error(`Gagal mengambil pending ${type} dari storage: HTTP ${response.status} ${url}`);
  }

  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));
    const stat = await fs.stat(temp);
    if (!stat.size) throw new Error(`Pending ${type} yang didownload kosong.`);
    await fs.rename(temp, target);
    return { filePath: target, temporary: true };
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function markPendingUploadPublished(item, result) {
  const now = new Date().toISOString();
  const jobId = pendingJobId(item);
  const patch = {
    status: "published",
    publish_status: "published",
    youtube_status: "published",
    youtube_video_id: result.videoId,
    youtube_url: result.url,
    youtube_error: "",
    youtube_published_at: now,
    published_at: now
  };

  if (jobId) await patchItem("jobs", jobId, patch);
  if (item.video_id) {
    await patchItem("videos", item.video_id, {
      status: "published",
      published_youtube_video_id: result.videoId,
      published_youtube_url: result.url
    });
  }

  const history = await readJson("history", []);
  let historyIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.job_id === jobId) {
      historyIndex = index;
      break;
    }
  }
  const historyPatch = {
    job_id: jobId,
    video_id: item.video_id || "",
    source_url: item.source_url || "",
    source_video_id: item.source_video_id || "",
    status: "published",
    publish_date: todayDate(config.timezone),
    youtube_video_id: result.videoId,
    youtube_url: result.url,
    published_at: now,
    recorded_at: now
  };
  if (historyIndex >= 0) history[historyIndex] = { ...history[historyIndex], ...historyPatch };
  else history.push(historyPatch);
  await writeJson("history", history.slice(-500));
}

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
  jobId = "",
  videoPath,
  videoUrl = "",
  metadata = {},
  thumbnailPath = "",
  thumbnailUrl = "",
  reason = "PENDING",
  error = ""
}) {
  const list = await readJsonFile(pendingFile(), []);
  const key = videoPath || metadata.output_file || metadata.job_id;
  const record = {
    job_id: jobId || metadata.job_id || "",
    video_id: metadata.video_id || "",
    video_path: videoPath || metadata.output_file || "",
    video_url: videoUrl || metadata.public_video_url || "",
    title: metadata.title_best || metadata.title || "",
    description: metadata.description || metadata.caption || "",
    tags: Array.isArray(metadata.hashtags) ? metadata.hashtags.map((tag) => String(tag).replace(/^#/, "")) : [],
    category: metadata.content_type || metadata.theme || "",
    scheduled_slot: `${metadata.publish_date_wib || ""} ${metadata.publish_slot_wib || ""}`.trim(),
    reason,
    error,
    thumbnail_path: thumbnailPath || metadata.thumbnailPath || metadata.thumbnail_path || "",
    thumbnail_url: thumbnailUrl || metadata.public_thumbnail_url || "",
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
  const expired = [];
  for (const item of pending) {
    if (isPendingUploadExpired(item)) {
      expired.push({ ...item, error: "Pending upload kedaluwarsa; file remote tidak lagi dijamin tersedia." });
      continue;
    }
    if (uploaded.length >= limit || !await canUploadYoutubeToday()) {
      remaining.push(item);
      continue;
    }
    if (dryRun) {
      uploaded.push({ ...item, dry_run: true });
      remaining.push(item);
      continue;
    }
    let video = null;
    let thumbnail = null;
    try {
      video = await downloadPendingAsset(item, "video");
      try {
        thumbnail = await downloadPendingAsset(item, "thumbnail");
      } catch (error) {
        thumbnail = { filePath: "", temporary: false };
        console.warn(`Pending thumbnail dilewati: ${error.message}`);
      }
      const result = await publishToYoutube({
        videoPath: video.filePath,
        thumbnailPath: thumbnail.filePath,
        title: item.title,
        description: item.description,
        tags: item.tags || []
      });
      await incrementYoutubeUploadCounter();
      await markPendingUploadPublished(item, result);
      uploaded.push({ ...item, result });
    } catch (error) {
      const retryCount = Number(item.retry_count || 0) + 1;
      const next = { ...item, retry_count: retryCount, last_error: error.message, updated_at: new Date().toISOString() };
      remaining.push(next);
      errors.push({ title: item.title, quota_exceeded: isYoutubeQuotaError(error), error: error.message });
    } finally {
      if (video?.temporary) await fs.rm(video.filePath, { force: true }).catch(() => {});
      if (thumbnail?.temporary) await fs.rm(thumbnail.filePath, { force: true }).catch(() => {});
    }
  }
  await writeJsonFile(pendingFile(), remaining);
  return {
    uploaded_count: uploaded.length,
    pending_count: remaining.length,
    expired_count: expired.length,
    uploaded,
    expired,
    errors
  };
}


import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { appendHistory } from "./history.js";
import { appendLog } from "./logger.js";
import { readJson, writeJson } from "./storage.js";
import { downloadStateFromRemote, uploadStateToRemote } from "./state-sync.js";
import { buildYoutubeMetadata, isYoutubeQuotaError, publishToYoutube } from "./youtube-publisher.js";

const retryStatuses = new Set([
  "ready",
  "ready_to_publish",
  "publish_failed",
  "failed_publish",
  "youtube_quota_exceeded",
  "quota_exceeded",
  "published_partial",
  "published_with_warnings",
  "partial_ready"
]);

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function boolArg(name) {
  return process.argv.includes(name);
}

function safeName(value) {
  return String(value || "ready")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "ready";
}

async function localFileExists(filePath) {
  if (!filePath) return false;
  try {
    const stat = await fs.stat(filePath);
    return stat.size > 0;
  } catch {
    return false;
  }
}

async function resolveAsset({ localPath, publicUrl, folder, filename, required }) {
  if (await localFileExists(localPath)) return localPath;
  if (!publicUrl) {
    if (required) throw new Error(`${folder} URL kosong.`);
    return localPath || "";
  }

  const dir = path.join(config.generatedDir, folder);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, filename);
  const response = await fetch(publicUrl);
  if (!response.ok) {
    if (required) throw new Error(`Gagal download ${folder} dari remote storage: HTTP ${response.status}`);
    return localPath || "";
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) {
    if (required) throw new Error(`${folder} dari remote storage kosong.`);
    return localPath || "";
  }
  await fs.writeFile(target, buffer);
  return target;
}

function buildTargets(jobs, { jobId = "", all = false, limit = 0 } = {}) {
  const selectedJobs = (jobId ? jobs.filter((job) => job.job_id === jobId) : jobs)
    .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));
  const targets = [];

  for (const job of selectedJobs) {
    const jobReady = [job.status, job.publish_status, job.youtube_status].some((status) => retryStatuses.has(status));
    const clips = Array.isArray(job.clip_results) ? job.clip_results.filter((clip) => clip?.public_video_url) : [];

    if (clips.length) {
      for (const clip of clips) {
        const clipReady = [clip.status, job.status, job.publish_status, job.youtube_status].some((status) => retryStatuses.has(status));
        if (!clipReady || clip.youtube_url || clip.youtube_video_id) continue;
        targets.push({
          parentJobId: job.job_id,
          clipJobId: clip.clip_job_id || `${job.job_id}-clip-${String(clip.clip_index || 1).padStart(2, "0")}`,
          clipIndex: Number(clip.clip_index || 1),
          clipTotal: Number(job.clip_total || clips.length || 1),
          sourceJob: job,
          sourceUrl: job.source_url,
          videoId: job.video_id,
          sourceTitle: job.source_title || clip.title || "Podcast Clip",
          caption: clip.caption || job.caption || "",
          localVideoPath: clip.final_video_path || "",
          publicVideoUrl: clip.public_video_url,
          localThumbnailPath: clip.thumbnail_path || job.thumbnail_path || "",
          publicThumbnailUrl: clip.public_thumbnail_url || job.public_thumbnail_url || ""
        });
      }
    } else if (jobReady && job.public_video_url && !job.youtube_url && !job.youtube_video_id) {
      targets.push({
        parentJobId: job.job_id,
        clipJobId: job.job_id,
        clipIndex: 1,
        clipTotal: 1,
        sourceJob: job,
        sourceUrl: job.source_url,
        videoId: job.video_id,
        sourceTitle: job.source_title || "Podcast Clip",
        caption: job.caption || "",
        localVideoPath: job.final_video_path || "",
        publicVideoUrl: job.public_video_url,
        localThumbnailPath: job.thumbnail_path || "",
        publicThumbnailUrl: job.public_thumbnail_url || ""
      });
    }
  }

  const scoped = all || jobId ? targets : targets.slice(0, 1);
  return limit > 0 ? scoped.slice(0, limit) : scoped;
}

async function updateJobTarget(target, patch, clipPatch = {}) {
  const jobs = await readJson("jobs", []);
  const index = jobs.findIndex((job) => job.job_id === target.parentJobId);
  if (index === -1) return null;

  const job = jobs[index];
  let clipResults = Array.isArray(job.clip_results) ? job.clip_results : [];
  if (clipResults.length) {
    clipResults = clipResults.map((clip) => {
      const sameClip = clip.clip_job_id === target.clipJobId || Number(clip.clip_index || 0) === target.clipIndex;
      return sameClip ? { ...clip, ...clipPatch } : clip;
    });
  }

  const now = new Date().toISOString();
  const allYoutubePublished = clipResults.length
    ? clipResults.every((clip) => clip.youtube_url || clip.youtube_video_id)
    : Boolean(patch.youtube_url || patch.youtube_video_id || job.youtube_url || job.youtube_video_id);

  jobs[index] = {
    ...job,
    ...patch,
    clip_results: clipResults,
    status: allYoutubePublished && patch.youtube_url ? "published" : patch.status || job.status,
    publish_status: allYoutubePublished && patch.youtube_url ? "published" : patch.publish_status || job.publish_status,
    updated_at: now
  };
  await writeJson("jobs", jobs);
  return jobs[index];
}

async function patchVideo(target, youtube) {
  const videos = await readJson("videos", []);
  const index = videos.findIndex((video) => video.id === target.videoId);
  if (index === -1) return;
  videos[index] = {
    ...videos[index],
    status: "published",
    youtube_video_id: youtube.videoId || videos[index].youtube_video_id || "",
    youtube_url: youtube.url || videos[index].youtube_url || "",
    updated_at: new Date().toISOString()
  };
  await writeJson("videos", videos);
}

async function publishTarget(target) {
  await updateJobTarget(target, {
    status: "publishing",
    publish_status: "publishing",
    youtube_status: "processing",
    youtube_error: ""
  }, {
    status: "youtube_processing",
    youtube_error: ""
  });

  const assetName = safeName(target.clipJobId);
  const videoPath = await resolveAsset({
    localPath: target.localVideoPath,
    publicUrl: target.publicVideoUrl,
    folder: "ready-videos",
    filename: `${assetName}.mp4`,
    required: true
  });
  const thumbnailPath = await resolveAsset({
    localPath: target.localThumbnailPath,
    publicUrl: target.publicThumbnailUrl,
    folder: "ready-thumbnails",
    filename: `${assetName}.jpg`,
    required: false
  });

  const job = {
    ...target.sourceJob,
    job_id: target.clipJobId,
    source_title: target.sourceTitle
  };
  const output = {
    title: target.sourceTitle,
    hook: target.sourceTitle,
    finalAbsPath: videoPath,
    caption: target.caption,
    clipTranscript: "",
    selectedAngle: ""
  };
  const metadata = buildYoutubeMetadata({ job, output, caption: target.caption });
  const youtube = await publishToYoutube({
    videoPath,
    thumbnailPath,
    ...metadata
  });
  const now = new Date().toISOString();

  const updatedJob = await updateJobTarget(target, {
    status: "ready_to_publish",
    publish_status: "youtube_partial_published",
    youtube_status: "published",
    youtube_video_id: youtube.videoId || "",
    youtube_url: youtube.url || "",
    youtube_custom_thumbnail: youtube.customThumbnail === true,
    youtube_thumbnail_error: youtube.thumbnailError || "",
    youtube_published_at: now,
    published_at: now,
    error_message: ""
  }, {
    status: "published",
    youtube_video_id: youtube.videoId || "",
    youtube_url: youtube.url || "",
    youtube_error: "",
    published_at: now
  });
  const allClipsPublished = !Array.isArray(updatedJob?.clip_results) || !updatedJob.clip_results.length
    || updatedJob.clip_results.every((clip) => clip.youtube_url || clip.youtube_video_id);
  if (allClipsPublished) await patchVideo(target, youtube);
  await appendHistory({
    job_id: target.clipJobId,
    clip_index: target.clipIndex,
    clip_total: target.clipTotal,
    video_id: target.videoId,
    source_url: target.sourceUrl,
    theme: target.sourceJob.theme,
    status: "published",
    final_video_path: videoPath,
    public_video_url: target.publicVideoUrl,
    public_thumbnail_url: target.publicThumbnailUrl,
    caption: target.caption,
    youtube_video_id: youtube.videoId || "",
    youtube_url: youtube.url || "",
    published_at: now
  });
  await appendLog("youtube_ready_published", {
    job_id: target.clipJobId,
    youtube_video_id: youtube.videoId || "",
    youtube_url: youtube.url || ""
  });
  await uploadStateToRemote().catch(() => {});
  return youtube;
}

async function markQuota(target, error) {
  await updateJobTarget(target, {
    status: "ready_to_publish",
    publish_status: "youtube_quota_exceeded",
    youtube_status: "quota_exceeded",
    youtube_error: error.message,
    error_message: "Quota YouTube habis; siap retry tanpa render ulang."
  }, {
    status: "youtube_quota_exceeded",
    youtube_error: error.message
  });
  await appendLog("youtube_quota_exceeded", {
    job_id: target.clipJobId,
    error: error.message
  });
  await uploadStateToRemote().catch(() => {});
}

async function markFailed(target, error) {
  await updateJobTarget(target, {
    status: "ready_to_publish",
    publish_status: "publish_failed",
    youtube_status: "failed",
    youtube_error: error.message,
    error_message: error.message
  }, {
    status: "publish_failed",
    youtube_error: error.message
  });
  await appendLog("youtube_ready_publish_failed", {
    job_id: target.clipJobId,
    error: error.message
  });
  await uploadStateToRemote().catch(() => {});
}

if (!config.youtube.enabled) {
  console.error("YOUTUBE_UPLOAD_ENABLED harus true untuk retry upload YouTube.");
  process.exit(1);
}

await downloadStateFromRemote().catch((error) => {
  console.warn(`State remote dilewati: ${error.message}`);
});

const jobs = await readJson("jobs", []);
const targets = buildTargets(jobs, {
  jobId: argValue("--job", ""),
  all: boolArg("--all"),
  limit: Number(argValue("--limit", "0")) || 0
});

if (!targets.length) {
  console.log(JSON.stringify({ status: "no_ready_youtube_jobs" }, null, 2));
  process.exit(0);
}

const results = [];
let failed = 0;
for (const target of targets) {
  try {
    console.log(`Retry YouTube upload: ${target.clipJobId}`);
    const youtube = await publishTarget(target);
    results.push({ job_id: target.clipJobId, status: "published", youtube_url: youtube.url });
  } catch (error) {
    if (isYoutubeQuotaError(error)) {
      await markQuota(target, error);
      results.push({ job_id: target.clipJobId, status: "youtube_quota_exceeded", error: error.message });
      break;
    }
    failed += 1;
    await markFailed(target, error);
    results.push({ job_id: target.clipJobId, status: "failed", error: error.message });
  }
}

console.log(JSON.stringify({
  status: failed ? "completed_with_failures" : "completed",
  attempted: results.length,
  failed,
  results
}, null, 2));

process.exit(failed ? 1 : 0);

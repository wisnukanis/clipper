import { config } from "./config.js";
import { appendHistory } from "./history.js";
import { publishReel } from "./instagram.js";
import { appendLog } from "./logger.js";
import { patchItem, readJson, writeJson } from "./storage.js";
import { buildYoutubeMetadata, publishToYoutube } from "./youtube-publisher.js";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function latestReadyJob(jobs) {
  return jobs
    .filter((job) => job.status === "ready_to_publish" || job.publish_status === "ready_to_publish")
    .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")))[0] || null;
}

async function patchVideo(videoId, patch) {
  const videos = await readJson("videos", []);
  const index = videos.findIndex((video) => video.id === videoId);
  if (index === -1) return null;
  videos[index] = { ...videos[index], ...patch, updated_at: new Date().toISOString() };
  await writeJson("videos", videos);
  return videos[index];
}

const jobId = argValue("--job", "");
const forceYoutube = process.argv.includes("--force-youtube");
const jobs = await readJson("jobs", []);
const job = jobId ? jobs.find((item) => item.job_id === jobId) : latestReadyJob(jobs);

if (!job) {
  console.error("Tidak ada job ready_to_publish.");
  process.exit(1);
}

if (!config.youtube.enabled && !config.instagram.enabled) {
  console.error("Tidak ada platform aktif. Aktifkan YOUTUBE_UPLOAD_ENABLED atau INSTAGRAM_UPLOAD_ENABLED.");
  process.exit(1);
}

if (!job.final_video_path) {
  console.error(`Job ${job.job_id} tidak punya final_video_path.`);
  process.exit(1);
}

await patchItem("jobs", job.job_id, {
  youtube_status: config.youtube.enabled && (!job.youtube_url || forceYoutube) ? "processing" : job.youtube_status,
  instagram_status: config.instagram.enabled && !job.instagram_media_id ? "processing" : job.instagram_status,
  publish_status: "publishing",
  status: "publishing"
});

try {
  let youtube = job.youtube_url ? {
    videoId: job.youtube_video_id,
    url: job.youtube_url,
    skipped: true
  } : null;
  let instagram = job.instagram_media_id ? {
    mediaId: job.instagram_media_id,
    skipped: true
  } : null;

  const output = {
    title: job.source_title,
    hook: job.source_title,
    finalAbsPath: job.final_video_path
  };

  if (config.youtube.enabled && (!youtube || forceYoutube)) {
    const metadata = buildYoutubeMetadata({
      job,
      output,
      caption: job.caption || ""
    });
    youtube = await publishToYoutube({
      videoPath: job.final_video_path,
      ...metadata
    });
  }

  if (config.instagram.enabled && !instagram) {
    if (!job.public_video_url) throw new Error("public_video_url kosong, Instagram butuh URL video publik dari FTP.");
    instagram = await publishReel({
      videoUrl: job.public_video_url,
      caption: job.caption || ""
    });
  }

  if (!youtube && !instagram) {
    throw new Error("Tidak ada publish yang dijalankan.");
  }

  const now = new Date().toISOString();
  await patchItem("jobs", job.job_id, {
    status: "published",
    publish_status: "published",
    youtube_status: youtube ? "published" : "disabled",
    youtube_video_id: youtube?.videoId || "",
    youtube_url: youtube?.url || "",
    youtube_published_at: youtube?.skipped ? job.youtube_published_at : youtube ? now : "",
    instagram_status: instagram ? "published" : "disabled",
    instagram_media_id: instagram?.mediaId || "",
    published_at: now
  });
  await patchVideo(job.video_id, {
    status: "published",
    youtube_video_id: youtube?.videoId || job.youtube_video_id,
    youtube_url: youtube?.url || job.youtube_url,
    instagram_media_id: instagram?.mediaId || job.instagram_media_id
  });
  await appendHistory({
    job_id: job.job_id,
    video_id: job.video_id,
    source_url: job.source_url,
    youtube_video_id: job.youtube_video_id,
    theme: job.theme,
    status: "published",
    final_video_path: job.final_video_path,
    public_video_url: job.public_video_url || "",
    public_thumbnail_url: job.public_thumbnail_url || "",
    caption: job.caption || "",
    instagram_media_id: instagram?.mediaId || "",
    youtube_video_id: youtube?.videoId || "",
    youtube_url: youtube?.url || "",
    published_at: now
  });
  await appendLog("platform_published", {
    job_id: job.job_id,
    instagram_media_id: instagram?.mediaId || "",
    youtube_video_id: youtube?.videoId || "",
    youtube_url: youtube?.url || ""
  });
  console.log(JSON.stringify({
    status: "published",
    job_id: job.job_id,
    instagram,
    youtube
  }, null, 2));
} catch (error) {
  const hasYoutube = Boolean(job.youtube_url || job.youtube_video_id);
  await patchItem("jobs", job.job_id, {
    status: hasYoutube ? "published" : "failed_publish",
    publish_status: hasYoutube ? "published" : "failed_publish",
    youtube_status: hasYoutube ? "published" : config.youtube.enabled ? "failed" : job.youtube_status,
    instagram_status: config.instagram.enabled ? "failed" : job.instagram_status,
    error_message: error.message
  });
  await appendLog("platform_publish_failed", {
    job_id: job.job_id,
    error: error.message
  });
  throw error;
}

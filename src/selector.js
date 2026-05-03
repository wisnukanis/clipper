import { readJson, patchItem, upsertItem } from "./storage.js";
import { todayDate, createJobId, makeId } from "./job-id.js";
import { extractYoutubeVideoId } from "./youtube.js";
import { hasProcessedVideo } from "./history.js";

const selectableStatuses = new Set(["queued", "failed", "retry"]);

export async function selectNextVideo(options = {}) {
  const date = options.targetDate || todayDate();
  const videos = await readJson("videos", []);
  const themes = await readJson("themes", []);
  const prompts = await readJson("prompts", []);

  const activeThemes = themes.filter((theme) => theme.status === "active");
  const requestedTheme = options.theme && options.theme !== "auto" ? options.theme : "";

  let candidates = videos
    .map(normalizeVideo)
    .filter((video) => video.active !== false)
    .filter((video) => selectableStatuses.has(video.status || "queued"))
    .filter((video) => !requestedTheme || video.theme === requestedTheme);

  const todayCandidates = candidates.filter((video) => video.target_date === date);
  if (todayCandidates.length) candidates = todayCandidates;

  candidates.sort((a, b) => {
    const priority = Number(a.priority || 100) - Number(b.priority || 100);
    if (priority !== 0) return priority;
    return String(a.created_at || "").localeCompare(String(b.created_at || ""));
  });

  for (const video of candidates) {
    if (!options.forceReprocess && !video.force_reprocess && await hasProcessedVideo(video)) {
      await patchItem("videos", video.id, { status: "skipped_duplicate" });
      continue;
    }
    const theme = activeThemes.find((item) => item.name === video.theme) || activeThemes[0] || null;
    const prompt = prompts.find((item) => item.theme === video.theme) || prompts[0] || null;
    return { video, theme, prompt };
  }

  return null;
}

export async function addVideo(input) {
  const url = String(input.url || "").trim();
  if (!url) throw new Error("URL wajib diisi.");

  const now = new Date().toISOString();
  const video = normalizeVideo({
    id: input.id || makeId("video"),
    source_type: "youtube_video",
    url,
    source_url: url,
    youtube_video_id: extractYoutubeVideoId(url),
    theme: input.theme || "podcast artis",
    priority: Number(input.priority || 1),
    target_date: input.target_date || "",
    active: input.active !== false,
    status: input.status || "queued",
    notes: input.notes || "",
    manual_range: input.manual_range || "",
    quality_profile: input.quality_profile || "standard",
    subtitle_font: input.subtitle_font || "Segoe UI Semibold",
    subtitle_font_size: Number(input.subtitle_font_size || 46),
    subtitle_margin_v: Number(input.subtitle_margin_v || 550),
    subtitle_margin_h: Number(input.subtitle_margin_h || 180),
    force_reprocess: input.force_reprocess === true,
    created_at: input.created_at || now,
    updated_at: now
  });
  await upsertItem("videos", video);
  return video;
}

export async function updateVideoStatus(videoId, status, patch = {}) {
  return patchItem("videos", videoId, {
    ...patch,
    status
  });
}

export async function createJobRecord({ video, theme, prompt }) {
  const jobId = createJobId(theme?.name || video?.theme || "podcast");
  const now = new Date().toISOString();
  const job = {
    job_id: jobId,
    video_id: video.id,
    theme: theme?.name || video.theme,
    source_type: video.source_type || "youtube_video",
    source_url: video.url || video.source_url,
    youtube_video_id: video.youtube_video_id || extractYoutubeVideoId(video.url),
    source_title: "",
    clipper_status: "pending",
    caption_status: "pending",
    thumbnail_status: "pending",
    publish_status: "pending",
    instagram_status: "pending",
    facebook_status: "pending",
    tiktok_status: "pending",
    youtube_status: "pending",
    status: "selected",
    prompt_id: prompt?.id || "",
    final_video_path: "",
    transcript_path: "",
    metadata_path: "",
    thumbnail_path: "",
    public_video_url: "",
    public_thumbnail_url: "",
    public_metadata_url: "",
    instagram_media_id: "",
    instagram_error: "",
    facebook_video_id: "",
    facebook_post_id: "",
    facebook_url: "",
    facebook_error: "",
    tiktok_publish_id: "",
    tiktok_mode: "",
    tiktok_error: "",
    youtube_video_id: "",
    youtube_url: "",
    youtube_error: "",
    youtube_published_at: "",
    created_at: now,
    updated_at: now,
    published_at: "",
    error_message: ""
  };
  await upsertItem("jobs", job, "job_id");
  await updateVideoStatus(video.id, "selected", { current_job_id: jobId });
  return job;
}

export function normalizeVideo(video) {
  const url = video.url || video.source_url || "";
  return {
    ...video,
    id: video.id || makeId("video"),
    source_type: video.source_type || "youtube_video",
    url,
    source_url: url,
    youtube_video_id: video.youtube_video_id || extractYoutubeVideoId(url),
    theme: video.theme || "podcast artis",
    priority: Number(video.priority || 1),
    quality_profile: video.quality_profile || "standard",
    subtitle_font: video.subtitle_font || "Segoe UI Semibold",
    subtitle_font_size: Number(video.subtitle_font_size || 46),
    subtitle_margin_v: Number(video.subtitle_margin_v || 550),
    subtitle_margin_h: Number(video.subtitle_margin_h || 180),
    force_reprocess: video.force_reprocess === true,
    active: video.active !== false,
    status: video.status || "queued"
  };
}

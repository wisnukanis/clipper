import fs from "node:fs/promises";
import path from "node:path";
import { config, canPublish, shouldUploadToFtp } from "./config.js";
import { ensureProjectDirs, patchItem, saveGeneratedJson } from "./storage.js";
import { appendLog } from "./logger.js";
import { appendHistory, hasPublishedToday } from "./history.js";
import { addVideo, createJobRecord, selectNextVideo, updateVideoStatus } from "./selector.js";
import { runClipper } from "./clipper-runner.js";
import { generateCaption, generateThumbnailText } from "./caption.js";
import { generateThumbnail } from "./thumbnail.js";
import { fileExists, uploadHistoryFile, uploadJobFiles, validatePublicUrl } from "./uploader.js";
import { publishReel } from "./instagram.js";
import { buildYoutubeMetadata, publishToYoutube } from "./youtube-publisher.js";
import { todayDate } from "./job-id.js";
import { downloadStateFromRemote, uploadStateToRemote } from "./state-sync.js";

export async function runWorkflow(options = {}) {
  await ensureProjectDirs();
  await downloadStateFromRemote().catch((error) => {
    console.warn(`State remote dilewati: ${error.message}`);
  });

  if (options.scheduled && options.publish && await hasPublishedToday()) {
    await appendLog("scheduled_skip", { reason: "already_published_today" });
    return { status: "scheduled_skip", reason: "already_published_today" };
  }

  const selection = options.url
    ? await createManualSelection(options)
    : await selectNextVideo({ theme: options.theme || config.defaultTheme });

  if (!selection) {
    await appendLog("no_video_selected");
    return { status: "no_video_selected" };
  }

  const { video, theme, prompt } = selection;
  const job = await createJobRecord(selection);
  await appendLog("job_created", { job_id: job.job_id, video_id: video.id, url: video.url });

  try {
    await updateJob(job.job_id, {
      status: "clipper_processing",
      clipper_status: "processing"
    });
    await updateVideoStatus(video.id, "clipper_processing");

    const clipperResult = await runClipper({
      video,
      job,
      onLog: (message) => {
        if (message) console.log(message);
      }
    });

    const output = clipperResult.outputs[0];
    if (!output?.finalAbsPath || !await fileExists(output.finalAbsPath)) {
      throw new Error("Clipper tidak menghasilkan file MP4 final.");
    }

    await updateJob(job.job_id, {
      status: "clipper_done",
      clipper_status: "done",
      source_title: output.title || "",
      final_video_path: output.finalAbsPath,
      transcript_path: output.transcriptReviewAbsPath || output.subtitleAbsPath || ""
    });

    const caption = await generateCaption({
      job,
      output,
      promptTemplate: prompt,
      clipperRoot: clipperResult.clipperRoot
    });
    await updateJob(job.job_id, {
      caption_status: "done",
      caption
    });

    const thumbnailText = await generateThumbnailText({ job, output, promptTemplate: prompt });
    const thumbnail = await generateThumbnail({
      job,
      videoPath: output.finalAbsPath,
      text: thumbnailText
    });
    await updateJob(job.job_id, {
      thumbnail_status: "done",
      thumbnail_path: thumbnail.path,
      thumbnail_text: thumbnail.text
    });

    const metadata = buildMetadata({
      job,
      video,
      theme,
      prompt,
      output,
      clipperResult,
      caption,
      thumbnail
    });
    const metadataPath = await saveGeneratedJson("metadata", `${job.job_id}.json`, metadata);

    let upload = {
      videoUrl: "",
      thumbnailUrl: "",
      metadataUrl: ""
    };
    if (shouldUploadToFtp()) {
      upload = await uploadJobFiles({
        job,
        videoPath: output.finalAbsPath,
        thumbnailPath: thumbnail.path,
        metadataPath
      });
      const videoPublicOk = await validatePublicUrl(upload.videoUrl);
      if (!videoPublicOk) throw new Error(`Public video URL belum valid: ${upload.videoUrl}`);
    }
    console.log("Public video URL valid:", upload.videoUrl);
console.log("Waiting 20 seconds before Instagram container creation...");
await new Promise((resolve) => setTimeout(resolve, 20000));

    await updateJob(job.job_id, {
      status: "ready_to_publish",
      publish_status: "ready",
      metadata_path: metadataPath,
      public_video_url: upload.videoUrl,
      public_thumbnail_url: upload.thumbnailUrl,
      public_metadata_url: upload.metadataUrl
    });

    if (options.publish && canPublish()) {
      const platformResults = await publishPlatforms({
        job,
        output,
        caption,
        upload
      });
      await updateJob(job.job_id, {
        status: "published",
        publish_status: "published",
        instagram_status: platformResults.instagram ? "published" : config.instagram.enabled ? "skipped" : "disabled",
        instagram_media_id: platformResults.instagram?.mediaId || "",
        youtube_status: platformResults.youtube ? "published" : config.youtube.enabled ? "skipped" : "disabled",
        youtube_video_id: platformResults.youtube?.videoId || "",
        youtube_url: platformResults.youtube?.url || "",
        youtube_published_at: platformResults.youtube ? new Date().toISOString() : "",
        published_at: new Date().toISOString()
      });
      await updateVideoStatus(video.id, "published");
      await appendHistoryEntry({ job, video, caption, output, upload, platformResults, status: "published" });
      await uploadHistoryIfPossible();
      await uploadStateToRemote().catch(() => {});
      await appendLog("published", {
        job_id: job.job_id,
        instagram_media_id: platformResults.instagram?.mediaId || "",
        youtube_video_id: platformResults.youtube?.videoId || ""
      });
      return { status: "published", job_id: job.job_id, platformResults };
    }

    const status = options.publish ? "dry_run" : "ready_to_publish";
    await updateJob(job.job_id, {
      status,
      publish_status: status
    });
    await updateVideoStatus(video.id, status === "dry_run" ? "queued" : "ready_to_publish");
    await appendHistoryEntry({ job, video, caption, output, upload, status });
    await uploadHistoryIfPossible();
    await uploadStateToRemote().catch(() => {});
    await appendLog(status, { job_id: job.job_id, video_url: upload.videoUrl || "" });
    return { status, job_id: job.job_id, videoUrl: upload.videoUrl };
  } catch (error) {
    await updateJob(job.job_id, {
      status: "failed",
      error_message: error.message
    });
    await updateVideoStatus(video.id, "failed", { error_message: error.message });
    await uploadStateToRemote().catch(() => {});
    await appendLog("workflow_failed", { job_id: job.job_id, error: error.message });
    throw error;
  }
}

async function createManualSelection(options) {
  const video = await addVideo({
    url: options.url,
    theme: options.theme && options.theme !== "auto" ? options.theme : "podcast artis",
    target_date: todayDate(),
    priority: 0,
    manual_range: options.range || "",
    quality_profile: options.qualityProfile || "standard",
    subtitle_font: options.subtitleFont || "Segoe UI Semibold",
    subtitle_font_size: options.subtitleFontSize || 48,
    subtitle_margin_v: options.subtitleMarginV || 240,
    notes: "Ditambahkan dari CLI/manual run"
  });
  return selectNextVideo({ theme: video.theme, targetDate: todayDate() });
}

async function updateJob(jobId, patch) {
  return patchItem("jobs", jobId, patch);
}

async function publishPlatforms({ job, output, caption, upload }) {
  const platformResults = {
    instagram: null,
    youtube: null
  };

  if (config.instagram.enabled) {
    const videoUrl = upload.videoUrl;
    if (!videoUrl) throw new Error("PUBLIC_BASE_URL/FTP wajib valid sebelum publish Instagram.");
    await updateJob(job.job_id, { instagram_status: "processing" });
    platformResults.instagram = await publishReel({ videoUrl, caption });
  }

  if (config.youtube.enabled) {
    await updateJob(job.job_id, { youtube_status: "processing" });
    const youtubeMetadata = buildYoutubeMetadata({ job, output, caption });
    platformResults.youtube = await publishToYoutube({
      videoPath: output.finalAbsPath,
      ...youtubeMetadata
    });
  }

  if (!platformResults.instagram && !platformResults.youtube) {
    throw new Error("Tidak ada platform publish yang aktif. Aktifkan INSTAGRAM_UPLOAD_ENABLED atau YOUTUBE_UPLOAD_ENABLED.");
  }

  return platformResults;
}

function buildMetadata({ job, video, theme, prompt, output, clipperResult, caption, thumbnail }) {
  return {
    job_id: job.job_id,
    source_type: "youtube_video",
    source_url: video.url,
    youtube_video_id: video.youtube_video_id,
    source_title: output.title || "",
    theme: theme?.name || job.theme,
    prompt_id: prompt?.id || "",
    status: "done",
    finalPath: output.finalAbsPath,
    transcriptPath: output.transcriptReviewAbsPath || "",
    subtitlePath: output.subtitleAbsPath || "",
    thumbnailPath: thumbnail.path,
    thumbnailText: thumbnail.text,
    caption,
    startTime: output.start,
    endTime: output.end,
    duration: output.duration,
    clipperJobId: clipperResult.jobId,
    createdAt: new Date().toISOString()
  };
}

async function appendHistoryEntry({ job, video, caption, output, upload, platformResults = {}, status }) {
  await appendHistory({
    job_id: job.job_id,
    video_id: video.id,
    source_url: video.url,
    youtube_video_id: video.youtube_video_id,
    theme: job.theme,
    status,
    publish_date: status === "published" ? todayDate() : "",
    final_video_path: output.finalAbsPath,
    public_video_url: upload.videoUrl || "",
    public_thumbnail_url: upload.thumbnailUrl || "",
    caption,
    instagram_media_id: platformResults.instagram?.mediaId || "",
    youtube_video_id: platformResults.youtube?.videoId || "",
    youtube_url: platformResults.youtube?.url || "",
    published_at: status === "published" ? new Date().toISOString() : ""
  });
}

async function uploadHistoryIfPossible() {
  const historyFile = path.join(config.dataDir, "history.json");
  try {
    await fs.access(historyFile);
    await uploadHistoryFile(historyFile);
  } catch {
    // History upload is best effort.
  }
}

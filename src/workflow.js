import fs from "node:fs/promises";
import path from "node:path";
import { config, canPublish, shouldUploadToFtp } from "./config.js";
import { ensureProjectDirs, patchItem, saveGeneratedJson } from "./storage.js";
import { appendLog } from "./logger.js";
import { appendHistory, publishedCountToday } from "./history.js";
import { addVideo, createJobRecord, selectNextVideo, updateVideoStatus } from "./selector.js";
import { runClipper } from "./clipper-runner.js";
import { generateCaption, generateThumbnailText } from "./caption.js";
import { generateThumbnail } from "./thumbnail.js";
import { fileExists, uploadHistoryFile, uploadJobFiles, validatePublicUrl } from "./uploader.js";
import { publishReel } from "./instagram.js";
import { prepareInstagramVideo } from "./instagram-video.js";
import { publishToFacebook } from "./facebook.js";
import { buildYoutubeMetadata, publishToYoutube } from "./youtube-publisher.js";
import { publishToTikTok } from "./tiktok.js";
import { todayDate } from "./job-id.js";
import { downloadStateFromRemote, uploadStateToRemote } from "./state-sync.js";
import { assertPreflightOk, printPreflightReport, runPreflight } from "./preflight.js";
import { discoverAndQueueVideos } from "./video-discovery.js";

export async function runWorkflow(options = {}) {
  await ensureProjectDirs();

  const publishRequired = Boolean(options.publish && canPublish());
  const preflight = await runPreflight({
    publishRequired,
    socialPublishRequired: false,
    socialOnline: publishRequired,
    deepgramOnline: false
  });
  printPreflightReport(preflight);
  try {
    assertPreflightOk(preflight);
  } catch (error) {
    await appendLog("precheck_failed", { error: error.message });
    throw error;
  }

  await downloadStateFromRemote().catch((error) => {
    console.warn(`State remote dilewati: ${error.message}`);
  });

  if (options.scheduled && options.publish) {
    const dailyLimit = Math.max(1, Number(process.env.MAX_SCHEDULED_POSTS_PER_DAY) || 3);
    const postedToday = await publishedCountToday();
    if (postedToday >= dailyLimit) {
      await appendLog("scheduled_skip", {
        reason: "daily_limit_reached",
        posted_today: postedToday,
        daily_limit: dailyLimit
      });
      return {
        status: "scheduled_skip",
        reason: "daily_limit_reached",
        posted_today: postedToday,
        daily_limit: dailyLimit
      };
    }
  }

  let selection = options.url
    ? await createManualSelection(options)
    : await selectNextVideo({ theme: options.theme || config.defaultTheme });

  if (!selection && !options.url) {
    await discoverAndQueueVideos({
      theme: options.theme || config.defaultTheme,
      targetDate: todayDate()
    });
    selection = await selectNextVideo({ theme: options.theme || config.defaultTheme });
  }

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
        upload,
        thumbnail
      });
      const youtubePrimary = config.youtube.enabled;
      const primaryPublished = youtubePrimary ? Boolean(platformResults.youtube) : platformResults.hasAnySuccess;
      const finalStatus = primaryPublished ? "published" : "ready_to_publish";
      const publishStatus = primaryPublished
        ? platformResults.hasErrors ? "published_with_warnings" : "published"
        : "publish_failed";
      const now = new Date().toISOString();

      await updateJob(job.job_id, {
        status: finalStatus,
        publish_status: publishStatus,
        instagram_status: platformResults.instagram ? "published" : config.instagram.enabled ? "failed" : "disabled",
        instagram_media_id: platformResults.instagram?.mediaId || "",
        instagram_error: platformResults.errors.instagram || "",
        facebook_status: platformResults.facebook ? "published" : config.facebook.enabled ? "failed" : "disabled",
        facebook_video_id: platformResults.facebook?.videoId || "",
        facebook_post_id: platformResults.facebook?.postId || "",
        facebook_url: platformResults.facebook?.url || "",
        facebook_error: platformResults.errors.facebook || "",
        tiktok_status: platformResults.tiktok ? "submitted" : config.tiktok.enabled ? "failed" : "disabled",
        tiktok_publish_id: platformResults.tiktok?.publishId || "",
        tiktok_mode: platformResults.tiktok?.mode || "",
        tiktok_error: platformResults.errors.tiktok || "",
        youtube_status: platformResults.youtube ? "published" : config.youtube.enabled ? "failed" : "disabled",
        youtube_video_id: platformResults.youtube?.videoId || "",
        youtube_url: platformResults.youtube?.url || "",
        youtube_error: platformResults.errors.youtube || "",
        youtube_published_at: platformResults.youtube ? now : "",
        published_at: primaryPublished ? now : ""
      });
      await updateVideoStatus(video.id, primaryPublished ? "published" : "ready_to_publish", {
        youtube_video_id: platformResults.youtube?.videoId || video.youtube_video_id,
        youtube_url: platformResults.youtube?.url || "",
        instagram_media_id: platformResults.instagram?.mediaId || "",
        facebook_video_id: platformResults.facebook?.videoId || "",
        facebook_url: platformResults.facebook?.url || "",
        tiktok_publish_id: platformResults.tiktok?.publishId || "",
        error_message: primaryPublished ? "" : platformResults.errors.youtube || "Publish platform gagal; siap retry."
      });
      await appendHistoryEntry({
        job,
        video,
        caption,
        output,
        upload,
        platformResults,
        status: primaryPublished ? "published" : "publish_failed"
      });
      await uploadHistoryIfPossible();
      await uploadStateToRemote().catch(() => {});
      await appendLog(primaryPublished ? "published" : "publish_failed", {
        job_id: job.job_id,
        instagram_media_id: platformResults.instagram?.mediaId || "",
        facebook_video_id: platformResults.facebook?.videoId || "",
        tiktok_publish_id: platformResults.tiktok?.publishId || "",
        youtube_video_id: platformResults.youtube?.videoId || ""
      });
      return { status: publishStatus, job_id: job.job_id, platformResults };
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
    subtitle_font_size: options.subtitleFontSize || 46,
    subtitle_margin_v: options.subtitleMarginV || 550,
    force_reprocess: options.forceReprocess === true,
    notes: "Ditambahkan dari CLI/manual run"
  });
  return selectNextVideo({
    theme: video.theme,
    targetDate: todayDate(),
    forceReprocess: options.forceReprocess === true
  });
}

async function updateJob(jobId, patch) {
  return patchItem("jobs", jobId, patch);
}

async function publishPlatforms({ job, output, caption, upload, thumbnail }) {
  const platformResults = {
    instagram: null,
    facebook: null,
    tiktok: null,
    youtube: null,
    errors: {},
    hasAnySuccess: false,
    hasErrors: false
  };

  if (config.youtube.enabled) {
    platformResults.youtube = await publishPlatform("youtube", platformResults, job.job_id, async () => {
      await updateJob(job.job_id, { youtube_status: "processing", youtube_error: "" });
      const youtubeMetadata = buildYoutubeMetadata({ job, output, caption });
      return publishToYoutube({
        videoPath: output.finalAbsPath,
        ...youtubeMetadata
      });
    });
  }

  if (config.facebook.enabled) {
    platformResults.facebook = await publishPlatform("facebook", platformResults, job.job_id, async () => {
      if (!upload.videoUrl) throw new Error("PUBLIC_BASE_URL/FTP wajib valid sebelum publish Facebook.");
      await updateJob(job.job_id, { facebook_status: "processing", facebook_error: "" });
      return publishToFacebook({
        videoUrl: upload.videoUrl,
        videoPath: output.finalAbsPath,
        title: output.title || job.source_title || "Podcast Clip",
        description: caption,
        thumbnailPath: thumbnail?.path || ""
      });
    });
  }

  if (config.instagram.enabled) {
    platformResults.instagram = await publishPlatform("instagram", platformResults, job.job_id, async () => {
      if (!upload.videoUrl) throw new Error("PUBLIC_BASE_URL/FTP wajib valid sebelum publish Instagram.");
      await updateJob(job.job_id, { instagram_status: "processing", instagram_error: "" });
      const instagramVideo = await prepareInstagramVideo({
        job,
        sourcePath: output.finalAbsPath,
        currentVideoUrl: upload.videoUrl
      });
      return publishReel({
        videoUrl: instagramVideo.videoUrl,
        caption,
        coverUrl: upload.thumbnailUrl || ""
      });
    });
  }

  if (config.tiktok.enabled) {
    platformResults.tiktok = await publishPlatform("tiktok", platformResults, job.job_id, async () => {
      if (!upload.videoUrl) throw new Error("PUBLIC_BASE_URL/FTP wajib valid sebelum publish TikTok.");
      await updateJob(job.job_id, { tiktok_status: "processing", tiktok_error: "" });
      return publishToTikTok({
        videoUrl: upload.videoUrl,
        videoPath: output.finalAbsPath,
        caption
      });
    });
  }

  return platformResults;
}

async function publishPlatform(name, platformResults, jobId, callback) {
  try {
    const result = await callback();
    if (result) platformResults.hasAnySuccess = true;
    return result;
  } catch (error) {
    platformResults.hasErrors = true;
    platformResults.errors[name] = error.message;
    await appendLog("platform_publish_failed", {
      job_id: jobId,
      platform: name,
      error: error.message
    });
    console.warn(`${name} publish gagal, workflow lanjut: ${error.message}`);
    return null;
  }
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
    transcriptSource: output.transcriptSource || "",
    finalPath: output.finalAbsPath,
    transcriptPath: output.transcriptReviewAbsPath || "",
    subtitlePath: output.subtitleAbsPath || "",
    thumbnailPath: thumbnail.path,
    thumbnailText: thumbnail.text,
    caption,
    startTime: output.start,
    endTime: output.end,
    duration: output.duration,
    clipTranscript: output.clipTranscript || "",
    viralScore: output.viralScore || 0,
    selectedAngle: output.selectedAngle || "",
    publishDecision: output.publishDecision || "",
    candidateId: output.candidateId || "",
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
    facebook_video_id: platformResults.facebook?.videoId || "",
    facebook_post_id: platformResults.facebook?.postId || "",
    facebook_url: platformResults.facebook?.url || "",
    youtube_video_id: platformResults.youtube?.videoId || "",
    youtube_url: platformResults.youtube?.url || "",
    tiktok_publish_id: platformResults.tiktok?.publishId || "",
    tiktok_mode: platformResults.tiktok?.mode || "",
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

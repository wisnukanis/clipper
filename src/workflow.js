import fs from "node:fs/promises";
import path from "node:path";
import { config, canPublish, shouldUploadToRemote } from "./config.js";
import { ensureProjectDirs, patchItem, saveGeneratedJson } from "./storage.js";
import { appendLog } from "./logger.js";
import { appendHistory, publishedCountToday } from "./history.js";
import { addVideo, createJobRecord, selectNextVideo, updateVideoStatus } from "./selector.js";
import { runClipper } from "./clipper-runner.js";
import { generateBumperSpec, generateCaption, generateFrameQuoteText, generateThumbnailText } from "./caption.js";
import { ensureCaptionSourceCredit } from "./caption-policy.js";
import { generateThumbnail, prependThumbnailIntro } from "./thumbnail.js";
import { fileExists, uploadHistoryFile, uploadJobFiles, validatePublicUrl } from "./uploader.js";
import { publishReel } from "./instagram.js";
import { prepareInstagramVideo } from "./instagram-video.js";
import { publishToFacebook } from "./facebook.js";
import { buildYoutubeMetadata, isYoutubeQuotaError, publishToYoutube } from "./youtube-publisher.js";
import { publishToTikTok } from "./tiktok.js";
import { publishToThreads } from "./threads.js";
import { todayDate } from "./job-id.js";
import { downloadStateFromRemote, uploadStateToRemote } from "./state-sync.js";
import { assertPreflightOk, printPreflightReport, runPreflight } from "./preflight.js";
import { discoverAndQueueVideos } from "./video-discovery.js";
import { applyVideoEffects } from "./video-effects.js";
import { appendQueueItem, applyDailyPlanToEnv, applySlotPlanToEnv, ensureQueueFiles, resolveDailyPlan } from "./daily-theme.js";
import {
  canUploadYoutubeToday,
  incrementYoutubeUploadCounter,
  markUsedSource,
  savePendingUpload,
  uploadPendingQueue
} from "./pending-uploads.js";

export async function runWorkflow(options = {}) {
  const context = { pendingUploadsFirst: null };
  const result = await runWorkflowInternal(options, context);
  if (context.pendingUploadsFirst) {
    result.pending_uploads_first = context.pendingUploadsFirst;
  }
  return result;
}

async function runWorkflowInternal(options = {}, context = {}) {
  await ensureProjectDirs();
  await ensureQueueFiles();
  const dailyPlan = resolveDailyPlan(options);
  applyDailyPlanToEnv(dailyPlan);
  options = {
    ...options,
    theme: options.theme && options.theme !== "auto" ? options.theme : dailyPlan.contentType,
    clipCount: Number(options.clipCount || dailyPlan.targetMax || process.env.CLIP_COUNT || 3),
    dailyPlan
  };
  const requestedSlot = String(options.slot || process.env.CLIPPER_SLOT || "all").toLowerCase();
  const mode = String(options.mode || "full").toLowerCase();

  const publishRequired = Boolean(options.publish && canPublish() && config.youtube.required);
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

  const remoteCheck = preflight.checks.find((check) => check.name === config.ftp.label);
  if (remoteCheck && !remoteCheck.ok && !remoteCheck.required) {
    const driver = config.uploadDriver;
    config.uploadDriver = "local";
    await appendLog("remote_upload_disabled", {
      driver,
      reason: remoteCheck.detail || "remote storage preflight failed"
    });
    console.warn(`${config.ftp.label} preflight warning; remote upload dinonaktifkan untuk run ini.`);
  }

  await downloadStateFromRemote().catch((error) => {
    console.warn(`State remote dilewati: ${error.message}`);
  });

  if (mode === "upload-pending") {
    const pending = await uploadPendingQueue({
      dryRun: options.dryRun === true || process.argv.includes("--dry-run"),
      limit: Number(process.env.YOUTUBE_DAILY_UPLOAD_LIMIT || 3) || 3
    });
    return dailyReport({
      status: "pending_upload_processed",
      dailyPlan,
      discoveryResult: null,
      clips: [],
      pending_uploads: pending
    });
  }

  if (options.publish && canPublish() && process.env.PROCESS_PENDING_UPLOADS_FIRST !== "false") {
    const pendingFirst = await uploadPendingQueue({
      dryRun: false,
      limit: Number(process.env.YOUTUBE_DAILY_UPLOAD_LIMIT || 3) || 3
    }).catch((error) => ({ error: error.message }));
    context.pendingUploadsFirst = pendingFirst;
    if (pendingFirst?.uploaded_count || pendingFirst?.pending_count || pendingFirst?.errors?.length || pendingFirst?.error) {
      await appendLog("pending_uploads_first", pendingFirst);
      console.log(
        `[UPLOAD] pending queue diproses: uploaded=${pendingFirst.uploaded_count || 0}, `
          + `pending=${pendingFirst.pending_count || 0}, errors=${pendingFirst.errors?.length || 0}`
      );
      await syncStateBestEffort("pending_uploads_first");
    }
  }

  let scheduledDailyLimit = 0;
  let scheduledPostedToday = 0;

  if (options.scheduled && options.publish) {
    scheduledDailyLimit = Math.max(0, Number(process.env.MAX_SCHEDULED_POSTS_PER_DAY || dailyPlan.targetMax) || 0);
    scheduledPostedToday = scheduledDailyLimit > 0 ? await publishedCountToday() : 0;
    if (scheduledDailyLimit > 0 && scheduledPostedToday >= scheduledDailyLimit) {
      await appendLog("scheduled_skip", {
        reason: "daily_limit_reached",
        posted_today: scheduledPostedToday,
        daily_limit: scheduledDailyLimit
      });
      return {
        status: "scheduled_skip",
        reason: "daily_limit_reached",
        posted_today: scheduledPostedToday,
        daily_limit: scheduledDailyLimit
      };
    }
  }

  const shouldUseMixedDailyLoop = !options.url
    && dailyPlan.mode === "mixed_daily"
    && (!options.scheduled || ["discover", "render"].includes(mode) || requestedSlot !== "all");
  if (shouldUseMixedDailyLoop) {
    return runMixedDailyWorkflow({
      options,
      dailyPlan,
      scheduledDailyLimit,
      scheduledPostedToday
    });
  }

  let discoveryResult = null;
  const keepVideoQueued = !options.url && !options.scheduled;

  if (options.url) {
    const selection = await createManualSelection(options);
    if (!selection) {
      return dailyReport(await noVideoSelectedResult({ discoveryResult, failedSelections: [] }));
    }
    const result = await processSelectedWorkflow({
      selection,
      options,
      scheduledDailyLimit,
      scheduledPostedToday,
      keepVideoQueued: false
    });
    return dailyReport({ ...result, dailyPlan, discoveryResult, failedSelections: [] });
  }

  let discoveryAttempted = false;
  let discoveredVideoIds = [];
  const failedSelections = [];
  const excludedVideoIds = new Set();
  const maxAttempts = queueFailoverLimit();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let selection = await selectQueuedWorkflowVideo({ options, excludedVideoIds });

    if (!selection && !discoveryAttempted) {
      discoveryAttempted = true;
      discoveryResult = await discoverQueuedVideos(options);
      if (options.mode === "discover") {
        return dailyReport({
          status: "discovered",
          dailyPlan,
          discoveryResult,
          clips: [],
          failedSelections
        });
      }
      discoveredVideoIds = (discoveryResult?.added || [])
        .map((video) => video.id)
        .filter(Boolean);

      if (discoveredVideoIds.length) {
        selection = await selectQueuedWorkflowVideo({
          options,
          excludedVideoIds,
          preferredVideoIds: discoveredVideoIds
        });
      }

      if (!selection) {
        selection = await selectQueuedWorkflowVideo({ options, excludedVideoIds });
      }

      if (!selection) {
        const fallbackTheme = dailyPlan.contentType === "podcast_lucu_hikmah" ? "inspiratif_hikmah" : "podcast_lucu_hikmah";
        const fallbackPlan = resolveDailyPlan({ ...options, theme: fallbackTheme });
        applyDailyPlanToEnv(fallbackPlan);
        discoveryResult = await discoverQueuedVideos({ ...options, dailyPlan: fallbackPlan, theme: fallbackTheme });
        discoveredVideoIds = (discoveryResult?.added || [])
          .map((video) => video.id)
          .filter(Boolean);
        selection = await selectQueuedWorkflowVideo({
          options: { ...options, theme: fallbackTheme, dailyPlan: fallbackPlan },
          excludedVideoIds,
          preferredVideoIds: discoveredVideoIds
        });
      }
    }

    if (!selection) {
      return dailyReport(await noVideoSelectedResult({ discoveryResult, failedSelections }));
    }

    try {
      const result = await processSelectedWorkflow({
        selection,
        options,
        scheduledDailyLimit,
        scheduledPostedToday,
        keepVideoQueued
      });
      if (failedSelections.length) {
        return dailyReport({
          ...result,
          dailyPlan,
          discoveryResult,
          skipped_failed_video_count: failedSelections.length,
          skipped_failed_videos: failedSelections
        });
      }
      return dailyReport({
        ...result,
        dailyPlan,
        discoveryResult,
        failedSelections
      });
    } catch (error) {
      if (isTerminalPublishFailure(error)) throw error;
      const failed = summarizeFailedSelection(selection, error);
      failedSelections.push(failed);
      excludedVideoIds.add(selection.video.id);
      const sourceBlocked = isYoutubeSourceBlocked(error);
      await appendLog("queue_video_failed_skip", {
        attempt,
        max_attempts: maxAttempts,
        terminal_source_block: sourceBlocked,
        ...failed
      });
      console.warn(`Video antrean gagal, dilewati: ${error.message}`);

      if (sourceBlocked) {
        await uploadStateToRemote().catch(() => {});
        await appendLog("queue_failover_stopped_source_blocked", {
          reason: "youtube_auth_required",
          failed_video_count: failedSelections.length,
          failed_videos: failedSelections
        });
        throw new Error(
          "YouTube memblokir download dari runner GitHub (bot-check/login). " +
          "Isi GitHub Secret YTDLP_COOKIES_TXT dengan cookies YouTube format Netscape, lalu jalankan ulang."
        );
      }
    }
  }

  await uploadStateToRemote().catch(() => {});
  await appendLog("queue_failover_exhausted", {
    failed_video_count: failedSelections.length,
    failed_videos: failedSelections
  });
  return {
    status: "queue_failed",
    failed_video_count: failedSelections.length,
    failed_videos: failedSelections
  };
}

async function createManualSelection(options) {
  const plan = options.dailyPlan || resolveDailyPlan(options);
  const video = await addVideo({
    url: options.url,
    theme: options.theme && options.theme !== "auto" ? options.theme : plan.contentType,
    content_type: plan.contentType,
    target_date: plan.dateWib || todayDate(),
    priority: 0,
    manual_range: options.range || "",
    quality_profile: options.qualityProfile || "standard",
    clip_count: Number(options.clipCount || process.env.CLIP_COUNT || 1),
    scene_mode: options.sceneMode || "podcast",
    subtitle_font: options.subtitleFont || "Segoe UI Semibold",
    subtitle_font_size: options.subtitleFontSize || 46,
    subtitle_margin_v: options.subtitleMarginV || 550,
    subtitle_margin_h: options.subtitleMarginH || 180,
    use_frame: options.useFrame,
    use_filter: options.useFilter,
    use_watermark: options.useWatermark,
    use_music: options.useMusic,
    force_reprocess: options.forceReprocess === true,
    notes: "Ditambahkan dari CLI/manual run"
  });
  return selectNextVideo({
    theme: video.theme,
    targetDate: todayDate(),
    preferredVideoIds: [video.id],
    forceReprocess: options.forceReprocess === true
  });
}

function queueFailoverLimit() {
  const configured = Number(process.env.QUEUE_FAILOVER_ATTEMPTS || process.env.MAX_SCHEDULED_POSTS_PER_DAY || 5);
  if (!Number.isFinite(configured) || configured <= 0) return 5;
  return Math.min(Math.floor(configured), 50);
}

function summarizeFailedSelection(selection, error) {
  return {
    video_id: selection?.video?.id || "",
    youtube_video_id: selection?.video?.youtube_video_id || "",
    url: selection?.video?.url || selection?.video?.source_url || "",
    error: error.message
  };
}

async function runMixedDailyWorkflow({ options, dailyPlan, scheduledDailyLimit, scheduledPostedToday }) {
  const slotPlans = Array.isArray(dailyPlan.slotPlans) ? dailyPlan.slotPlans : [];
  const clips = [];
  const discoveryResults = [];
  const failedSelections = [];
  const excludedVideoIds = new Set();

  if (!slotPlans.length) {
    return dailyReport({
      status: "no_slots",
      dailyPlan,
      discoveryResult: null,
      clips,
      failedSelections
    });
  }

  for (const slotPlan of slotPlans) {
    applySlotPlanToEnv(slotPlan, dailyPlan);
    const slotDailyPlan = {
      ...dailyPlan,
      contentType: slotPlan.content_type,
      dailyTheme: dailyPlan.dailyTheme || "mixed_daily",
      query: slotPlan.discover_query,
      dailyQuery: slotPlan.discover_query?.split("|")[0] || dailyPlan.dailyQuery || "",
      channelHandles: slotPlan.channel_handles,
      themePrompt: slotPlan.theme_prompt,
      hashtags: slotPlan.hashtags,
      publishSlotWib: slotPlan.slot_time_wib,
      activeSlot: slotPlan
    };

    if (!slotPlan.discover_query) {
      const error = `Query kosong untuk slot ${slotPlan.slot_index} (${slotPlan.content_type}).`;
      failedSelections.push({ slot_index: slotPlan.slot_index, error });
      await appendLog("slot_discovery_skipped", {
        slot_index: slotPlan.slot_index,
        slot_time_wib: slotPlan.slot_time_wib,
        slot_content_type: slotPlan.content_type,
        error
      });
      continue;
    }

    const discoveryResult = await discoverQueuedVideos({
      ...options,
      theme: slotPlan.content_type,
      dailyPlan: slotDailyPlan,
      slot: slotPlan.slot_index,
      clipCount: 1
    });
    discoveryResults.push({
      slot_index: slotPlan.slot_index,
      slot_time_wib: slotPlan.slot_time_wib,
      slot_content_type: slotPlan.content_type,
      ...summarizeDiscoveryForReport(discoveryResult)
    });

    if (options.mode === "discover") continue;

    const preferredVideoIds = (discoveryResult?.added || []).map((video) => video.id).filter(Boolean);
    let slotSucceeded = false;
    const maxSlotAttempts = queueFailoverLimit();

    for (let attempt = 1; attempt <= maxSlotAttempts; attempt += 1) {
      let selection = await selectQueuedWorkflowVideo({
        options: {
          ...options,
          theme: slotPlan.content_type,
          dailyPlan: slotDailyPlan,
          forceReprocess: options.forceReprocess
        },
        excludedVideoIds,
        preferredVideoIds
      });

      if (!selection) {
        const fallbackContentType = slotPlan.content_type === "podcast_lucu_hikmah" ? "inspiratif_hikmah" : "podcast_lucu_hikmah";
        selection = await selectQueuedWorkflowVideo({
          options: { ...options, theme: fallbackContentType, dailyPlan: { ...slotDailyPlan, contentType: fallbackContentType } },
          excludedVideoIds
        });
      }

      if (!selection) {
        if (attempt === 1) {
          failedSelections.push({
            slot_index: slotPlan.slot_index,
            slot_time_wib: slotPlan.slot_time_wib,
            slot_content_type: slotPlan.content_type,
            error: "Tidak ada kandidat slot yang lolos queue/fallback."
          });
        }
        break;
      }

      excludedVideoIds.add(selection.video.id);
      try {
        const result = await processSelectedWorkflow({
          selection,
          options: {
            ...options,
            theme: slotPlan.content_type,
            clipCount: 1,
            dailyPlan: slotDailyPlan,
            slotPlan
          },
          scheduledDailyLimit,
          scheduledPostedToday,
          keepVideoQueued: false
        });
        clips.push(...(result.clips || []).map((clip) => ({
          ...clip,
          slot_index: slotPlan.slot_index,
          slot_time_wib: slotPlan.slot_time_wib,
          slot_content_type: slotPlan.content_type
        })));
        slotSucceeded = true;
        break;
      } catch (error) {
        if (isTerminalPublishFailure(error)) throw error;
        const sourceBlocked = isYoutubeSourceBlocked(error);
        failedSelections.push({
          slot_index: slotPlan.slot_index,
          slot_time_wib: slotPlan.slot_time_wib,
          slot_content_type: slotPlan.content_type,
          attempt,
          video_id: selection.video.id,
          url: selection.video.url,
          terminal_source_block: sourceBlocked,
          error: error.message
        });
        await appendLog("slot_video_failed_skip", {
          slot_index: slotPlan.slot_index,
          slot_time_wib: slotPlan.slot_time_wib,
          slot_content_type: slotPlan.content_type,
          attempt,
          max_attempts: maxSlotAttempts,
          video_id: selection.video.id,
          url: selection.video.url,
          terminal_source_block: sourceBlocked,
          error: error.message
        });

        if (sourceBlocked) {
          await appendLog("mixed_daily_stopped_source_blocked", {
            reason: "youtube_auth_required",
            failed_video_count: failedSelections.length,
            failed_videos: failedSelections
          });
          throw new Error(
            "YouTube memblokir download dari runner GitHub (bot-check/login). " +
            "Kandidat ada, tapi tidak bisa diproses dari IP runner ini. " +
            "Jika YTDLP_COOKIES_DISABLED=1, cookies invalid sudah dilepas dan fallback PO/no-cookie tetap ditolak. " +
            "Solusi tersisa: export ulang cookies YouTube dari private/incognito session yang tidak dibuka lagi, " +
            "atau gunakan sumber video/non-runner yang tidak kena bot-check."
          );
        }
      }
    }

    if (!slotSucceeded) {
      await appendLog("slot_failed_no_clip", {
        slot_index: slotPlan.slot_index,
        slot_time_wib: slotPlan.slot_time_wib,
        slot_content_type: slotPlan.content_type,
        attempted_video_count: failedSelections.filter((item) => item.slot_index === slotPlan.slot_index).length
      });
    }
  }

  await uploadStateToRemote().catch(() => {});
  const successfulClipCount = clips.filter((clip) => clip.ok).length;
  const failedClipCount = failedSelections.length;
  if (options.mode !== "discover" && successfulClipCount <= 0) {
    const sourceBlocked = failedSelections.some((item) => isYoutubeSourceBlocked(item.error));
    await appendLog("mixed_daily_no_successful_clip", {
      failed_clip_count: failedClipCount,
      terminal_source_block: sourceBlocked,
      failedSelections
    });
    if (sourceBlocked) {
      throw new Error(
        "Tidak ada video final karena YouTube memblokir semua download dari runner GitHub (bot-check/login). " +
        "Ini bukan kandidat kosong. Jika cookie canary menonaktifkan cookies, fallback PO/no-cookie juga ditolak; " +
        "butuh cookies YouTube yang benar-benar valid atau sumber video yang tidak bergantung pada download YouTube dari GitHub runner."
      );
    }
    throw new Error(
      `Tidak ada video final yang berhasil dibuat. Semua kandidat gagal (${failedClipCount} failure). ` +
      "Cek failedSelections di log untuk URL dan error detail."
    );
  }
  const youtubePublishedCount = clips.filter((clip) => Boolean(clip.youtube_video_id)).length;
  return dailyReport({
    status: options.mode === "discover"
      ? "discovered"
      : options.publish && canPublish()
        ? youtubePublishedCount > 0 ? "mixed_daily_published" : "mixed_daily_publish_failed"
        : "mixed_daily_rendered",
    dailyPlan,
    discoveryResult: aggregateDiscoveryResults(discoveryResults),
    discoveryResults,
    clips,
    failedSelections,
    successful_clip_count: successfulClipCount,
    failed_clip_count: failedClipCount,
    published_clip_count: youtubePublishedCount
  });
}

function isYoutubeSourceBlocked(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return [
    "youtube_auth_required",
    "sign in to confirm",
    "not a bot",
    "use --cookies",
    "cookies-from-browser",
    "bot-check"
  ].some((pattern) => message.includes(pattern));
}

function isTerminalPublishFailure(error) {
  return ["YOUTUBE_PUBLISH_REQUIRED", "YOUTUBE_PUBLISH_DEFERRED"].includes(String(error?.code || ""));
}

async function syncStateBestEffort(context) {
  try {
    return await uploadStateToRemote();
  } catch (error) {
    console.warn(`State sync gagal setelah ${context}: ${error.message}`);
    await appendLog("state_sync_failed", { context, error: error.message });
    return { error: error.message };
  }
}

function requiredPublishError(final, clipResults) {
  const youtubeErrors = clipResults
    .map((item) => item?.platformResults?.errors?.youtube || item?.error || "")
    .filter(Boolean);
  const deferred = final.publishStatus === "queued";
  const detail = youtubeErrors.length ? ` Detail: ${[...new Set(youtubeErrors)].join("; ")}` : "";
  const error = new Error(
    `${deferred ? "YOUTUBE_PUBLISH_DEFERRED" : "YOUTUBE_PUBLISH_REQUIRED"}: `
      + `render selesai tetapi tidak ada youtube_video_id (status=${final.publishStatus}).${detail}`
  );
  error.code = deferred ? "YOUTUBE_PUBLISH_DEFERRED" : "YOUTUBE_PUBLISH_REQUIRED";
  return error;
}

async function selectQueuedWorkflowVideo({ options, excludedVideoIds, preferredVideoIds = [] }) {
  return selectNextVideo({
    theme: options.theme || config.defaultTheme,
    preferredVideoIds,
    excludeVideoIds: [...excludedVideoIds],
    forceReprocess: options.forceReprocess === true,
    randomize: true
  });
}

async function discoverQueuedVideos(options) {
  const plan = options.dailyPlan || resolveDailyPlan(options);
  const activeSlot = plan.activeSlot || null;
  try {
    const discoveryResult = await discoverAndQueueVideos({
      theme: plan.contentType || options.theme || config.defaultTheme,
      contentType: plan.contentType,
      targetDate: plan.dateWib || todayDate(),
      ignoreDailyQueueLimit: !options.scheduled,
      queries: splitList(plan.query),
      channelHandles: splitList(plan.channelHandles),
      publishSlots: activeSlot ? [activeSlot.slot_time_wib] : plan.slots,
      slotIndex: activeSlot?.slot_index || options.slot || "",
      slotTimeWib: activeSlot?.slot_time_wib || "",
      slotContentType: activeSlot?.slot_content_type || plan.contentType || ""
    });
    await appendLog("discovery_result", {
      skipped: Boolean(discoveryResult?.skipped),
      reason: discoveryResult?.reason || "",
      added_count: discoveryResult?.added?.length || 0,
      expired_count: discoveryResult?.expired_count || 0,
      daily_queue_count: discoveryResult?.daily_queue_count || 0,
      daily_queue_limit: discoveryResult?.daily_queue_limit || 0,
      added_video_ids: (discoveryResult?.added || []).map((video) => video.id)
    });
    return discoveryResult;
  } catch (error) {
    console.warn(`Auto discovery gagal, fallback ke antrean lama: ${error.message}`);
    await appendLog("discovery_failed", { error: error.message });
    return null;
  }
}

function summarizeDiscoveryForReport(discoveryResult = {}) {
  return {
    skipped: Boolean(discoveryResult?.skipped),
    reason: discoveryResult?.reason || "",
    query: discoveryResult?.query || "",
    selected_channel_handles: discoveryResult?.selected_channel_handles || [],
    found_count: discoveryResult?.found_count || 0,
    channel_found_count: discoveryResult?.channel_found_count || 0,
    query_found_count: discoveryResult?.query_found_count || 0,
    trending_found_count: discoveryResult?.trending_found_count || 0,
    passed_filter_count: discoveryResult?.passed_filter_count || 0,
    added_count: discoveryResult?.added?.length || 0
  };
}

function aggregateDiscoveryResults(results = []) {
  return {
    per_slot: results,
    found_count: sumBy(results, "found_count"),
    channel_found_count: sumBy(results, "channel_found_count"),
    query_found_count: sumBy(results, "query_found_count"),
    trending_found_count: sumBy(results, "trending_found_count"),
    passed_filter_count: sumBy(results, "passed_filter_count"),
    added: [],
    added_count: sumBy(results, "added_count")
  };
}

function sumBy(items, key) {
  return items.reduce((sum, item) => sum + (Number(item?.[key]) || 0), 0);
}

async function noVideoSelectedResult({ discoveryResult, failedSelections }) {
  await appendLog("no_video_selected", {
    discovery_added_count: discoveryResult?.added?.length || 0,
    discovery_skipped: Boolean(discoveryResult?.skipped),
    discovery_reason: discoveryResult?.reason || "",
    discovery_expired_count: discoveryResult?.expired_count || 0,
    daily_queue_count: discoveryResult?.daily_queue_count || 0,
    daily_queue_limit: discoveryResult?.daily_queue_limit || 0,
    skipped_failed_video_count: failedSelections.length
  });
  return {
    status: "no_video_selected",
    discovery_added_count: discoveryResult?.added?.length || 0,
    discovery_skipped: Boolean(discoveryResult?.skipped),
    discovery_reason: discoveryResult?.reason || "",
    discovery_expired_count: discoveryResult?.expired_count || 0,
    daily_queue_count: discoveryResult?.daily_queue_count || 0,
    daily_queue_limit: discoveryResult?.daily_queue_limit || 0,
    skipped_failed_video_count: failedSelections.length,
    skipped_failed_videos: failedSelections
  };
}

async function processSelectedWorkflow({ selection, options, scheduledDailyLimit, scheduledPostedToday, keepVideoQueued = false }) {
  const { video, theme, prompt } = selection;
  const dailyPlan = options.dailyPlan || resolveDailyPlan({ theme: video.theme });
  const job = await createJobRecord(selection, { keepVideoStatus: keepVideoQueued });
  const maybeUpdateVideoStatus = async (status, patch) => {
    if (keepVideoQueued) return;
    await updateVideoStatus(video.id, status, patch);
  };
  await appendLog("job_created", {
    job_id: job.job_id,
    video_id: video.id,
    url: video.url,
    keep_video_queued: keepVideoQueued
  });

  try {
    await updateJob(job.job_id, {
      status: "clipper_processing",
      clipper_status: "processing"
    });
    await maybeUpdateVideoStatus("clipper_processing");

    const clipperResult = await runClipper({
      video,
      job,
      onLog: (message) => {
        if (message) console.log(message);
      }
    });

    const allOutputs = clipperResult.outputs.filter((output) => output?.finalAbsPath);
    if (!allOutputs.length) {
      throw new Error("Clipper tidak menghasilkan file MP4 final.");
    }

    const remainingScheduledSlots = options.scheduled && options.publish && scheduledDailyLimit > 0
      ? Math.min(1, Math.max(0, scheduledDailyLimit - scheduledPostedToday))
      : allOutputs.length;
    const outputs = allOutputs.slice(0, remainingScheduledSlots);

    if (allOutputs.length > outputs.length) {
      await appendLog("scheduled_clip_cap", {
        job_id: job.job_id,
        generated_clip_count: allOutputs.length,
        processed_clip_count: outputs.length,
        posted_today: scheduledPostedToday,
        daily_limit: scheduledDailyLimit
      });
      console.log(
        `Scheduled daily cap: proses ${outputs.length}/${allOutputs.length} clip ` +
          `(posted today ${scheduledPostedToday}/${scheduledDailyLimit}).`
      );
    }

    if (!outputs.length) throw new Error("Tidak ada slot publish tersisa untuk jadwal hari ini.");

    for (const output of outputs) {
      if (!await fileExists(output.finalAbsPath)) {
        throw new Error(`Clipper output tidak ditemukan: ${output.finalAbsPath}`);
      }
    }

    await updateJob(job.job_id, {
      status: "clipper_done",
      clipper_status: "done",
      source_title: outputs[0]?.title || "",
      final_video_path: outputs[0]?.finalAbsPath || "",
      transcript_path: outputs[0]?.transcriptReviewAbsPath || outputs[0]?.subtitleAbsPath || "",
      clip_total: outputs.length
    });

    const clipResults = [];
    for (const [index, output] of outputs.entries()) {
      await updateJob(job.job_id, {
        status: "clip_processing",
        current_clip_index: index + 1,
        clip_total: outputs.length
      });

      try {
        const result = await processClipOutput({
          job,
          video,
          theme,
          prompt,
          output,
          clipperResult,
          index,
          total: outputs.length,
          options: {
            ...options,
            dailyPlan,
            publishSlotWib: dailyPlan.activeSlot?.slot_time_wib || dailyPlan.slots[index] || dailyPlan.publishSlotWib || "",
            publishDateWib: dailyPlan.dateWib
          }
        });
        clipResults.push(result);
      } catch (error) {
        const failed = {
          ok: false,
          clipIndex: index + 1,
          clipJobId: buildClipStorageJob(job, index, outputs.length).job_id,
          error: error.message
        };
        clipResults.push(failed);
        await appendLog("clip_failed", {
          job_id: job.job_id,
          clip_index: index + 1,
          error: error.message
        });
        console.warn(`Clip ${index + 1}/${outputs.length} gagal, lanjut clip berikutnya: ${error.message}`);
      }

      await updateJob(job.job_id, {
        clip_results: clipResults.map(summarizeClipResult)
      });
    }

    if (!clipResults.some((item) => item.ok)) {
      throw new Error(clipResults.map((item) => item.error).filter(Boolean).join("; ") || "Semua clip gagal diproses.");
    }

    const final = finalStatusFromClipResults(clipResults, Boolean(options.publish && canPublish()));
    const firstSuccess = clipResults.find((item) => item.ok);
    const lastPlatformResults = [...clipResults].reverse().find((item) => item.platformResults)?.platformResults || {};

    await updateJob(job.job_id, {
      status: final.status,
      publish_status: final.publishStatus,
      successful_clip_count: final.successfulClips,
      failed_clip_count: final.failedClips,
      published_clip_count: final.publishedClips,
      clip_results: clipResults.map(summarizeClipResult),
      final_video_path: firstSuccess?.output?.finalAbsPath || "",
      original_final_video_path: firstSuccess?.output?.originalFinalAbsPath || "",
      video_effects: firstSuccess?.output?.videoEffects || null,
      background_music: firstSuccess?.output?.backgroundMusic || null,
      thumbnail_intro: firstSuccess?.output?.thumbnailIntro || { applied: false },
      frame_quote_text: firstSuccess?.output?.frameQuoteText || "",
      public_video_url: firstSuccess?.upload?.videoUrl || "",
      public_thumbnail_url: firstSuccess?.upload?.thumbnailUrl || "",
      public_metadata_url: firstSuccess?.upload?.metadataUrl || "",
      published_at: final.publishedClips > 0 ? new Date().toISOString() : ""
    });

    await maybeUpdateVideoStatus(final.videoStatus, {
      published_youtube_video_id: lastPlatformResults.youtube?.videoId || "",
      published_youtube_url: lastPlatformResults.youtube?.url || "",
      instagram_media_id: lastPlatformResults.instagram?.mediaId || "",
      facebook_video_id: lastPlatformResults.facebook?.videoId || "",
      facebook_url: lastPlatformResults.facebook?.url || "",
      tiktok_publish_id: lastPlatformResults.tiktok?.publishId || "",
      threads_media_id: lastPlatformResults.threads?.mediaId || "",
      threads_url: lastPlatformResults.threads?.url || "",
      error_message: final.errorMessage
    });

    await uploadHistoryIfPossible();
    await uploadStateToRemote().catch(() => {});
    await appendLog(final.event, {
      job_id: job.job_id,
      clip_total: outputs.length,
      successful_clip_count: final.successfulClips,
      failed_clip_count: final.failedClips,
      published_clip_count: final.publishedClips
    });

    if (options.publish && canPublish() && config.youtube.required && final.publishedClips <= 0) {
      throw requiredPublishError(final, clipResults);
    }

    return {
      status: final.publishStatus,
      job_id: job.job_id,
      clip_total: outputs.length,
      successful_clip_count: final.successfulClips,
      failed_clip_count: final.failedClips,
      published_clip_count: final.publishedClips,
      clips: clipResults.map(summarizeClipResult)
    };
  } catch (error) {
    if (isTerminalPublishFailure(error)) {
      await updateJob(job.job_id, { error_message: error.message });
      await syncStateBestEffort("youtube_publish_required_failed");
      await appendLog("youtube_publish_required_failed", { job_id: job.job_id, error: error.message });
      throw error;
    }
    await updateJob(job.job_id, {
      status: "failed",
      error_message: error.message
    });
    await maybeUpdateVideoStatus("failed", { error_message: error.message });
    await uploadStateToRemote().catch(() => {});
    await appendLog("workflow_failed", { job_id: job.job_id, error: error.message });
    throw error;
  }
}

async function processClipOutput({ job, video, theme, prompt, output, clipperResult, index, total, options }) {
  const clipIndex = index + 1;
  const storageJob = buildClipStorageJob(job, index, total);
  const dailyPlan = options.dailyPlan || resolveDailyPlan({ theme: video.content_type || video.theme || theme?.name });
  const publishSlotWib = options.publishSlotWib || dailyPlan.publishSlotWib || "";
  const publishDateWib = options.publishDateWib || dailyPlan.dateWib || todayDate();
  const aiProvider = options.aiProvider || config.ai.provider || "auto";
  const thumbnailText = await generateThumbnailText({ job: storageJob, output, promptTemplate: prompt, aiProvider });
  const frameQuoteText = await generateFrameQuoteText({ job: storageJob, output, promptTemplate: prompt, aiProvider });
  const openingHook = buildOpeningHook({ output, thumbnailText });
  output = { ...output, thumbnailText, openingHook, frameQuoteText };
  const bumper = await generateBumperSpec({ job: storageJob, output, promptTemplate: prompt, aiProvider });
  output = { ...output, bumper };

  const effectsResult = await applyVideoEffects({
    job: storageJob,
    video,
    output,
    options: {
      ...options,
      lowerThirdText: frameQuoteText
    }
  });
  output = { ...effectsResult.output, videoEffects: effectsResult.effects };

  await updateJob(job.job_id, {
    final_video_path: output.finalAbsPath,
    original_final_video_path: output.originalFinalAbsPath || "",
    video_effects: effectsResult.effects,
    frame_quote_text: frameQuoteText
  });

  const generatedCaption = await generateCaption({
    job: storageJob,
    output,
    promptTemplate: prompt,
    clipperRoot: clipperResult.clipperRoot,
    aiProvider
  });
  const caption = ensureCaptionSourceCredit(generatedCaption, {
    sourceUrl: video.url || video.source_url,
    sourceTitle: video.source_title || output.title || job.source_title
  });
  await updateJob(job.job_id, {
    caption_status: "done",
    caption,
    current_clip_index: clipIndex
  });

  const thumbnail = await generateThumbnail({
    job: storageJob,
    videoPath: output.finalAbsPath,
    text: thumbnailText
  });
  const thumbnailIntro = await prependThumbnailIntro({
    job: storageJob,
    videoPath: output.finalAbsPath,
    thumbnailPath: thumbnail.path,
    bumper
  }).catch((error) => {
    console.warn(`Intro thumbnail dilewati: ${error.message}`);
    return null;
  });
  if (thumbnailIntro?.path) {
    output = {
      ...output,
      finalAbsPath: thumbnailIntro.path,
      thumbnailIntro: {
        applied: true,
        durationSeconds: thumbnailIntro.durationSeconds,
        transitionEnabled: thumbnailIntro.transitionEnabled,
        transitionSeconds: thumbnailIntro.transitionSeconds,
        transitionType: thumbnailIntro.transitionType,
        trimmedMainSeconds: thumbnailIntro.trimmedMainSeconds,
        introPath: thumbnailIntro.introPath,
        bumperApplied: thumbnailIntro.bumperApplied,
        bumperPath: thumbnailIntro.bumperPath,
        bumperDurationSeconds: thumbnailIntro.bumperDurationSeconds,
        bumper
      }
    };
  }
  await updateJob(job.job_id, {
    thumbnail_status: "done",
    thumbnail_path: thumbnail.path,
    thumbnail_text: thumbnail.text,
    final_video_path: output.finalAbsPath,
    thumbnail_intro: output.thumbnailIntro || { applied: false }
  });

  const metadata = buildMetadata({
    job: storageJob,
    video,
    theme,
    prompt,
    output,
    clipperResult,
    caption,
    thumbnail,
    clipIndex,
    clipTotal: total,
    videoEffects: effectsResult.effects,
    dailyPlan,
    publishSlotWib,
    publishDateWib,
    publishStatus: options.publish && canPublish() ? "pending_publish" : "rendered_waiting_review"
  });
  const metadataPath = await saveGeneratedJson("metadata", `${storageJob.job_id}.json`, metadata);

  let upload = {
    videoUrl: "",
    thumbnailUrl: "",
    metadataUrl: ""
  };
  if (shouldUploadToRemote()) {
    try {
      upload = await uploadJobFiles({
        job: storageJob,
        videoPath: output.finalAbsPath,
        thumbnailPath: thumbnail.path,
        metadataPath
      });
      const videoPublicOk = await validatePublicUrl(upload.videoUrl);
      if (!videoPublicOk) throw new Error(`Public video URL belum valid: ${upload.videoUrl}`);
    } catch (error) {
      if (config.remoteUploadRequired || !config.youtube.enabled) throw error;
      await appendLog("remote_upload_failed_skip", {
        job_id: storageJob.job_id,
        error: error.message
      });
      console.warn(`${config.ftp.label} upload gagal; lanjut YouTube tanpa public URL: ${error.message}`);
      upload = {
        videoUrl: "",
        thumbnailUrl: "",
        metadataUrl: ""
      };
    }
  }
  console.log(`Public video URL valid clip ${clipIndex}/${total}:`, upload.videoUrl);

  await updateJob(job.job_id, {
    status: options.publish ? "ready_to_publish" : "rendered_waiting_review",
    publish_status: options.publish ? "ready" : "rendered_waiting_review",
    metadata_path: metadataPath,
    public_video_url: upload.videoUrl,
    public_thumbnail_url: upload.thumbnailUrl,
    public_metadata_url: upload.metadataUrl
  });

  const publishBlockReason = publishValidationBlockReason(metadata);
  if (options.publish && canPublish() && publishBlockReason) {
    const status = "skipped";
    await updateJob(job.job_id, {
      status,
      publish_status: "skipped",
      error_message: publishBlockReason
    });
    await appendHistoryEntry({ job: storageJob, video, caption, output, upload, status, clipIndex, clipTotal: total });
    await appendRenderedQueueItem({
      dailyPlan,
      video,
      output,
      metadataPath,
      publishSlotWib,
      publishDateWib,
      status,
      metadata: { ...metadata, publish_status: status, risk_notes: publishBlockReason }
    });
    return {
      ok: false,
      clipIndex,
      clipJobId: storageJob.job_id,
      output,
      upload,
      caption,
      platformResults: null,
      primaryPublished: false,
      publishStatus: status,
      error: publishBlockReason,
      metadataPath,
      metadata: { ...metadata, publish_status: status, risk_notes: publishBlockReason }
    };
  }

  if (options.publish && canPublish()) {
    const platformResults = await publishPlatforms({
      job,
      video,
      output,
      caption,
      upload,
      thumbnail,
      metadata
    });
    const youtubePrimary = config.youtube.enabled;
    const primaryPublished = youtubePrimary ? Boolean(platformResults.youtube) : platformResults.hasAnySuccess;
    const youtubeQuotaExceeded = Boolean(platformResults.quotaExceeded?.youtube);
    const youtubeDeferred = Boolean(platformResults.deferred?.youtube);
    const deferredByQuota = (youtubeQuotaExceeded || youtubeDeferred) && !primaryPublished;
    const publishStatus = primaryPublished
      ? platformResults.hasErrors ? "published_with_warnings" : "published"
      : deferredByQuota ? "queued" : "publish_failed";
    const now = new Date().toISOString();

    await updateJob(job.job_id, {
      status: primaryPublished ? "published" : deferredByQuota ? "queued" : "ready_to_publish",
      publish_status: publishStatus,
      instagram_status: platformResults.instagram ? "published" : deferredByQuota ? "queued" : config.instagram.enabled ? "failed" : "disabled",
      instagram_media_id: platformResults.instagram?.mediaId || "",
      instagram_error: platformResults.errors.instagram || "",
      facebook_status: platformResults.facebook ? "published" : deferredByQuota ? "queued" : config.facebook.enabled ? "failed" : "disabled",
      facebook_video_id: platformResults.facebook?.videoId || "",
      facebook_post_id: platformResults.facebook?.postId || "",
      facebook_url: platformResults.facebook?.url || "",
      facebook_error: platformResults.errors.facebook || "",
      tiktok_status: platformResults.tiktok ? "submitted" : deferredByQuota ? "queued" : config.tiktok.enabled ? "failed" : "disabled",
      tiktok_publish_id: platformResults.tiktok?.publishId || "",
      tiktok_mode: platformResults.tiktok?.mode || "",
      tiktok_error: platformResults.errors.tiktok || "",
      threads_status: platformResults.threads ? "published" : deferredByQuota ? "queued" : config.threads.enabled ? "failed" : "disabled",
      threads_media_id: platformResults.threads?.mediaId || "",
      threads_url: platformResults.threads?.url || "",
      threads_error: platformResults.errors.threads || "",
      youtube_status: platformResults.youtube ? "published" : config.youtube.enabled ? youtubeQuotaExceeded ? "quota_exceeded" : "failed" : "disabled",
      youtube_video_id: platformResults.youtube?.videoId || "",
      youtube_url: platformResults.youtube?.url || "",
      youtube_error: platformResults.errors.youtube || "",
      youtube_custom_thumbnail: platformResults.youtube?.customThumbnail === true,
      youtube_thumbnail_error: platformResults.youtube?.thumbnailError || "",
      youtube_published_at: platformResults.youtube ? now : "",
      published_at: primaryPublished ? now : ""
    });

    await appendHistoryEntry({
      job: storageJob,
      video,
      caption,
      output,
      upload,
      platformResults,
      status: primaryPublished ? "published" : publishStatus,
      clipIndex,
      clipTotal: total
    });
    await appendRenderedQueueItem({
      dailyPlan,
      video,
      output,
      metadataPath,
      publishSlotWib,
      publishDateWib,
      status: primaryPublished ? "published" : publishStatus,
      metadata
    });
    if (primaryPublished) {
      await markUsedSource({ video, output, platformResults, metadata }).catch(() => {});
    }

    return {
      ok: true,
      clipIndex,
      clipJobId: storageJob.job_id,
      output,
      upload,
      caption,
      platformResults,
      primaryPublished,
      publishStatus,
      metadataPath,
      metadata
    };
  }

  const status = options.publish ? "dry_run" : "rendered_waiting_review";
  await appendHistoryEntry({ job: storageJob, video, caption, output, upload, status, clipIndex, clipTotal: total });
  await appendRenderedQueueItem({
    dailyPlan,
    video,
    output,
    metadataPath,
    publishSlotWib,
    publishDateWib,
    status,
    metadata
  });
  return {
    ok: true,
    clipIndex,
    clipJobId: storageJob.job_id,
    output,
    upload,
    caption,
    platformResults: null,
    primaryPublished: false,
    publishStatus: status,
    metadataPath,
    metadata
  };
}

async function appendRenderedQueueItem({
  dailyPlan,
  video,
  output,
  metadataPath,
  publishSlotWib,
  publishDateWib,
  status,
  metadata
}) {
  const contentType = dailyPlan.contentType || video.content_type || video.theme || "inspiratif_hikmah";
  const confidenceScore = Number(metadata?.confidence_score ?? video.confidence_score ?? 1);
  const minConfidence = Number(process.env.MIN_CLASSIFICATION_CONFIDENCE || 0.6);
  const queueName = confidenceScore < minConfidence && process.env.LOW_CONFIDENCE_TO_REVIEW !== "false" ? "review" : contentType;
  await appendQueueItem(queueName, {
    source_video_id: video.youtube_video_id || "",
    source_url: video.url || video.source_url || "",
    source_title: video.source_title || output.title || "",
    source_channel: video.source_channel || video.channel_title || output.channel || "",
    source_published_at: video.published_at_source || "",
    source_duration_seconds: Number(video.source_duration_seconds || video.discovery_duration || 0),
    source_views: Number(video.discovery_views || 0),
    source_views_per_hour: Number(video.discovery_views_per_hour || 0),
    content_type: contentType,
    slot_index: Number(dailyPlan.activeSlot?.slot_index || video.slot_index || 0),
    slot_time_wib: dailyPlan.activeSlot?.slot_time_wib || video.slot_time_wib || "",
    slot_content_type: dailyPlan.activeSlot?.slot_content_type || video.slot_content_type || contentType,
    discovered_query: video.discovered_query || dailyPlan.query || "",
    daily_theme: dailyPlan.dailyTheme || contentType,
    selected_channel_handles: Array.isArray(video.selected_channel_handles) && video.selected_channel_handles.length
      ? video.selected_channel_handles
      : splitList(dailyPlan.channelHandles || ""),
    discovery_source: video.discovery_source || "",
    discovered_at: video.discovered_at || video.created_at || "",
    filter_passed: true,
    filter_reason: "",
    dedup_status: "new",
    classification_reason: metadata?.classification_reason || video.classification_reason || "",
    confidence_score: confidenceScore,
    candidate_clips: output.analysisCandidates || [],
    selected_clip: {
      start_time: output.start,
      end_time: output.end,
      duration: output.duration,
      title_best: metadata?.title_best || output.bestTitle || output.title || "",
      final_score: metadata?.final_score || output.finalScore || 0,
      concrete_hook_score: metadata?.concrete_hook_score || output.concreteHookScore || 0,
      thumbnail_readability_score: metadata?.thumbnail_readability_score || output.thumbnailReadabilityScore || 0,
      face_expression_score: metadata?.face_expression_score || output.faceExpressionScore || 0,
      reason_hook_selected: metadata?.reason_hook_selected || output.reasonHookSelected || ""
    },
    output_file: output.finalAbsPath || "",
    metadata_file: metadataPath || "",
    publish_slot_wib: publishSlotWib || "",
    publish_date_wib: publishDateWib || dailyPlan.dateWib || "",
    publish_status: status,
    error: "",
    status
  });
}

function buildClipStorageJob(job, index, total) {
  if (total <= 1) return job;
  return {
    ...job,
    job_id: `${job.job_id}-clip-${String(index + 1).padStart(2, "0")}`
  };
}

function summarizeClipResult(result) {
  return {
    ok: Boolean(result.ok),
    clip_index: result.clipIndex,
    clip_job_id: result.clipJobId,
    status: result.publishStatus || (result.ok ? "ready" : "failed"),
    content_type: result.metadata?.content_type || "",
    title_best: result.metadata?.title_best || result.metadata?.best_title || "",
    opening_hook: result.metadata?.opening_hook || "",
    cover_hook: result.metadata?.cover_hook || "",
    publish_slot_wib: result.metadata?.publish_slot_wib || "",
    final_score: result.metadata?.final_score || result.metadata?.scoring?.final_score || 0,
    context_safety_score: result.metadata?.context_safety_score || 0,
    concrete_hook_score: result.metadata?.concrete_hook_score || 0,
    thumbnail_readability_score: result.metadata?.thumbnail_readability_score || 0,
    face_expression_score: result.metadata?.face_expression_score || 0,
    confidence_score: result.metadata?.confidence_score || 0,
    candidate_clip_count: Array.isArray(result.metadata?.clip_candidates) ? result.metadata.clip_candidates.length : 0,
    error: result.error || "",
    public_video_url: result.upload?.videoUrl || "",
    public_thumbnail_url: result.upload?.thumbnailUrl || "",
    youtube_video_id: result.platformResults?.youtube?.videoId || "",
    youtube_url: result.platformResults?.youtube?.url || "",
    instagram_media_id: result.platformResults?.instagram?.mediaId || "",
    facebook_video_id: result.platformResults?.facebook?.videoId || "",
    tiktok_publish_id: result.platformResults?.tiktok?.publishId || "",
    threads_media_id: result.platformResults?.threads?.mediaId || "",
    final_video_path: result.output?.finalAbsPath || "",
    original_final_video_path: result.output?.originalFinalAbsPath || "",
    metadata_path: result.metadataPath || result.metadata?.metadata_file || "",
    video_effects: result.output?.videoEffects || null,
    background_music: result.output?.backgroundMusic || null,
    thumbnail_intro: result.output?.thumbnailIntro || { applied: false },
    frame_quote_text: result.output?.frameQuoteText || "",
    caption: result.caption || "",
    youtube_error: result.platformResults?.errors?.youtube || ""
  };
}

function finalStatusFromClipResults(clipResults, publishEnabled) {
  const successfulClips = clipResults.filter((item) => item.ok).length;
  const failedClips = clipResults.filter((item) => !item.ok).length;
  const publishedClips = clipResults.filter((item) => item.primaryPublished).length;
  const hasPlatformErrors = clipResults.some((item) => item.platformResults?.hasErrors);
  const hasYoutubeQuotaExceeded = clipResults.some((item) => item.platformResults?.quotaExceeded?.youtube);
  const total = clipResults.length;

  if (!publishEnabled) {
    return {
      status: failedClips ? "partial_rendered_waiting_review" : "rendered_waiting_review",
      publishStatus: failedClips ? "partial_rendered_waiting_review" : "rendered_waiting_review",
      videoStatus: failedClips ? "partial_rendered_waiting_review" : "rendered_waiting_review",
      event: failedClips ? "partial_rendered_waiting_review" : "rendered_waiting_review",
      successfulClips,
      failedClips,
      publishedClips,
      errorMessage: failedClips ? `${failedClips}/${total} clip gagal diproses.` : ""
    };
  }

  if (publishedClips === total && !hasPlatformErrors) {
    return {
      status: "published",
      publishStatus: "published",
      videoStatus: "published",
      event: "published",
      successfulClips,
      failedClips,
      publishedClips,
      errorMessage: ""
    };
  }

  if (publishedClips > 0) {
    return {
      status: "published_partial",
      publishStatus: hasPlatformErrors || failedClips ? "published_with_warnings" : "published_partial",
      videoStatus: "published_partial",
      event: "published_partial",
      successfulClips,
      failedClips,
      publishedClips,
      errorMessage: `${publishedClips}/${total} clip berhasil publish.`
    };
  }

  if (hasYoutubeQuotaExceeded) {
    return {
      status: "queued",
      publishStatus: "queued",
      videoStatus: "queued",
      event: "youtube_quota_deferred",
      successfulClips,
      failedClips,
      publishedClips,
      errorMessage: "Quota YouTube habis; video dikembalikan ke queue untuk jadwal berikutnya."
    };
  }

  return {
    status: "ready_to_publish",
    publishStatus: "publish_failed",
    videoStatus: "ready_to_publish",
    event: "publish_failed",
    successfulClips,
    failedClips,
    publishedClips,
    errorMessage: "Publish platform gagal; siap retry."
  };
}

async function updateJob(jobId, patch) {
  return patchItem("jobs", jobId, patch);
}

async function publishPlatforms({ job, video, output, caption, upload, thumbnail, metadata }) {
  const publishCaption = ensureCaptionSourceCredit(caption, {
    sourceUrl: job.source_url,
    sourceTitle: job.source_title || output.title
  });
  const platformResults = {
    instagram: null,
    facebook: null,
    tiktok: null,
    youtube: null,
    threads: null,
    errors: {},
    quotaExceeded: {},
    deferred: {},
    hasAnySuccess: false,
    hasErrors: false
  };

  if (config.youtube.enabled) {
    platformResults.youtube = await publishPlatform("youtube", platformResults, job.job_id, async () => {
      await updateJob(job.job_id, { youtube_status: "processing", youtube_error: "" });
      const youtubeMetadata = buildYoutubeMetadata({ job, output, caption: publishCaption });
      if (!await canUploadYoutubeToday()) {
        await savePendingUpload({
          jobId: job.job_id,
          videoPath: output.finalAbsPath,
          videoUrl: upload.videoUrl,
          thumbnailPath: thumbnail?.path || "",
          thumbnailUrl: upload.thumbnailUrl,
          metadata: { ...metadata, ...youtubeMetadata },
          reason: "PENDING_DAILY_LIMIT"
        });
        const error = new Error("YOUTUBE_DAILY_UPLOAD_LIMIT tercapai; video masuk pending queue.");
        error.pendingUpload = true;
        error.pendingReason = "PENDING_DAILY_LIMIT";
        throw error;
      }
      return publishToYoutube({
        videoPath: output.finalAbsPath,
        thumbnailPath: thumbnail?.path || "",
        ...youtubeMetadata
      });
    });
    if (platformResults.youtube) {
      const now = new Date().toISOString();
      await updateJob(job.job_id, {
        youtube_status: "published",
        youtube_video_id: platformResults.youtube.videoId,
        youtube_url: platformResults.youtube.url,
        youtube_published_at: now
      });
      await appendLog("youtube_publish_confirmed", {
        job_id: job.job_id,
        youtube_video_id: platformResults.youtube.videoId,
        youtube_url: platformResults.youtube.url
      });
      try {
        await incrementYoutubeUploadCounter();
      } catch (error) {
        console.warn(`Counter YouTube gagal disimpan setelah upload berhasil: ${error.message}`);
        await appendLog("youtube_counter_failed", {
          job_id: job.job_id,
          youtube_video_id: platformResults.youtube.videoId,
          error: error.message
        });
      }
      await syncStateBestEffort("youtube_publish_confirmed");
    }
    if (platformResults.quotaExceeded.youtube) {
      const youtubeMetadata = buildYoutubeMetadata({ job, output, caption: publishCaption });
      await savePendingUpload({
        jobId: job.job_id,
        videoPath: output.finalAbsPath,
        videoUrl: upload.videoUrl,
        thumbnailPath: thumbnail?.path || "",
        thumbnailUrl: upload.thumbnailUrl,
        metadata: { ...metadata, ...youtubeMetadata },
        reason: "QUOTA_EXCEEDED",
        error: platformResults.errors.youtube || ""
      });
      return platformResults;
    }
    if (platformResults.deferred.youtube) return platformResults;
    if (!platformResults.youtube) return platformResults;
  }

  if (config.facebook.enabled) {
    platformResults.facebook = await publishPlatform("facebook", platformResults, job.job_id, async () => {
      if (!upload.videoUrl) throw new Error("PUBLIC_BASE_URL/SFTP wajib valid sebelum publish Facebook.");
      await updateJob(job.job_id, { facebook_status: "processing", facebook_error: "" });
      return publishToFacebook({
        videoUrl: upload.videoUrl,
        videoPath: output.finalAbsPath,
        title: output.title || job.source_title || "Podcast Clip",
        description: publishCaption,
        thumbnailPath: thumbnail?.path || ""
      });
    });
  }

  if (config.instagram.enabled) {
    platformResults.instagram = await publishPlatform("instagram", platformResults, job.job_id, async () => {
      if (!upload.videoUrl) throw new Error("PUBLIC_BASE_URL/SFTP wajib valid sebelum publish Instagram.");
      await updateJob(job.job_id, { instagram_status: "processing", instagram_error: "" });
      const instagramVideo = await prepareInstagramVideo({
        job,
        sourcePath: output.finalAbsPath,
        currentVideoUrl: upload.videoUrl
      });
      return publishReel({
        videoUrl: instagramVideo.videoUrl,
        caption: publishCaption,
        coverUrl: upload.thumbnailUrl || ""
      });
    });
  }

  if (config.tiktok.enabled) {
    platformResults.tiktok = await publishPlatform("tiktok", platformResults, job.job_id, async () => {
      if (!upload.videoUrl) throw new Error("PUBLIC_BASE_URL/SFTP wajib valid sebelum publish TikTok.");
      await updateJob(job.job_id, { tiktok_status: "processing", tiktok_error: "" });
      return publishToTikTok({
        videoUrl: upload.videoUrl,
        videoPath: output.finalAbsPath,
        caption: publishCaption
      });
    });
  }

  if (config.threads.enabled) {
    platformResults.threads = await publishPlatform("threads", platformResults, job.job_id, async () => {
      if (!upload.videoUrl) throw new Error("PUBLIC_BASE_URL/SFTP wajib valid sebelum publish Threads.");
      await updateJob(job.job_id, { threads_status: "processing", threads_error: "" });
      return publishToThreads({
        videoUrl: upload.videoUrl,
        caption: ensureCaptionSourceCredit(publishCaption, {
          sourceUrl: job.source_url,
          sourceTitle: job.source_title || output.title,
          maxLength: 500
        })
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
    if (name === "youtube" && error.pendingUpload) {
      platformResults.deferred.youtube = true;
    }
    if (name === "youtube" && isYoutubeQuotaError(error)) {
      platformResults.quotaExceeded.youtube = true;
    }
    await appendLog("platform_publish_failed", {
      job_id: jobId,
      platform: name,
      error: error.message,
      quota_exceeded: name === "youtube" && isYoutubeQuotaError(error)
    });
    console.warn(`${name} publish gagal, workflow lanjut: ${error.message}`);
    return null;
  }
}

function buildMetadata({
  job,
  video,
  theme,
  prompt,
  output,
  clipperResult,
  caption,
  thumbnail,
  clipIndex = 1,
  clipTotal = 1,
  videoEffects = null,
  dailyPlan = null,
  publishSlotWib = "",
  publishDateWib = "",
  publishStatus = "rendered_waiting_review"
}) {
  const contentType = dailyPlan?.contentType || video.content_type || job.theme || theme?.name || "inspiratif_hikmah";
  const activeSlot = dailyPlan?.activeSlot || {};
  const classification = classifyContentType({ dailyPlan, video, output, contentType });
  const hashtags = metadataHashtags(output, caption, theme, dailyPlan);
  const titleAlternatives = Array.isArray(output.titleAlternatives)
    ? output.titleAlternatives.slice(0, 3)
    : [];
  const titleBest = output.bestTitle || output.title || thumbnail.text || "";
  const contextSafetyScore = output.contextSafetyScore || output.contextSafeScore || 0;
  const concreteHookScore = output.concreteHookScore || 0;
  const thumbnailReadabilityScore = Math.max(
    Number(output.thumbnailReadabilityScore || 0),
    estimateThumbnailReadability(output.openingHook || output.coverHook || output.screenHook || thumbnail.text || titleBest)
  );
  const faceExpressionScore = output.faceExpressionScore || 0;
  const finalScore = output.finalScore || 0;
  const thumbnailIntro = output.thumbnailIntro || { applied: false };
  const bumper = output.bumper || thumbnailIntro.bumper || {};
  const openingEnabled = Boolean(thumbnailIntro.applied);
  const openingHook = output.openingHook || output.coverHook || output.screenHook || thumbnail.text || "INI BIKIN MIKIR";
  return {
    job_id: job.job_id,
    clip_index: clipIndex,
    clip_total: clipTotal,
    source_type: "youtube_video",
    source_url: video.url,
    source_video: video.url,
    youtube_video_id: video.youtube_video_id,
    source_video_id: video.youtube_video_id,
    output_file: output.finalAbsPath || "",
    content_type: classification.contentType,
    slot_index: Number(activeSlot.slot_index || video.slot_index || 0),
    slot_time_wib: activeSlot.slot_time_wib || video.slot_time_wib || "",
    slot_content_type: activeSlot.slot_content_type || video.slot_content_type || contentType,
    daily_theme: dailyPlan?.dailyTheme || contentType,
    source_channel: video.source_channel || video.channel_title || output.channel || "",
    source_published_at: video.published_at_source || "",
    source_duration_seconds: Number(video.source_duration_seconds || video.discovery_duration || 0),
    source_views: Number(video.discovery_views || 0),
    source_views_per_hour: Number(video.discovery_views_per_hour || 0),
    discovered_query: video.discovered_query || dailyPlan?.query || "",
    selected_channel_handles: Array.isArray(video.selected_channel_handles) && video.selected_channel_handles.length
      ? video.selected_channel_handles
      : splitList(dailyPlan?.channelHandles || process.env.AUTO_DISCOVER_CHANNEL_HANDLES || ""),
    discovery_mode: dailyPlan?.discoveryMode || (process.env.THEME_AWARE_DISCOVERY === "false" ? "legacy" : "theme_aware"),
    discovery_source: video.discovery_source || "",
    source_title: video.source_title || output.title || "",
    title: titleBest,
    title_best: titleBest,
    best_title: titleBest,
    title_alternatives: titleAlternatives,
    theme: theme?.name || job.theme,
    prompt_id: prompt?.id || "",
    status: "done",
    transcriptSource: output.transcriptSource || "",
    finalPath: output.finalAbsPath,
    originalFinalPath: output.originalFinalAbsPath || "",
    videoEffects,
    backgroundMusic: output.backgroundMusic || {},
    thumbnailIntro,
    bumper_enabled: Boolean(bumper.bumper_enabled ?? process.env.BUMPER_ENABLED !== "false"),
    bumper_adaptive_enabled: Boolean(bumper.bumper_adaptive_enabled ?? process.env.BUMPER_ADAPTIVE_ENABLED !== "false"),
    bumper_duration: Number(thumbnailIntro.bumperDurationSeconds || bumper.bumper_duration || 0),
    bumper_series_label: bumper.bumper_series_label || process.env.BUMPER_SERIES_LABEL || "MENIT HIKMAH",
    bumper_tagline: bumper.bumper_tagline || process.env.BUMPER_DEFAULT_TAGLINE || "1 menit yang bikin mikir",
    bumper_mood: bumper.bumper_mood || "",
    bumper_icon: bumper.bumper_icon || "",
    bumper_accent_color: bumper.bumper_accent_color || process.env.BUMPER_ACCENT_LINE_COLOR || "#F5C542",
    bumper_motion: bumper.bumper_motion || "",
    bumper_style: bumper.bumper_style || process.env.BUMPER_STYLE || "adaptive_theme_stamp",
    bumper_reason: bumper.bumper_reason || "",
    bumper_risk_notes: bumper.bumper_risk_notes || "",
    opening_title_enabled: openingEnabled,
    opening_hook: openingHook,
    opening_style: process.env.OPENING_STYLE || "bold_hook",
    opening_duration: openingEnabled ? Number(thumbnailIntro.durationSeconds || 0) : 0,
    opening_transition_enabled: Boolean(thumbnailIntro.transitionEnabled),
    opening_transition_type: thumbnailIntro.transitionType || process.env.OPENING_TRANSITION_TYPE || "zoom_blur",
    opening_transition_duration: Number(thumbnailIntro.transitionSeconds || 0),
    opening_frame_source_time: output.start || "",
    opening_hook_reason: output.reasonHookSelected || output.reason || "Fallback dari cover hook/title clip.",
    reason_hook_selected: output.reasonHookSelected || output.reason || "Hook dipilih karena paling konkret dan terbaca cepat.",
    frameQuoteText: output.frameQuoteText || "",
    transcriptPath: output.transcriptReviewAbsPath || "",
    subtitlePath: output.subtitleAbsPath || "",
    thumbnailPath: thumbnail.path,
    thumbnailText: thumbnail.text,
    caption,
    caption_short: firstCaptionSentence(caption),
    startTime: output.start,
    start_time: output.start,
    endTime: output.end,
    end_time: output.end,
    duration: output.duration,
    summary: output.summary || "",
    reason_selected: output.reason || "",
    alasan_segmen_dipilih: output.reason || "",
    risk_notes: output.risks || "",
    risiko_konteks_copyright: output.risks || "",
    screen_hook: output.screenHook || thumbnail.text || "",
    cover_hook: output.coverHook || output.screenHook || thumbnail.text || "",
    emotion: output.mainEmotion || "",
    main_emotion: output.mainEmotion || "",
    context_safe_score: contextSafetyScore,
    final_score: finalScore,
    hook_score: output.hookScore || 0,
    concrete_hook_score: concreteHookScore,
    retention_score: output.retentionScore || 0,
    emotion_score: output.emotionScore || 0,
    clarity_score: output.clarityScore || 0,
    context_safety_score: contextSafetyScore,
    thumbnail_readability_score: thumbnailReadabilityScore,
    face_expression_score: faceExpressionScore,
    shareability_score: output.shareabilityScore || 0,
    classification_reason: classification.reason,
    confidence_score: classification.confidenceScore,
    classifier_version: classification.version,
    publish_date_wib: publishDateWib || dailyPlan?.dateWib || "",
    publish_slot_wib: publishSlotWib || "",
    publish_status: publishStatus,
    scoring: {
      hook_score: output.hookScore || 0,
      concrete_hook_score: concreteHookScore,
      retention_score: output.retentionScore || 0,
      emotion_score: output.emotionScore || 0,
      clarity_score: output.clarityScore || 0,
      context_safety_score: output.contextSafetyScore || output.contextSafeScore || 0,
      thumbnail_readability_score: thumbnailReadabilityScore,
      face_expression_score: faceExpressionScore,
      shareability_score: output.shareabilityScore || 0,
      final_score: output.finalScore || 0
    },
    clip_candidates: output.analysisCandidates || [],
    clipTranscript: output.clipTranscript || "",
    viralScore: output.viralScore || 0,
    viral_score_1_10: output.viralScore1To10 || 0,
    selectedAngle: output.selectedAngle || "",
    publishDecision: output.publishDecision || "",
    candidateId: output.candidateId || "",
    hashtags,
    risks: output.risks || "",
    validation: output.validation || {},
    clipperJobId: clipperResult.jobId,
    created_at: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
}

function buildOpeningHook({ output, thumbnailText }) {
  const source = output.openingHook
    || output.coverHook
    || output.screenHook
    || thumbnailText
    || output.bestTitle
    || output.title
    || "INI BIKIN MIKIR";
  const normalized = prioritizeHookPattern(String(source || ""));
  const words = normalized
    .replace(/[`"'*_#]/g, "")
    .replace(/[?!.,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, Number(process.env.OPENING_TITLE_MAX_WORDS || process.env.TITLE_MAX_WORDS || 5));
  return words.join(" ") || "INI BIKIN MIKIR";
}

function prioritizeHookPattern(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const upper = text.toUpperCase();
  const patterns = [
    "RAHASIA",
    "TERNYATA",
    "JANGAN",
    "KENAPA",
    "INI BUKAN",
    "KITA HARUS"
  ];
  for (const pattern of patterns) {
    const index = upper.indexOf(pattern);
    if (index !== -1) return upper.slice(index);
  }
  return upper;
}

function publishValidationBlockReason(metadata = {}) {
  if (config.ai.requiredForPublish && metadata.publish_decision === "local_fallback") {
    return "AI_REQUIRED_FOR_PUBLISH=1; AI analyzer gagal sehingga hasil fallback lokal masuk review, bukan auto-publish.";
  }
  if (Number(metadata.context_safety_score || 0) < 7) {
    return "context_safety_score < 7; tidak aman untuk auto-publish.";
  }
  if (Number(metadata.thumbnail_readability_score || 0) < 7) {
    return "thumbnail_readability_score < 7; opening/thumbnail belum cukup terbaca untuk auto-publish.";
  }
  const minConfidence = Number(process.env.MIN_CLASSIFICATION_CONFIDENCE || 0.6);
  if (Number(metadata.confidence_score || 0) < minConfidence) {
    return `confidence_score < ${minConfidence}; masuk review.`;
  }
  if (!metadata.cover_hook && !metadata.opening_hook) return "opening_hook/cover_hook kosong.";
  if (!metadata.caption) return "caption kosong.";
  if (!Array.isArray(metadata.hashtags) || metadata.hashtags.length < 5) return "hashtag kurang dari 5.";
  return "";
}

function estimateThumbnailReadability(value = "") {
  const words = String(value || "")
    .replace(/[`"'*_#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return 5;
  let score = 8;
  if (words.length > 5) score -= Math.min(3, (words.length - 5) * 0.7);
  if (words.some((word) => word.length > 14)) score -= 1;
  if (/\b(rahasia|ternyata|jangan|kenapa|ini|bukan)\b/i.test(words.join(" "))) score += 0.8;
  return Math.max(0, Math.min(10, Math.round(score * 10) / 10));
}

function firstCaptionSentence(value = "") {
  const body = String(value || "").replace(/#[\p{L}\p{N}_]+/gu, "").trim();
  const match = body.match(/^(.{20,220}?[.!?])(?:\s|$)/su);
  return (match?.[1] || body.split(/\n+/)[0] || "").trim().slice(0, 220);
}

function metadataHashtags(output = {}, caption = "", theme = {}, dailyPlan = null) {
  const contentType = dailyPlan?.contentType || theme?.name || "";
  const defaults = contentType === "podcast_lucu_hikmah"
    ? ["#Shorts", "#PodcastIndonesia", "#CeritaLucu", "#CeritaHidup", "#InspirasiHidup"]
    : ["#Shorts", "#CeritaInspiratif", "#Hikmah", "#Renungan", "#MotivasiHidup"];
  const raw = [
    ...(Array.isArray(output.hashtags) ? output.hashtags : []),
    ...(Array.isArray(dailyPlan?.hashtags) ? dailyPlan.hashtags : []),
    ...(String(caption || "").match(/#[\p{L}\p{N}_]+/gu) || []),
    ...defaults,
    theme?.name ? `#${theme.name}` : ""
  ];
  const seen = new Set();
  const tags = [];
  for (const item of raw) {
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
    if (tags.length >= 8) break;
  }
  return tags.length >= 5 ? tags : [...tags, ...defaults].filter((tag, index, arr) => arr.indexOf(tag) === index).slice(0, 8);
}

function classifyContentType({ dailyPlan, video, output, contentType }) {
  if (process.env.AUTO_CLASSIFY_CONTENT_TYPE === "false") {
    return {
      contentType,
      confidenceScore: Number(video.confidence_score ?? output.confidenceScore ?? 1),
      reason: video.classification_reason || "Auto classify disabled; memakai daily theme.",
      version: "manual_theme_v1"
    };
  }

  const text = [
    video.source_title,
    video.channel_title,
    video.discovered_query,
    output.title,
    output.summary,
    output.reason,
    output.clipTranscript
  ].join(" ").toLowerCase();
  const keywordMap = {
    inspiratif_hikmah: ["hikmah", "nasihat", "renungan", "keluarga", "orang tua", "perjuangan", "kisah hidup", "pengalaman", "rezeki", "sabar", "ikhlas", "syukur", "pelajaran hidup"],
    podcast_lucu_hikmah: ["podcast", "lucu", "ketawa", "ngakak", "cerita", "pengalaman", "relate", "obrolan", "teman", "keluarga", "komedi", "kok iya", "bercanda", "blunder", "awkward", "kocak"]
  };
  const scores = Object.fromEntries(Object.entries(keywordMap).map(([themeName, words]) => [
    themeName,
    words.reduce((score, word) => score + (text.includes(word) ? 1 : 0), 0)
  ]));
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [bestTheme, bestScore] = sorted[0] || [contentType, 0];
  const totalHits = Object.values(scores).reduce((sum, score) => sum + score, 0);
  const dailyTheme = dailyPlan?.contentType || contentType;
  const resolved = bestScore > 0 ? bestTheme : dailyTheme;
  const confidenceScore = bestScore > 0
    ? Math.max(0.6, Math.min(0.95, bestScore / Math.max(totalHits, bestScore)))
    : Number(video.confidence_score ?? output.confidenceScore ?? 0.75);
  return {
    contentType: ["inspiratif_hikmah", "podcast_lucu_hikmah"].includes(dailyTheme) ? dailyTheme : resolved,
    confidenceScore,
    reason: bestScore > 0
      ? `Keyword classifier memilih ${resolved} (${bestScore} hit). Daily theme=${dailyTheme}.`
      : `Tidak ada keyword dominan; memakai daily theme ${dailyTheme}.`,
    version: "keyword_classifier_v1"
  };
}

function dailyReport(result = {}) {
  const plan = result.dailyPlan || resolveDailyPlan({});
  const clips = Array.isArray(result.clips) ? result.clips : [];
  const discovery = result.discoveryResult || {};
  const foundCount = discovery.found_count || discovery.candidate_count || discovery.raw_count || discovery.added?.length || 0;
  const renderedCount = clips.filter((clip) => clip.ok).length;
  const scheduledOrPublishedCount = clips.filter((clip) => {
    const status = String(clip.status || "").toLowerCase();
    return ["scheduled", "published", "published_with_warnings", "queued"].includes(status);
  }).length;
  const youtubePublishedCount = clips.filter((clip) => Boolean(clip.youtube_video_id)).length;
  const queuedCount = clips.filter((clip) => String(clip.status || "").toLowerCase() === "queued").length;
  const candidateClipCount = clips.reduce((total, clip) => {
    return total + (Number(clip.candidate_clip_count) || 0);
  }, 0);
  const errorOrSkippedCount = clips.filter((clip) => !clip.ok).length + (result.failedSelections?.length || 0);

  const report = {
    ...result,
    tanggal_wib: plan.dateWib,
    mode: plan.mode || "legacy",
    target_count: plan.targetCount || plan.targetMax,
    slots: (plan.slotPlans || []).map((slot) => ({
      slot_index: slot.slot_index,
      slot_time_wib: slot.slot_time_wib,
      slot_content_type: slot.slot_content_type || slot.content_type,
      query: slot.discover_query || "",
      selected_channel_handles: slot.selected_channel_handles || []
    })),
    tema_hari_ini: plan.contentType,
    target_video_hari_ini: `${plan.targetMin}-${plan.targetMax}`,
    query_yang_dipakai: plan.query,
    jumlah_video_ditemukan: foundCount,
    jumlah_video_ditemukan_dari_channel: discovery.channel_found_count || 0,
    jumlah_video_ditemukan_dari_query: discovery.query_found_count || 0,
    jumlah_video_dari_trending: discovery.trending_found_count || 0,
    jumlah_video_lolos_filter: discovery.passed_filter_count || discovery.added?.length || 0,
    jumlah_transcript_berhasil: renderedCount,
    jumlah_kandidat_clip_dibuat: candidateClipCount,
    jumlah_video_dirender: renderedCount,
    jumlah_video_scheduled_published: youtubePublishedCount,
    jumlah_video_publish_youtube: youtubePublishedCount,
    jumlah_video_queued: queuedCount,
    jumlah_video_scheduled_legacy: scheduledOrPublishedCount,
    jumlah_error_skipped: errorOrSkippedCount,
    shortage: renderedCount < plan.targetMin
      ? `Stok/render kurang dari target minimum ${plan.targetMin}; tersedia ${renderedCount}.`
      : "",
    outputs: clips.map((clip) => ({
      slot_index: clip.slot_index || "",
      slot_time_wib: clip.slot_time_wib || clip.publish_slot_wib || "",
      content_type: clip.content_type || "",
      title_best: clip.title_best || "",
      opening_hook: clip.opening_hook || "",
      cover_hook: clip.cover_hook || "",
      publish_slot_wib: clip.publish_slot_wib || "",
      final_score: clip.final_score || 0,
      context_safety_score: clip.context_safety_score || 0,
      concrete_hook_score: clip.concrete_hook_score || 0,
      thumbnail_readability_score: clip.thumbnail_readability_score || 0,
      face_expression_score: clip.face_expression_score || 0,
      confidence_score: clip.confidence_score || 0,
      status: clip.status || "",
      output_file: clip.final_video_path || "",
      metadata_file: clip.metadata_path || ""
    }))
  };
  saveDailyReport(report).catch(() => {});
  return report;
}

async function saveDailyReport(report) {
  const date = report.tanggal_wib || todayDate();
  const dir = path.join(config.dataDir, "reports");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `daily_report_${date}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
}

function splitList(value) {
  return String(value || "")
    .split(/[\n,|;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function appendHistoryEntry({ job, video, caption, output, upload, platformResults = {}, status, clipIndex = 1, clipTotal = 1 }) {
  await appendHistory({
    job_id: job.job_id,
    clip_index: clipIndex,
    clip_total: clipTotal,
    video_id: video.id,
    source_url: video.url,
    source_video_id: video.youtube_video_id,
    theme: job.theme,
    content_type: video.content_type || job.theme,
    source_title: video.source_title || output.title || "",
    title_best: output.bestTitle || output.title || "",
    start_time: output.start,
    end_time: output.end,
    status,
    publish_date: status === "published" ? todayDate() : "",
    final_video_path: output.finalAbsPath,
    original_final_video_path: output.originalFinalAbsPath || "",
    video_effects: output.videoEffects || "",
    background_music: output.backgroundMusic || "",
    thumbnail_intro: output.thumbnailIntro || { applied: false },
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
    threads_media_id: platformResults.threads?.mediaId || "",
    threads_url: platformResults.threads?.url || "",
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

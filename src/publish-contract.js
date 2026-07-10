function cleanId(value) {
  return String(value || "").trim();
}

function addId(target, value) {
  const id = cleanId(value);
  if (id) target.add(id);
}

function addPendingUploadIds(target, pending = {}) {
  for (const item of pending?.uploaded || []) {
    addId(target, item?.result?.videoId);
    addId(target, item?.youtube_video_id);
  }
}

export function youtubeUploadIds(result = {}) {
  const ids = new Set();
  addId(ids, result.youtube_video_id);

  for (const clip of result.clips || []) {
    addId(ids, clip?.youtube_video_id);
    addId(ids, clip?.platformResults?.youtube?.videoId);
    addId(ids, clip?.platform_results?.youtube?.videoId);
  }

  addPendingUploadIds(ids, result.pending_uploads);
  addPendingUploadIds(ids, result.pending_uploads_first);
  return [...ids];
}

export function isExpectedPublishNoop(result = {}) {
  return String(result.status || "").toLowerCase() === "scheduled_skip"
    && String(result.reason || "").toLowerCase() === "daily_limit_reached";
}

export function assertYoutubePublishContract(result = {}, { required = false } = {}) {
  const ids = youtubeUploadIds(result);
  if (!required || ids.length || isExpectedPublishNoop(result)) return ids;

  const errors = (result.clips || [])
    .flatMap((clip) => [clip?.youtube_error, clip?.error])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const status = String(result.status || result.publish_status || "unknown");
  const detail = errors.length ? ` Detail: ${[...new Set(errors)].join("; ")}` : "";
  const error = new Error(
    `YOUTUBE_PUBLISH_REQUIRED: workflow meminta publish tetapi tidak menerima youtube_video_id `
      + `(status=${status}).${detail}`
  );
  error.code = "YOUTUBE_PUBLISH_REQUIRED";
  error.result = result;
  throw error;
}

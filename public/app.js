const STATE_URL = "/api/state";
const POLL_ACTIVE_MS = 3000;
const POLL_IDLE_MS = 30000;
const ROW_LIMIT_DEFAULT = 5;
const ROW_LIMIT_EXPANDED = 18;
const FALLBACK_PIPELINE = [
  { label: "Queue" },
  { label: "Clipper" },
  { label: "Branding" },
  { label: "Caption" },
  { label: "Thumbnail" },
  { label: "SFTP" },
  { label: "Instagram" },
  { label: "Facebook" },
  { label: "YouTube" },
  { label: "TikTok" },
  { label: "Threads" },
  { label: "History" }
];

let dashboardPin =
  new URLSearchParams(window.location.search).get("pin") ||
  window.sessionStorage.getItem("dashboardPin") ||
  "";
let authVisible = true;
let pollTimer = null;
let lastRunStatus = "idle";
let videoLimit = ROW_LIMIT_DEFAULT;
let jobLimit = ROW_LIMIT_DEFAULT;
let cachedVideos = [];
let cachedJobs = [];
let effectDefaults = { use_frame: true, use_filter: true, use_watermark: true };
let effectDefaultsApplied = false;

if (dashboardPin) {
  window.sessionStorage.setItem("dashboardPin", dashboardPin);
  const cleanUrl = new URL(window.location.href);
  if (cleanUrl.searchParams.has("pin")) {
    cleanUrl.searchParams.delete("pin");
    window.history.replaceState({}, "", cleanUrl);
  }
}

const els = {
  configLine: document.querySelector("#configLine"),
  refreshBtn: document.querySelector("#refreshBtn"),
  preflightBtn: document.querySelector("#preflightBtn"),
  metrics: document.querySelector("#metrics"),
  workflowGraph: document.querySelector("#workflowGraph"),
  workflowMeta: document.querySelector("#workflowMeta"),
  workflowTitle: document.querySelector("#workflowTitle"),
  progressBar: document.querySelector("#progressBar"),
  runProgressLabel: document.querySelector("#runProgressLabel"),
  runBadge: document.querySelector("#runBadge"),
  runLink: document.querySelector("#runLink"),
  runDetail: document.querySelector("#runDetail"),
  runStatus: document.querySelector("#runStatus"),
  videoForm: document.querySelector("#videoForm"),
  runForm: document.querySelector("#runForm"),
  consoleOutput: document.querySelector("#consoleOutput"),
  consoleMeta: document.querySelector("#consoleMeta"),
  videoRows: document.querySelector("#videoRows"),
  videoCount: document.querySelector("#videoCount"),
  videosMore: document.querySelector("#videosMore"),
  jobRows: document.querySelector("#jobRows"),
  jobCount: document.querySelector("#jobCount"),
  jobsMore: document.querySelector("#jobsMore"),
  authOverlay: document.querySelector("#authOverlay"),
  authForm: document.querySelector("#authForm"),
  authPin: document.querySelector("#authPin"),
  authError: document.querySelector("#authError"),
  logoutBtn: document.querySelector("#logoutBtn")
};

class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

async function api(path, options = {}) {
  const headers = { Accept: "application/json" };
  if (options.body) headers["Content-Type"] = "application/json";
  if (dashboardPin) headers["X-Dashboard-Pin"] = dashboardPin;

  const response = await fetch(path, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  });

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await response.text();
    throw new ApiError(
      `Server tidak mengembalikan JSON (${response.status}). ${short(text.replace(/\s+/g, " "), 120)}`,
      response.status
    );
  }

  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error || "Request gagal.", response.status);
  return data;
}

function short(value, length = 54) {
  const text = String(value || "");
  if (text.length <= length) return text;
  return `${text.slice(0, length - 1)}...`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function setSubmittersDisabled(disabled) {
  for (const form of [els.runForm, els.videoForm]) {
    if (!form) continue;
    const btn = form.querySelector('button[type="submit"]');
    if (!btn) continue;
    if (disabled) {
      if (!btn.dataset.originalText) btn.dataset.originalText = btn.textContent;
      btn.disabled = true;
      btn.classList.add("isBusy");
      btn.textContent = "Workflow berjalan…";
    } else {
      btn.disabled = false;
      btn.classList.remove("isBusy");
      if (btn.dataset.originalText) {
        btn.textContent = btn.dataset.originalText;
        delete btn.dataset.originalText;
      }
    }
  }
}

function formData(form) {
  const raw = Object.fromEntries(new FormData(form).entries());
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, String(value).trim()]));
}

function pill(status) {
  const label = status || "queued";
  const safe = String(label).replace(/[^a-z0-9_-]/gi, "_");
  return `<span class="pill ${safe}">${escapeHtml(label)}</span>`;
}

function link(url, text) {
  return `<a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">${escapeHtml(short(text, 28))}</a>`;
}

async function refresh() {
  const state = await api(STATE_URL);
  hideAuth();

  const cfg = state.config || {};
  els.configLine.textContent = [
    cfg.dryRun ? "dry-run" : "live",
    cfg.autoPublish ? "publish on" : "publish off",
    `IG ${cfg.instagramEnabled ? "on" : "off"}`,
    `FB ${cfg.facebookEnabled ? "on" : "off"}`,
    `YT ${cfg.youtubeEnabled ? "on" : "off"}`,
    `TT ${cfg.tiktokEnabled ? "on" : "off"}`,
    `TH ${cfg.threadsEnabled ? "on" : "off"}`,
    `Storage ${(cfg.uploadDriver || "local").toUpperCase()}`,
    `FX ${effectSummary(cfg)}`,
    `AI ${cfg.aiProvider || "gemini"}`,
    cfg.timezone
  ].filter(Boolean).join(" · ");

  applyEffectDefaults(cfg);
  renderMetrics(state);
  renderHero(state);
  renderWorkflow(state);
  renderConsole(state.activeRun);
  renderVideos(state.videos || []);
  renderJobs(state.jobs || []);

  lastRunStatus = state.activeRun?.status === "running" ? "running" : "idle";
}

function effectSummary(cfg) {
  const items = [];
  if (cfg.videoFrameEnabled) items.push("frame");
  if (cfg.videoFilterEnabled) items.push("filter");
  if (cfg.videoWatermarkEnabled) items.push("wm");
  return items.length ? items.join("+") : "manual";
}

function applyEffectDefaults(cfg) {
  effectDefaults = {
    use_frame: Boolean(cfg.videoFrameEnabled),
    use_filter: Boolean(cfg.videoFilterEnabled),
    use_watermark: Boolean(cfg.videoWatermarkEnabled)
  };
  if (effectDefaultsApplied) return;
  for (const form of [els.runForm, els.videoForm]) {
    if (!form) continue;
    for (const [key, value] of Object.entries(effectDefaults)) {
      if (form.elements[key]) form.elements[key].checked = value;
    }
  }
  effectDefaultsApplied = true;
}

function readEffectOptions(form) {
  return {
    use_frame: Boolean(form.elements.use_frame?.checked),
    use_filter: Boolean(form.elements.use_filter?.checked),
    use_watermark: Boolean(form.elements.use_watermark?.checked)
  };
}

function resetEffectOptions(form) {
  for (const [key, value] of Object.entries(effectDefaults)) {
    if (form.elements[key]) form.elements[key].checked = value;
  }
}

async function refreshTikTokDemoStatus() {
  if (!els.tiktokStatusBadge) return;
  try {
    const status = await api("/api/tiktok/demo-status");
    const connected = Boolean(status.connected);
    els.tiktokStatusBadge.textContent = connected ? "Connected" : "Not connected";
    els.tiktokStatusBadge.classList.toggle("success", connected);
    els.publishTikTokBtn.disabled = !connected || !status.latestJob;
    els.tiktokDemoText.textContent = [
      status.configured ? "Sandbox app configured" : "TikTok app belum lengkap",
      connected ? "akun TikTok terhubung" : "akun TikTok belum terhubung",
      status.latestJob ? `video siap: ${short(status.latestJob.job_id, 32)}` : "belum ada video siap upload",
      `mode ${status.publishMode || "inbox"}`
    ].join(" · ");
  } catch (error) {
    els.tiktokStatusBadge.textContent = "Check failed";
    setTikTokLog(error.message);
  }
}

function setTikTokLog(text) {
  if (!els.tiktokDemoLog) return;
  els.tiktokDemoLog.textContent = text || "Belum ada aksi TikTok.";
}

function renderMetrics(state) {
  const videos = state.videos || [];
  const jobs = state.jobs || [];
  const published = jobs.filter((job) => job.status === "published").length;
  const warnings = jobs.filter((job) => job.publish_status === "published_with_warnings").length;
  const failed = jobs.filter((job) => String(job.status || "").includes("failed")).length;
  const queued = videos.filter((video) => video.status === "queued").length;
  els.metrics.innerHTML = [
    metricCard("Queued", queued, "amber"),
    metricCard("Published", published, "green"),
    metricCard("Warnings", warnings, "amber"),
    metricCard("Failed", failed, "red")
  ].join("");
}

function metricCard(label, value, tone) {
  return `<article class="metric ${tone}"><span>${label}</span><strong>${value}</strong></article>`;
}

function renderHero(state) {
  const run = state.activeRun;
  setSubmittersDisabled(run?.status === "running");
  if (!run) {
    els.runBadge.textContent = "Idle";
    els.runBadge.className = "runBadge idle";
    els.workflowTitle.textContent = "Menunggu proses";
    els.workflowMeta.textContent = "Belum ada workflow yang berjalan.";
    els.runStatus.textContent = "Idle";
    els.runDetail.textContent = "Siap menerima link YouTube atau menjalankan queue.";
    els.runProgressLabel.textContent = "0%";
    els.progressBar.style.width = "0%";
    els.progressBar.classList.remove("running");
    els.runLink.hidden = true;
    return;
  }

  const status = run.status || "running";
  const isLive = status === "running";
  els.runBadge.textContent = isLive ? "RUNNING" : `LAST · ${status.toUpperCase()}`;
  els.runBadge.className = `runBadge ${status}`;
  els.workflowTitle.textContent = run.title || run.name || "Workflow";
  els.workflowMeta.textContent = run.branch
    ? `${run.name || "Workflow"} · ${run.branch} · ${formatTime(run.startedAt)}`
    : `${run.name || "Workflow"} · ${formatTime(run.startedAt)}`;
  els.runStatus.textContent = status;
  els.runDetail.textContent = run.detail || run.error || "Workflow berjalan";

  const pct = typeof run.progress === "number" ? run.progress : status === "running" ? 8 : 100;
  els.runProgressLabel.textContent = `${pct}%`;
  els.progressBar.style.width = `${pct}%`;
  els.progressBar.classList.toggle("running", status === "running");

  if (run.htmlUrl) {
    els.runLink.href = run.htmlUrl;
    els.runLink.hidden = false;
  } else {
    els.runLink.hidden = true;
  }
}

function renderWorkflow(state) {
  const run = state.activeRun;
  const jobs = run?.jobs || [];
  const steps = jobs.length ? buildLiveSteps(jobs) : buildPipelineSteps(state);
  els.workflowGraph.innerHTML = steps
    .map((step, index) => {
      const next = steps[index + 1];
      const edge = next ? `<div class="flowEdge ${edgeState(step, next)}"><span></span></div>` : "";
      return `${flowNode(step, index + 1)}${edge}`;
    })
    .join("");
}

function buildLiveSteps(jobs) {
  const steps = [];
  jobs.forEach((job) => {
    (job.steps || []).forEach((step) => {
      const stepState = mapStepState(step);
      const detail =
        step.status === "completed" && step.completed_at && step.started_at
          ? `${step.conclusion || "done"} · ${durationSeconds(step.started_at, step.completed_at)}s`
          : step.status === "in_progress"
            ? "Sedang berjalan"
            : step.status === "queued"
              ? "Menunggu"
              : step.conclusion || step.status || "—";
      steps.push({ label: step.name, detail, state: stepState });
    });
  });
  return steps;
}

function buildPipelineSteps(stateData) {
  const mkStep = (label, stepState, detail) => ({ label, state: stepState, detail });
  const job = currentJob(stateData);
  if (!job) {
    return FALLBACK_PIPELINE.map((entry) => mkStep(entry.label, "pending", "Menunggu"));
  }

  const failed = isFailed(job.status) || Boolean(job.error_message);
  const clipperDone = job.clipper_status === "done" || Boolean(job.final_video_path);
  const brandingRequested = Boolean(job.use_frame || job.use_filter || job.use_watermark || job.video_effects?.applied);
  const brandingDone = !brandingRequested || Boolean(job.video_effects);
  const captionDone = job.caption_status === "done" || Boolean(job.caption);
  const thumbnailDone = job.thumbnail_status === "done" || Boolean(job.thumbnail_path);
  const ftpDone = Boolean(job.public_video_url);
  const remoteLabel = storageStepLabel(stateData.config?.uploadDriver);
  const published =
    job.status === "published" ||
    job.publish_status === "published" ||
    job.publish_status === "published_with_warnings";

  return [
    mkStep("Queue", "done", job.youtube_video_id || "Selected"),
    mkStep(
      "Clipper",
      stageState({
        failed: failed && !clipperDone,
        active: job.clipper_status === "processing" || job.status === "clipper_processing",
        done: clipperDone
      }),
      stageText(job.clipper_status, clipperDone ? "MP4 siap" : "Render video")
    ),
    mkStep(
      "Branding",
      stageState({
        failed: failed && clipperDone && !brandingDone,
        active: clipperDone && brandingRequested && !brandingDone && !failed,
        done: brandingRequested && brandingDone,
        muted: !brandingRequested
      }),
      brandingRequested
        ? job.video_effects?.applied ? effectDetail(job.video_effects) : "Frame/filter/watermark"
        : "Opsional"
    ),
    mkStep(
      "Caption",
      stageState({
        failed: failed && clipperDone && !captionDone,
        active: clipperDone && !captionDone && !failed,
        done: captionDone
      }),
      stageText(job.caption_status, captionDone ? "Caption siap" : "Buat caption")
    ),
    mkStep(
      "Thumbnail",
      stageState({
        failed: failed && captionDone && !thumbnailDone,
        active: captionDone && !thumbnailDone && !failed,
        done: thumbnailDone
      }),
      stageText(job.thumbnail_status, thumbnailDone ? "Thumbnail siap" : "Buat thumbnail")
    ),
    mkStep(
      remoteLabel,
      stageState({
        failed: failed && thumbnailDone && !ftpDone,
        active: thumbnailDone && !ftpDone && !failed,
        done: ftpDone
      }),
      ftpDone ? "Public URL valid" : "Upload file"
    ),
    platformStep("Instagram", job.instagram_status, Boolean(job.instagram_media_id), ftpDone, failed),
    platformStep("Facebook", job.facebook_status, Boolean(job.facebook_video_id || job.facebook_post_id), ftpDone, failed),
    platformStep("YouTube", job.youtube_status, Boolean(job.youtube_url), ftpDone, failed),
    platformStep("TikTok", job.tiktok_status, Boolean(job.tiktok_publish_id), ftpDone, failed),
    platformStep("Threads", job.threads_status, Boolean(job.threads_media_id), ftpDone, failed),
    mkStep(
      "History",
      stageState({
        failed,
        active: !published && (job.status === "publishing" || job.status === "ready_to_publish"),
        done: published
      }),
      published ? "Published" : job.publish_status || job.status || "Menunggu"
    )
  ];
}

function effectDetail(effects) {
  const items = [];
  if (effects?.frame) items.push("frame");
  if (effects?.filter) items.push("filter");
  if (effects?.watermark) items.push("wm");
  return items.length ? items.join(" + ") : "Selesai";
}

function storageStepLabel(driver) {
  const normalized = String(driver || "sftp").toLowerCase();
  if (normalized === "ftp") return "FTP";
  if (normalized === "sftp") return "SFTP";
  return "Storage";
}

function platformStep(label, status, hasResult, ftpDone, failed) {
  const normalized = String(status || "").toLowerCase();
  const disabled = normalized === "disabled";
  return {
    label,
    state: stageState({
      failed: isFailed(status) || (failed && ftpDone && !hasResult && !disabled),
      active: ftpDone && normalized === "processing" && !failed,
      done: hasResult || normalized === "published" || normalized === "submitted",
      muted: disabled || normalized === "skipped"
    }),
    detail:
      hasResult && normalized === "submitted"
        ? "Submitted"
        : hasResult
          ? "Published"
          : status || "Menunggu"
  };
}

function currentJob(state) {
  const jobs = state.jobs || [];
  const activeRun = state.activeRun || null;
  if (activeRun?.result?.job_id) {
    const fromRun = jobs.find((job) => job.job_id === activeRun.result.job_id);
    if (fromRun) return fromRun;
  }
  return [...jobs].sort((a, b) => {
    const left = String(a.updated_at || a.published_at || a.created_at || "");
    const right = String(b.updated_at || b.published_at || b.created_at || "");
    return right.localeCompare(left);
  })[0] || null;
}

function mapStepState(step) {
  if (step.status === "completed") {
    if (step.conclusion === "failure" || step.conclusion === "cancelled") return "failed";
    if (step.conclusion === "skipped") return "muted";
    return "done";
  }
  if (step.status === "in_progress") return "active";
  return "pending";
}

function stageState({ failed = false, active = false, done = false, muted = false }) {
  if (failed) return "failed";
  if (active) return "active";
  if (done) return "done";
  if (muted) return "muted";
  return "pending";
}

function stageText(status, fallback) {
  return status && status !== "pending" ? status : fallback;
}

function isFailed(status) {
  return String(status || "").toLowerCase().includes("failed");
}

function edgeState(step, next) {
  if (step.state === "failed" || next.state === "failed") return "failed";
  if (step.state === "done" && next.state === "done") return "done";
  if (step.state === "done" && next.state === "active") return "active";
  return "pending";
}

function flowNode(step, index) {
  return `
    <article class="flowNode ${step.state}">
      <span class="flowIndex">${index}</span>
      <strong>${escapeHtml(step.label)}</strong>
      <small>${escapeHtml(step.detail || "")}</small>
    </article>
  `;
}

function durationSeconds(start, end) {
  return Math.max(0, Math.round((new Date(end) - new Date(start)) / 1000));
}

function formatTime(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

function renderConsole(run) {
  const logs = run?.logs || [];
  els.consoleMeta.textContent = `${logs.length} log`;
  els.consoleOutput.innerHTML = logs.length
    ? logs
        .map((item) => {
          const ts = formatTime(item.at) || "--:--:--";
          const lvl = String(item.level || "system").toLowerCase();
          return `<span class="ts">[${escapeHtml(ts)}]</span> <span class="lvl-${escapeAttr(lvl)}">${escapeHtml(lvl.toUpperCase())}</span> ${escapeHtml(item.text || "")}`;
        })
        .join("\n")
    : "Belum ada output.";
  els.consoleOutput.scrollTop = els.consoleOutput.scrollHeight;
}

function renderVideos(videos) {
  cachedVideos = videos;
  const total = videos.length;
  els.videoCount.textContent = `${total} item`;
  const rows = [...videos]
    .reverse()
    .slice(0, videoLimit)
    .map(
      (video) => `
    <tr>
      <td data-label="Status">${pill(video.status)}</td>
      <td data-label="Theme">${escapeHtml(video.theme || "")}</td>
      <td data-label="Target">${escapeHtml(video.target_date || "-")}</td>
      <td data-label="Kualitas">${escapeHtml(video.quality_profile || "standard")}</td>
      <td data-label="URL"><a href="${escapeAttr(video.url)}" target="_blank" rel="noreferrer">${escapeHtml(short(video.url, 60))}</a></td>
    </tr>
  `
    );
  els.videoRows.innerHTML = rows.join("") || `<tr><td colspan="5" class="emptyRow">Belum ada link.</td></tr>`;
  toggleMoreButton(els.videosMore, total, videoLimit);
}

function renderJobs(jobs) {
  cachedJobs = jobs;
  const total = jobs.length;
  els.jobCount.textContent = `${total} item`;
  const rows = [...jobs]
    .reverse()
    .slice(0, jobLimit)
    .map(
      (job) => `
    <tr>
      <td data-label="Status">${pill(job.status)}</td>
      <td data-label="Job">${escapeHtml(short(job.job_id || "", 24))}</td>
      <td data-label="IG">${job.instagram_media_id ? link(`https://www.instagram.com/p/${job.instagram_media_id}`, job.instagram_status || "published") : escapeHtml(job.instagram_status || "-")}</td>
      <td data-label="FB">${job.facebook_url ? link(job.facebook_url, job.facebook_status || "published") : escapeHtml(job.facebook_status || "-")}</td>
      <td data-label="YT">${job.youtube_url ? link(job.youtube_url, job.youtube_status || "published") : escapeHtml(job.youtube_status || "-")}</td>
      <td data-label="TT">${job.tiktok_publish_id ? escapeHtml(short(job.tiktok_status || "submitted", 18)) : escapeHtml(job.tiktok_status || "-")}</td>
      <td data-label="TH">${job.threads_media_id ? (job.threads_url ? link(job.threads_url, job.threads_status || "published") : escapeHtml(short(job.threads_status || "published", 18))) : escapeHtml(job.threads_status || "-")}</td>
      <td data-label="Error">${escapeHtml(short(job.error_message || job.instagram_error || job.facebook_error || job.youtube_error || job.tiktok_error || job.threads_error || "", 50))}</td>
    </tr>
  `
    );
  els.jobRows.innerHTML = rows.join("") || `<tr><td colspan="8" class="emptyRow">Belum ada job.</td></tr>`;
  toggleMoreButton(els.jobsMore, total, jobLimit);
}

function toggleMoreButton(button, total, limit) {
  if (!button) return;
  if (total <= ROW_LIMIT_DEFAULT) {
    button.hidden = true;
    return;
  }
  button.hidden = false;
  const expanded = limit > ROW_LIMIT_DEFAULT;
  button.textContent = expanded ? "Show less" : `Show more (${total - ROW_LIMIT_DEFAULT})`;
}

function showAuth(message = "") {
  authVisible = true;
  document.body.classList.add("authLocked");
  if (!els.authOverlay) return;
  els.authOverlay.classList.add("active");
  els.authOverlay.setAttribute("aria-hidden", "false");
  els.authError.textContent = message;
  window.setTimeout(() => els.authPin?.focus(), 30);
  stopPolling();
}

function hideAuth() {
  if (!authVisible) return;
  authVisible = false;
  document.body.classList.remove("authLocked");
  if (!els.authOverlay) return;
  els.authOverlay.classList.remove("active");
  els.authOverlay.setAttribute("aria-hidden", "true");
  els.authError.textContent = "";
  schedulePoll();
}

function handleApiError(error, target = els.runDetail) {
  if (error.status === 401 || error.status === 403 || /PIN|AUTO_DASHBOARD_PIN/i.test(error.message)) {
    window.sessionStorage.removeItem("dashboardPin");
    dashboardPin = "";
    showAuth(error.message);
    return;
  }
  if (target) target.textContent = error.message;
}

function pollIntervalMs() {
  if (document.hidden) return null;
  if (authVisible) return null;
  return lastRunStatus === "running" ? POLL_ACTIVE_MS : POLL_IDLE_MS;
}

function schedulePoll() {
  stopPolling();
  const ms = pollIntervalMs();
  if (ms === null) return;
  pollTimer = window.setTimeout(async () => {
    try {
      await refresh();
    } catch (error) {
      handleApiError(error);
    } finally {
      schedulePoll();
    }
  }, ms);
}

function stopPolling() {
  if (pollTimer) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling();
    return;
  }
  if (authVisible) return;
  refresh().catch((error) => handleApiError(error));
  schedulePoll();
});

els.refreshBtn.addEventListener("click", () => {
  refresh().catch((error) => handleApiError(error));
});

els.videosMore?.addEventListener("click", () => {
  videoLimit = videoLimit > ROW_LIMIT_DEFAULT ? ROW_LIMIT_DEFAULT : ROW_LIMIT_EXPANDED;
  renderVideos(cachedVideos);
});

els.jobsMore?.addEventListener("click", () => {
  jobLimit = jobLimit > ROW_LIMIT_DEFAULT ? ROW_LIMIT_DEFAULT : ROW_LIMIT_EXPANDED;
  renderJobs(cachedJobs);
});

els.preflightBtn.addEventListener("click", async () => {
  els.runStatus.textContent = "preflight";
  els.runDetail.textContent = "Cek SFTP, token platform, dan workflow engine.";
  try {
    const report = await api("/api/preflight", { method: "POST", body: "{}" });
    const failed = (report.checks || []).filter((item) => !item.ok && item.required);
    els.runDetail.textContent = failed.length
      ? `Gagal: ${failed.map((item) => item.name).join(", ")}`
      : "Preflight OK.";
    els.consoleOutput.textContent = (report.checks || [])
      .map((item) => `${item.ok ? "OK  " : item.required ? "FAIL" : "WARN"} ${item.name}${item.detail ? ` — ${item.detail}` : ""}`)
      .join("\n");
    els.consoleMeta.textContent = `${(report.checks || []).length} check`;
  } catch (error) {
    handleApiError(error);
  }
});

els.videoForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setSubmittersDisabled(true);
  try {
    const payload = formData(els.videoForm);
    payload.priority = Number(payload.priority || 1);
    payload.clip_count = Number(payload.clip_count || 1);
    Object.assign(payload, readEffectOptions(els.videoForm));
    await api("/api/videos", { method: "POST", body: JSON.stringify(payload) });
    els.videoForm.reset();
    els.videoForm.elements.theme.value = "podcast artis";
    els.videoForm.elements.priority.value = "1";
    els.videoForm.elements.quality_profile.value = "standard";
    if (els.videoForm.elements.ai_provider) els.videoForm.elements.ai_provider.value = "gemini";
    if (els.videoForm.elements.scene_mode) els.videoForm.elements.scene_mode.value = "podcast";
    if (els.videoForm.elements.clip_count) els.videoForm.elements.clip_count.value = "1";
    resetEffectOptions(els.videoForm);
    await refresh();
  } catch (error) {
    setSubmittersDisabled(false);
    handleApiError(error);
  }
});

els.runForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setSubmittersDisabled(true);
  try {
    const payload = formData(els.runForm);
    payload.publish = els.runForm.elements.publish.checked;
    payload.clip_count = Number(payload.clip_count || 1);
    Object.assign(payload, readEffectOptions(els.runForm));
    await api("/api/run", { method: "POST", body: JSON.stringify(payload) });
    await refresh();
  } catch (error) {
    setSubmittersDisabled(false);
    handleApiError(error);
  }
});

els.authForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const pin = els.authPin.value.trim();
  if (!pin) {
    els.authError.textContent = "PIN wajib diisi.";
    return;
  }
  try {
    await api("/api/auth", { method: "POST", body: JSON.stringify({ pin }) });
    dashboardPin = pin;
    window.sessionStorage.setItem("dashboardPin", pin);
    hideAuth();
    await refresh();
  } catch (error) {
    els.authError.textContent = error.message;
  }
});

els.logoutBtn?.addEventListener("click", async () => {
  window.sessionStorage.removeItem("dashboardPin");
  dashboardPin = "";
  await api("/api/auth", { method: "DELETE" }).catch(() => {});
  showAuth("Anda sudah keluar.");
});

refresh().catch((error) => handleApiError(error));

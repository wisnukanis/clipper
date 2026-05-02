const stateUrl = "/api/state";
const dashboardPin = new URLSearchParams(window.location.search).get("pin") || window.sessionStorage.getItem("dashboardPin") || "";

if (dashboardPin) {
  window.sessionStorage.setItem("dashboardPin", dashboardPin);
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
  runDetail: document.querySelector("#runDetail"),
  videoForm: document.querySelector("#videoForm"),
  runForm: document.querySelector("#runForm"),
  runStatus: document.querySelector("#runStatus"),
  settingsForm: document.querySelector("#settingsForm"),
  settingsGrid: document.querySelector("#settingsGrid"),
  settingsMeta: document.querySelector("#settingsMeta"),
  settingsStatus: document.querySelector("#settingsStatus"),
  consoleOutput: document.querySelector("#consoleOutput"),
  consoleMeta: document.querySelector("#consoleMeta"),
  videoRows: document.querySelector("#videoRows"),
  videoCount: document.querySelector("#videoCount"),
  jobRows: document.querySelector("#jobRows"),
  jobCount: document.querySelector("#jobCount")
};

let settingsLoaded = false;

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (dashboardPin) headers["X-Dashboard-Pin"] = dashboardPin;

  const response = await fetch(path, {
    headers,
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request gagal.");
  return data;
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

function short(value, length = 54) {
  const text = String(value || "");
  if (text.length <= length) return text;
  return `${text.slice(0, length - 1)}...`;
}

async function refresh() {
  const state = await api(stateUrl);
  const cfg = state.config || {};
  els.configLine.textContent = [
    cfg.dryRun ? "dry-run" : "live",
    cfg.autoPublish ? "publish on" : "publish off",
    `upload ${cfg.uploadDriver}`,
    `IG ${cfg.instagramEnabled ? "on" : "off"}`,
    `FB ${cfg.facebookEnabled ? "on" : "off"}`,
    `YT ${cfg.youtubeEnabled ? "on" : "off"}`,
    cfg.timezone
  ].join(" | ");

  renderVideos(state.videos || []);
  renderJobs(state.jobs || []);
  renderMetrics(state);
  renderWorkflow(state);
  renderRun(state.activeRun);
  renderConsole(state.activeRun);

  if (!settingsLoaded) {
    await loadSettings();
  }
}

async function loadSettings() {
  const settings = await api("/api/settings");
  renderSettings(settings);
  settingsLoaded = true;
}

function renderMetrics(state) {
  const videos = state.videos || [];
  const jobs = state.jobs || [];
  const published = jobs.filter((job) => job.status === "published").length;
  const warnings = jobs.filter((job) => job.publish_status === "published_with_warnings").length;
  const failed = jobs.filter((job) => String(job.status || "").includes("failed")).length;
  const queued = videos.filter((video) => video.status === "queued").length;
  els.metrics.innerHTML = [
    metric("Queued", queued, "amber"),
    metric("Published", published, "green"),
    metric("Warnings", warnings, "gold"),
    metric("Failed", failed, "red")
  ].join("");
}

function metric(label, value, tone) {
  return `<article class="metric ${tone}"><span>${label}</span><strong>${value}</strong></article>`;
}

function renderWorkflow(state) {
  const jobs = state.jobs || [];
  const activeRun = state.activeRun || null;
  const job = currentJob(jobs, activeRun);
  const steps = workflowSteps(job, activeRun);
  const doneCount = steps.filter((item) => item.state === "done").length;
  const progress = Math.round((doneCount / steps.length) * 100);

  els.workflowTitle.textContent = job?.job_id || activeRun?.id || "Menunggu proses";
  els.workflowMeta.textContent = workflowMeta(job, activeRun);
  els.progressBar.style.width = `${activeRun?.status === "running" ? Math.max(progress, 12) : progress}%`;
  els.workflowGraph.innerHTML = steps.map((step, index) => {
    const next = steps[index + 1];
    const edge = next ? `<div class="flowEdge ${edgeState(step, next)}"><span></span></div>` : "";
    return `${workflowNode(step, index + 1)}${edge}`;
  }).join("");
}

function currentJob(jobs, activeRun) {
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

function workflowMeta(job, activeRun) {
  if (activeRun?.status === "running") return `Running ${job?.job_id || activeRun.id || ""}`.trim();
  if (!job) return "Belum ada job";
  return `${job.job_id || "job"} | ${job.publish_status || job.status || "selected"}`;
}

function workflowSteps(job, activeRun) {
  const activeWithoutJob = activeRun?.status === "running" && !job;
  if (!job) {
    return [
      step("Queue", activeWithoutJob ? "active" : "pending", activeWithoutJob ? "Memilih video" : "Menunggu link"),
      step("Clipper", "pending", "Belum mulai"),
      step("Caption", "pending", "Belum mulai"),
      step("Thumbnail", "pending", "Belum mulai"),
      step("FTP", "pending", "Belum mulai"),
      step("Instagram", "pending", "Belum mulai"),
      step("Facebook", "pending", "Belum mulai"),
      step("YouTube", "pending", "Belum mulai"),
      step("History", "pending", "Belum mulai")
    ];
  }

  const failed = isFailed(job.status) || Boolean(job.error_message);
  const clipperDone = job.clipper_status === "done" || Boolean(job.final_video_path);
  const captionDone = job.caption_status === "done" || Boolean(job.caption);
  const thumbnailDone = job.thumbnail_status === "done" || Boolean(job.thumbnail_path);
  const ftpDone = Boolean(job.public_video_url);
  const published = job.status === "published" || job.publish_status === "published" || job.publish_status === "published_with_warnings";

  return [
    step("Queue", "done", job.youtube_video_id || "Selected"),
    step("Clipper", stageState({
      failed: failed && !clipperDone,
      active: job.clipper_status === "processing" || job.status === "clipper_processing",
      done: clipperDone
    }), stageText(job.clipper_status, clipperDone ? "MP4 siap" : "Render video")),
    step("Caption", stageState({
      failed: failed && clipperDone && !captionDone,
      active: clipperDone && !captionDone && !failed,
      done: captionDone
    }), stageText(job.caption_status, captionDone ? "Caption siap" : "Buat caption")),
    step("Thumbnail", stageState({
      failed: failed && captionDone && !thumbnailDone,
      active: captionDone && !thumbnailDone && !failed,
      done: thumbnailDone
    }), stageText(job.thumbnail_status, thumbnailDone ? "Thumbnail siap" : "Buat thumbnail")),
    step("FTP", stageState({
      failed: failed && thumbnailDone && !ftpDone,
      active: thumbnailDone && !ftpDone && !failed,
      done: ftpDone
    }), ftpDone ? "Public URL valid" : "Upload file"),
    platformStep("Instagram", job.instagram_status, Boolean(job.instagram_media_id), ftpDone, failed),
    platformStep("Facebook", job.facebook_status, Boolean(job.facebook_video_id || job.facebook_post_id), ftpDone, failed),
    platformStep("YouTube", job.youtube_status, Boolean(job.youtube_url), ftpDone, failed),
    step("History", stageState({
      failed,
      active: !published && (job.status === "publishing" || job.status === "ready_to_publish"),
      done: published
    }), published ? "Published" : job.publish_status || job.status || "Menunggu")
  ];
}

function platformStep(label, status, hasResult, ftpDone, failed) {
  const normalized = String(status || "").toLowerCase();
  const disabled = normalized === "disabled";
  return step(label, stageState({
    failed: isFailed(status) || (failed && ftpDone && !hasResult && !disabled),
    active: ftpDone && normalized === "processing" && !failed,
    done: hasResult || normalized === "published",
    muted: disabled || normalized === "skipped"
  }), hasResult ? "Published" : status || "Menunggu");
}

function step(label, state, detail) {
  return { label, state, detail };
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

function workflowNode(step, index) {
  return `
    <article class="flowNode ${step.state}">
      <span class="flowIndex">${index}</span>
      <strong>${escapeHtml(step.label)}</strong>
      <small>${escapeHtml(step.detail || "")}</small>
    </article>
  `;
}

function renderVideos(videos) {
  els.videoCount.textContent = `${videos.length} item`;
  const rows = [...videos].reverse().slice(0, 80).map((video) => `
    <tr>
      <td>${pill(video.status)}</td>
      <td>${escapeHtml(video.theme || "")}</td>
      <td>${escapeHtml(video.target_date || "-")}</td>
      <td>${escapeHtml(video.priority || 1)}</td>
      <td>${escapeHtml(video.quality_profile || "standard")}</td>
      <td>${escapeHtml(short(`${video.subtitle_font || "Georgia"} ${video.subtitle_font_size || 46}px / ${video.subtitle_margin_v || 400}`, 34))}</td>
      <td>${escapeHtml(video.youtube_video_id || "-")}</td>
      <td><a href="${escapeAttr(video.url)}" target="_blank" rel="noreferrer">${escapeHtml(short(video.url, 72))}</a></td>
    </tr>
  `);
  els.videoRows.innerHTML = rows.join("") || `<tr><td colspan="8">Belum ada link.</td></tr>`;
}

function renderJobs(jobs) {
  els.jobCount.textContent = `${jobs.length} item`;
  const rows = [...jobs].reverse().slice(0, 80).map((job) => `
    <tr>
      <td>${pill(job.status)}</td>
      <td>${escapeHtml(job.job_id || "")}</td>
      <td>${escapeHtml(job.theme || "")}</td>
      <td>${escapeHtml(job.youtube_video_id || "-")}</td>
      <td>${job.instagram_media_id ? link(`https://www.instagram.com/p/${job.instagram_media_id}`, job.instagram_status || "published") : escapeHtml(job.instagram_status || "-")}</td>
      <td>${job.facebook_url ? link(job.facebook_url, job.facebook_status || "published") : escapeHtml(job.facebook_status || "-")}</td>
      <td>${job.youtube_url ? link(job.youtube_url, job.youtube_status || "published") : escapeHtml(job.youtube_status || "-")}</td>
      <td>${job.public_video_url ? link(job.public_video_url, "video") : "-"}</td>
      <td>${escapeHtml(short(job.error_message || job.instagram_error || job.facebook_error || job.youtube_error || "", 88))}</td>
    </tr>
  `);
  els.jobRows.innerHTML = rows.join("") || `<tr><td colspan="9">Belum ada job.</td></tr>`;
}

function renderRun(run) {
  if (!run) {
    els.runStatus.textContent = "Idle";
    els.runDetail.textContent = "Siap menerima link YouTube atau menjalankan queue.";
    return;
  }
  const extra = run.error ? run.error : run.result ? run.result.status : "Workflow berjalan";
  els.runStatus.textContent = run.status;
  els.runDetail.textContent = extra;
}

function renderConsole(run) {
  const logs = run?.logs || [];
  els.consoleMeta.textContent = `${logs.length} log`;
  els.consoleOutput.textContent = logs.length
    ? logs.map((item) => `[${new Date(item.at).toLocaleTimeString()}] ${item.level.toUpperCase()} ${item.text}`).join("\n")
    : "Belum ada output.";
  els.consoleOutput.scrollTop = els.consoleOutput.scrollHeight;
}

function renderSettings(settings) {
  els.settingsMeta.textContent = settings.envFile || ".env";
  els.settingsGrid.innerHTML = (settings.groups || []).map((group) => `
    <fieldset class="settingGroup">
      <legend>${escapeHtml(group.title)}</legend>
      ${(group.fields || []).map(settingField).join("")}
    </fieldset>
  `).join("");
}

function settingField(item) {
  const type = item.sensitive ? "password" : inferInputType(item.key);
  const placeholder = item.sensitive && item.configured ? `tersimpan: ${item.masked}` : "";
  return `
    <label class="settingField">
      <span>${escapeHtml(item.label)}</span>
      <input
        name="${escapeAttr(item.key)}"
        type="${type}"
        value="${item.sensitive ? "" : escapeAttr(item.value || "")}"
        placeholder="${escapeAttr(placeholder)}"
        data-sensitive="${item.sensitive ? "1" : "0"}"
        autocomplete="off">
    </label>
  `;
}

function inferInputType(key) {
  if (/_PORT$|_SIZE$|_SECONDS$|_COUNT$|_DAYS$|_BYTES$|_MARGIN_|_LINES$|_OUTLINE$|_SHADOW$/.test(key)) return "number";
  return "text";
}

function link(url, text) {
  return `<a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">${escapeHtml(short(text, 28))}</a>`;
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

els.refreshBtn.addEventListener("click", () => {
  settingsLoaded = false;
  refresh().catch((error) => {
    els.runDetail.textContent = error.message;
  });
});

els.preflightBtn.addEventListener("click", async () => {
  els.runStatus.textContent = "preflight";
  els.runDetail.textContent = "Cek FTP, token platform, dan YouTube tanpa memakai Gemini.";
  try {
    const report = await api("/api/preflight", { method: "POST", body: "{}" });
    const failed = (report.checks || []).filter((item) => !item.ok && item.required);
    els.runDetail.textContent = failed.length ? `Gagal: ${failed.map((item) => item.name).join(", ")}` : "Preflight OK.";
    els.consoleOutput.textContent = (report.checks || [])
      .map((item) => `${item.ok ? "OK" : item.required ? "FAIL" : "WARN"} ${item.name}${item.detail ? ` - ${item.detail}` : ""}`)
      .join("\n");
  } catch (error) {
    els.runDetail.textContent = error.message;
  }
});

els.videoForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = formData(els.videoForm);
  payload.priority = Number(payload.priority || 1);
  await api("/api/videos", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  els.videoForm.reset();
  els.videoForm.elements.theme.value = "podcast artis";
  els.videoForm.elements.priority.value = "1";
  els.videoForm.elements.quality_profile.value = "standard";
  els.videoForm.elements.subtitle_font.value = "Georgia";
  els.videoForm.elements.subtitle_font_size.value = "46";
  els.videoForm.elements.subtitle_margin_v.value = "400";
  await refresh();
});

els.runForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = formData(els.runForm);
  payload.publish = els.runForm.elements.publish.checked;
  await api("/api/run", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  await refresh();
});

els.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = {};
  for (const input of els.settingsForm.querySelectorAll("input[name]")) {
    if (input.dataset.sensitive === "1" && !input.value.trim()) continue;
    values[input.name] = input.value.trim();
  }
  const result = await api("/api/settings", {
    method: "POST",
    body: JSON.stringify({ values })
  });
  els.settingsStatus.textContent = `${result.updated.length} setting disimpan.`;
  renderSettings(result.settings);
});

refresh().catch((error) => {
  els.runDetail.textContent = error.message;
});

window.setInterval(() => {
  refresh().catch(() => {});
}, 3000);

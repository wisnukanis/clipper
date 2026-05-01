const stateUrl = "/api/state";

const els = {
  configLine: document.querySelector("#configLine"),
  refreshBtn: document.querySelector("#refreshBtn"),
  metrics: document.querySelector("#metrics"),
  workflowGraph: document.querySelector("#workflowGraph"),
  workflowMeta: document.querySelector("#workflowMeta"),
  videoForm: document.querySelector("#videoForm"),
  runForm: document.querySelector("#runForm"),
  runStatus: document.querySelector("#runStatus"),
  videoRows: document.querySelector("#videoRows"),
  videoCount: document.querySelector("#videoCount"),
  jobRows: document.querySelector("#jobRows"),
  jobCount: document.querySelector("#jobCount")
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
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
  const safe = String(status || "queued").replace(/[^a-z0-9_-]/gi, "_");
  return `<span class="pill ${safe}">${status || "queued"}</span>`;
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
    `mode ${cfg.dryRun ? "dry-run" : "live"}`,
    `publish ${cfg.autoPublish ? "enabled" : "disabled"}`,
    `upload ${cfg.uploadDriver}`,
    `${cfg.timezone}`,
    `cron ${cfg.postCron}`
  ].join(" | ");

  renderVideos(state.videos || []);
  renderJobs(state.jobs || []);
  renderMetrics(state);
  renderWorkflow(state);
  renderRun(state.activeRun);
}

function renderMetrics(state) {
  const videos = state.videos || [];
  const jobs = state.jobs || [];
  const published = jobs.filter((job) => job.status === "published").length;
  const ready = jobs.filter((job) => job.status === "ready_to_publish").length;
  const failed = jobs.filter((job) => String(job.status || "").includes("failed")).length;
  const queued = videos.filter((video) => video.status === "queued").length;
  els.metrics.innerHTML = [
    metric("Queued", queued),
    metric("Ready", ready),
    metric("Published", published),
    metric("Failed", failed)
  ].join("");
}

function metric(label, value) {
  return `<article class="metric"><span>${label}</span><strong>${value}</strong></article>`;
}

function renderWorkflow(state) {
  const jobs = state.jobs || [];
  const activeRun = state.activeRun || null;
  const job = currentJob(jobs, activeRun);
  const steps = workflowSteps(job, activeRun);

  els.workflowMeta.textContent = workflowMeta(job, activeRun);
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
  return `${job.job_id || "job"} | ${job.status || "selected"}`;
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
      step("YouTube", "pending", "Belum mulai"),
      step("History", "pending", "Belum mulai")
    ];
  }

  const failed = isFailed(job.status) || Boolean(job.error_message);
  const clipperDone = job.clipper_status === "done" || Boolean(job.final_video_path);
  const captionDone = job.caption_status === "done" || Boolean(job.caption);
  const thumbnailDone = job.thumbnail_status === "done" || Boolean(job.thumbnail_path);
  const ftpDone = Boolean(job.public_video_url);
  const published = job.status === "published" || job.publish_status === "published";

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

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderVideos(videos) {
  els.videoCount.textContent = `${videos.length} item`;
  const rows = [...videos].reverse().slice(0, 80).map((video) => `
    <tr>
      <td>${pill(video.status)}</td>
      <td>${video.theme || ""}</td>
      <td>${video.target_date || "-"}</td>
      <td>${video.priority || 1}</td>
      <td>${video.quality_profile || "standard"}</td>
      <td>${short(`${video.subtitle_font || "Segoe UI"} ${video.subtitle_font_size || 48}px`, 28)}</td>
      <td>${video.youtube_video_id || "-"}</td>
      <td><a href="${video.url}" target="_blank" rel="noreferrer">${short(video.url, 72)}</a></td>
    </tr>
  `);
  els.videoRows.innerHTML = rows.join("") || `<tr><td colspan="8">Belum ada link.</td></tr>`;
}

function renderJobs(jobs) {
  els.jobCount.textContent = `${jobs.length} item`;
  const rows = [...jobs].reverse().slice(0, 80).map((job) => `
    <tr>
      <td>${pill(job.status)}</td>
      <td>${job.job_id || ""}</td>
      <td>${job.theme || ""}</td>
      <td>${job.youtube_video_id || "-"}</td>
      <td>${job.instagram_media_id ? link(`https://www.instagram.com/p/${job.instagram_media_id}`, job.instagram_status || "published") : (job.instagram_status || "-")}</td>
      <td>${job.youtube_url ? link(job.youtube_url, job.youtube_status || "published") : (job.youtube_status || "-")}</td>
      <td>${job.public_video_url ? link(job.public_video_url, "video") : "-"}</td>
      <td>${short(job.error_message || "", 80)}</td>
    </tr>
  `);
  els.jobRows.innerHTML = rows.join("") || `<tr><td colspan="8">Belum ada job.</td></tr>`;
}

function link(url, text) {
  return `<a href="${url}" target="_blank" rel="noreferrer">${short(text, 28)}</a>`;
}

function renderRun(run) {
  if (!run) {
    els.runStatus.textContent = "Idle";
    return;
  }
  const extra = run.error ? `: ${run.error}` : run.result ? `: ${run.result.status}` : "";
  els.runStatus.textContent = `${run.status}${extra}`;
}

els.refreshBtn.addEventListener("click", () => {
  refresh().catch((error) => {
    els.runStatus.textContent = error.message;
  });
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
  els.videoForm.elements.subtitle_font.value = "Segoe UI Semibold";
  els.videoForm.elements.subtitle_font_size.value = "48";
  els.videoForm.elements.subtitle_margin_v.value = "240";
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

refresh().catch((error) => {
  els.runStatus.textContent = error.message;
});

window.setInterval(() => {
  refresh().catch(() => {});
}, 3000);

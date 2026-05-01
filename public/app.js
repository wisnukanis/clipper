const stateUrl = "/api/state";

const els = {
  configLine: document.querySelector("#configLine"),
  refreshBtn: document.querySelector("#refreshBtn"),
  metrics: document.querySelector("#metrics"),
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

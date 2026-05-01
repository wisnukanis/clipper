import express from "express";
import path from "node:path";
import { config } from "./config.js";
import { ensureProjectDirs, patchItem, readJson, upsertItem } from "./storage.js";
import { addVideo } from "./selector.js";
import { runWorkflow } from "./workflow.js";
import { makeId } from "./job-id.js";
import { downloadStateFromRemote, uploadStateToRemote } from "./state-sync.js";

await ensureProjectDirs();
await downloadStateFromRemote().catch(() => {});

const app = express();
app.use(express.json({ limit: "1mb" }));

let activeRun = null;

app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || "";
  const local = ip === "::1" || ip === "127.0.0.1" || ip === "::ffff:127.0.0.1";
  if (local) return next();
  if (!config.dashboardAllowRemote) {
    res.status(403).json({ error: "Dashboard hanya aktif untuk localhost." });
    return;
  }

  if (!req.path.startsWith("/api/")) return next();

  if (!config.dashboardPin) {
    res.status(403).json({ error: "AUTO_DASHBOARD_PIN wajib diisi untuk akses remote." });
    return;
  }

  const pin = req.get("x-dashboard-pin") || req.query.pin || "";
  if (pin === config.dashboardPin) return next();

  res.status(401).json({ error: "PIN dashboard tidak valid atau belum diisi." });
});

app.get("/api/state", async (_req, res) => {
  res.json({
    config: {
      dryRun: config.dryRun,
      autoPublish: config.autoPublish,
      uploadDriver: config.uploadDriver,
      defaultTheme: config.defaultTheme,
      publicBaseUrl: config.publicBaseUrl,
      postCron: config.postCron,
      timezone: config.timezone
    },
    activeRun,
    themes: await readJson("themes", []),
    videos: await readJson("videos", []),
    prompts: await readJson("prompts", []),
    jobs: await readJson("jobs", []),
    history: await readJson("history", [])
  });
});

app.post("/api/videos", async (req, res) => {
  try {
    const video = await addVideo(req.body || {});
    await syncState();
    res.json(video);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch("/api/videos/:id", async (req, res) => {
  const item = await patchItem("videos", req.params.id, req.body || {});
  if (!item) {
    res.status(404).json({ error: "Video tidak ditemukan." });
    return;
  }
  await syncState();
  res.json(item);
});

app.post("/api/themes", async (req, res) => {
  const now = new Date().toISOString();
  const item = {
    id: req.body.id || makeId("theme"),
    name: req.body.name || "podcast",
    status: req.body.status || "active",
    language: req.body.language || "id",
    caption_style: req.body.caption_style || "natural",
    post_per_day: Number(req.body.post_per_day || 1),
    created_at: now,
    updated_at: now
  };
  await upsertItem("themes", item);
  await syncState();
  res.json(item);
});

app.patch("/api/themes/:id", async (req, res) => {
  const item = await patchItem("themes", req.params.id, req.body || {});
  if (!item) {
    res.status(404).json({ error: "Theme tidak ditemukan." });
    return;
  }
  await syncState();
  res.json(item);
});

app.post("/api/prompts", async (req, res) => {
  const item = {
    id: req.body.id || makeId("prompt"),
    theme: req.body.theme || "podcast artis",
    hook_style: req.body.hook_style || "emotional curiosity",
    language: req.body.language || "id",
    cta: req.body.cta || "Menurut kamu bagaimana?",
    hashtag_template: req.body.hashtag_template || "#PodcastIndonesia #ReelsIndonesia",
    thumbnail_style: req.body.thumbnail_style || "singkat dan kuat",
    updated_at: new Date().toISOString()
  };
  await upsertItem("prompts", item);
  await syncState();
  res.json(item);
});

app.patch("/api/prompts/:id", async (req, res) => {
  const item = await patchItem("prompts", req.params.id, req.body || {});
  if (!item) {
    res.status(404).json({ error: "Prompt tidak ditemukan." });
    return;
  }
  await syncState();
  res.json(item);
});

app.post("/api/run", async (req, res) => {
  if (activeRun?.status === "running") {
    res.status(409).json({ error: "Masih ada workflow berjalan." });
    return;
  }

  const body = req.body || {};
  activeRun = {
    id: makeId("run"),
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: "",
    error: "",
    result: null
  };

  runWorkflow({
    publish: Boolean(body.publish),
    theme: body.theme || config.defaultTheme,
    url: body.url || "",
    range: body.range || "",
    qualityProfile: body.quality_profile || "standard",
    subtitleFont: body.subtitle_font || "Segoe UI Semibold",
    subtitleFontSize: Number(body.subtitle_font_size || 48),
    subtitleMarginV: Number(body.subtitle_margin_v || 240)
  })
    .then((result) => {
      activeRun = {
        ...activeRun,
        status: "completed",
        finishedAt: new Date().toISOString(),
        result
      };
    })
    .catch((error) => {
      activeRun = {
        ...activeRun,
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: error.message
      };
    });

  res.json(activeRun);
});

app.use(express.static(config.publicDir));
app.use((_req, res) => {
  res.sendFile(path.join(config.publicDir, "index.html"));
});

async function listenWithFallback(startPort) {
  let port = startPort;
  while (port < startPort + 20) {
    try {
      await new Promise((resolve, reject) => {
        const server = app.listen(port, "127.0.0.1");
        server.once("listening", resolve);
        server.once("error", reject);
      });
      return port;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      port += 1;
    }
  }
  throw new Error("Tidak ada port kosong untuk dashboard.");
}

const port = await listenWithFallback(config.localPort);
console.log(`Dashboard aktif: http://localhost:${port}`);

async function syncState() {
  try {
    await uploadStateToRemote();
  } catch (error) {
    console.warn(`State FTP sync dilewati: ${error.message}`);
  }
}

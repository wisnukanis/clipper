import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { config, reloadConfigFromEnv } from "./config.js";
import { ensureProjectDirs, patchItem, readJson, upsertItem } from "./storage.js";
import { addVideo } from "./selector.js";
import { runWorkflow } from "./workflow.js";
import { makeId } from "./job-id.js";
import { downloadStateFromRemote, uploadStateToRemote } from "./state-sync.js";
import { runPreflight } from "./preflight.js";

await ensureProjectDirs();
await downloadStateFromRemote().catch(() => {});

const app = express();
app.use(express.json({ limit: "1mb" }));

let activeRun = null;

const envFilePath = path.join(config.rootDir, ".env");
const sensitiveEnvKeys = new Set([
  "AUTO_DASHBOARD_PIN",
  "FTP_PASSWORD",
  "INSTAGRAM_ACCESS_TOKEN",
  "FACEBOOK_PAGE_ACCESS_TOKEN",
  "FACEBOOK_USER_ACCESS_TOKEN",
  "TIKTOK_CLIENT_SECRET",
  "TIKTOK_ACCESS_TOKEN",
  "TIKTOK_REFRESH_TOKEN",
  "META_APP_SECRET",
  "YOUTUBE_CLIENT_SECRET",
  "YOUTUBE_REFRESH_TOKEN",
  "GEMINI_API_KEY",
  "GEMINI_API_KEY_2",
  "GEMINI_API_KEY_3",
  "GEMINI_API_KEYS",
  "CLOD_API_KEY",
  "DEEPGRAM_API_KEY",
  "DEEPGRAM_API_KEYS",
  "YTDLP_COOKIES_TXT"
]);

const envGroups = [
  {
    id: "core",
    title: "Core",
    fields: [
      field("PUBLIC_BASE_URL", "Public base URL"),
      field("UPLOAD_DRIVER", "Upload driver"),
      field("DRY_RUN", "Dry run"),
      field("AUTO_PUBLISH", "Auto publish"),
      field("DEFAULT_THEME", "Default theme"),
      field("APP_TIMEZONE", "Timezone"),
      field("LOCAL_PORT", "Local port"),
      field("AUTO_DASHBOARD_PIN", "Dashboard PIN", true)
    ]
  },
  {
    id: "ftp",
    title: "FTP",
    fields: [
      field("FTP_HOST", "Host"),
      field("FTP_PORT", "Port"),
      field("FTP_USER", "User"),
      field("FTP_PASSWORD", "Password", true),
      field("FTP_REMOTE_DIR", "Remote dir"),
      field("FTP_TIMEOUT_SECONDS", "Timeout seconds")
    ]
  },
  {
    id: "meta",
    title: "Meta App",
    fields: [
      field("GRAPH_API_VERSION", "Graph API version"),
      field("META_APP_ID", "App ID"),
      field("META_APP_SECRET", "App Secret", true),
      field("TOKEN_REFRESH_BEFORE_DAYS", "Refresh before days")
    ]
  },
  {
    id: "instagram",
    title: "Instagram",
    fields: [
      field("INSTAGRAM_UPLOAD_ENABLED", "Upload enabled"),
      field("INSTAGRAM_IG_USER_ID", "IG user ID"),
      field("INSTAGRAM_ACCESS_TOKEN", "Access token", true),
      field("INSTAGRAM_REEL_UPLOAD_METHOD", "Upload method"),
      field("INSTAGRAM_MAX_UPLOAD_BYTES", "Max upload bytes"),
      field("AUTO_REFRESH_INSTAGRAM_TOKEN", "Auto refresh token")
    ]
  },
  {
    id: "facebook",
    title: "Facebook Page",
    fields: [
      field("FACEBOOK_UPLOAD_ENABLED", "Upload enabled"),
      field("FACEBOOK_PAGE_ID", "Page ID"),
      field("FACEBOOK_PAGE_ACCESS_TOKEN", "Page access token", true),
      field("FACEBOOK_USER_ACCESS_TOKEN", "User access token", true),
      field("AUTO_REFRESH_FACEBOOK_TOKEN", "Auto refresh token"),
      field("FACEBOOK_MEDIA_TYPE", "Media type"),
      field("FACEBOOK_VIDEO_STATE", "Video state"),
      field("FACEBOOK_TITLE_PREFIX", "Title prefix")
    ]
  },
  {
    id: "youtube",
    title: "YouTube",
    fields: [
      field("YOUTUBE_UPLOAD_ENABLED", "Upload enabled"),
      field("YOUTUBE_CLIENT_ID", "Client ID"),
      field("YOUTUBE_CLIENT_SECRET", "Client secret", true),
      field("YOUTUBE_REFRESH_TOKEN", "Refresh token", true),
      field("YOUTUBE_PRIVACY_STATUS", "Privacy status"),
      field("YOUTUBE_CATEGORY_ID", "Category ID"),
      field("YOUTUBE_TAGS", "Tags"),
      field("YOUTUBE_TITLE_PREFIX", "Title prefix")
    ]
  },
  {
    id: "tiktok",
    title: "TikTok",
    fields: [
      field("TIKTOK_UPLOAD_ENABLED", "Upload enabled"),
      field("TIKTOK_CLIENT_KEY", "Client key"),
      field("TIKTOK_CLIENT_SECRET", "Client secret", true),
      field("TIKTOK_ACCESS_TOKEN", "Access token", true),
      field("TIKTOK_REFRESH_TOKEN", "Refresh token", true),
      field("TIKTOK_OPEN_ID", "Open ID"),
      field("TIKTOK_SCOPE", "Scope"),
      field("TIKTOK_REDIRECT_URI", "Redirect URI"),
      field("TIKTOK_PUBLISH_MODE", "Publish mode"),
      field("TIKTOK_PRIVACY_LEVEL", "Privacy level"),
      field("TIKTOK_DISABLE_DUET", "Disable duet"),
      field("TIKTOK_DISABLE_COMMENT", "Disable comment"),
      field("TIKTOK_DISABLE_STITCH", "Disable stitch")
    ]
  },
  {
    id: "ai",
    title: "AI & Transcript",
    fields: [
      field("GEMINI_API_KEY", "Gemini key 1", true),
      field("GEMINI_API_KEY_2", "Gemini key 2", true),
      field("GEMINI_API_KEY_3", "Gemini key 3", true),
      field("GEMINI_API_KEYS", "Gemini keys list", true),
      field("GEMINI_MODEL", "Gemini model"),
      field("DEEPGRAM_ENABLED", "Deepgram enabled"),
      field("DEEPGRAM_API_KEYS", "Deepgram keys", true),
      field("DEEPGRAM_MODEL", "Deepgram model"),
      field("DEEPGRAM_TIMEOUT_SECONDS", "Deepgram timeout")
    ]
  },
  {
    id: "subtitle",
    title: "Subtitle",
    fields: [
      field("SUBTITLE_FONT_FAMILY", "Font family"),
      field("SUBTITLE_FALLBACK_FONTS", "Fallback fonts"),
      field("SUBTITLE_FONT_SIZE", "Font size"),
      field("SUBTITLE_MIN_FONT_SIZE", "Min font size"),
      field("SUBTITLE_MARGIN_V", "Bottom margin"),
      field("SUBTITLE_MARGIN_H", "Side margin"),
      field("SUBTITLE_MAX_LINES", "Max lines"),
      field("SUBTITLE_PRIMARY_COLOUR", "Primary colour"),
      field("SUBTITLE_OUTLINE_COLOUR", "Outline colour"),
      field("SUBTITLE_SHADOW_COLOUR", "Shadow colour"),
      field("SUBTITLE_BOLD", "Bold"),
      field("SUBTITLE_OUTLINE", "Outline"),
      field("SUBTITLE_SHADOW", "Shadow")
    ]
  }
];

app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || "";
  const local = ip === "::1" || ip === "127.0.0.1" || ip === "::ffff:127.0.0.1";
  if (local) return next();
  if (!config.dashboardAllowRemote) {
    res.status(403).json({ error: "Dashboard hanya aktif untuk localhost." });
    return;
  }

  if (!req.path.startsWith("/api/")) return next();
  if (req.path === "/api/auth") return next();

  if (!config.dashboardPin) {
    res.status(403).json({ error: "AUTO_DASHBOARD_PIN wajib diisi untuk akses remote." });
    return;
  }

  const pin = req.get("x-dashboard-pin") || req.query.pin || "";
  if (pin === config.dashboardPin) return next();

  res.status(401).json({ error: "PIN dashboard tidak valid atau belum diisi." });
});

app.post("/api/auth", (req, res) => {
  if (!config.dashboardPin) {
    res.json({ ok: true, local: true });
    return;
  }

  if (String(req.body?.pin || "") === config.dashboardPin) {
    res.json({ ok: true });
    return;
  }

  res.status(401).json({ error: "PIN dashboard salah." });
});

app.delete("/api/auth", (_req, res) => {
  res.json({ ok: true });
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
      timezone: config.timezone,
      instagramEnabled: config.instagram.enabled,
      facebookEnabled: config.facebook.enabled,
      youtubeEnabled: config.youtube.enabled,
    tiktokEnabled: config.tiktok.enabled,
    subtitleFont: process.env.SUBTITLE_FONT_FAMILY || "Segoe UI Semibold",
    subtitleMarginV: process.env.SUBTITLE_MARGIN_V || "550"
    },
    activeRun,
    themes: await readJson("themes", []),
    videos: await readJson("videos", []),
    prompts: await readJson("prompts", []),
    jobs: await readJson("jobs", []),
    history: await readJson("history", [])
  });
});

app.get("/api/settings", async (_req, res) => {
  res.json(await readDashboardSettings());
});

app.post("/api/settings", async (req, res) => {
  try {
    const result = await saveDashboardSettings(req.body?.values || {});
    reloadConfigFromEnv();
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/preflight", async (_req, res) => {
  try {
    const report = await runPreflight({
      online: true,
      aiOnline: false,
      deepgramOnline: false,
      socialOnline: true,
      youtubeOnline: true,
      ftpOnline: true,
      socialPublishRequired: false
    });
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
    result: null,
    logs: []
  };

  appendRunLog("system", [`Run ${activeRun.id} dimulai.`]);

  captureConsoleForRun(() => runWorkflow({
    publish: Boolean(body.publish),
    theme: body.theme || config.defaultTheme,
    url: body.url || "",
    range: body.range || "",
    qualityProfile: body.quality_profile || "standard",
    subtitleFont: body.subtitle_font || "Segoe UI Semibold",
    subtitleFontSize: Number(body.subtitle_font_size || 46),
    subtitleMarginV: Number(body.subtitle_margin_v || 550)
  }))
    .then((result) => {
      activeRun = {
        ...activeRun,
        status: "completed",
        finishedAt: new Date().toISOString(),
        result
      };
      appendRunLog("system", [`Run selesai: ${result?.status || "completed"}`]);
    })
    .catch((error) => {
      activeRun = {
        ...activeRun,
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: error.message
      };
      appendRunLog("error", [error.message]);
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

function field(key, label, sensitive = false) {
  return {
    key,
    label,
    sensitive: sensitive || sensitiveEnvKeys.has(key)
  };
}

async function readEnvMap() {
  let raw = "";
  try {
    raw = await fs.readFile(envFilePath, "utf8");
  } catch {
    raw = "";
  }

  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [rawKey, ...rest] = trimmed.split("=");
    const key = rawKey.trim();
    values[key] = rest.join("=").trim().replace(/^["']|["']$/g, "");
  }
  return values;
}

async function readDashboardSettings() {
  const fileValues = await readEnvMap();
  return {
    envFile: envFilePath,
    groups: envGroups.map((group) => ({
      ...group,
      fields: group.fields.map((item) => {
        const value = fileValues[item.key] ?? process.env[item.key] ?? "";
        return {
          ...item,
          configured: Boolean(String(value || "").trim()),
          masked: item.sensitive ? maskSecret(value) : "",
          value: item.sensitive ? "" : value
        };
      })
    }))
  };
}

async function saveDashboardSettings(values) {
  const allowed = new Map(envGroups.flatMap((group) => group.fields.map((item) => [item.key, item])));
  const updates = {};

  for (const [key, rawValue] of Object.entries(values || {})) {
    const item = allowed.get(key);
    if (!item) continue;

    const value = normalizeEnvValue(rawValue);
    if (item.sensitive && !value) continue;
    updates[key] = value;
  }

  if (!Object.keys(updates).length) {
    return { ok: true, updated: [], settings: await readDashboardSettings() };
  }

  let raw = "";
  try {
    raw = await fs.readFile(envFilePath, "utf8");
  } catch {
    raw = "";
  }

  const next = updateEnvContent(raw, updates);
  await fs.writeFile(envFilePath, next, "utf8");
  Object.assign(process.env, updates);

  return {
    ok: true,
    updated: Object.keys(updates),
    settings: await readDashboardSettings()
  };
}

function normalizeEnvValue(value) {
  return String(value ?? "").replace(/\r?\n/g, "\\n").trim();
}

function updateEnvContent(raw, updates) {
  const lines = raw.split(/\r?\n/);
  const seen = new Set();
  const next = [];

  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !Object.prototype.hasOwnProperty.call(updates, match[1])) {
      next.push(line);
      continue;
    }

    const key = match[1];
    if (seen.has(key)) continue;
    next.push(`${key}=${updates[key]}`);
    seen.add(key);
  }

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }

  return `${next.join("\n").replace(/\s*$/, "")}\n`;
}

function captureConsoleForRun(callback) {
  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };

  for (const level of Object.keys(original)) {
    console[level] = (...args) => {
      appendRunLog(level, args);
      original[level](...args);
    };
  }

  return Promise.resolve()
    .then(callback)
    .finally(() => {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    });
}

function appendRunLog(level, args) {
  if (!activeRun) return;

  const logs = Array.isArray(activeRun.logs) ? activeRun.logs : [];
  logs.push({
    at: new Date().toISOString(),
    level,
    text: maskSecrets(args.map(formatLogArg).join(" "))
  });
  activeRun.logs = logs.slice(-500);
}

function formatLogArg(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function maskSecrets(text) {
  let masked = String(text || "")
    .replace(/EA[A-Za-z0-9_-]{20,}/g, "[META_TOKEN]")
    .replace(/ya29\.[A-Za-z0-9_.-]+/g, "[GOOGLE_TOKEN]")
    .replace(/\b(act|rft)\.[A-Za-z0-9_.-]{20,}/g, "[TIKTOK_TOKEN]")
    .replace(/AIza[A-Za-z0-9_-]+/g, "[API_KEY]");

  for (const key of sensitiveEnvKeys) {
    const value = process.env[key];
    if (value && String(value).length >= 8) {
      masked = masked.split(String(value)).join(`[${key}]`);
    }
  }
  return masked;
}

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "configured";
  return `${text.slice(0, 3)}...${text.slice(-3)}`;
}

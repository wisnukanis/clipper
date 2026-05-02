import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { Client } from "basic-ftp";

const STATE_FILES = ["themes.json", "videos.json", "prompts.json", "jobs.json", "history.json"];
const SENSITIVE_KEYS = new Set([
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
  "GH_REPO_SECRET_TOKEN",
  "GITHUB_TOKEN",
  "YTDLP_COOKIES_TXT"
]);

export const envGroups = [
  group("Core", [
    field("PUBLIC_BASE_URL", "Public base URL"),
    field("UPLOAD_DRIVER", "Upload driver"),
    field("DRY_RUN", "Dry run"),
    field("AUTO_PUBLISH", "Auto publish"),
    field("DEFAULT_THEME", "Default theme"),
    field("APP_TIMEZONE", "Timezone"),
    field("AUTO_DASHBOARD_PIN", "Dashboard PIN", true)
  ]),
  group("GitHub / Vercel", [
    field("DASHBOARD_GITHUB_REPO", "GitHub repo"),
    field("DASHBOARD_GITHUB_REF", "GitHub ref"),
    field("GH_REPO_SECRET_TOKEN", "GitHub token", true)
  ]),
  group("Discovery", [
    field("AUTO_DISCOVER_VIDEOS", "Auto discover videos"),
    field("AUTO_DISCOVER_QUERY", "Discovery query"),
    field("AUTO_DISCOVER_MAX_RESULTS", "Max search results"),
    field("AUTO_DISCOVER_ADD_COUNT", "Add count")
  ]),
  group("FTP State", [
    field("FTP_HOST", "Host"),
    field("FTP_PORT", "Port"),
    field("FTP_USER", "User"),
    field("FTP_PASSWORD", "Password", true),
    field("FTP_REMOTE_DIR", "Remote dir")
  ]),
  group("Meta", [
    field("GRAPH_API_VERSION", "Graph API version"),
    field("META_APP_ID", "App ID"),
    field("META_APP_SECRET", "App secret", true),
    field("TOKEN_REFRESH_BEFORE_DAYS", "Refresh before days")
  ]),
  group("Instagram", [
    field("INSTAGRAM_UPLOAD_ENABLED", "Upload enabled"),
    field("INSTAGRAM_IG_USER_ID", "IG user ID"),
    field("INSTAGRAM_ACCESS_TOKEN", "Access token", true)
  ]),
  group("Facebook", [
    field("FACEBOOK_UPLOAD_ENABLED", "Upload enabled"),
    field("FACEBOOK_PAGE_ID", "Page ID"),
    field("FACEBOOK_PAGE_ACCESS_TOKEN", "Page token", true),
    field("FACEBOOK_USER_ACCESS_TOKEN", "User token", true)
  ]),
  group("YouTube", [
    field("YOUTUBE_UPLOAD_ENABLED", "Upload enabled"),
    field("YOUTUBE_CLIENT_ID", "Client ID"),
    field("YOUTUBE_CLIENT_SECRET", "Client secret", true),
    field("YOUTUBE_REFRESH_TOKEN", "Refresh token", true),
    field("YOUTUBE_PRIVACY_STATUS", "Privacy")
  ]),
  group("AI", [
    field("GEMINI_API_KEY", "Gemini key 1", true),
    field("GEMINI_API_KEY_2", "Gemini key 2", true),
    field("GEMINI_API_KEY_3", "Gemini key 3", true),
    field("DEEPGRAM_API_KEYS", "Deepgram keys", true)
  ]),
  group("Subtitle", [
    field("SUBTITLE_FONT_FAMILY", "Font family"),
    field("SUBTITLE_FONT_SIZE", "Font size"),
    field("SUBTITLE_MARGIN_V", "Bottom margin")
  ])
];

function group(title, fields) {
  return {
    id: title.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
    title,
    fields
  };
}

function field(key, label, sensitive = false) {
  return { key, label, sensitive: sensitive || SENSITIVE_KEYS.has(key) };
}

export function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export function methodAllowed(req, res, methods) {
  if (methods.includes(req.method)) return true;
  sendJson(res, 405, { error: `Method ${req.method} tidak didukung.` });
  return false;
}

export async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    const rawBody = req.body.trim();
    return rawBody ? JSON.parse(rawBody) : {};
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

export function requireAuth(req, res) {
  const expected = clean(process.env.AUTO_DASHBOARD_PIN);
  if (!expected) {
    sendJson(res, 403, { error: "AUTO_DASHBOARD_PIN belum diset di Vercel Environment." });
    return false;
  }

  const provided = clean(
    req.headers["x-dashboard-pin"]
      || queryValue(req, "pin")
      || cookieValue(req.headers.cookie || "", "clipper_dashboard_pin")
  );

  if (provided === expected) return true;

  sendJson(res, 401, { error: "PIN dashboard tidak valid atau belum diisi." });
  return false;
}

export function setPinCookie(res, pin) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `clipper_dashboard_pin=${encodeURIComponent(pin)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`
  );
}

export function clearPinCookie(res) {
  res.setHeader("Set-Cookie", "clipper_dashboard_pin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

export function settingsPayload() {
  return {
    envFile: "Vercel Environment",
    groups: envGroups.map((group) => ({
      ...group,
      fields: group.fields.map((item) => {
        const value = process.env[item.key] || "";
        return {
          ...item,
          configured: Boolean(clean(value)),
          masked: item.sensitive ? maskSecret(value) : "",
          value: item.sensitive ? "" : value
        };
      })
    }))
  };
}

export async function readState() {
  const entries = await Promise.all(STATE_FILES.map(async (file) => [file, await readStateFile(file)]));
  return Object.fromEntries(entries.map(([file, data]) => [file.replace(/\.json$/, ""), data]));
}

export async function readStateFile(file) {
  const fromRemote = await readStateFileFromPublicBaseUrl(file);
  if (fromRemote) return fromRemote;

  try {
    const raw = await fs.readFile(path.join(process.cwd(), "data", file), "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function readStateFileFromPublicBaseUrl(file) {
  const baseUrl = cleanBaseUrl(process.env.PUBLIC_BASE_URL);
  if (!baseUrl) return null;

  try {
    const response = await fetch(`${baseUrl}/state/${encodeURIComponent(file)}`, {
      cache: "no-store",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function uploadStateFile(file, data) {
  const cfg = ftpConfig();
  const missing = Object.entries(cfg)
    .filter(([key, value]) => key !== "port" && !value)
    .map(([key]) => key.toUpperCase());
  if (missing.length) {
    throw new Error(`FTP env belum lengkap untuk update state: ${missing.join(", ")}`);
  }

  const client = new Client(45000);
  const raw = `${JSON.stringify(data, null, 2)}\n`;
  try {
    await client.access({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      secure: false
    });
    await client.ensureDir(path.posix.join(cfg.remoteDir, "state"));
    await client.uploadFrom(Readable.from([Buffer.from(raw, "utf8")]), file);
  } finally {
    client.close();
  }
}

export function configSummary() {
  return {
    dryRun: boolEnv("DRY_RUN", false),
    autoPublish: boolEnv("AUTO_PUBLISH", true),
    uploadDriver: clean(process.env.UPLOAD_DRIVER || "ftp"),
    defaultTheme: clean(process.env.DEFAULT_THEME || "auto"),
    publicBaseUrl: cleanBaseUrl(process.env.PUBLIC_BASE_URL),
    postCron: clean(process.env.POST_CRON || ""),
    timezone: clean(process.env.APP_TIMEZONE || "Asia/Jakarta"),
    instagramEnabled: boolEnv("INSTAGRAM_UPLOAD_ENABLED", true),
    facebookEnabled: boolEnv("FACEBOOK_UPLOAD_ENABLED", true),
    youtubeEnabled: boolEnv("YOUTUBE_UPLOAD_ENABLED", true),
    tiktokEnabled: boolEnv("TIKTOK_UPLOAD_ENABLED", false),
    subtitleFont: clean(process.env.SUBTITLE_FONT_FAMILY || "Segoe UI"),
    subtitleMarginV: clean(process.env.SUBTITLE_MARGIN_V || "400"),
    vercelDashboard: true
  };
}

export async function getRecentRuns(limit = 5) {
  const token = githubToken();
  if (!token) return [];

  const repo = githubRepo();
  const response = await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=${limit}`, {
    headers: githubHeaders(token),
    cache: "no-store"
  });
  if (!response.ok) return [];
  const data = await response.json();
  return (data.workflow_runs || []).map((run) => ({
    id: run.id,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    event: run.event,
    head_sha: run.head_sha,
    head_branch: run.head_branch,
    run_attempt: run.run_attempt,
    display_title: run.display_title || run.head_commit?.message || "",
    created_at: run.created_at,
    updated_at: run.updated_at,
    html_url: run.html_url
  }));
}

export async function getRunJobs(runId) {
  const token = githubToken();
  if (!token || !runId) return [];

  const repo = githubRepo();
  const response = await fetch(
    `https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs?per_page=30`,
    { headers: githubHeaders(token), cache: "no-store" }
  );
  if (!response.ok) return [];
  const data = await response.json();
  return (data.jobs || []).map((job) => ({
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    started_at: job.started_at,
    completed_at: job.completed_at,
    html_url: job.html_url,
    steps: (job.steps || []).map((step) => ({
      name: step.name,
      status: step.status,
      conclusion: step.conclusion,
      number: step.number,
      started_at: step.started_at,
      completed_at: step.completed_at
    }))
  }));
}

export async function dispatchWorkflow(inputs) {
  const token = githubToken();
  if (!token) throw new Error("GH_REPO_SECRET_TOKEN belum diset di Vercel Environment.");

  const repo = githubRepo();
  const workflow = process.env.DASHBOARD_WORKFLOW_FILE || "podcast-automation.yml";
  const ref = process.env.DASHBOARD_GITHUB_REF || "main";
  const response = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
    {
      method: "POST",
      headers: githubHeaders(token),
      body: JSON.stringify({ ref, inputs })
    }
  );

  if (response.status === 204) {
    return { ok: true, repo, workflow, ref };
  }

  let detail = "";
  try {
    detail = JSON.stringify(await response.json());
  } catch {
    detail = await response.text();
  }
  throw new Error(`Gagal trigger GitHub Actions (${response.status}): ${detail.slice(0, 500)}`);
}

export function buildVideo(input) {
  const url = clean(input.url);
  if (!url) throw new Error("URL wajib diisi.");

  const now = new Date().toISOString();
  return {
    id: input.id || makeId("video"),
    source_type: "youtube_video",
    url,
    source_url: url,
    youtube_video_id: extractYoutubeVideoId(url),
    theme: clean(input.theme || "podcast artis"),
    priority: Number(input.priority || 1),
    target_date: clean(input.target_date || ""),
    active: input.active !== false,
    status: clean(input.status || "queued"),
    notes: clean(input.notes || "Ditambahkan dari dashboard Vercel"),
    manual_range: clean(input.manual_range || ""),
    quality_profile: clean(input.quality_profile || "standard"),
    subtitle_font: clean(input.subtitle_font || process.env.SUBTITLE_FONT_FAMILY || "Segoe UI"),
    subtitle_font_size: Number(input.subtitle_font_size || process.env.SUBTITLE_FONT_SIZE || 46),
    subtitle_margin_v: Number(input.subtitle_margin_v || process.env.SUBTITLE_MARGIN_V || 400),
    force_reprocess: input.force_reprocess === true,
    created_at: input.created_at || now,
    updated_at: now
  };
}

export function upsertById(items, item) {
  const list = Array.isArray(items) ? [...items] : [];
  const index = list.findIndex((entry) => entry?.id === item.id);
  if (index === -1) list.push(item);
  else list[index] = { ...list[index], ...item };
  return list;
}

export function extractYoutubeVideoId(input) {
  const value = clean(input);
  if (!value) return "";

  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return cleanId(url.pathname.split("/").filter(Boolean)[0]);
    if (host.endsWith("youtube.com")) {
      const watchId = url.searchParams.get("v");
      if (watchId) return cleanId(watchId);
      const parts = url.pathname.split("/").filter(Boolean);
      const index = parts.findIndex((part) => ["shorts", "embed", "live"].includes(part));
      if (index !== -1 && parts[index + 1]) return cleanId(parts[index + 1]);
    }
  } catch {
    const match = value.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{6,})/);
    return cleanId(match?.[1] || "");
  }

  return "";
}

export function makeId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const random = crypto.randomBytes(2).toString("hex");
  return `${prefix}_${stamp}_${random}`;
}

export function check(name, ok, detail = "", required = true) {
  return { name, ok: Boolean(ok), detail, required };
}

export function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function clean(value) {
  return String(value || "").trim();
}

function cleanId(value) {
  return clean(value).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
}

function cleanBaseUrl(value) {
  return clean(value).replace(/\/+$/, "");
}

function ftpConfig() {
  return {
    host: clean(process.env.FTP_HOST),
    port: Number(process.env.FTP_PORT || 21),
    user: clean(process.env.FTP_USER),
    password: process.env.FTP_PASSWORD || "",
    remoteDir: clean(process.env.FTP_REMOTE_DIR || "/public_html/ig-generated")
  };
}

function githubRepo() {
  return clean(process.env.DASHBOARD_GITHUB_REPO || process.env.GITHUB_REPOSITORY || "emsabiq/clipper");
}

function githubToken() {
  return clean(process.env.GH_REPO_SECRET_TOKEN || process.env.GITHUB_TOKEN);
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "clipper-dashboard"
  };
}

function queryValue(req, name) {
  try {
    return new URL(req.url, "https://dashboard.local").searchParams.get(name) || "";
  } catch {
    return "";
  }
}

function cookieValue(raw, name) {
  for (const part of String(raw || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function maskSecret(value) {
  const text = clean(value);
  if (!text) return "";
  if (text.length <= 8) return "configured";
  return `${text.slice(0, 3)}...${text.slice(-3)}`;
}

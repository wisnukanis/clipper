import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

function cleanText(value) {
  return String(value || "").trim();
}

function cleanBaseUrl(value) {
  return cleanText(value).replace(/\/+$/, "");
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function listEnv(...names) {
  const values = [];
  for (const name of names) {
    const raw = process.env[name] || "";
    values.push(...raw.split(/[\n,;]+/).map(cleanText).filter(Boolean));
  }
  return [...new Set(values)];
}

function encodePathSegment(value) {
  return String(value)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

const geminiApiKeys = listEnv("GEMINI_API_KEY", "GEMINI_API_KEY_2", "GEMINI_API_KEY_3", "GEMINI_API_KEYS");

export const config = {
  rootDir,
  srcDir: path.join(rootDir, "src"),
  publicDir: path.join(rootDir, "public"),
  dataDir: path.join(rootDir, "data"),
  generatedDir: path.join(rootDir, "generated"),
  thumbnailDir: path.join(rootDir, "generated", "thumbnails"),
  metadataDir: path.join(rootDir, "generated", "metadata"),
  logDir: path.join(rootDir, "generated", "logs"),
  localPort: numberEnv("LOCAL_PORT", 8788),
  timezone: cleanText(process.env.APP_TIMEZONE || "Asia/Jakarta"),
  publicBaseUrl: cleanBaseUrl(process.env.PUBLIC_BASE_URL),
  uploadDriver: cleanText(process.env.UPLOAD_DRIVER || "local").toLowerCase(),
  dryRun: boolEnv("DRY_RUN", true),
  autoPublish: boolEnv("AUTO_PUBLISH", false),
  cleanupLocalAfterPublish: boolEnv("CLEANUP_LOCAL_AFTER_PUBLISH", false),
  defaultTheme: cleanText(process.env.DEFAULT_THEME || "auto"),
  postCron: cleanText(process.env.POST_CRON || "7 5 * * *"),
  dashboardPin: cleanText(process.env.AUTO_DASHBOARD_PIN),
  dashboardAllowRemote: boolEnv("AUTO_DASHBOARD_ALLOW_REMOTE", false),
  graphApiVersion: cleanText(process.env.GRAPH_API_VERSION || "v21.0"),
  instagram: {
    enabled: boolEnv("INSTAGRAM_UPLOAD_ENABLED", true),
    igUserId: cleanText(process.env.INSTAGRAM_IG_USER_ID),
    accessToken: process.env.INSTAGRAM_ACCESS_TOKEN || ""
  },
  youtube: {
    enabled: boolEnv("YOUTUBE_UPLOAD_ENABLED", false),
    clientId: cleanText(process.env.YOUTUBE_CLIENT_ID),
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET || "",
    refreshToken: process.env.YOUTUBE_REFRESH_TOKEN || "",
    privacyStatus: cleanText(process.env.YOUTUBE_PRIVACY_STATUS || "private"),
    categoryId: cleanText(process.env.YOUTUBE_CATEGORY_ID || "22"),
    tags: listEnv("YOUTUBE_TAGS"),
    titlePrefix: cleanText(process.env.YOUTUBE_TITLE_PREFIX),
    descriptionFooter: cleanText(process.env.YOUTUBE_DESCRIPTION_FOOTER)
  },
  instagramIgUserId: cleanText(process.env.INSTAGRAM_IG_USER_ID),
  instagramAccessToken: cleanText(process.env.INSTAGRAM_ACCESS_TOKEN),
  gemini: {
    apiKey: geminiApiKeys[0] || "",
    apiKeys: geminiApiKeys,
    model: cleanText(process.env.GEMINI_MODEL || "gemini-flash-latest"),
    temperature: numberEnv("GEMINI_TEMPERATURE", 0.75)
  },
  ftp: {
    host: cleanText(process.env.FTP_HOST),
    port: numberEnv("FTP_PORT", 21),
    user: cleanText(process.env.FTP_USER),
    password: process.env.FTP_PASSWORD || "",
    remoteDir: cleanText(process.env.FTP_REMOTE_DIR || "/public_html/ig-generated")
  },
  clipper: {
    rootDir: path.resolve(rootDir, cleanText(process.env.CLIPPER_ROOT || "clipper")),
    pythonCommand: cleanText(process.env.PYTHON_CMD || (process.platform === "win32" ? "python" : "python3")),
    clipCount: numberEnv("CLIP_COUNT", 1),
    minClipSeconds: numberEnv("MIN_CLIP_SECONDS", 40),
    maxClipSeconds: numberEnv("MAX_CLIP_SECONDS", 60)
  }
};

export function shouldUploadToFtp() {
  return config.uploadDriver === "ftp";
}

export function canPublish() {
  return config.autoPublish && !config.dryRun;
}

export function publicGeneratedUrl(folder, filename) {
  if (!config.publicBaseUrl) return "";
  return `${config.publicBaseUrl}/${folder}/${encodePathSegment(filename)}`;
}

export function publicVideoUrl(filename) {
  return publicGeneratedUrl("videos", filename);
}

export function publicThumbnailUrl(filename) {
  return publicGeneratedUrl("thumbnails", filename);
}

export function publicMetadataUrl(filename) {
  return publicGeneratedUrl("metadata", filename);
}

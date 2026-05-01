import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config, shouldUploadToFtp } from "./config.js";
import { ensureProjectDirs } from "./storage.js";

async function commandOk(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

await ensureProjectDirs();

const checks = [
  ["ffmpeg", await commandOk("ffmpeg", ["-version"])],
  ["yt-dlp", await commandOk("yt-dlp", ["--version"])],
  [config.clipper.pythonCommand, await commandOk(config.clipper.pythonCommand, ["--version"])],
  ["clipper/scripts/clipper.py", await exists(path.join(config.clipper.rootDir, "scripts", "clipper.py"))],
  ["data/themes.json", await exists(path.join(config.dataDir, "themes.json"))],
  ["data/videos.json", await exists(path.join(config.dataDir, "videos.json"))]
];

for (const [name, ok] of checks) {
  console.log(`${ok ? "OK" : "MISS"} ${name}`);
}

const missingEnv = [];
if (shouldUploadToFtp()) {
  if (!config.publicBaseUrl) missingEnv.push("PUBLIC_BASE_URL");
  if (!config.ftp.host) missingEnv.push("FTP_HOST");
  if (!config.ftp.user) missingEnv.push("FTP_USER");
  if (!config.ftp.password) missingEnv.push("FTP_PASSWORD");
}
if (config.autoPublish && !config.dryRun && config.instagram.enabled) {
  if (!config.instagram.igUserId) missingEnv.push("INSTAGRAM_IG_USER_ID");
  if (!config.instagram.accessToken) missingEnv.push("INSTAGRAM_ACCESS_TOKEN");
}
if (config.autoPublish && !config.dryRun && config.youtube.enabled) {
  if (!config.youtube.clientId) missingEnv.push("YOUTUBE_CLIENT_ID");
  if (!config.youtube.clientSecret) missingEnv.push("YOUTUBE_CLIENT_SECRET");
  if (!config.youtube.refreshToken) missingEnv.push("YOUTUBE_REFRESH_TOKEN");
}

if (!config.gemini.apiKeys.length) {
  console.log("WARN GEMINI_API_KEYS kosong. Caption fallback masih jalan, tetapi clipper auto-highlight butuh Gemini.");
}

if (missingEnv.length) {
  console.error(`Missing env: ${missingEnv.join(", ")}`);
  process.exitCode = 1;
}

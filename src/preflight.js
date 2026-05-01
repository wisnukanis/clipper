import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config, canPublish, shouldUploadToFtp } from "./config.js";
import { ensureFreshInstagramToken } from "./instagram-token.js";
import { withFtpClient } from "./uploader.js";
import { getYoutubeAccessToken } from "./youtube-publisher.js";

function checkResult(name, ok, detail = "", required = true) {
  return { name, ok, detail, required };
}

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

function missingEnv(names) {
  return names.filter((name) => !String(process.env[name] || "").trim());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}, timeoutMs = config.apiCheckTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const message = data?.error?.message || data?.message || response.statusText;
      throw new Error(`${response.status} ${message}`.trim());
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`timeout ${Math.round(timeoutMs / 1000)}s`);
    }
    if (error.cause?.code) {
      throw new Error(`${error.message} (${error.cause.code})`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithRetries(url, options = {}, retries = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetchJson(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(1200 * attempt);
    }
  }
  throw lastError;
}

async function localChecks() {
  const clipperScript = path.join(config.clipper.rootDir, "scripts", "clipper.py");
  const checks = await Promise.all([
    commandOk("ffmpeg", ["-version"]).then((ok) => checkResult("ffmpeg", ok)),
    commandOk("yt-dlp", ["--version"]).then((ok) => checkResult("yt-dlp", ok)),
    commandOk(config.clipper.pythonCommand, ["--version"]).then((ok) => checkResult(config.clipper.pythonCommand, ok)),
    exists(clipperScript).then((ok) => checkResult("clipper/scripts/clipper.py", ok)),
    exists(path.join(config.dataDir, "themes.json")).then((ok) => checkResult("data/themes.json", ok)),
    exists(path.join(config.dataDir, "videos.json")).then((ok) => checkResult("data/videos.json", ok))
  ]);
  return checks;
}

async function checkDeepgram(online) {
  if (!config.deepgram.enabled) {
    return checkResult(
      "Deepgram",
      false,
      "DEEPGRAM_ENABLED harus 1; transkripsi hanya memakai Deepgram",
      true
    );
  }

  if (!config.deepgram.apiKeys.length) {
    return checkResult("Deepgram", false, "DEEPGRAM_API_KEYS / DEEPGRAM_API_KEY belum diisi", true);
  }

  if (!online) {
    return checkResult("Deepgram", true, `${config.deepgram.apiKeys.length} key terkonfigurasi`);
  }

  let validCount = 0;
  const failures = [];
  for (const [index, apiKey] of config.deepgram.apiKeys.entries()) {
    try {
      await fetchJsonWithRetries("https://api.deepgram.com/v1/auth/token", {
        headers: { Authorization: `Token ${apiKey}` }
      });
      validCount += 1;
    } catch (error) {
      failures.push(`key ${index + 1}: ${error.message}`);
    }
  }

  if (!validCount) {
    return checkResult("Deepgram", false, failures.join("; "), true);
  }

  const detail = failures.length
    ? `${validCount}/${config.deepgram.apiKeys.length} key valid; gagal: ${failures.join("; ")}`
    : `${validCount} key valid, model ${config.deepgram.model}, language ${config.deepgram.language}`;

  return checkResult(
    "Deepgram",
    true,
    detail
  );
}

async function checkGemini(online, required = true) {
  if (!config.gemini.apiKeys.length) {
    return checkResult("Gemini", false, "GEMINI_API_KEYS / GEMINI_API_KEY belum diisi", required);
  }

  if (!online) {
    return checkResult("Gemini", true, `${config.gemini.apiKeys.length} key terkonfigurasi`, required);
  }

  const results = await Promise.all(config.gemini.apiKeys.map(async (apiKey, index) => {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.gemini.model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    try {
      await fetchJson(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Balas OK saja." }] }],
          generationConfig: { maxOutputTokens: 4, temperature: 0 }
        })
      });
      return { ok: true, index };
    } catch (error) {
      return { ok: false, index, error };
    }
  }));

  const validCount = results.filter((result) => result.ok).length;
  const failures = results
    .filter((result) => !result.ok)
    .map((result) => `key ${result.index + 1}: ${result.error.message}`);

  if (!validCount) {
    return checkResult("Gemini", false, failures.join("; "), required);
  }

  const detail = failures.length
    ? `${validCount}/${config.gemini.apiKeys.length} key valid; gagal: ${failures.join("; ")}`
    : `${validCount} key valid, model ${config.gemini.model}`;

  return checkResult("Gemini", true, detail, required);
}

async function checkClod(online, required = false) {
  if (!config.clod.apiKey) {
    return checkResult("CLOD API", false, "CLOD_API_KEY belum diisi", required);
  }

  if (!online) {
    return checkResult("CLOD API", true, `key terkonfigurasi, model ${config.clod.model}`, required);
  }

  try {
    await fetchJson(`${config.clod.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.clod.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.clod.model,
        messages: [{ role: "user", content: "Balas OK saja." }],
        temperature: 0,
        max_completion_tokens: 4
      })
    });
    return checkResult("CLOD API", true, `model ${config.clod.model}`, required);
  } catch (error) {
    return checkResult("CLOD API", false, error.message, required);
  }
}

async function aiChecks(online) {
  const hasClod = Boolean(config.clod.apiKey);
  const gemini = await checkGemini(online, !hasClod);
  const clod = await checkClod(online, !gemini.ok);
  return [gemini, clod];
}

async function checkFtp(online) {
  if (!shouldUploadToFtp()) {
    return checkResult("FTP", true, "UPLOAD_DRIVER bukan ftp", false);
  }

  const missing = missingEnv(["PUBLIC_BASE_URL", "FTP_HOST", "FTP_USER", "FTP_PASSWORD", "FTP_REMOTE_DIR"]);
  if (missing.length) {
    return checkResult("FTP", false, `missing env: ${missing.join(", ")}`, true);
  }

  if (!online) {
    return checkResult("FTP", true, "env lengkap");
  }

  try {
    await withFtpClient(async (client) => {
      await client.ensureDir(config.ftp.remoteDir);
      await client.list();
    }, { timeoutMs: Math.min(config.ftp.stateTimeoutMs, config.apiCheckTimeoutMs) });
    return checkResult("FTP", true, `remote siap: ${config.ftp.remoteDir}`);
  } catch (error) {
    return checkResult("FTP", false, error.message, true);
  }
}

async function checkInstagram(online, required = canPublish()) {
  if (!config.instagram.enabled) {
    return checkResult("Instagram Graph API", true, "INSTAGRAM_UPLOAD_ENABLED=false", false);
  }

  const missing = missingEnv(["INSTAGRAM_IG_USER_ID", "INSTAGRAM_ACCESS_TOKEN"]);
  if (missing.length) {
    return checkResult("Instagram Graph API", false, `missing env: ${missing.join(", ")}`, required);
  }

  if (!online) {
    return checkResult("Instagram Graph API", true, "env lengkap", required);
  }

  try {
    const status = await ensureFreshInstagramToken();
    const detail = status.checked ? "token valid" : status.reason || "dilewati";
    return checkResult("Instagram Graph API", true, detail, required);
  } catch (error) {
    return checkResult("Instagram Graph API", false, error.message, required);
  }
}

async function checkFacebook(online, required = false) {
  if (!config.facebook.enabled) {
    return checkResult("Facebook Page API", true, "FACEBOOK_UPLOAD_ENABLED=false", false);
  }

  const missing = missingEnv(["FACEBOOK_PAGE_ID", "FACEBOOK_PAGE_ACCESS_TOKEN"]);
  if (missing.length) {
    return checkResult("Facebook Page API", false, `missing env: ${missing.join(", ")}`, required);
  }

  if (!online) {
    return checkResult("Facebook Page API", true, "env lengkap", required);
  }

  try {
    const url = `https://graph.facebook.com/${config.graphApiVersion}/${encodeURIComponent(config.facebook.pageId)}?fields=id,name&access_token=${encodeURIComponent(config.facebook.accessToken)}`;
    const data = await fetchJson(url);
    return checkResult("Facebook Page API", Boolean(data?.id), data?.name ? `page valid: ${data.name}` : "page valid", required);
  } catch (error) {
    return checkResult("Facebook Page API", false, error.message, required);
  }
}

async function checkYoutube(online, required = canPublish()) {
  if (!config.youtube.enabled) {
    return checkResult("YouTube Data API", true, "YOUTUBE_UPLOAD_ENABLED=false", false);
  }

  const missing = missingEnv(["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"]);
  if (missing.length) {
    return checkResult("YouTube Data API", false, `missing env: ${missing.join(", ")}`, required);
  }

  if (!online) {
    return checkResult("YouTube Data API", true, "env lengkap", required);
  }

  try {
    const token = await getYoutubeAccessToken();
    return checkResult("YouTube Data API", Boolean(token), token ? "refresh token valid" : "access token kosong", required);
  } catch (error) {
    return checkResult("YouTube Data API", false, error.message, required);
  }
}

export async function runPreflight(options = {}) {
  const online = options.online !== false;
  const aiOnline = options.aiOnline ?? false;
  const deepgramOnline = options.deepgramOnline ?? online;
  const ftpOnline = options.ftpOnline ?? online;
  const socialOnline = options.socialOnline ?? false;
  const youtubeOnline = options.youtubeOnline ?? online;
  const publishRequired = options.publishRequired ?? canPublish();
  const socialPublishRequired = options.socialPublishRequired ?? false;
  const ai = await aiChecks(aiOnline);
  const checks = [
    ...await localChecks(),
    await checkDeepgram(deepgramOnline),
    ...ai,
    await checkFtp(ftpOnline),
    await checkInstagram(socialOnline, socialPublishRequired),
    await checkFacebook(socialOnline, socialPublishRequired),
    await checkYoutube(youtubeOnline, publishRequired)
  ];

  return {
    online,
    ok: checks.every((check) => check.ok || !check.required),
    checks
  };
}

export function printPreflightReport(report) {
  console.log(`Preflight status (${report.online ? "online" : "offline"}):`);
  for (const check of report.checks) {
    const status = check.ok ? "OK" : check.required ? "FAIL" : "WARN";
    const detail = check.detail ? ` - ${check.detail}` : "";
    console.log(`${status} ${check.name}${detail}`);
  }
}

export function assertPreflightOk(report) {
  const failures = report.checks.filter((check) => check.required && !check.ok);
  if (!failures.length) return;
  throw new Error(`Preflight gagal: ${failures.map((check) => check.name).join(", ")}`);
}

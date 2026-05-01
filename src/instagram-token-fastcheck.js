import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const args = new Set(process.argv.slice(2));

loadEnvFile(path.join(rootDir, ".env"));

const graphApiVersion = clean(process.env.GRAPH_API_VERSION || "v25.0");
const igUserId = clean(process.env.INSTAGRAM_IG_USER_ID);
let accessToken = process.env.INSTAGRAM_ACCESS_TOKEN || "";
const appId = clean(process.env.META_APP_ID);
const appSecret = process.env.META_APP_SECRET || "";
const autoRefresh = boolEnv("AUTO_REFRESH_INSTAGRAM_TOKEN", true);
const refreshBeforeDays = numberEnv("TOKEN_REFRESH_BEFORE_DAYS", 10);

function clean(value) {
  return String(value || "").trim();
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

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;

    const [rawKey, ...rest] = trimmed.split("=");
    const key = rawKey.trim();
    const value = rest.join("=").trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function mask(value) {
  if (!value || !process.env.GITHUB_ACTIONS) return;
  console.log(`::add-mask::${value}`);
}

function apiUrl(pathName, params = {}) {
  const url = new URL(`https://graph.facebook.com/${graphApiVersion}/${pathName}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

async function fetchJson(pathName, params = {}) {
  const response = await fetch(apiUrl(pathName, params));
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const apiError = data?.error || {};
    const error = new Error(
      `${apiError.message || response.statusText} ` +
        `[code ${apiError.code || response.status}${apiError.error_subcode ? `, subcode ${apiError.error_subcode}` : ""}]`
    );
    error.apiCode = apiError.code;
    error.apiSubcode = apiError.error_subcode;
    throw error;
  }

  return data;
}

async function validateToken(token) {
  const data = await fetchJson(igUserId, {
    fields: "id,username",
    access_token: token
  });

  return {
    valid: Boolean(data?.id),
    usernamePresent: Boolean(data?.username)
  };
}

async function debugToken(token) {
  if (!appId || !appSecret) return null;

  const data = await fetchJson("debug_token", {
    input_token: token,
    access_token: `${appId}|${appSecret}`
  });

  const detail = data?.data || {};
  return {
    valid: Boolean(detail.is_valid),
    expiresAt: detail.expires_at ? new Date(detail.expires_at * 1000) : null
  };
}

async function exchangeToken(token) {
  if (!appId || !appSecret) {
    throw new Error("META_APP_ID dan META_APP_SECRET wajib diisi untuk refresh token Instagram.");
  }

  const data = await fetchJson("oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: token
  });

  if (!data?.access_token) {
    throw new Error("Meta tidak mengembalikan access_token baru.");
  }

  return {
    accessToken: data.access_token,
    expiresIn: Number(data.expires_in || 0)
  };
}

function updateEnvFile(filePath, token) {
  if (!fs.existsSync(filePath)) return false;

  const raw = fs.readFileSync(filePath, "utf8");
  const nextLine = `INSTAGRAM_ACCESS_TOKEN=${token}`;
  const next = raw.match(/^INSTAGRAM_ACCESS_TOKEN=/m)
    ? raw.replace(/^INSTAGRAM_ACCESS_TOKEN=.*$/m, nextLine)
    : `${raw.replace(/\s*$/, "\n")}${nextLine}\n`;

  if (next !== raw) fs.writeFileSync(filePath, next, "utf8");
  return next !== raw;
}

function persistLocalToken(token) {
  const files = [
    path.join(rootDir, ".env"),
    path.join(rootDir, "clipper", ".env")
  ];
  return files.filter((filePath) => updateEnvFile(filePath, token)).length;
}

function writeGitHubEnv(token, refreshed) {
  const githubEnv = process.env.GITHUB_ENV;
  if (!githubEnv) return;

  fs.appendFileSync(
    githubEnv,
    [
      "INSTAGRAM_ACCESS_TOKEN<<__INSTAGRAM_ACCESS_TOKEN__",
      token,
      "__INSTAGRAM_ACCESS_TOKEN__",
      `INSTAGRAM_TOKEN_REFRESHED=${refreshed ? "true" : "false"}`
    ].join("\n") + "\n",
    "utf8"
  );
}

function daysUntil(date) {
  if (!date) return null;
  return (date.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
}

function isExpiredTokenError(error) {
  return error?.apiSubcode === 463 || /expired/i.test(String(error?.message || ""));
}

function printStatus(status) {
  console.log(JSON.stringify(status, null, 2));
}

async function main() {
  if (!igUserId || !accessToken) {
    throw new Error("INSTAGRAM_IG_USER_ID dan INSTAGRAM_ACCESS_TOKEN wajib diisi.");
  }

  mask(accessToken);
  await validateToken(accessToken);

  let debug = null;
  try {
    debug = await debugToken(accessToken);
  } catch (error) {
    console.warn(`IG token debug dilewati: ${error.message}`);
  }

  const daysLeft = daysUntil(debug?.expiresAt);
  const shouldRefresh = autoRefresh && (
    args.has("--force") ||
    (debug?.expiresAt && daysLeft <= refreshBeforeDays)
  );

  let refreshed = false;
  let localFilesUpdated = 0;
  let expiresAt = debug?.expiresAt || null;

  if (shouldRefresh) {
    const exchanged = await exchangeToken(accessToken);
    accessToken = exchanged.accessToken;
    refreshed = true;
    mask(accessToken);
    await validateToken(accessToken);

    try {
      debug = await debugToken(accessToken);
      expiresAt = debug?.expiresAt || expiresAt;
    } catch (error) {
      console.warn(`IG token debug setelah refresh dilewati: ${error.message}`);
    }

    if (args.has("--persist-local")) {
      localFilesUpdated = persistLocalToken(accessToken);
    }
  }

  if (args.has("--github-env")) {
    writeGitHubEnv(accessToken, refreshed);
  }

  printStatus({
    ok: true,
    refreshed,
    expiresAt: expiresAt ? expiresAt.toISOString() : "",
    daysLeft: expiresAt ? Math.floor(daysUntil(expiresAt)) : "",
    localFilesUpdated
  });
}

main().catch((error) => {
  const message = isExpiredTokenError(error)
    ? "INSTAGRAM_ACCESS_TOKEN sudah expired. Masukkan token baru, lalu jalankan refresh sebelum token itu expired lagi."
    : error.message;

  console.error(JSON.stringify({
    ok: false,
    error: message,
    apiCode: error.apiCode || "",
    apiSubcode: error.apiSubcode || ""
  }, null, 2));
  process.exitCode = 1;
});

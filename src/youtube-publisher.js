import fs from "node:fs";
import fsp from "node:fs/promises";
import axios from "axios";
import { config } from "./config.js";

const tokenUrl = "https://oauth2.googleapis.com/token";
const uploadUrl = "https://www.googleapis.com/upload/youtube/v3/videos";
const thumbnailUploadUrl = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set";
const maxThumbnailBytes = 2 * 1024 * 1024;

function assertYoutubeConfig() {
  const missing = [];
  if (!config.youtube.clientId) missing.push("YOUTUBE_CLIENT_ID");
  if (!config.youtube.clientSecret) missing.push("YOUTUBE_CLIENT_SECRET");
  if (!config.youtube.refreshToken) missing.push("YOUTUBE_REFRESH_TOKEN");
  if (missing.length) throw new Error(`Missing YouTube config: ${missing.join(", ")}`);
}

export async function getYoutubeAccessToken() {
  assertYoutubeConfig();
  const body = new URLSearchParams({
    client_id: config.youtube.clientId,
    client_secret: config.youtube.clientSecret,
    refresh_token: config.youtube.refreshToken,
    grant_type: "refresh_token"
  });

  try {
    const response = await axios.post(tokenUrl, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 60000
    });
    return response.data.access_token;
  } catch (error) {
    throw wrapGoogleError(error, "YouTube token refresh failed");
  }
}

export async function setYoutubeThumbnail({ videoId, thumbnailPath, accessToken }) {
  if (!videoId || !thumbnailPath) {
    return { ok: false, error: "videoId atau thumbnailPath kosong" };
  }

  let stat = null;
  try {
    stat = await fsp.stat(thumbnailPath);
  } catch (error) {
    return { ok: false, error: `thumbnail tidak ditemukan: ${error.message}` };
  }

  if (!stat.size) return { ok: false, error: "thumbnail kosong" };
  if (stat.size > maxThumbnailBytes) {
    return { ok: false, error: `thumbnail ${stat.size} bytes melebihi batas YouTube 2MB` };
  }

  let token = accessToken;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      if (!token) token = await getYoutubeAccessToken();
      const response = await axios.post(
        thumbnailUploadUrl,
        fs.createReadStream(thumbnailPath),
        {
          params: { videoId, uploadType: "media" },
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "image/jpeg",
            "Content-Length": stat.size
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: 60000
        }
      );
      console.log("YT THUMBNAIL SET:", response.data);
      return { ok: true, response: response.data };
    } catch (error) {
      lastError = wrapGoogleError(error, "YouTube thumbnail upload failed");
      console.warn(`YouTube thumbnail attempt ${attempt}/3 gagal: ${lastError.message}`);
      if (attempt < 3) await sleep(5000 * attempt);
    }
  }

  return { ok: false, error: lastError?.message || "YouTube thumbnail upload failed" };
}

export async function publishToYoutube({ videoPath, title, description, tags = [], thumbnailPath }) {
  const accessToken = await getYoutubeAccessToken();
  const stat = await fsp.stat(videoPath);
  const metadata = {
    snippet: {
      title: normalizeTitle(title),
      description: normalizeDescription(description),
      tags: normalizeTags(tags),
      categoryId: config.youtube.categoryId || "22"
    },
    status: {
      privacyStatus: normalizePrivacyStatus(config.youtube.privacyStatus),
      selfDeclaredMadeForKids: false
    }
  };

  let sessionUrl = "";
  try {
    const start = await axios.post(uploadUrl, metadata, {
      params: {
        uploadType: "resumable",
        part: "snippet,status"
      },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": stat.size,
        "X-Upload-Content-Type": "video/mp4"
      },
      maxBodyLength: Infinity,
      timeout: 60000
    });
    sessionUrl = start.headers.location;
  } catch (error) {
    throw wrapGoogleError(error, "YouTube upload session failed");
  }

  if (!sessionUrl) throw new Error("YouTube tidak mengembalikan upload session URL.");

  try {
    const upload = await axios.put(sessionUrl, fs.createReadStream(videoPath), {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": stat.size
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 30 * 60 * 1000
    });
    const id = upload.data?.id;
    if (!id) throw new Error("YouTube upload selesai tetapi video id kosong.");
    const thumbnail = await setYoutubeThumbnail({ videoId: id, thumbnailPath, accessToken });
    return {
      videoId: id,
      url: `https://www.youtube.com/watch?v=${id}`,
      privacyStatus: metadata.status.privacyStatus,
      title: metadata.snippet.title,
      type: "youtube_video",
      customThumbnail: thumbnail.ok,
      thumbnailError: thumbnail.ok ? "" : thumbnail.error
    };
  } catch (error) {
    throw wrapGoogleError(error, "YouTube video upload failed");
  }
}

export async function getYoutubeChannel() {
  const accessToken = await getYoutubeAccessToken();
  try {
    const response = await axios.get("https://www.googleapis.com/youtube/v3/channels", {
      params: {
        part: "snippet",
        mine: "true"
      },
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      timeout: 60000
    });
    return response.data?.items?.[0] || null;
  } catch (error) {
    throw wrapGoogleError(error, "YouTube channel check failed");
  }
}

export function buildYoutubeMetadata({ job, output, caption }) {
  const topic = buildHookTitle({ job, output, caption });
  const rawTitle = [config.youtube.titlePrefix, topic, "#Shorts"].filter(Boolean).join(" ");
  const dynamicTags = tagsFromCaption(caption);

  const description = [
    caption,
    "",
    "Shorts ini dipilih dari bagian paling kuat: hook jelas, konflik terasa, dan konteksnya relevan untuk ditonton sampai akhir.",
    "Diproses otomatis dari clip podcast.",
    config.youtube.descriptionFooter
  ].filter(Boolean).join("\n");

  return {
    title: rawTitle,
    description,
    tags: normalizeTags([
      ...config.youtube.tags,
      ...dynamicTags,
      ...keywordsFromText(`${topic} ${output.title || ""} ${output.hook || ""}`)
    ])
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildHookTitle({ job, output, caption }) {
  const firstLine = String(caption || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));

  const candidates = [
    firstLine,
    output.hook,
    output.thumbnailText,
    output.title,
    job.source_title,
    job.theme
  ];

  for (const candidate of candidates) {
    const topic = shortTopic(candidate);
    if (topic !== "Podcast Clip") return topic;
  }
  return "Podcast Clip";
}

function tagsFromCaption(value) {
  return String(value || "")
    .match(/#[\p{L}\p{N}_]+/gu)
    ?.map((tag) => tag.replace(/^#/, ""))
    .filter(Boolean) || [];
}

function keywordsFromText(value) {
  const stopwords = new Set([
    "yang",
    "dan",
    "atau",
    "ini",
    "itu",
    "dari",
    "dengan",
    "karena",
    "untuk",
    "gak",
    "nggak",
    "tidak",
    "kok",
    "sih"
  ]);
  const seen = new Set();
  const tags = [];
  for (const word of String(value || "").split(/[^\p{L}\p{N}]+/u)) {
    const cleaned = word.trim();
    const key = cleaned.toLowerCase();
    if (cleaned.length < 4 || stopwords.has(key) || seen.has(key)) continue;
    seen.add(key);
    tags.push(cleaned);
    if (tags.length >= 8) break;
  }
  return tags;
}

function shortTopic(value) {
  const cleaned = String(value || "")
    .replace(/[#"`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length < 5 || cleaned.endsWith(":")) return "Podcast Clip";
  return cleaned
    .replace(/\b(selama|hampir)\s+\d+\s+tahun\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
}

function normalizeTitle(value) {
  const cleaned = String(value || "Podcast Clip #Shorts").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 100);
}

function normalizeDescription(value) {
  return String(value || "").slice(0, 4900);
}

function normalizeTags(tags) {
  const values = Array.isArray(tags) ? tags : [];
  const normalized = values.map((tag) => String(tag).trim()).filter(Boolean);
  return [...new Set(normalized)].slice(0, 25);
}

function normalizePrivacyStatus(value) {
  const status = String(value || "private").toLowerCase();
  return ["private", "unlisted", "public"].includes(status) ? status : "private";
}

function wrapGoogleError(error, prefix) {
  const detail = error.response?.data?.error;
  if (detail) {
    const message = typeof detail === "string" ? detail : detail.message || JSON.stringify(detail);
    return new Error(`${prefix}: ${message}`);
  }
  return new Error(`${prefix}: ${error.message}`);
}

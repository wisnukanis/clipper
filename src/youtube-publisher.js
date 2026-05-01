import fs from "node:fs";
import fsp from "node:fs/promises";
import axios from "axios";
import { config } from "./config.js";

const tokenUrl = "https://oauth2.googleapis.com/token";
const uploadUrl = "https://www.googleapis.com/upload/youtube/v3/videos";

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

export async function publishToYoutube({ videoPath, title, description, tags = [] }) {
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
    return {
      videoId: id,
      url: `https://www.youtube.com/watch?v=${id}`,
      privacyStatus: metadata.status.privacyStatus,
      title: metadata.snippet.title,
      type: "youtube_video"
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
  const topic = shortTopic(output.title || job.source_title || output.hook || job.theme);
  const rawTitle = [config.youtube.titlePrefix, topic, "#Shorts"].filter(Boolean).join(" ");

  const description = [
    caption,
    "",
    "Diproses otomatis dari clip podcast.",
    config.youtube.descriptionFooter
  ].filter(Boolean).join("\n");

  return {
    title: rawTitle,
    description,
    tags: config.youtube.tags
  };
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

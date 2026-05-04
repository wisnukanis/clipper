import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { addVideo } from "./selector.js";
import { readJson } from "./storage.js";
import { todayDate } from "./job-id.js";
import { extractYoutubeVideoId } from "./youtube.js";
import { getYoutubeAccessToken } from "./youtube-publisher.js";

const DEFAULT_QUERIES = [
  "podcast artis indonesia terbaru",
  "podcast artis indonesia viral",
  "deddy corbuzier artis terbaru",
  "vindes artis terbaru",
  "politik indonesia terbaru podcast",
  "komedi indonesia podcast komika"
];

const FALLBACK_QUERIES = [
  "podcast indonesia terbaru",
  "podcast indonesia viral",
  "podcast artis indonesia full",
  "podcast selebriti indonesia terbaru",
  "deddy corbuzier terbaru",
  "raditya dika podcast terbaru",
  "vindes terbaru",
  "komika indonesia podcast terbaru",
  "politik indonesia terbaru",
  "podcast politik indonesia"
];

const TOPIC_RE = /podcast|podhub|podkesmas|vindes|deddy|corbuzier|raditya|artis|aktor|aktris|penyanyi|komika|komedi|stand\s*up|lucu|politik|pilpres|dpr|presiden|menteri|prabowo|jokowi|anies|ganjar/i;
const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function numberEnv(name, fallback, min = 0, max = 100) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function listEnv(name, fallback = []) {
  const value = String(process.env[name] || "").trim();
  if (!value) return fallback;
  return value
    .split(/[\n,|;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function listEnvMany(names, fallback = []) {
  const values = names.flatMap((name) => listEnv(name, []));
  return values.length ? [...new Set(values)] : fallback;
}

function uniqueList(items) {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

function videoUrl(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}

function knownVideoIds(videos, history) {
  const ids = new Set();
  for (const item of [...videos, ...history]) {
    for (const value of [
      item.youtube_video_id,
      extractYoutubeVideoId(item.url),
      extractYoutubeVideoId(item.source_url)
    ]) {
      if (value) ids.add(value);
    }
  }
  return ids;
}

function ageHours(publishedAt) {
  const timestamp = Date.parse(publishedAt || "");
  if (!Number.isFinite(timestamp)) return 24 * 365;
  return Math.max(1, (Date.now() - timestamp) / 36e5);
}

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function candidateText(item) {
  return [
    item.title,
    item.description,
    item.channel,
    item.uploader,
    item.channelTitle
  ].join(" ");
}

function viralStats(item) {
  const views = numberValue(item.view_count);
  const likes = numberValue(item.like_count);
  const comments = numberValue(item.comment_count);
  const hours = ageHours(item.publishedAt || item.upload_date);
  return {
    views,
    likes,
    comments,
    ageHours: hours,
    viewsPerHour: views / hours,
    likesPerHour: likes / hours,
    commentsPerHour: comments / hours,
    engagementRate: views ? (likes + comments * 2) / views : 0
  };
}

function topicMultiplier(text) {
  const value = String(text || "").toLowerCase();
  if (/podcast.*artis|artis.*podcast|deddy|corbuzier|vindes|raditya/.test(value)) return 1.35;
  if (/politik|pilpres|dpr|presiden|menteri|prabowo|jokowi|anies|ganjar/.test(value)) return 1.12;
  if (/komedi|komika|stand\s*up|lucu/.test(value)) return 1.08;
  return 1;
}

function scoreCandidate(item) {
  const duration = numberValue(item.duration);
  const stats = viralStats(item);
  const text = candidateText(item);
  const durationMultiplier = duration >= 1200 && duration <= 7200 ? 1.1 : 1;
  const recencyMultiplier = stats.ageHours <= 72 ? 1.15 : stats.ageHours <= 168 ? 1.05 : 0.95;
  const raw =
    stats.viewsPerHour * 0.75 +
    stats.likesPerHour * 2 +
    stats.commentsPerHour * 25 +
    stats.engagementRate * 50000;

  return Math.round(raw * topicMultiplier(text) * durationMultiplier * recencyMultiplier);
}

function isViralCandidate(item, options) {
  const id = item.id || extractYoutubeVideoId(item.url || item.webpage_url);
  if (!id) return false;

  const duration = numberValue(item.duration);
  if (duration && duration < options.minDuration) return false;
  if (duration && duration > options.maxDuration) return false;

  const stats = viralStats(item);
  const isFastGrowing = stats.viewsPerHour >= options.minViewsPerHour;
  const hasEnoughViews = stats.views >= options.minViews;
  if (!isFastGrowing && !hasEnoughViews) return false;

  return TOPIC_RE.test(candidateText(item));
}

function isTopicCandidate(item, options) {
  const id = item.id || extractYoutubeVideoId(item.url || item.webpage_url);
  if (!id) return false;

  const duration = numberValue(item.duration);
  if (duration && duration < options.minDuration) return false;
  if (duration && duration > options.maxDuration) return false;

  return TOPIC_RE.test(candidateText(item));
}

function parseJsonLines(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function runYtDlpSearch(query, maxResults) {
  const command = process.env.YTDLP_COMMAND || "yt-dlp";
  const args = [
    "--dump-json",
    "--flat-playlist",
    `ytsearch${maxResults}:${query}`
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(parseJsonLines(stdout));
      } else {
        reject(new Error(`yt-dlp search gagal (${code}): ${stderr.slice(-800)}`));
      }
    });
  });
}

function parseIsoDuration(value) {
  const match = String(value || "").match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return 0;
  const [, days, hours, minutes, seconds] = match.map((part) => Number(part || 0));
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

function publishedAfterDate(days) {
  const date = new Date(Date.now() - days * 86400 * 1000);
  return date.toISOString();
}

async function fetchYoutube(pathname, params, credential) {
  const url = new URL(`${YOUTUBE_API_BASE}/${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const headers = {};
  if (credential.apiKey) {
    url.searchParams.set("key", credential.apiKey);
  } else if (credential.accessToken) {
    headers.Authorization = `Bearer ${credential.accessToken}`;
  }

  const response = await fetch(url, { headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message || `${response.status} ${response.statusText}`;
    throw new Error(`YouTube API ${pathname} gagal: ${message}`);
  }
  return body;
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function searchYoutubeIds({ credential, query, channelId, options }) {
  const data = await fetchYoutube("search", {
    part: "snippet",
    type: "video",
    q: query || undefined,
    channelId: channelId || undefined,
    maxResults: options.maxResults,
    order: channelId ? "date" : "relevance",
    regionCode: options.regionCode,
    relevanceLanguage: options.relevanceLanguage,
    safeSearch: "none",
    videoEmbeddable: "true",
    publishedAfter: publishedAfterDate(options.publishedAfterDays)
  }, credential);

  return (data.items || [])
    .map((item) => item?.id?.videoId)
    .filter(Boolean);
}

async function loadYoutubeDetails(credential, ids, queryById) {
  const candidates = [];
  for (const group of chunk(ids, 50)) {
    const data = await fetchYoutube("videos", {
      part: "snippet,statistics,contentDetails,status",
      id: group.join(",")
    }, credential);

    for (const item of data.items || []) {
      if (!item?.id) continue;
      if (item.status?.embeddable === false) continue;
      const snippet = item.snippet || {};
      const statistics = item.statistics || {};
      const duration = parseIsoDuration(item.contentDetails?.duration);
      candidates.push({
        id: item.id,
        url: videoUrl(item.id),
        webpage_url: videoUrl(item.id),
        title: snippet.title || "",
        description: snippet.description || "",
        channel: snippet.channelTitle || "",
        channelId: snippet.channelId || "",
        publishedAt: snippet.publishedAt || "",
        duration,
        view_count: numberValue(statistics.viewCount),
        like_count: numberValue(statistics.likeCount),
        comment_count: numberValue(statistics.commentCount),
        discovery_source: "youtube_api",
        discovery_query: queryById.get(item.id) || ""
      });
    }
  }
  return candidates;
}

async function youtubeDiscoveryCredentials() {
  const apiKeys = listEnvMany(["YOUTUBE_API_KEY", "YOUTUBE_DATA_API_KEY", "GOOGLE_API_KEY"], []);
  if (apiKeys.length) {
    return apiKeys.map((apiKey) => ({ apiKey, label: "api_key" }));
  }

  if (config.youtube.clientId && config.youtube.clientSecret && config.youtube.refreshToken) {
    const accessToken = await getYoutubeAccessToken();
    return [{ accessToken, label: "oauth" }];
  }

  return [];
}

async function discoverWithYoutubeApi({ queries, knownIds, options }) {
  const credentials = await youtubeDiscoveryCredentials();
  if (!credentials.length) {
    console.log("AUTO DISCOVERY: credential YouTube discovery belum ada, fallback ke yt-dlp search.");
    return null;
  }

  const channelIds = listEnv("AUTO_DISCOVER_CHANNEL_IDS", []);
  let lastError = null;
  for (const credential of credentials) {
    const ids = [];
    const queryById = new Map();

    try {
      console.log(`AUTO DISCOVERY: memakai YouTube ${credential.label}.`);
      for (const query of queries) {
        const found = await searchYoutubeIds({ credential, query, options });
        for (const id of found) {
          if (knownIds.has(id) || queryById.has(id)) continue;
          ids.push(id);
          queryById.set(id, query);
        }
      }

      for (const channelId of channelIds) {
        const found = await searchYoutubeIds({ credential, channelId, options });
        for (const id of found) {
          if (knownIds.has(id) || queryById.has(id)) continue;
          ids.push(id);
          queryById.set(id, `channel:${channelId}`);
        }
      }

      if (!ids.length) return [];
      return loadYoutubeDetails(credential, ids, queryById);
    } catch (error) {
      lastError = error;
      console.warn(`YouTube API discovery gagal, coba credential berikutnya: ${error.message}`);
    }
  }

  throw lastError || new Error("YouTube API discovery gagal.");
}

async function discoverWithYtDlp({ queries, knownIds, options }) {
  const candidates = new Map();
  for (const query of queries) {
    try {
      const results = await runYtDlpSearch(query, options.maxResults);
      for (const item of results) {
        const id = item.id || extractYoutubeVideoId(item.url || item.webpage_url);
        if (!id || knownIds.has(id) || candidates.has(id)) continue;
        candidates.set(id, {
          ...item,
          id,
          url: item.webpage_url || item.url || videoUrl(id),
          discovery_source: "yt_dlp",
          discovery_query: query
        });
      }
    } catch (error) {
      console.warn(`Auto discovery query gagal (${query}): ${error.message}`);
    }
  }
  return [...candidates.values()];
}

async function loadRawCandidates({ queries, knownIds, options }) {
  let rawCandidates = null;
  try {
    rawCandidates = await discoverWithYoutubeApi({ queries, knownIds, options });
  } catch (error) {
    console.warn(`YouTube API discovery dilewati: ${error.message}`);
  }

  if (!rawCandidates) {
    rawCandidates = await discoverWithYtDlp({ queries, knownIds, options });
  }

  return rawCandidates || [];
}

function selectDiscoveredCandidates(rawCandidates, options, addCount, mode) {
  const filter = mode === "best_available" ? isTopicCandidate : isViralCandidate;
  return rawCandidates
    .filter((item) => filter(item, options))
    .map((item) => ({
      ...item,
      discovery_score: scoreCandidate(item),
      discovery_stats: viralStats(item),
      discovery_fallback_mode: mode
    }))
    .sort((a, b) => b.discovery_score - a.discovery_score)
    .slice(0, addCount);
}

function fallbackPasses(baseQueries, baseOptions) {
  const fallbackQueries = uniqueList([...baseQueries, ...FALLBACK_QUERIES]);
  const fallbackMaxResults = numberEnv("AUTO_DISCOVER_FALLBACK_MAX_RESULTS", 25, baseOptions.maxResults, 50);

  return [
    {
      mode: "strict",
      queries: baseQueries,
      options: baseOptions
    },
    {
      mode: "wide_search",
      queries: fallbackQueries,
      options: {
        ...baseOptions,
        maxResults: fallbackMaxResults,
        publishedAfterDays: Math.max(baseOptions.publishedAfterDays, 30),
        minViews: Math.max(10000, Math.floor(baseOptions.minViews * 0.5)),
        minViewsPerHour: Math.max(250, Math.floor(baseOptions.minViewsPerHour * 0.5))
      }
    },
    {
      mode: "relaxed_viral",
      queries: fallbackQueries,
      options: {
        ...baseOptions,
        maxResults: fallbackMaxResults,
        publishedAfterDays: Math.max(baseOptions.publishedAfterDays, 60),
        minDuration: Math.min(baseOptions.minDuration, 300),
        minViews: Math.max(5000, Math.floor(baseOptions.minViews * 0.25)),
        minViewsPerHour: Math.max(100, Math.floor(baseOptions.minViewsPerHour * 0.2))
      }
    },
    {
      mode: "best_available",
      queries: fallbackQueries,
      options: {
        ...baseOptions,
        maxResults: fallbackMaxResults,
        publishedAfterDays: Math.max(baseOptions.publishedAfterDays, 90),
        minDuration: Math.min(baseOptions.minDuration, 300),
        minViews: 0,
        minViewsPerHour: 0
      }
    }
  ];
}

export async function discoverAndQueueVideos(options = {}) {
  if (!boolEnv("AUTO_DISCOVER_VIDEOS", true)) {
    return { skipped: true, reason: "AUTO_DISCOVER_VIDEOS=false", added: [] };
  }

  const queries = listEnv("AUTO_DISCOVER_QUERY", DEFAULT_QUERIES);
  const maxResults = numberEnv("AUTO_DISCOVER_MAX_RESULTS", 8, 1, 25);
  const addCount = numberEnv("AUTO_DISCOVER_ADD_COUNT", 5, 1, 10);
  const minDuration = numberEnv("AUTO_DISCOVER_MIN_DURATION_SECONDS", 600, 0, 86400);
  const maxDuration = numberEnv("AUTO_DISCOVER_MAX_DURATION_SECONDS", 10800, 60, 86400);
  const minViews = numberEnv("AUTO_DISCOVER_MIN_VIEWS", 25000, 0, 1000000000);
  const minViewsPerHour = numberEnv("AUTO_DISCOVER_MIN_VIEWS_PER_HOUR", 500, 0, 1000000000);
  const publishedAfterDays = numberEnv("AUTO_DISCOVER_PUBLISHED_AFTER_DAYS", 14, 1, 365);
  const regionCode = String(process.env.AUTO_DISCOVER_REGION_CODE || "ID").trim().toUpperCase();
  const relevanceLanguage = String(process.env.AUTO_DISCOVER_RELEVANCE_LANGUAGE || "id").trim().toLowerCase();
  const discoveryOptions = {
    maxResults,
    minDuration,
    maxDuration,
    minViews,
    minViewsPerHour,
    publishedAfterDays,
    regionCode,
    relevanceLanguage
  };
  const theme = options.theme && options.theme !== "auto" ? options.theme : "podcast artis";
  const targetDate = options.targetDate || todayDate();

  const videos = await readJson("videos", []);
  const history = await readJson("history", []);
  const knownIds = knownVideoIds(videos, history);

  let selected = [];
  let selectedPass = "";
  for (const pass of fallbackPasses(queries, discoveryOptions)) {
    console.log(`AUTO DISCOVERY pass=${pass.mode}, queries=${pass.queries.length}, maxResults=${pass.options.maxResults}, days=${pass.options.publishedAfterDays}`);
    const rawCandidates = await loadRawCandidates({
      queries: pass.queries,
      knownIds,
      options: pass.options
    });
    selected = selectDiscoveredCandidates(rawCandidates, pass.options, addCount, pass.mode);
    if (selected.length) {
      selectedPass = pass.mode;
      console.log(`AUTO DISCOVERY pass=${pass.mode} memilih ${selected.length} kandidat.`);
      break;
    }
    console.log(`AUTO DISCOVERY pass=${pass.mode} kosong; lanjut fallback.`);
  }

  const added = [];
  for (const [index, item] of selected.entries()) {
    const url = item.webpage_url || item.url || videoUrl(item.id);
    const stats = item.discovery_stats || viralStats(item);
    const video = await addVideo({
      url,
      theme,
      target_date: targetDate,
      priority: 10 + index,
      status: "queued",
      quality_profile: process.env.VIDEO_QUALITY_PROFILE || "standard",
      subtitle_font: process.env.SUBTITLE_FONT_FAMILY || "Segoe UI Semibold",
      subtitle_font_size: Number(process.env.SUBTITLE_FONT_SIZE || 46),
      subtitle_margin_v: Number(process.env.SUBTITLE_MARGIN_V || 550),
      subtitle_margin_h: Number(process.env.SUBTITLE_MARGIN_H || 180),
      notes: [
        `Auto discovery: ${item.discovery_query || "unknown"}`,
        `source=${item.discovery_source || "unknown"}`,
        `fallback=${item.discovery_fallback_mode || selectedPass || "strict"}`,
        `score=${item.discovery_score}`,
        item.channel ? `channel=${item.channel}` : "",
        stats.views ? `views=${stats.views}` : "",
        stats.viewsPerHour ? `views_per_hour=${Math.round(stats.viewsPerHour)}` : ""
      ].filter(Boolean).join("; "),
      source_title: item.title || "",
      channel_title: item.channel || "",
      published_at_source: item.publishedAt || "",
      discovery_source: item.discovery_source || "",
      discovery_query: item.discovery_query || "",
      discovery_fallback_mode: item.discovery_fallback_mode || selectedPass || "strict",
      discovery_score: item.discovery_score || 0,
      discovery_views: stats.views || 0,
      discovery_likes: stats.likes || 0,
      discovery_comments: stats.comments || 0,
      discovery_views_per_hour: Math.round(stats.viewsPerHour || 0)
    });
    added.push(video);
    knownIds.add(video.youtube_video_id);
  }

  if (added.length) {
    console.log("AUTO DISCOVERY queued videos:", added.map((item) => ({
      id: item.id,
      youtube_video_id: item.youtube_video_id,
      url: item.url,
      target_date: item.target_date
    })));
  } else {
    console.log("AUTO DISCOVERY tidak menemukan kandidat viral baru.");
  }

  return { skipped: false, added };
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  discoverAndQueueVideos({
    theme: process.env.THEME || "podcast artis",
    targetDate: todayDate()
  })
    .then((result) => {
      console.log(JSON.stringify({
        ...result,
        added: result.added?.map((item) => ({
          id: item.id,
          url: item.url,
          status: item.status
        })) || []
      }, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

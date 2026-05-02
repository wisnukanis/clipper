import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addVideo } from "./selector.js";
import { readJson } from "./storage.js";
import { todayDate } from "./job-id.js";
import { extractYoutubeVideoId } from "./youtube.js";

const DEFAULT_QUERIES = [
  "podcast artis indonesia viral",
  "podcast artis indonesia terbaru",
  "podcast deddy corbuzier artis terbaru",
  "podcast raditya dika artis",
  "podcast vindes artis terbaru"
];

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
    .split(/[\n|;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function videoUrl(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}

function knownVideoIds(videos, history) {
  const ids = new Set();
  for (const item of [...videos, ...history]) {
    const id = item.youtube_video_id || extractYoutubeVideoId(item.url || item.source_url);
    if (id) ids.add(id);
  }
  return ids;
}

function isPodcastCandidate(item, minDuration, maxDuration) {
  const id = item.id || extractYoutubeVideoId(item.url || item.webpage_url);
  if (!id) return false;

  const duration = Number(item.duration || 0);
  if (duration && duration < minDuration) return false;
  if (duration && duration > maxDuration) return false;

  const text = [
    item.title,
    item.description,
    item.channel,
    item.uploader
  ].join(" ").toLowerCase();

  return /podcast|podhub|podkesmas|vindes|deddy|corbuzier|raditya|artis|komika|aktor|penyanyi/.test(text);
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

function scoreCandidate(item) {
  const views = Number(item.view_count || 0);
  const duration = Number(item.duration || 0);
  const verifiedBoost = item.channel_is_verified ? 250000 : 0;
  const durationBoost = duration >= 1800 && duration <= 7200 ? 150000 : 0;
  return views + verifiedBoost + durationBoost;
}

export async function discoverAndQueueVideos(options = {}) {
  if (!boolEnv("AUTO_DISCOVER_VIDEOS", true)) {
    return { skipped: true, reason: "AUTO_DISCOVER_VIDEOS=false", added: [] };
  }

  const queries = listEnv("AUTO_DISCOVER_QUERY", DEFAULT_QUERIES);
  const maxResults = numberEnv("AUTO_DISCOVER_MAX_RESULTS", 8, 1, 25);
  const addCount = numberEnv("AUTO_DISCOVER_ADD_COUNT", 3, 1, 10);
  const minDuration = numberEnv("AUTO_DISCOVER_MIN_DURATION_SECONDS", 900, 0, 86400);
  const maxDuration = numberEnv("AUTO_DISCOVER_MAX_DURATION_SECONDS", 10800, 60, 86400);
  const theme = options.theme && options.theme !== "auto" ? options.theme : "podcast artis";
  const targetDate = options.targetDate || todayDate();

  const videos = await readJson("videos", []);
  const history = await readJson("history", []);
  const knownIds = knownVideoIds(videos, history);
  const candidates = new Map();

  for (const query of queries) {
    try {
      const results = await runYtDlpSearch(query, maxResults);
      for (const item of results) {
        const id = item.id || extractYoutubeVideoId(item.url || item.webpage_url);
        if (!id || knownIds.has(id) || candidates.has(id)) continue;
        if (!isPodcastCandidate(item, minDuration, maxDuration)) continue;
        candidates.set(id, { ...item, id, discovery_query: query });
      }
    } catch (error) {
      console.warn(`Auto discovery query gagal (${query}): ${error.message}`);
    }
  }

  const selected = [...candidates.values()]
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, addCount);

  const added = [];
  for (const item of selected) {
    const url = item.webpage_url || item.url || videoUrl(item.id);
    const video = await addVideo({
      url,
      theme,
      target_date: targetDate,
      priority: 20,
      status: "queued",
      quality_profile: process.env.VIDEO_QUALITY_PROFILE || "standard",
      subtitle_font: process.env.SUBTITLE_FONT_FAMILY || "Segoe UI",
      subtitle_font_size: Number(process.env.SUBTITLE_FONT_SIZE || 46),
      subtitle_margin_v: Number(process.env.SUBTITLE_MARGIN_V || 400),
      notes: [
        `Auto discovery: ${item.discovery_query}`,
        item.channel ? `channel=${item.channel}` : "",
        item.view_count ? `views=${item.view_count}` : ""
      ].filter(Boolean).join("; ")
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
    console.log("AUTO DISCOVERY tidak menemukan kandidat baru.");
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

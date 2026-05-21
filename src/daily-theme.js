import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { todayDate } from "./job-id.js";

const DEFAULT_CONTENT_TYPES = ["renungan", "inspiratif", "opini", "mindset", "mixed_best"];
export const CONTENT_TYPES = parseList(process.env.CONTENT_TYPES).length
  ? parseList(process.env.CONTENT_TYPES)
  : DEFAULT_CONTENT_TYPES;

const DEFAULT_WEEKLY = {
  monday: "renungan",
  tuesday: "inspiratif",
  wednesday: "opini",
  thursday: "renungan",
  friday: "inspiratif",
  saturday: "mindset",
  sunday: "mixed_best"
};

const DEFAULT_QUERIES = {
  renungan: "ceramah pendek islam|renungan hidup islam|nasihat kehidupan islam|ceramah tentang rezeki|ceramah tentang sabar|ceramah tentang sedekah|ceramah tentang ikhlas|ceramah tentang ujian hidup|kajian keluarga islam|kajian islam terbaru indonesia|ceramah tentang kehilangan|ceramah tentang keluarga",
  inspiratif: "kisah inspiratif indonesia|podcast keluarga indonesia|nasihat orang tua|kisah perjuangan hidup|cerita keluarga inspiratif|motivasi hidup indonesia|kisah orang biasa inspiratif|pengalaman hidup inspiratif|cerita sukses dari nol|kisah keluarga menyentuh|perjuangan orang tua|kisah hidup inspiratif",
  opini: "opini tokoh indonesia|podcast politik indonesia|demokrasi indonesia|kritik sosial indonesia|isu sosial indonesia|politik ringan indonesia|obrolan tokoh indonesia|podcast indonesia terbaru|diskusi publik indonesia|analisis sosial indonesia|kritik masyarakat indonesia|opini publik indonesia",
  mindset: "motivasi karier indonesia|mindset sukses indonesia|podcast bisnis indonesia|motivasi anak muda indonesia|zona nyaman|kerja keras sukses|skill masa depan indonesia|pengembangan diri indonesia|produktif indonesia|nasihat karier indonesia|mindset bisnis indonesia|cara berpikir sukses",
  mixed_best: "renungan hidup islam|kisah inspiratif indonesia|podcast keluarga indonesia|opini tokoh indonesia|motivasi hidup indonesia|mindset sukses indonesia|ceramah pendek islam|nasihat kehidupan|podcast indonesia inspiratif|cerita hidup inspiratif"
};

const DEFAULT_CHANNELS = {
  renungan: "",
  inspiratif: "",
  opini: "",
  mindset: "",
  mixed_best: ""
};

const THEME_PROMPTS = {
  renungan: "Pilih bagian yang adem, reflektif, punya hikmah, dan cocok untuk disimpan/share. Prioritaskan rezeki, sabar, ikhlas, sedekah, ujian, kehilangan, keluarga, dan nasihat agama. Hindari potongan debat, serangan kelompok, atau kalimat keras yang perlu konteks panjang.",
  inspiratif: "Pilih bagian yang punya cerita personal, keluarga, perjuangan, kegagalan, bangkit, pengalaman lucu/haru, atau nasihat orang tua. Hindari bagian yang hanya menyebut nama orang tanpa makna universal.",
  opini: "Pilih bagian yang tajam, jelas, dan bikin mikir. Prioritaskan kritik sosial ringan, demokrasi, kebiasaan masyarakat, opini tokoh, dan pertanyaan yang mengundang komentar. Hindari tuduhan tanpa konteks, potongan provokatif berlebihan, dan kalimat yang bisa memelintir makna.",
  mindset: "Pilih bagian yang praktis, menampar, dan relevan dengan karier, uang, bisnis, kerja keras, zona nyaman, produktivitas, atau skill masa depan. Hindari bagian yang terlalu teknis atau terlalu panjang konteksnya.",
  mixed_best: "Pilih kandidat terbaik lintas tema dengan prioritas hook kuat, aman konteks, jelas, dan tidak duplikat."
};

const THEME_HASHTAGS = {
  renungan: ["#Renungan", "#Ceramah", "#HikmahHidup", "#NasihatAgama", "#Shorts"],
  inspiratif: ["#KisahInspiratif", "#Keluarga", "#MotivasiHidup", "#CeritaHidup", "#Shorts"],
  opini: ["#Opini", "#KritikSosial", "#BikinMikir", "#Indonesia", "#Shorts"],
  mindset: ["#Mindset", "#Karier", "#Produktivitas", "#PengembanganDiri", "#Shorts"],
  mixed_best: ["#Renungan", "#KisahInspiratif", "#Mindset", "#Opini", "#Shorts"]
};

export function resolveDailyPlan(options = {}) {
  const now = new Date();
  const dateWib = options.targetDate || todayDate(config.timezone);
  const dayKey = weekdayKey(now, config.timezone);
  const requestedTheme = normalizeContentType(options.theme);
  const theme = requestedTheme && requestedTheme !== "auto"
    ? requestedTheme
    : normalizeContentType(process.env[`${dayKey.toUpperCase()}_THEME`]) || DEFAULT_WEEKLY[dayKey];
  const targetMax = clampNumber(options.targetCount || process.env.DAILY_TARGET_MAX, 5, 4, 5);
  const targetMin = clampNumber(process.env.DAILY_TARGET_MIN, 4, 1, targetMax);
  const slots = publishSlots(targetMax);
  const themeAware = process.env.THEME_AWARE_DISCOVERY !== "false";
  const themeQuery = themeAware ? envForTheme(theme, "DISCOVER_QUERY") || DEFAULT_QUERIES[theme] || "" : "";
  const query = themeQuery || process.env.AUTO_DISCOVER_DAILY_QUERY || process.env.AUTO_DISCOVER_QUERY || DEFAULT_QUERIES.mixed_best;
  const dailyQuery = process.env[`${theme.toUpperCase()}_DAILY_QUERY`] || query.split("|")[0] || process.env.AUTO_DISCOVER_DAILY_QUERY || "";
  const channelHandles = envForTheme(theme, "CHANNEL_HANDLES") || process.env.AUTO_DISCOVER_CHANNEL_HANDLES || DEFAULT_CHANNELS[theme] || "";

  return {
    dateWib,
    dayKey,
    timezone: config.timezone,
    contentType: theme,
    dailyTheme: theme,
    targetMin,
    targetMax,
    slots,
    query,
    dailyQuery,
    discoveryMode: themeAware ? "theme_aware" : "legacy",
    channelHandles,
    themePrompt: THEME_PROMPTS[theme] || THEME_PROMPTS.mixed_best,
    hashtags: THEME_HASHTAGS[theme] || THEME_HASHTAGS.mixed_best,
    publishSlotWib: currentOrNextSlot(slots, now, config.timezone)
  };
}

export function applyDailyPlanToEnv(plan) {
  process.env.CONTENT_TYPE = plan.contentType;
  process.env.DAILY_THEME = plan.dailyTheme;
  process.env.AUTO_DISCOVER_QUERY = plan.query;
  process.env.AUTO_DISCOVER_DAILY_QUERY = plan.dailyQuery;
  if (plan.channelHandles) process.env.AUTO_DISCOVER_CHANNEL_HANDLES = plan.channelHandles;
  process.env.AUTO_DISCOVER_ADD_COUNT = String(plan.targetMax);
  process.env.AUTO_DISCOVER_DAILY_QUEUE_LIMIT = String(Math.max(plan.targetMax, Number(process.env.AUTO_DISCOVER_DAILY_QUEUE_LIMIT || 0) || 0));
  process.env.MAX_SCHEDULED_POSTS_PER_DAY = String(plan.targetMax);
  process.env.CLIP_COUNT = String(plan.targetMax);
  process.env.THEME_PROMPT = plan.themePrompt;
  process.env.THEME_HASHTAGS = plan.hashtags.join(" ");
  process.env.DAILY_PUBLISH_SLOTS_WIB = plan.slots.join(",");
  process.env.DISCOVERY_MODE = plan.discoveryMode;
}

export async function ensureQueueFiles() {
  const dir = path.join(config.dataDir, "queues");
  await fs.mkdir(dir, { recursive: true });
  await Promise.all([...CONTENT_TYPES, "review"].map(async (name) => {
    const file = path.join(dir, `${name}.json`);
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, "[]\n", "utf8");
    }
  }));
}

export async function appendQueueItem(contentType, item) {
  await ensureQueueFiles();
  const name = CONTENT_TYPES.includes(contentType) ? contentType : "review";
  const file = path.join(config.dataDir, "queues", `${name}.json`);
  const list = JSON.parse(await fs.readFile(file, "utf8").catch(() => "[]"));
  const key = item.source_video_id || item.source_url || item.output_file;
  const index = list.findIndex((entry) => (entry.source_video_id || entry.source_url || entry.output_file) === key);
  const record = { ...item, updated_at: new Date().toISOString() };
  if (index === -1) list.push(record);
  else list[index] = { ...list[index], ...record };
  await fs.writeFile(file, `${JSON.stringify(list.slice(-500), null, 2)}\n`, "utf8");
}

export function normalizeContentType(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[^a-z_]+/g, "_");
  if (CONTENT_TYPES.includes(normalized)) return normalized;
  return normalized === "auto" ? "auto" : "";
}

function weekdayKey(date, timeZone) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone })
    .format(date)
    .toLowerCase();
}

function envForTheme(theme, suffix) {
  return process.env[`${String(theme || "").toUpperCase()}_${suffix}`] || "";
}

function parseList(value) {
  return String(value || "")
    .split(/[\n,|;]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.floor(number), min), max);
}

function publishSlots(targetMax) {
  const slots = String(process.env.DAILY_PUBLISH_SLOTS_WIB || "05:30,09:30,12:15,16:30,19:30")
    .split(",")
    .map((slot) => slot.trim())
    .filter(Boolean);
  if (targetMax <= 4 && slots.length >= 5) return [slots[0], slots[2], slots[3], slots[4]];
  return slots.slice(0, 5);
}

function currentOrNextSlot(slots, now, timeZone) {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(now);
  return slots.find((slot) => slot >= time) || slots[0] || "";
}

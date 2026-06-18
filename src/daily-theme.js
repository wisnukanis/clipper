import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { todayDate } from "./job-id.js";

const DEFAULT_CONTENT_TYPES = [
  "inspiratif_hikmah",
  "podcast_lucu_hikmah"
];
const CONTENT_TYPE_ALIASES = {
  inspiratif: "inspiratif_hikmah",
  renungan: "inspiratif_hikmah",
  hikmah: "inspiratif_hikmah",
  humor_insight: "podcast_lucu_hikmah",
  lucu: "podcast_lucu_hikmah",
  podcast: "podcast_lucu_hikmah",
  kisah_islami_lama: "inspiratif_hikmah",
  kisah_islami: "inspiratif_hikmah",
  motivasi_renungan: "inspiratif_hikmah",
  sejarah_tokoh: "inspiratif_hikmah",
  fakta_sains: "podcast_lucu_hikmah",
  misteri_trending: "podcast_lucu_hikmah",
  mindset: "inspiratif_hikmah",
  opini: "podcast_lucu_hikmah",
  mixed_best: "podcast_lucu_hikmah"
};
const LEGACY_ENV_KEYS = {
  inspiratif_hikmah: ["INSPIRATIF", "RENUNGAN", "MOTIVASI_RENUNGAN", "KISAH_ISLAMI", "SEJARAH_TOKOH"],
  podcast_lucu_hikmah: ["HUMOR_INSIGHT", "MIXED_BEST", "OPINI", "FAKTA_SAINS", "MISTERI_TRENDING"]
};
export const CONTENT_TYPES = uniqueList([
  ...(process.env.CONTENT_TYPES ? [] : DEFAULT_CONTENT_TYPES),
  ...parseList(process.env.CONTENT_TYPES || DEFAULT_CONTENT_TYPES.join(",")).map((item) => CONTENT_TYPE_ALIASES[item] || item)
]).filter((item) => DEFAULT_CONTENT_TYPES.includes(item));

const DEFAULT_WEEKLY = {
  monday: "inspiratif_hikmah",
  tuesday: "podcast_lucu_hikmah",
  wednesday: "inspiratif_hikmah",
  thursday: "podcast_lucu_hikmah",
  friday: "inspiratif_hikmah",
  saturday: "podcast_lucu_hikmah",
  sunday: "inspiratif_hikmah"
};

const DEFAULT_QUERIES = {
  inspiratif_hikmah: "cerita inspiratif indonesia|hikmah kehidupan|nasihat kehidupan|kisah perjuangan hidup|cerita keluarga menyentuh|motivasi hidup indonesia|rezeki tidak selalu uang|sabar ikhlas syukur|pengalaman hidup inspiratif|cerita orang tua",
  podcast_lucu_hikmah: "podcast lucu indonesia ada hikmahnya|cerita lucu podcast indonesia|pengalaman lucu hidup podcast|obrolan lucu tapi bermakna|podcast keluarga lucu|cerita kocak ada pelajaran|ketawa tapi dalem podcast|podcast indonesia cerita hidup lucu"
};

const DEFAULT_CHANNELS = {
  inspiratif_hikmah: "",
  podcast_lucu_hikmah: ""
};

const SAFETY_GUARD = "Wajib hindari politik praktis, SARA provokatif, horor ekstrem, gosip vulgar, konten dewasa, kekerasan eksplisit, dan klaim agama sensitif tanpa sumber jelas. Jika ragu, turunkan context_safety_score dan jangan pilih untuk auto-publish.";

const THEME_PROMPTS = {
  inspiratif_hikmah: `Pilih potongan cerita inspiratif dan hikmah kehidupan yang relate, emosional secukupnya, dan bisa berdiri sendiri. Prioritaskan cerita keluarga, perjuangan, rezeki, sabar, ikhlas, pengalaman pribadi, nasihat orang tua, dan twist yang bikin hati adem. Hindari ceramah teoritis panjang tanpa cerita atau konteks yang menggantung. ${SAFETY_GUARD}`,
  podcast_lucu_hikmah: `Pilih potongan podcast yang lucu, ringan, relate, tapi tetap punya makna. Prioritaskan pengalaman nyata, konflik ringan, punchline, ekspresi lucu, obrolan keluarga/kerja/usaha, dan ending yang bikin "kok iya ya". Hindari gosip mentah, vulgar, politik panas, atau candaan yang menyerang. ${SAFETY_GUARD}`
};

const THEME_HASHTAGS = {
  inspiratif_hikmah: ["#Shorts", "#CeritaInspiratif", "#Hikmah", "#Renungan", "#MotivasiHidup", "#CeritaHidup"],
  podcast_lucu_hikmah: ["#Shorts", "#PodcastIndonesia", "#CeritaLucu", "#CeritaHidup", "#InspirasiHidup", "#Hikmah"]
};

const DEFAULT_SLOT_TYPES_5 = ["inspiratif_hikmah", "podcast_lucu_hikmah", "inspiratif_hikmah", "podcast_lucu_hikmah", "inspiratif_hikmah"];
const DEFAULT_SLOT_TYPES_4 = ["inspiratif_hikmah", "podcast_lucu_hikmah", "inspiratif_hikmah", "podcast_lucu_hikmah"];

export function resolveDailyPlan(options = {}) {
  const now = new Date();
  const dateWib = options.targetDate || todayDate(config.timezone);
  const dayKey = weekdayKey(now, config.timezone);
  const dailyThemeMode = String(process.env.DAILY_THEME_MODE || "").trim().toLowerCase();
  const targetMax = clampNumber(options.targetCount || process.env.DAILY_TARGET_MAX, 3, 1, 5);
  const targetMin = clampNumber(process.env.DAILY_TARGET_MIN, Math.min(3, targetMax), 1, targetMax);
  const targetCount = clampNumber(options.targetCount || targetMax, targetMax, targetMin, targetMax);
  const slots = publishSlots(targetCount);
  const themeAware = process.env.THEME_AWARE_DISCOVERY !== "false";

  if (dailyThemeMode === "mixed_daily") {
    const slotPlans = resolveSlotPlans({
      targetCount,
      slots,
      themeAware,
      selectedSlot: options.slot || process.env.CLIPPER_SLOT || "all"
    });
    const slotWib = currentOrNextSlot(slots, now, config.timezone);
    const activeSlot = slotPlans.find((s) => s.slot_time_wib === slotWib) || slotPlans[0];
    const primary = activeSlot || resolveSlotPlan(1, slots[0] || "07:00", "inspiratif_hikmah", themeAware);
    return {
      dateWib,
      dayKey,
      timezone: config.timezone,
      mode: "mixed_daily",
      contentType: primary.content_type,
      dailyTheme: "mixed_daily",
      targetMin,
      targetMax,
      targetCount,
      slots,
      slotPlans,
      query: primary.discover_query,
      dailyQuery: primary.discover_query.split("|")[0] || process.env.AUTO_DISCOVER_DAILY_QUERY || "",
      discoveryMode: themeAware ? "theme_aware_slot" : "legacy",
      channelHandles: primary.channel_handles,
      themePrompt: THEME_PROMPTS[primary.content_type] || THEME_PROMPTS.inspiratif_hikmah,
      hashtags: THEME_HASHTAGS[primary.content_type] || THEME_HASHTAGS.inspiratif_hikmah,
      publishSlotWib: slotWib
    };
  }

  const requestedTheme = normalizeContentType(options.theme);
  const theme = requestedTheme && requestedTheme !== "auto"
    ? requestedTheme
    : normalizeContentType(process.env[`${dayKey.toUpperCase()}_THEME`]) || DEFAULT_WEEKLY[dayKey];
  const themeQuery = themeAware ? envForTheme(theme, "DISCOVER_QUERY") || DEFAULT_QUERIES[theme] || "" : "";
  const query = themeQuery || process.env.AUTO_DISCOVER_DAILY_QUERY || process.env.AUTO_DISCOVER_QUERY || DEFAULT_QUERIES.inspiratif_hikmah;
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
    targetCount: targetMax,
    slots,
    slotPlans: slots.map((slot, index) => resolveSlotPlan(index + 1, slot, theme, themeAware)),
    query,
    dailyQuery,
    discoveryMode: themeAware ? "theme_aware" : "legacy",
    channelHandles,
    themePrompt: THEME_PROMPTS[theme] || THEME_PROMPTS.inspiratif_hikmah,
    hashtags: THEME_HASHTAGS[theme] || THEME_HASHTAGS.inspiratif_hikmah,
    publishSlotWib: currentOrNextSlot(slots, now, config.timezone)
  };
}

export function applyDailyPlanToEnv(plan) {
  process.env.CONTENT_TYPE = plan.contentType;
  process.env.DAILY_THEME = plan.dailyTheme;
  process.env.AUTO_DISCOVER_QUERY = plan.query;
  process.env.AUTO_DISCOVER_DAILY_QUERY = plan.dailyQuery;
  if (plan.channelHandles) process.env.AUTO_DISCOVER_CHANNEL_HANDLES = plan.channelHandles;
  process.env.FAST_PRODUCTION_MODE = String(process.env.FAST_PRODUCTION_MODE || "false");
  process.env.AUTO_DISCOVER_ADD_COUNT = fastProductionMode()
    ? String(plan.targetMax)
    : String(Number(process.env.AUTO_DISCOVER_ADD_COUNT || 5) || 5);
  process.env.AUTO_DISCOVER_DAILY_QUEUE_LIMIT = String(Math.max(9, plan.targetMax, Number(process.env.AUTO_DISCOVER_DAILY_QUEUE_LIMIT || 0) || 0));
  process.env.MAX_SCHEDULED_POSTS_PER_DAY = String(Number(process.env.YOUTUBE_DAILY_UPLOAD_LIMIT || plan.targetMax) || plan.targetMax);
  process.env.CLIP_COUNT = String(plan.targetMax);
  process.env.THEME_PROMPT = plan.themePrompt;
  process.env.THEME_HASHTAGS = plan.hashtags.join(" ");
  process.env.DAILY_PUBLISH_SLOTS_WIB = plan.slots.join(",");
  process.env.DISCOVERY_MODE = plan.discoveryMode;
}

export function applySlotPlanToEnv(slotPlan, plan = {}) {
  const contentType = normalizeContentType(slotPlan?.content_type) || "inspiratif_hikmah";
  process.env.CONTENT_TYPE = contentType;
  process.env.DAILY_THEME = plan.dailyTheme || contentType;
  process.env.AUTO_DISCOVER_QUERY = slotPlan.discover_query || process.env.AUTO_DISCOVER_QUERY || "";
  process.env.AUTO_DISCOVER_DAILY_QUERY = (slotPlan.discover_query || "").split("|")[0] || process.env.AUTO_DISCOVER_DAILY_QUERY || "";
  if (slotPlan.channel_handles) process.env.AUTO_DISCOVER_CHANNEL_HANDLES = slotPlan.channel_handles;
  process.env.AUTO_DISCOVER_ADD_COUNT = fastProductionMode()
    ? String(Number(process.env.AUTO_DISCOVER_ADD_COUNT_PER_SLOT || 1) || 1)
    : String(Number(process.env.AUTO_DISCOVER_ADD_COUNT_PER_SLOT || process.env.AUTO_DISCOVER_ADD_COUNT || 5) || 5);
  process.env.CLIP_COUNT = "1";
  process.env.THEME_PROMPT = THEME_PROMPTS[contentType] || THEME_PROMPTS.inspiratif_hikmah;
  process.env.THEME_HASHTAGS = (THEME_HASHTAGS[contentType] || THEME_HASHTAGS.inspiratif_hikmah).join(" ");
  process.env.CLIPPER_SLOT = String(slotPlan.slot_index || "");
}

function fastProductionMode() {
  return ["1", "true", "yes", "on"].includes(String(process.env.FAST_PRODUCTION_MODE || "").toLowerCase());
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
  if (CONTENT_TYPE_ALIASES[normalized]) return CONTENT_TYPE_ALIASES[normalized];
  return normalized === "auto" ? "auto" : "";
}

function weekdayKey(date, timeZone) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone })
    .format(date)
    .toLowerCase();
}

function envForTheme(theme, suffix, rawTheme = "") {
  const rawKey = String(rawTheme || "").trim().toUpperCase().replace(/[^A-Z0-9_]+/g, "_");
  if (rawKey) {
    const raw = process.env[`${rawKey}_${suffix}`];
    if (raw) return raw;
  }
  const key = String(theme || "").toUpperCase();
  const direct = process.env[`${key}_${suffix}`];
  if (direct) return direct;
  for (const legacyKey of LEGACY_ENV_KEYS[theme] || []) {
    const legacy = process.env[`${legacyKey}_${suffix}`];
    if (legacy) return legacy;
  }
  return "";
}

function queryForTheme(theme, themeAware, rawTheme = "") {
  if (!themeAware) return process.env.AUTO_DISCOVER_QUERY || DEFAULT_QUERIES.inspiratif_hikmah;
  return envForTheme(theme, "DISCOVER_QUERY", rawTheme)
    || DEFAULT_QUERIES[theme]
    || process.env.AUTO_DISCOVER_DAILY_QUERY
    || process.env.AUTO_DISCOVER_QUERY
    || "";
}

function channelHandlesForTheme(theme, rawTheme = "") {
  return envForTheme(theme, "CHANNEL_HANDLES", rawTheme) || process.env.AUTO_DISCOVER_CHANNEL_HANDLES || "";
}

function resolveSlotPlans({ targetCount, slots, themeAware, selectedSlot = "all" }) {
  const slotNameMap = { pagi: "1", siang: "2", malam: "3" };
  const requestedSlotRaw = String(selectedSlot || "all").trim().toLowerCase();
  const requestedSlot = slotNameMap[requestedSlotRaw] || requestedSlotRaw;
  const defaults = targetCount <= 4 ? DEFAULT_SLOT_TYPES_4 : DEFAULT_SLOT_TYPES_5;
  const fromMix = slotTypesFromMix(targetCount);
  const slotTypes = defaults.map((fallback, index) => {
    const envValue = normalizeContentType(process.env[`SLOT_${index + 1}_CONTENT_TYPE`]);
    return envValue || fromMix[index] || fallback;
  });

  return slots.slice(0, targetCount)
    .map((slot, index) => {
      const slotIndex = index + 1;
      const timeWib = process.env[`SLOT_${slotIndex}_TIME_WIB`] || slot;
      const rawSlotType = process.env[`SLOT_${slotIndex}_CONTENT_TYPE`] || slotTypes[index] || "inspiratif_hikmah";
      return resolveSlotPlan(slotIndex, timeWib, rawSlotType, themeAware);
    })
    .filter((slot) => requestedSlot === "all" || String(slot.slot_index) === requestedSlot);
}

function resolveSlotPlan(slotIndex, timeWib, contentType, themeAware) {
  const normalized = normalizeContentType(contentType) || "inspiratif_hikmah";
  const discoverQuery = queryForTheme(normalized, themeAware, contentType);
  const channelHandles = channelHandlesForTheme(normalized, contentType);
  return {
    slot_index: slotIndex,
    slot_time_wib: timeWib,
    content_type: normalized,
    slot_content_type: normalized,
    discover_query: discoverQuery,
    channel_handles: channelHandles,
    selected_channel_handles: parseLooseList(channelHandles),
    discovery_mode: themeAware ? "theme_aware_slot" : "legacy",
    theme_prompt: THEME_PROMPTS[normalized] || THEME_PROMPTS.inspiratif_hikmah,
    hashtags: THEME_HASHTAGS[normalized] || THEME_HASHTAGS.inspiratif_hikmah
  };
}

function slotTypesFromMix(targetCount) {
  const raw = process.env[targetCount <= 4 ? "DAILY_CONTENT_MIX_4" : "DAILY_CONTENT_MIX"]
    || process.env.DAILY_CONTENT_MIX
    || "";
  const result = [];
  for (const part of String(raw).split(/[,;]+/)) {
    const [name, countText] = part.split(":").map((item) => item?.trim());
    const type = normalizeContentType(name);
    const count = Math.max(0, Number(countText || 0) || 0);
    for (let index = 0; type && index < count; index += 1) result.push(type);
  }
  return result.slice(0, targetCount);
}

function parseList(value) {
  return String(value || "")
    .split(/[\n,|;]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function uniqueList(values) {
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.floor(number), min), max);
}

function publishSlots(targetMax) {
  const slots = String(process.env.UPLOAD_SLOTS || process.env.DAILY_PUBLISH_SLOTS_WIB || "07:00,12:00,19:30")
    .split(",")
    .map((slot) => slot.trim())
    .filter(Boolean);
  return slots.slice(0, targetMax);
}

function parseLooseList(value) {
  return String(value || "")
    .split(/[\n,|;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
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

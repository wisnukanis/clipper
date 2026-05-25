import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { todayDate } from "./job-id.js";

const DEFAULT_CONTENT_TYPES = [
  "motivasi_renungan",
  "sejarah_tokoh",
  "kisah_islami",
  "fakta_sains",
  "misteri_trending"
];
const CONTENT_TYPE_ALIASES = {
  renungan: "kisah_islami",
  inspiratif: "motivasi_renungan",
  mindset: "motivasi_renungan",
  opini: "misteri_trending",
  mixed_best: "misteri_trending"
};
const LEGACY_ENV_KEYS = {
  motivasi_renungan: ["INSPIRATIF", "MINDSET"],
  kisah_islami: ["RENUNGAN"],
  misteri_trending: ["MIXED_BEST", "OPINI"]
};
export const CONTENT_TYPES = uniqueList([
  ...DEFAULT_CONTENT_TYPES,
  ...parseList(process.env.CONTENT_TYPES).map((item) => CONTENT_TYPE_ALIASES[item] || item)
]).filter((item) => DEFAULT_CONTENT_TYPES.includes(item));

const DEFAULT_WEEKLY = {
  monday: "motivasi_renungan",
  tuesday: "sejarah_tokoh",
  wednesday: "kisah_islami",
  thursday: "fakta_sains",
  friday: "motivasi_renungan",
  saturday: "misteri_trending",
  sunday: "kisah_islami"
};

const DEFAULT_QUERIES = {
  motivasi_renungan: "motivasi hidup indonesia|renungan hidup|nasihat kehidupan|kisah perjuangan hidup|pengembangan diri indonesia|nasihat orang tua|cerita inspiratif indonesia|motivasi kerja keras|hidup sederhana bermakna|pelajaran hidup",
  sejarah_tokoh: "sejarah indonesia|tokoh indonesia inspiratif|kisah nyata tokoh dunia|biografi tokoh indonesia|sejarah tokoh islam aman|kisah pahlawan indonesia|cerita sejarah singkat|fakta sejarah indonesia|kisah nyata inspiratif|tokoh dunia berpengaruh",
  kisah_islami: "kisah islami penuh hikmah|hikmah kehidupan islam|cerita islami singkat|nilai moral islami|kisah sahabat nabi penuh hikmah|ceramah pendek islam adem|nasihat agama islam|akhlak mulia islam|kisah teladan islam|renungan islami",
  fakta_sains: "fakta unik indonesia|sains ringan indonesia|pengetahuan populer|fakta psikologi ringan|fakta tubuh manusia|teknologi sederhana|fenomena alam dijelaskan|edukasi sains indonesia|fakta sejarah populer|ilmu pengetahuan umum",
  misteri_trending: "misteri sejarah indonesia|fenomena menarik dunia|fakta unik misterius|teka teki sejarah|tempat bersejarah misterius|fenomena alam unik|trending edukatif indonesia|kisah nyata penuh tanda tanya|misteri arkeologi|fakta menarik trending aman"
};

const DEFAULT_CHANNELS = {
  motivasi_renungan: "",
  sejarah_tokoh: "",
  kisah_islami: "",
  fakta_sains: "",
  misteri_trending: ""
};

const SAFETY_GUARD = "Wajib hindari politik praktis, SARA provokatif, horor ekstrem, gosip vulgar, konten dewasa, kekerasan eksplisit, dan klaim agama sensitif tanpa sumber jelas. Jika ragu, turunkan context_safety_score dan jangan pilih untuk auto-publish.";

const THEME_PROMPTS = {
  motivasi_renungan: `Pilih bagian motivasi dan renungan hidup yang hangat, reflektif, mudah dipahami, dan memberi dorongan hidup tanpa menggurui. Prioritaskan perjuangan, keluarga, kerja keras, kegagalan, bangkit, dan pelajaran hidup universal. ${SAFETY_GUARD}`,
  sejarah_tokoh: `Pilih bagian sejarah, tokoh, dan kisah nyata yang informatif, inspiratif, serta punya pelajaran jelas. Prioritaskan biografi, peristiwa sejarah, pahlawan, tokoh dunia, dan kisah nyata yang aman konteks. ${SAFETY_GUARD}`,
  kisah_islami: `Pilih bagian kisah Islami, hikmah, dan nilai moral yang adem, edukatif, dan tidak menyerang kelompok mana pun. Prioritaskan akhlak, hikmah, kisah teladan, sabar, syukur, keluarga, dan nasihat moral. ${SAFETY_GUARD}`,
  fakta_sains: `Pilih bagian fakta unik, sains ringan, dan pengetahuan populer yang jelas, menarik, tidak menyesatkan, dan cocok untuk penonton umum. Prioritaskan fakta alam, tubuh manusia, psikologi ringan, teknologi, dan pengetahuan umum. ${SAFETY_GUARD}`,
  misteri_trending: `Pilih bagian misteri sejarah, fenomena menarik, dan trending aman yang bikin penasaran tanpa horor ekstrem atau klaim liar. Prioritaskan teka-teki sejarah, fenomena alam, arkeologi, dan topik trending edukatif. ${SAFETY_GUARD}`
};

const THEME_HASHTAGS = {
  motivasi_renungan: ["#MotivasiHidup", "#RenunganHidup", "#PelajaranHidup", "#Inspirasi", "#ShortsIndonesia"],
  sejarah_tokoh: ["#Sejarah", "#TokohInspiratif", "#KisahNyata", "#Pengetahuan", "#ShortsIndonesia"],
  kisah_islami: ["#KisahIslami", "#Hikmah", "#NilaiMoral", "#RenunganIslami", "#ShortsIndonesia"],
  fakta_sains: ["#FaktaUnik", "#SainsRingan", "#Pengetahuan", "#Edukasi", "#ShortsIndonesia"],
  misteri_trending: ["#MisteriSejarah", "#FenomenaMenarik", "#FaktaMenarik", "#TrendingAman", "#ShortsIndonesia"]
};

const DEFAULT_SLOT_TYPES_5 = ["motivasi_renungan", "sejarah_tokoh", "kisah_islami", "fakta_sains", "misteri_trending"];
const DEFAULT_SLOT_TYPES_4 = ["motivasi_renungan", "sejarah_tokoh", "kisah_islami", "fakta_sains"];

export function resolveDailyPlan(options = {}) {
  const now = new Date();
  const dateWib = options.targetDate || todayDate(config.timezone);
  const dayKey = weekdayKey(now, config.timezone);
  const dailyThemeMode = String(process.env.DAILY_THEME_MODE || "").trim().toLowerCase();
  const targetMax = clampNumber(options.targetCount || process.env.DAILY_TARGET_MAX, 5, 4, 5);
  const targetMin = clampNumber(process.env.DAILY_TARGET_MIN, 4, 1, targetMax);
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
    const primary = slotPlans[0] || resolveSlotPlan(1, slots[0] || "05:30", "misteri_trending", themeAware);
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
      themePrompt: THEME_PROMPTS[primary.content_type] || THEME_PROMPTS.misteri_trending,
      hashtags: THEME_HASHTAGS[primary.content_type] || THEME_HASHTAGS.misteri_trending,
      publishSlotWib: currentOrNextSlot(slots, now, config.timezone)
    };
  }

  const requestedTheme = normalizeContentType(options.theme);
  const theme = requestedTheme && requestedTheme !== "auto"
    ? requestedTheme
    : normalizeContentType(process.env[`${dayKey.toUpperCase()}_THEME`]) || DEFAULT_WEEKLY[dayKey];
  const themeQuery = themeAware ? envForTheme(theme, "DISCOVER_QUERY") || DEFAULT_QUERIES[theme] || "" : "";
  const query = themeQuery || process.env.AUTO_DISCOVER_DAILY_QUERY || process.env.AUTO_DISCOVER_QUERY || DEFAULT_QUERIES.misteri_trending;
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
    themePrompt: THEME_PROMPTS[theme] || THEME_PROMPTS.misteri_trending,
    hashtags: THEME_HASHTAGS[theme] || THEME_HASHTAGS.misteri_trending,
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
  process.env.AUTO_DISCOVER_DAILY_QUEUE_LIMIT = String(Math.max(25, plan.targetMax, Number(process.env.AUTO_DISCOVER_DAILY_QUEUE_LIMIT || 0) || 0));
  process.env.MAX_SCHEDULED_POSTS_PER_DAY = String(plan.targetMax);
  process.env.CLIP_COUNT = String(plan.targetMax);
  process.env.THEME_PROMPT = plan.themePrompt;
  process.env.THEME_HASHTAGS = plan.hashtags.join(" ");
  process.env.DAILY_PUBLISH_SLOTS_WIB = plan.slots.join(",");
  process.env.DISCOVERY_MODE = plan.discoveryMode;
}

export function applySlotPlanToEnv(slotPlan, plan = {}) {
  const contentType = normalizeContentType(slotPlan?.content_type) || "misteri_trending";
  process.env.CONTENT_TYPE = contentType;
  process.env.DAILY_THEME = plan.dailyTheme || contentType;
  process.env.AUTO_DISCOVER_QUERY = slotPlan.discover_query || process.env.AUTO_DISCOVER_QUERY || "";
  process.env.AUTO_DISCOVER_DAILY_QUERY = (slotPlan.discover_query || "").split("|")[0] || process.env.AUTO_DISCOVER_DAILY_QUERY || "";
  if (slotPlan.channel_handles) process.env.AUTO_DISCOVER_CHANNEL_HANDLES = slotPlan.channel_handles;
  process.env.AUTO_DISCOVER_ADD_COUNT = fastProductionMode()
    ? String(Number(process.env.AUTO_DISCOVER_ADD_COUNT_PER_SLOT || 1) || 1)
    : String(Number(process.env.AUTO_DISCOVER_ADD_COUNT_PER_SLOT || process.env.AUTO_DISCOVER_ADD_COUNT || 5) || 5);
  process.env.CLIP_COUNT = "1";
  process.env.THEME_PROMPT = THEME_PROMPTS[contentType] || THEME_PROMPTS.misteri_trending;
  process.env.THEME_HASHTAGS = (THEME_HASHTAGS[contentType] || THEME_HASHTAGS.misteri_trending).join(" ");
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
  if (!themeAware) return process.env.AUTO_DISCOVER_QUERY || DEFAULT_QUERIES.misteri_trending;
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
  const requestedSlot = String(selectedSlot || "all").trim().toLowerCase();
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
      const rawSlotType = process.env[`SLOT_${slotIndex}_CONTENT_TYPE`] || slotTypes[index] || "misteri_trending";
      return resolveSlotPlan(slotIndex, timeWib, rawSlotType, themeAware);
    })
    .filter((slot) => requestedSlot === "all" || String(slot.slot_index) === requestedSlot);
}

function resolveSlotPlan(slotIndex, timeWib, contentType, themeAware) {
  const normalized = normalizeContentType(contentType) || "misteri_trending";
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
    theme_prompt: THEME_PROMPTS[normalized] || THEME_PROMPTS.misteri_trending,
    hashtags: THEME_HASHTAGS[normalized] || THEME_HASHTAGS.misteri_trending
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
  const slots = String(process.env.DAILY_PUBLISH_SLOTS_WIB || "05:30,09:30,12:15,16:30,19:30")
    .split(",")
    .map((slot) => slot.trim())
    .filter(Boolean);
  return slots.slice(0, targetMax <= 4 ? 4 : 5);
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

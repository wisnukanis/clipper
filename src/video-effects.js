import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";

const FRAME = {
  width: 950,
  height: 1375,
  x: 65,
  y: 138
};
const rendererPath = path.join(config.srcDir, "branding-renderer.py");

const CONTENT_TYPE_ALIASES = {
  renungan: "kisah_islami",
  inspiratif: "motivasi_renungan",
  mindset: "motivasi_renungan",
  opini: "misteri_trending",
  mixed_best: "misteri_trending"
};

const LEGACY_FRAME_ENV_KEY = {
  motivasi_renungan: "MINDSET",
  sejarah_tokoh: "MIXED_BEST",
  kisah_islami: "RENUNGAN",
  fakta_sains: "MINDSET",
  misteri_trending: "HUMOR_INSIGHT"
};

const FRAME_PALETTE = {
  motivasi_renungan: { accent: "#B6FF00", secondary: "#00E5FF" },
  sejarah_tokoh: { accent: "#00E5FF", secondary: "#7C3AED" },
  kisah_islami: { accent: "#00E5FF", secondary: "#7C3AED" },
  fakta_sains: { accent: "#B6FF00", secondary: "#00E5FF" },
  misteri_trending: { accent: "#FF2BD6", secondary: "#00E5FF" },
  humor_insight: { accent: "#FF2BD6", secondary: "#00E5FF" }
};

const FRAME_LABELS = {
  motivasi_renungan: "MENIT HIKMAH",
  sejarah_tokoh: "KISAH NYATA",
  kisah_islami: "MENIT HIKMAH",
  fakta_sains: "FAKTA RINGAN",
  misteri_trending: "PILIHAN HARI INI",
  humor_insight: "LUCU TAPI DALAM"
};

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function effectOptions(video = {}, options = {}) {
  return {
    frame: boolValue(options.useFrame ?? video.use_frame, config.videoEffects.frameEnabled),
    filter: boolValue(options.useFilter ?? video.use_filter, config.videoEffects.filterEnabled),
    watermark: boolValue(options.useWatermark ?? video.use_watermark, config.videoEffects.watermarkEnabled),
    lowerThird: boolValue(options.useLowerThird ?? video.use_lower_third, config.videoEffects.lowerThirdEnabled)
  };
}

function hasAnyEffect(options) {
  return options.frame || options.filter || options.watermark;
}

async function fileIsReadable(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function hasAudioStream(filePath) {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=index",
      "-of", "csv=p=0",
      filePath
    ], { windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(Boolean(stdout.trim())));
  });
}

function ffmpegPathArg(filePath) {
  return String(filePath).replace(/\\/g, "/").replace(/'/g, "\\'");
}

function lightFilterChain() {
  return [
    "eq=brightness=0.012:contrast=1.035:saturation=1.06",
    "hue=h=2:s=1.02",
    "noise=alls=2:allf=t+u"
  ].join(",");
}

function numberEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function premiumFrameConfig(contentType = "") {
  const width = 1080;
  const height = 1920;
  const palette = resolveFramePalette(contentType);
  const colorMode = String(process.env.FRAME_COLOR_MODE || "").toLowerCase();
  const adaptiveNeon = colorMode === "adaptive_neon";
  const fgW = Math.round(width * numberEnv("FRAME_FOREGROUND_WIDTH_RATIO", 0.92, 0.75, 0.98));
  const fgH = Math.round(height * numberEnv("FRAME_FOREGROUND_HEIGHT_RATIO", 0.60, 0.42, 0.72));
  const x = Math.round((width - fgW) / 2);
  const y = Math.round(numberEnv("FRAME_FOREGROUND_Y", 310, 240, 520));
  return {
    width,
    height,
    fgW,
    fgH,
    x,
    y,
    blur: Math.round(numberEnv("FRAME_BACKGROUND_BLUR", 30, 4, 60)),
    darken: numberEnv("FRAME_BACKGROUND_DARKEN", 0.36, 0, 0.85),
    scale: numberEnv("FRAME_BACKGROUND_SCALE", 1.18, 1, 1.5),
    borderWidth: Math.round(numberEnv("FRAME_BORDER_WIDTH", numberEnv("FRAME_FOREGROUND_BORDER_WIDTH", 3, 0, 6), 0, 4)),
    borderColor: adaptiveNeon ? palette.accent : process.env.FRAME_FOREGROUND_BORDER_COLOR || "#F5C542",
    accentEnabled: boolValue(process.env.FRAME_ACCENT_LINE_ENABLED, true),
    accentColor: adaptiveNeon ? palette.accent : process.env.FRAME_ACCENT_LINE_COLOR || "#F5C542",
    secondaryColor: palette.secondary,
    accentWidth: Math.round(numberEnv("FRAME_ACCENT_LINE_WIDTH", 6, 1, 12)),
    colorMode: colorMode || "legacy",
    shapeMode: process.env.FRAME_SHAPE_MODE || "rounded",
    useFullBorder: boolValue(process.env.FRAME_USE_FULL_BORDER, !adaptiveNeon),
    usePartialGlow: boolValue(process.env.FRAME_USE_PARTIAL_GLOW, adaptiveNeon),
    glowEnabled: boolValue(process.env.FRAME_GLOW_ENABLED, adaptiveNeon),
    glowBlur: Math.round(numberEnv("FRAME_GLOW_BLUR", 18, 4, 36)),
    glowOpacity: numberEnv("FRAME_GLOW_OPACITY", 0.55, 0, 0.85),
    accentBarEnabled: boolValue(process.env.FRAME_ACCENT_BAR_ENABLED, adaptiveNeon),
    accentBarPosition: process.env.FRAME_ACCENT_BAR_POSITION || "left",
    accentBarWidth: Math.round(numberEnv("FRAME_ACCENT_BAR_WIDTH", 8, 3, 16)),
    labelEnabled: boolValue(process.env.FRAME_ACCENT_LABEL_ENABLED, adaptiveNeon),
    label: frameLabel(contentType)
  };
}

function resolveFramePalette(contentType = "") {
  const type = normalizeContentType(contentType);
  const key = type.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const legacyKey = LEGACY_FRAME_ENV_KEY[type] || key;
  return {
    accent: normalizeHexColor(process.env[`${key}_ACCENT_COLOR`] || process.env[`${legacyKey}_ACCENT_COLOR`] || FRAME_PALETTE[type]?.accent || "#00E5FF"),
    secondary: normalizeHexColor(process.env[`${key}_SECONDARY_COLOR`] || process.env[`${legacyKey}_SECONDARY_COLOR`] || FRAME_PALETTE[type]?.secondary || "#B6FF00")
  };
}

function normalizeContentType(value) {
  const key = String(value || "").toLowerCase().trim();
  return CONTENT_TYPE_ALIASES[key] || key || "misteri_trending";
}

function normalizeHexColor(value) {
  const color = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : "#00E5FF";
}

function frameLabel(contentType = "") {
  return FRAME_LABELS[normalizeContentType(contentType)] || "PILIHAN HARI INI";
}

function drawColor(value) {
  return normalizeHexColor(value).replace("#", "0x");
}

function escapeDrawtext(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/,/g, "\\,")
    .replace(/%/g, "\\%");
}

function normalizeOverlayText(value) {
  return String(value || "")
    .replace(/[`*_#]/g, "")
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 11)
    .join(" ");
}

function buildFilterGraph({ useFrame, useFilter, useWatermark, useLowerThird, premiumFrame, contentType = "" }) {
  const filters = [];
  const sourceFilters = ["setpts=PTS-STARTPTS", "setsar=1", "fps=30"];
  let nextInputIndex = 1;
  const bgIndex = useFrame && !premiumFrame ? nextInputIndex++ : null;
  const frameIndex = useFrame && !premiumFrame ? nextInputIndex++ : null;
  const lowerThirdIndex = useLowerThird ? nextInputIndex++ : null;
  const watermarkIndex = useWatermark ? nextInputIndex++ : null;

  if (useFrame && !premiumFrame) {
    sourceFilters.push(`scale=${FRAME.width}:${FRAME.height}:force_original_aspect_ratio=increase`);
    sourceFilters.push(`crop=${FRAME.width}:${FRAME.height}`);
  }
  if (useFilter) sourceFilters.push(lightFilterChain());
  filters.push(`[0:v]${sourceFilters.join(",")}[video]`);

  let current = "video";
  if (useFrame && premiumFrame) {
    const frame = premiumFrameConfig(contentType);
    const bgScaleW = Math.round(frame.width * frame.scale);
    const bgScaleH = Math.round(frame.height * frame.scale);
    filters.push(
      `[video]split=2[bgsrc][fgsrc]`,
      `[bgsrc]scale=${bgScaleW}:${bgScaleH}:force_original_aspect_ratio=increase,crop=${frame.width}:${frame.height},boxblur=${frame.blur}:1,eq=brightness=-${frame.darken}:contrast=1.04:saturation=1.05[bg]`,
      `[fgsrc]scale=${frame.fgW}:${frame.fgH}:force_original_aspect_ratio=increase,crop=${frame.fgW}:${frame.fgH},setsar=1[fg0]`
    );
    const fgLabel = frame.borderWidth > 0 && frame.useFullBorder
      ? "fg"
      : "fg0";
    if (frame.borderWidth > 0 && frame.useFullBorder) {
      filters.push(`[fg0]drawbox=x=0:y=0:w=iw:h=ih:color=${drawColor(frame.borderColor)}:t=${frame.borderWidth}[fg]`);
    }
    filters.push(`[bg][${fgLabel}]overlay=${frame.x}:${frame.y}:shortest=1[premium]`);
    current = "premium";
    if (frame.usePartialGlow) {
      const accent = drawColor(frame.accentColor);
      const secondary = drawColor(frame.secondaryColor);
      const corner = Math.round(numberEnv("FRAME_CUT_CORNER_SIZE", 48, 18, 86));
      const long = Math.min(390, Math.round(frame.fgW * 0.44));
      const bw = Math.max(2, frame.borderWidth || 3);
      const alpha = frame.glowEnabled ? Math.max(frame.glowOpacity, 0.68) : 0.35;
      filters.push(
        `[${current}]drawbox=x=${frame.x - 2}:y=${frame.y - 2}:w=${long}:h=${bw + 2}:color=${accent}@${alpha}:t=fill[glow1]`,
        `[glow1]drawbox=x=${frame.x - 2}:y=${frame.y - 2}:w=${bw + 2}:h=${long}:color=${accent}@${alpha}:t=fill[glow2]`,
        `[glow2]drawbox=x=${frame.x + frame.fgW - long + 2}:y=${frame.y + frame.fgH + 2}:w=${long}:h=${bw + 2}:color=${secondary}@${alpha}:t=fill[glow3]`,
        `[glow3]drawbox=x=${frame.x + frame.fgW + 2}:y=${frame.y + frame.fgH - long + 2}:w=${bw + 2}:h=${long}:color=${secondary}@${alpha}:t=fill[glow4]`,
        `[glow4]drawbox=x=${frame.x}:y=${frame.y}:w=${corner}:h=${bw}:color=${accent}:t=fill[cut1]`,
        `[cut1]drawbox=x=${frame.x}:y=${frame.y}:w=${bw}:h=${corner}:color=${accent}:t=fill[cut2]`,
        `[cut2]drawbox=x=${frame.x + frame.fgW - corner}:y=${frame.y + frame.fgH - bw}:w=${corner}:h=${bw}:color=${secondary}:t=fill[cut3]`,
        `[cut3]drawbox=x=${frame.x + frame.fgW - bw}:y=${frame.y + frame.fgH - corner}:w=${bw}:h=${corner}:color=${secondary}:t=fill[cut4]`
      );
      current = "cut4";
    }
    if (frame.accentBarEnabled) {
      const barX = frame.accentBarPosition === "bottom" ? frame.x : Math.max(20, frame.x - frame.accentBarWidth - 14);
      const barY = frame.accentBarPosition === "bottom" ? frame.y + frame.fgH + 18 : frame.y + 20;
      const barW = frame.accentBarPosition === "bottom" ? frame.fgW : frame.accentBarWidth;
      const barH = frame.accentBarPosition === "bottom" ? frame.accentBarWidth : Math.max(120, frame.fgH - 40);
      filters.push(`[${current}]drawbox=x=${barX}:y=${barY}:w=${barW}:h=${barH}:color=${drawColor(frame.accentColor)}@0.88:t=fill[barred]`);
      current = "barred";
    }
    if (frame.labelEnabled) {
      filters.push(`[${current}]drawtext=font='Arial':text='${escapeDrawtext(frame.label)}':fontcolor=${drawColor(frame.accentColor)}:fontsize=34:bordercolor=black@0.82:borderw=2:x=${frame.x}:y=${Math.max(88, frame.y - 56)}[labeled]`);
      current = "labeled";
    }
    if (frame.accentEnabled) {
      filters.push(`[${current}]drawbox=x=${frame.x}:y=${Math.max(80, frame.y - 28)}:w=${Math.round(frame.fgW * 0.58)}:h=${frame.accentWidth}:color=${drawColor(frame.accentColor)}@0.95:t=fill[accented]`);
      current = "accented";
    }
  } else if (useFrame) {
    filters.push(`[${bgIndex}:v][${current}]overlay=${FRAME.x}:${FRAME.y}:shortest=1[framedbase]`);
    filters.push(`[framedbase][${frameIndex}:v]overlay=0:0:shortest=1[framed]`);
    current = "framed";
  }

  if (useLowerThird) {
    filters.push(`[${current}][${lowerThirdIndex}:v]overlay=0:0:shortest=1[lowerthird]`);
    current = "lowerthird";
  }

  if (useWatermark) {
    const size = useFrame ? 118 : 126;
    const x = useFrame ? `${FRAME.x + FRAME.width - size - 34}` : "W-w-36";
    const y = useFrame ? `${FRAME.y + 34}` : "36";
    filters.push(`[${watermarkIndex}:v]scale=${size}:${size}:force_original_aspect_ratio=decrease,format=rgba,colorchannelmixer=aa=0.20[wm]`);
    filters.push(`[${current}][wm]overlay=${x}:${y}:shortest=1[vout]`);
    current = "vout";
  }

  if (current !== "vout") filters.push(`[${current}]null[vout]`);
  return filters.join(";");
}

async function renderLowerThirdOverlay({ job, text }) {
  const outputPath = path.join(config.generatedVideoDir, `${job.job_id}-lower-third.png`);
  await runRenderer([
    "lower-third",
    "--output", outputPath,
    "--quote", normalizeOverlayText(text),
    "--brand", config.videoEffects.lowerThirdBrand || "@clipperemsapro | Podcast Highlight"
  ]);
  return outputPath;
}

function runRenderer(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.clipper.pythonCommand, [rendererPath, ...args], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `branding renderer exited with ${code}`));
    });
  });
}

async function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { windowsHide: true });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg video effects gagal (${code}): ${stderr.slice(-1600)}`));
    });
  });
}

export async function applyVideoEffects({ job, video, output, options = {} }) {
  const selected = effectOptions(video, options);
  const premiumFrame = selected.frame && String(process.env.FRAME_STYLE || "auto").toLowerCase() !== "legacy";
  if (!hasAnyEffect(selected)) {
    return {
      output,
      effects: {
        applied: false,
        ...selected
      }
    };
  }

  const inputPath = output.finalAbsPath;
  if (!await fileIsReadable(inputPath)) {
    throw new Error(`Video efek gagal: file input tidak ditemukan: ${inputPath}`);
  }

  const useFrame = selected.frame;
  const contentType = video.content_type || output.contentType || output.content_type || job.theme || "";
  const frameConfig = premiumFrame ? premiumFrameConfig(contentType) : null;
  const useWatermark = selected.watermark && await fileIsReadable(config.videoEffects.watermarkAssetPath);
  const lowerThirdText = normalizeOverlayText(
    options.lowerThirdText
    || video.lower_third_text
    || output.frameQuoteText
    || output.thumbnailText
    || output.hook
    || output.caption
  );
  const useLowerThird = Boolean(useFrame && selected.lowerThird && lowerThirdText);
  if (selected.frame && !premiumFrame && !await fileIsReadable(config.videoEffects.frameAssetPath)) {
    throw new Error(`VIDEO_FRAME_ASSET tidak ditemukan: ${config.videoEffects.frameAssetPath}`);
  }
  if (selected.watermark && !useWatermark) {
    throw new Error(`VIDEO_WATERMARK_ASSET tidak ditemukan: ${config.videoEffects.watermarkAssetPath}`);
  }

  await fs.mkdir(config.generatedVideoDir, { recursive: true });
  const outputPath = path.join(config.generatedVideoDir, `${job.job_id}-branded.mp4`);
  const tempPath = path.join(config.generatedVideoDir, `${job.job_id}-branded.tmp.mp4`);
  await fs.rm(tempPath, { force: true }).catch(() => {});
  const hasAudio = await hasAudioStream(inputPath);

  const lowerThirdPath = useLowerThird
    ? await renderLowerThirdOverlay({ job, text: lowerThirdText })
    : "";

  const args = ["-y", "-fflags", "+genpts", "-i", inputPath];
  if (useFrame && !premiumFrame) {
    args.push("-f", "lavfi", "-i", "color=c=#070709:s=1080x1920:r=30");
    args.push("-loop", "1", "-i", config.videoEffects.frameAssetPath);
  }
  if (useLowerThird) {
    args.push("-loop", "1", "-i", lowerThirdPath);
  }
  if (useWatermark) {
    args.push("-loop", "1", "-i", config.videoEffects.watermarkAssetPath);
  }

  args.push(
    "-filter_complex",
    buildFilterGraph({
      useFrame,
      useFilter: selected.filter,
      useWatermark,
      useLowerThird,
      premiumFrame,
      contentType
    }),
    "-map",
    "[vout]",
    "-c:v",
    "libx264",
    "-preset",
    config.videoEffects.preset || "veryfast",
    "-crf",
    String(config.videoEffects.crf),
    "-pix_fmt",
    "yuv420p"
  );

  if (hasAudio) {
    args.push(
      "-map",
      "0:a:0",
      "-af",
      "aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS",
      "-c:a",
      "aac",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-b:a",
      "128k"
    );
  }

  args.push(
    "-avoid_negative_ts",
    "make_zero",
    "-movflags",
    "+faststart",
    "-shortest",
    tempPath
  );

  await runFfmpeg(args);
  await fs.rename(tempPath, outputPath);

  return {
    output: {
      ...output,
      originalFinalAbsPath: inputPath,
      finalAbsPath: outputPath
    },
    effects: {
      applied: true,
      frame: useFrame,
      filter: selected.filter,
      watermark: useWatermark,
      lowerThird: useLowerThird,
      lowerThirdText: useLowerThird ? lowerThirdText : "",
      frameStyle: premiumFrame ? String(process.env.FRAME_PRESET_DEFAULT || "premium_blur") : "legacy",
      frameColorMode: frameConfig?.colorMode || "",
      frameShapeMode: frameConfig?.shapeMode || "",
      frameAccentColor: frameConfig?.accentColor || "",
      frameSecondaryColor: frameConfig?.secondaryColor || "",
      frameUseFullBorder: frameConfig?.useFullBorder ?? null,
      frameUsePartialGlow: frameConfig?.usePartialGlow ?? null,
      frameAccentLabel: frameConfig?.label || "",
      frameAssetPath: useFrame && !premiumFrame ? ffmpegPathArg(config.videoEffects.frameAssetPath) : "",
      watermarkAssetPath: useWatermark ? ffmpegPathArg(config.videoEffects.watermarkAssetPath) : ""
    }
  };
}

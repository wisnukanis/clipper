import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";

const CANVAS_WIDTH = 1080;
const CANVAS_HEIGHT = 1920;
const CARD_WIDTH = 840;
const CARD_X = Math.round((CANVAS_WIDTH - CARD_WIDTH) / 2);
const CARD_PADDING_X = 54;
const MAX_TITLE_LINES = 3;
const MAX_TITLE_WORDS = 10;

export async function generateThumbnail({ job, videoPath, text }) {
  await fs.mkdir(config.thumbnailDir, { recursive: true });
  const filename = `${job.job_id}-thumbnail.jpg`;
  const outputPath = path.join(config.thumbnailDir, filename);

  const displayText = normalizeTitleText(text);
  const layout = buildTitleLayout(displayText);
  const fontOption = await resolveFontOption();
  const frameFilter = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920";
  const overlayFilter = [
    frameFilter,
    "eq=contrast=1.04:saturation=1.08",
    "drawbox=x=0:y=0:w=iw:h=ih:color=black@0.08:t=fill",
    `drawbox=x=${layout.shadowX}:y=${layout.shadowY}:w=${layout.shadowW}:h=${layout.cardH}:color=black@0.20:t=fill`,
    `drawbox=x=${layout.cyanX}:y=${layout.cyanY}:w=${CARD_WIDTH}:h=${layout.cardH}:color=0x24D7E5@0.90:t=fill`,
    `drawbox=x=${layout.pinkX}:y=${layout.pinkY}:w=${CARD_WIDTH}:h=${layout.cardH}:color=0xFF2D5B@0.90:t=fill`,
    `drawbox=x=${CARD_X}:y=${layout.cardY}:w=${CARD_WIDTH}:h=${layout.cardH}:color=white@0.76:t=fill`,
    `drawbox=x=${CARD_X + 22}:y=${layout.cardY + 20}:w=${CARD_WIDTH - 44}:h=8:color=0x24D7E5@0.90:t=fill`,
    `drawbox=x=${CARD_X + CARD_WIDTH - 230}:y=${layout.cardY + layout.cardH - 30}:w=190:h=8:color=0xFF2D5B@0.90:t=fill`,
    `drawbox=x=${CARD_X}:y=${layout.cardY}:w=${CARD_WIDTH}:h=${layout.cardH}:color=black@0.92:t=6`,
    `drawbox=x=${CARD_X + 20}:y=${layout.cardY + 20}:w=${CARD_WIDTH - 40}:h=${layout.cardH - 40}:color=white@0.26:t=2`,
    ...layout.lines.map((line, index) => (
      `drawtext=${fontOption}:text='${escapeDrawtext(line)}':fontcolor=0x111111:fontsize=${layout.fontSize}:x=(w-text_w)/2:y=${layout.lineYs[index]}`
    ))
  ].join(",");

  try {
    await runFfmpeg([
      "-y",
      "-ss",
      "00:00:01",
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-vf",
      overlayFilter,
      "-q:v",
      "2",
      outputPath
    ]);
  } catch {
    await runFfmpeg([
      "-y",
      "-ss",
      "00:00:01",
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-vf",
      frameFilter,
      "-q:v",
      "2",
      outputPath
    ]);
  }

  return { path: outputPath, filename, text: displayText };
}

function buildTitleLayout(value) {
  const title = String(value || "CERITA YANG JARANG DIBUKA")
    .replace(/\s+/g, " ")
    .trim();
  const textAreaW = CARD_WIDTH - (CARD_PADDING_X * 2);
  let fontSize = 58;
  let lines = [];

  while (fontSize >= 38) {
    const maxChars = Math.max(12, Math.floor(textAreaW / (fontSize * 0.55)));
    lines = wrapText(title, maxChars, MAX_TITLE_LINES);
    const textBlockH = estimateTextBlockHeight(lines.length, fontSize);
    const widthOk = lines.every((line) => estimateTextWidth(line, fontSize) <= textAreaW);
    if (widthOk && textBlockH <= 178) break;
    fontSize -= 2;
  }

  if (!lines.length) lines = ["CERITA YANG JARANG", "DIBUKA"];
  const textBlockH = estimateTextBlockHeight(lines.length, fontSize);
  const cardH = Math.max(198, Math.min(270, textBlockH + 74));
  const cardY = CANVAS_HEIGHT - 330 - cardH;
  const firstLineY = cardY + Math.round((cardH - textBlockH) / 2);

  return {
    lines,
    fontSize,
    cardH,
    cardY,
    shadowX: CARD_X - 34,
    shadowY: cardY + 26,
    shadowW: CARD_WIDTH + 54,
    cyanX: CARD_X - 18,
    cyanY: cardY - 16,
    pinkX: CARD_X + 18,
    pinkY: cardY + 20,
    lineYs: lines.map((_, index) => firstLineY + (index * (fontSize + 10)))
  };
}

function normalizeTitleText(value) {
  return String(value || "CERITA YANG JARANG DIBUKA")
    .replace(/[`"'*_#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .split(/\s+/)
    .slice(0, MAX_TITLE_WORDS)
    .join(" ") || "CERITA YANG JARANG DIBUKA";
}

function wrapText(value, maxChars, maxLines) {
  const words = String(value || "")
    .split(/\s+/)
    .flatMap((word) => splitLongWord(word, maxChars))
    .filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && next.length > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);

  if (lines.length <= maxLines) return lines;

  const kept = lines.slice(0, maxLines);
  const overflow = lines.slice(maxLines - 1).join(" ");
  kept[maxLines - 1] = truncateLine(overflow, maxChars);
  return kept;
}

function splitLongWord(word, maxChars) {
  if (word.length <= maxChars) return [word];
  const chunks = [];
  let remaining = word;
  while (remaining.length > maxChars) {
    chunks.push(remaining.slice(0, maxChars - 1));
    remaining = remaining.slice(maxChars - 1);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function truncateLine(value, maxChars) {
  const cleaned = String(value || "").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxChars - 3)).trim()}...`;
}

function estimateTextWidth(value, fontSize) {
  return String(value || "").length * fontSize * 0.55;
}

function estimateTextBlockHeight(lineCount, fontSize) {
  return (lineCount * fontSize) + (Math.max(0, lineCount - 1) * 10);
}

async function resolveFontOption() {
  const candidates = [
    process.env.THUMBNAIL_FONT_FILE,
    "C:\\Windows\\Fonts\\arialbd.ttf",
    "C:\\Windows\\Fonts\\segoeuib.ttf",
    "/usr/share/fonts/truetype/msttcorefonts/Arial_Bold.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
  ].filter(Boolean);

  for (const fontPath of candidates) {
    try {
      await fs.access(fontPath);
      return `fontfile='${escapeFontPath(fontPath)}'`;
    } catch {
      // Try the next installed bold sans font.
    }
  }

  return "font='Arial'";
}

function escapeFontPath(value) {
  return path.resolve(value)
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `ffmpeg exited with ${code}`));
    });
  });
}

function escapeDrawtext(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/,/g, "\\,")
    .replace(/%/g, "\\%");
}

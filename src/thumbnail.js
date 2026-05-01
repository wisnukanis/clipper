import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";

export async function generateThumbnail({ job, videoPath, text }) {
  await fs.mkdir(config.thumbnailDir, { recursive: true });
  const filename = `${job.job_id}-thumbnail.jpg`;
  const outputPath = path.join(config.thumbnailDir, filename);

  const frameFilter = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920";
  const overlayFilter = [
    frameFilter,
    "drawbox=x=0:y=h-430:w=w:h=310:color=black@0.62:t=fill",
    `drawtext=text='${escapeDrawtext(text)}':fontcolor=white:fontsize=76:line_spacing=12:x=(w-text_w)/2:y=h-345`
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

  return { path: outputPath, filename, text };
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
    .replace(/%/g, "\\%");
}

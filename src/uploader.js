import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "basic-ftp";
import {
  config,
  publicMetadataUrl,
  publicThumbnailUrl,
  publicVideoUrl,
  shouldUploadToFtp
} from "./config.js";

function requireFtpConfig() {
  const missing = [];
  if (!config.ftp.host) missing.push("FTP_HOST");
  if (!config.ftp.user) missing.push("FTP_USER");
  if (!config.ftp.password) missing.push("FTP_PASSWORD");
  if (!config.ftp.remoteDir) missing.push("FTP_REMOTE_DIR");
  if (missing.length) throw new Error(`FTP config belum lengkap: ${missing.join(", ")}`);
}

export async function withFtpClient(callback, options = {}) {
  requireFtpConfig();
  const client = new Client(options.timeoutMs || config.ftp.timeoutMs);
  try {
    await client.access({
      host: config.ftp.host,
      port: config.ftp.port,
      user: config.ftp.user,
      password: config.ftp.password,
      secure: false
    });
    return await callback(client);
  } finally {
    client.close();
  }
}

export async function uploadJobFiles({ job, videoPath, thumbnailPath, metadataPath }) {
  const videoName = `${job.job_id}.mp4`;
  const thumbnailName = `${job.job_id}-thumbnail.jpg`;
  const metadataName = `${job.job_id}.json`;

  if (!shouldUploadToFtp()) {
    return {
      videoUrl: "",
      thumbnailUrl: "",
      metadataUrl: "",
      videoName,
      thumbnailName,
      metadataName
    };
  }

  await withFtpClient(async (client) => {
    await client.ensureDir(path.posix.join(config.ftp.remoteDir, "videos"));
    await client.uploadFrom(videoPath, videoName);

    await client.ensureDir(path.posix.join(config.ftp.remoteDir, "thumbnails"));
    await client.uploadFrom(thumbnailPath, thumbnailName);

    await client.ensureDir(path.posix.join(config.ftp.remoteDir, "metadata"));
    await client.uploadFrom(metadataPath, metadataName);
  }, { timeoutMs: config.ftp.timeoutMs });

  return {
    videoUrl: publicVideoUrl(videoName),
    thumbnailUrl: publicThumbnailUrl(thumbnailName),
    metadataUrl: publicMetadataUrl(metadataName),
    videoName,
    thumbnailName,
    metadataName
  };
}

export async function uploadHistoryFile(historyFile) {
  if (!shouldUploadToFtp()) return "";
  await withFtpClient(async (client) => {
    await client.ensureDir(path.posix.join(config.ftp.remoteDir, "history"));
    await client.uploadFrom(historyFile, path.basename(historyFile));
  }, { timeoutMs: config.ftp.stateTimeoutMs });
  return `${config.publicBaseUrl}/history/${encodeURIComponent(path.basename(historyFile))}`;
}

export async function validatePublicUrl(url) {
  if (!url) return false;
  try {
    let response = await fetch(url, { method: "HEAD" });
    if (response.ok) return true;
    response = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-1000" }
    });
    return response.ok || response.status === 206;
  } catch {
    return false;
  }
}

export async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

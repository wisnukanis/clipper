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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableFtpError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || error || "");
  const text = `${code} ${message}`;
  if (/\b(530|550|553)\b/.test(text)) return false;
  return /timeout|timed out|closed|socket|econn|etimedout|econnreset|econnrefused|epipe|no control connection|421|425|426|450|451/i.test(text);
}

function retryDelayMs(attempt) {
  return Math.min(30000, 1500 * attempt);
}

async function localFileSize(filePath) {
  const stat = await fs.stat(filePath);
  return stat.size;
}

async function remoteSize(client, remoteName) {
  try {
    return await client.size(remoteName);
  } catch {
    return -1;
  }
}

async function remoteFileMatches(fullRemotePath, expectedSize) {
  try {
    return await withFtpClient(async (client) => {
      return await remoteSize(client, fullRemotePath) === expectedSize;
    }, { timeoutMs: config.ftp.stateTimeoutMs, retries: 1 });
  } catch {
    return false;
  }
}

async function uploadFromVerified(client, localPath, remoteName, remoteDir) {
  const expectedSize = await localFileSize(localPath);
  const fullRemotePath = path.posix.join(remoteDir, remoteName);

  if (await remoteSize(client, remoteName) === expectedSize) {
    console.log(`FTP skip, remote sudah lengkap: ${fullRemotePath}`);
    return;
  }

  try {
    await client.uploadFrom(localPath, remoteName);
  } catch (error) {
    if (isRetriableFtpError(error) && await remoteFileMatches(fullRemotePath, expectedSize)) {
      console.warn(`FTP upload timeout, tapi file remote lengkap. Lanjut: ${fullRemotePath}`);
      return;
    }
    throw error;
  }
}

export async function withFtpClient(callback, options = {}) {
  requireFtpConfig();
  const maxAttempts = Math.max(1, Number(options.retries || config.ftp.retries || 3));
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const client = new Client(options.timeoutMs || config.ftp.timeoutMs);
    try {
      await client.access({
        host: config.ftp.host,
        port: config.ftp.port,
        user: config.ftp.user,
        password: config.ftp.password,
        secure: false
      });
      return await callback(client, attempt);
    } catch (error) {
      lastError = error;
      const canRetry = attempt < maxAttempts && isRetriableFtpError(error);
      if (!canRetry) throw error;
      console.warn(`FTP gagal attempt ${attempt}/${maxAttempts}, reconnect lalu retry: ${error.message || error}`);
      await sleep(retryDelayMs(attempt));
    } finally {
      client.close();
    }
  }

  throw lastError;
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
    const videosDir = path.posix.join(config.ftp.remoteDir, "videos");
    const thumbnailsDir = path.posix.join(config.ftp.remoteDir, "thumbnails");
    const metadataDir = path.posix.join(config.ftp.remoteDir, "metadata");

    await client.ensureDir(videosDir);
    await uploadFromVerified(client, videoPath, videoName, videosDir);

    await client.ensureDir(thumbnailsDir);
    await uploadFromVerified(client, thumbnailPath, thumbnailName, thumbnailsDir);

    await client.ensureDir(metadataDir);
    await uploadFromVerified(client, metadataPath, metadataName, metadataDir);
  }, { timeoutMs: config.ftp.uploadTimeoutMs, retries: config.ftp.retries });

  return {
    videoUrl: publicVideoUrl(videoName),
    thumbnailUrl: publicThumbnailUrl(thumbnailName),
    metadataUrl: publicMetadataUrl(metadataName),
    videoName,
    thumbnailName,
    metadataName
  };
}

export async function uploadVideoFile({ videoPath, videoName }) {
  if (!shouldUploadToFtp()) return "";

  await withFtpClient(async (client) => {
    const videosDir = path.posix.join(config.ftp.remoteDir, "videos");
    await client.ensureDir(videosDir);
    await uploadFromVerified(client, videoPath, videoName, videosDir);
  }, { timeoutMs: config.ftp.uploadTimeoutMs, retries: config.ftp.retries });

  return publicVideoUrl(videoName);
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

  for (let attempt = 1; attempt <= config.ftp.publicUrlRetries; attempt += 1) {
    try {
      const cacheBustUrl = `${url}${url.includes("?") ? "&" : "?"}v=${Date.now()}`;
      let response = await fetch(cacheBustUrl, { method: "HEAD", cache: "no-store" });
      if (response.ok) return true;
      response = await fetch(cacheBustUrl, {
        method: "GET",
        cache: "no-store",
        headers: { Range: "bytes=0-1000" }
      });
      if (response.ok || response.status === 206) return true;
    } catch {
      // Public hosting can lag a few seconds after FTP upload.
    }
    if (attempt < config.ftp.publicUrlRetries) await sleep(config.ftp.publicUrlRetryDelayMs);
  }

  return false;
}

export async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

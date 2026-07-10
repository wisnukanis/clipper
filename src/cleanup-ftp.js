import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config, shouldUploadToRemote } from "./config.js";
import { withRemoteClient } from "./uploader.js";

const DEFAULT_RETENTION_DAYS = 1;
const DEFAULT_SUBDIRS = ["videos", "thumbnails", "metadata", "history"];

function parseArgs(argv) {
  const args = { dryRun: false, deleteAll: false, days: null, subdirs: null, match: null };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--dry-run") args.dryRun = true;
    else if (token === "--all" || token === "--delete-all") args.deleteAll = true;
    else if (token === "--days") args.days = argv[++i];
    else if (token.startsWith("--days=")) args.days = token.slice("--days=".length);
    else if (token === "--subdirs") args.subdirs = argv[++i];
    else if (token.startsWith("--subdirs=")) args.subdirs = token.slice("--subdirs=".length);
    else if (token === "--match") args.match = argv[++i];
    else if (token.startsWith("--match=")) args.match = token.slice("--match=".length);
  }
  return args;
}

function resolveRetentionDays(arg) {
  const candidate = arg ?? cleanupEnv("DAYS") ?? DEFAULT_RETENTION_DAYS;
  const num = Number(candidate);
  if (!Number.isFinite(num) || num < 0) return DEFAULT_RETENTION_DAYS;
  return Math.floor(num);
}

function resolveSubdirs(arg) {
  const raw = arg ?? cleanupEnv("SUBDIRS") ?? "";
  const list = String(raw).split(",").map((part) => part.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_SUBDIRS;
}

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

function resolveMatch(arg) {
  return String(arg ?? cleanupEnv("MATCH") ?? "").trim();
}

function cleanupEnv(suffix) {
  const prefix = config.ftp.envPrefix || "FTP";
  return process.env[`${prefix}_CLEANUP_${suffix}`] ?? process.env[`FTP_CLEANUP_${suffix}`];
}

function isConnectionError(error) {
  const text = String(error?.code || "") + " " + String(error?.message || error || "");
  return /timeout|timed out|etimedout|econnreset|econnrefused|socket|connection|closed/i.test(text);
}

function matchesCleanupFilter(name, match) {
  if (!match) return true;
  const patterns = match.split(",").map((item) => item.trim()).filter(Boolean);
  if (!patterns.length) return true;
  return patterns.some((pattern) => {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`, "i").test(name) || name.includes(pattern);
  });
}

function filenameFromUrl(value) {
  if (!value) return "";
  try {
    return decodeURIComponent(new URL(value).pathname.split("/").pop() || "");
  } catch {
    return "";
  }
}

function pendingJobId(item = {}) {
  if (item.job_id) return String(item.job_id);
  const filename = path.basename(String(item.video_path || "").replace(/\\/g, "/"));
  return filename.replace(/-with-thumb-intro(?=\.mp4$)/i, "").replace(/\.mp4$/i, "");
}

function activePendingItem(item = {}) {
  if (String(item.status || "pending").toLowerCase() !== "pending") return false;
  const maxAgeDays = Math.max(1, Number(process.env.PENDING_UPLOAD_MAX_AGE_DAYS || 7) || 7);
  const createdAt = Date.parse(item.created_at || item.updated_at || "");
  return !Number.isFinite(createdAt) || Date.now() - createdAt <= maxAgeDays * 86400000;
}

export function protectedPendingNames(items = []) {
  const protectedByFolder = {
    videos: new Set(),
    thumbnails: new Set(),
    metadata: new Set()
  };

  for (const item of items.filter(activePendingItem)) {
    const jobId = pendingJobId(item);
    const videoName = filenameFromUrl(item.video_url || item.public_video_url) || (jobId ? `${jobId}.mp4` : "");
    const thumbnailName = filenameFromUrl(item.thumbnail_url || item.public_thumbnail_url)
      || (jobId ? `${jobId}-thumbnail.jpg` : "");
    const metadataName = filenameFromUrl(item.metadata_url || item.public_metadata_url)
      || (jobId ? `${jobId}.json` : "");
    if (videoName) protectedByFolder.videos.add(videoName);
    if (thumbnailName) protectedByFolder.thumbnails.add(thumbnailName);
    if (metadataName) protectedByFolder.metadata.add(metadataName);
  }
  return protectedByFolder;
}

async function loadRemotePendingUploads(client) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clipper-cleanup-"));
  const target = path.join(tempDir, "pending_uploads.json");
  try {
    await client.cd("/");
    await client.cd(path.posix.join(config.ftp.remoteDir, "state"));
    await client.downloadTo(target, "pending_uploads.json");
    const parsed = JSON.parse(await fs.readFile(target, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    const message = String(error?.message || error || "");
    if (/no such|not found|does not exist|\b550\b|code 2\b/i.test(message)) {
      console.warn(`Pending upload state belum ada; cleanup lanjut tanpa protection: ${message}`);
      return [];
    }
    throw new Error(`Cleanup dibatalkan karena pending upload state tidak dapat dibaca: ${message}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function cleanupSubdir(client, dir, { cutoffMs, dryRun, deleteAll, match, protectedNames = new Set() }) {
  let stats = { scanned: 0, deleted: 0, freedBytes: 0, skipped: 0, errors: 0 };

  try {
    await client.cd("/");
    await client.cd(dir);
  } catch (err) {
    console.log(`Skip ${dir}: ${err.message}`);
    return stats;
  }

  let items;
  try {
    items = await client.list();
  } catch (err) {
    console.log(`List gagal di ${dir}: ${err.message}`);
    stats.errors += 1;
    return stats;
  }

  for (const item of items) {
    if (!item.isFile) continue;
    stats.scanned += 1;

    if (!matchesCleanupFilter(item.name, match)) {
      stats.skipped += 1;
      continue;
    }

    if (!deleteAll && protectedNames.has(item.name)) {
      console.log(`= ${dir}/${item.name}: dilindungi karena masih ada di pending upload queue`);
      stats.skipped += 1;
      continue;
    }

    const mtime = item.modifiedAt ? item.modifiedAt.getTime() : null;
    if (!deleteAll && !mtime) {
      console.log(`? ${dir}/${item.name}: tidak ada mtime; skip`);
      stats.skipped += 1;
      continue;
    }
    if (!deleteAll && mtime >= cutoffMs) continue;

    const ageDays = mtime ? ((Date.now() - mtime) / 86400000).toFixed(1) : "?";
    const sizeKb = item.size ? (item.size / 1024).toFixed(0) : "?";
    const tag = dryRun ? " [dry-run]" : "";
    console.log(`x ${dir}/${item.name}  age=${ageDays}d  size=${sizeKb}KB${tag}`);

    if (dryRun) {
      stats.deleted += 1;
      stats.freedBytes += item.size || 0;
      continue;
    }

    try {
      await client.remove(item.name);
      stats.deleted += 1;
      stats.freedBytes += item.size || 0;
    } catch (err) {
      console.log(`  failed: ${err.message}`);
      stats.errors += 1;
    }
  }

  return stats;
}

function mergeStats(target, addition) {
  target.scanned += addition.scanned;
  target.deleted += addition.deleted;
  target.freedBytes += addition.freedBytes;
  target.skipped += addition.skipped;
  target.errors += addition.errors;
}

async function main() {
  const label = config.ftp.label || "Remote";

  if (!shouldUploadToRemote()) {
    console.log("UPLOAD_DRIVER bukan ftp/sftp; cleanup dilewati.");
    return;
  }

  if (!config.ftp.host || !config.ftp.user || (!config.ftp.password && !config.ftp.privateKey) || !config.ftp.remoteDir) {
    console.error(`${label} credentials/remoteDir belum lengkap di env.`);
    process.exit(1);
  }

  const args = parseArgs(process.argv);
  const deleteAll = args.deleteAll || boolEnv(`${config.ftp.envPrefix || "FTP"}_CLEANUP_DELETE_ALL`, boolEnv("FTP_CLEANUP_DELETE_ALL", false));
  const retentionDays = deleteAll ? 0 : resolveRetentionDays(args.days);
  const subdirs = resolveSubdirs(args.subdirs);
  const match = resolveMatch(args.match);
  const dryRun = args.dryRun;
  const cutoffMs = Date.now() - retentionDays * 86400000;
  const cleanupRetries = numberEnv(
    `${config.ftp.envPrefix || "FTP"}_CLEANUP_RETRIES`,
    numberEnv("FTP_CLEANUP_RETRIES", 3, 1, 10),
    1,
    10
  );

  console.log(`${label} cleanup target: ${config.ftp.remoteDir}`);
  console.log(deleteAll
    ? "Retention: delete_all aktif (semua file yang match akan dihapus)"
    : `Retention: ${retentionDays} hari (cutoff ${new Date(cutoffMs).toISOString()})`);
  console.log(`Subdirs: ${subdirs.join(", ")}`);
  if (match) console.log(`Match: ${match}`);
  if (dryRun) console.log("Mode: DRY RUN - tidak ada file yang akan dihapus.");

  const totals = { scanned: 0, deleted: 0, freedBytes: 0, skipped: 0, errors: 0 };

  await withRemoteClient(async (client) => {
    const pendingItems = await loadRemotePendingUploads(client);
    const protectedByFolder = protectedPendingNames(pendingItems);
    if (pendingItems.length) {
      console.log(`Pending protection aktif untuk ${pendingItems.length} item queue.`);
    }
    for (const sub of subdirs) {
      const dir = path.posix.join(config.ftp.remoteDir, sub);
      const stats = await cleanupSubdir(client, dir, {
        cutoffMs,
        dryRun,
        deleteAll,
        match,
        protectedNames: protectedByFolder[sub] || new Set()
      });
      mergeStats(totals, stats);
    }
  }, { timeoutMs: config.ftp.cleanupTimeoutMs, retries: cleanupRetries });

  const freedMb = (totals.freedBytes / 1048576).toFixed(1);
  console.log("---");
  console.log(`Selesai. Scanned=${totals.scanned}, deleted=${totals.deleted}, skipped=${totals.skipped}, errors=${totals.errors}, freed=${freedMb} MB.`);

  if (totals.errors > 0) process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    const softFail = boolEnv(`${config.ftp.envPrefix || "FTP"}_CLEANUP_SOFT_FAIL`, boolEnv("FTP_CLEANUP_SOFT_FAIL", true));
    if (softFail && isConnectionError(err)) {
      console.warn(`Cleanup dilewati karena koneksi remote timeout/tidak stabil: ${err.message || err}`);
      console.warn("Set SFTP_CLEANUP_SOFT_FAIL=false jika ingin timeout cleanup menggagalkan workflow.");
      process.exit(0);
    }
    console.error("Cleanup gagal:", err.stack || err.message);
    process.exit(1);
  });
}

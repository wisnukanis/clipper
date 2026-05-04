import path from "node:path";
import { config, shouldUploadToFtp } from "./config.js";
import { withFtpClient } from "./uploader.js";

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
  const candidate = arg ?? process.env.FTP_CLEANUP_DAYS ?? DEFAULT_RETENTION_DAYS;
  const num = Number(candidate);
  if (!Number.isFinite(num) || num < 0) return DEFAULT_RETENTION_DAYS;
  return Math.floor(num);
}

function resolveSubdirs(arg) {
  const raw = arg ?? process.env.FTP_CLEANUP_SUBDIRS ?? "";
  const list = String(raw).split(",").map((part) => part.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_SUBDIRS;
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function resolveMatch(arg) {
  return String(arg ?? process.env.FTP_CLEANUP_MATCH ?? "").trim();
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

async function cleanupSubdir(client, dir, { cutoffMs, dryRun, deleteAll, match }) {
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
  if (!shouldUploadToFtp()) {
    console.log("UPLOAD_DRIVER bukan ftp; cleanup dilewati.");
    return;
  }

  if (!config.ftp.host || !config.ftp.user || !config.ftp.password || !config.ftp.remoteDir) {
    console.error("FTP credentials/remoteDir belum lengkap di env.");
    process.exit(1);
  }

  const args = parseArgs(process.argv);
  const deleteAll = args.deleteAll || boolEnv("FTP_CLEANUP_DELETE_ALL", false);
  const retentionDays = deleteAll ? 0 : resolveRetentionDays(args.days);
  const subdirs = resolveSubdirs(args.subdirs);
  const match = resolveMatch(args.match);
  const dryRun = args.dryRun;
  const cutoffMs = Date.now() - retentionDays * 86400000;

  console.log(`FTP cleanup target: ${config.ftp.remoteDir}`);
  console.log(deleteAll
    ? "Retention: delete_all aktif (semua file yang match akan dihapus)"
    : `Retention: ${retentionDays} hari (cutoff ${new Date(cutoffMs).toISOString()})`);
  console.log(`Subdirs: ${subdirs.join(", ")}`);
  if (match) console.log(`Match: ${match}`);
  if (dryRun) console.log("Mode: DRY RUN - tidak ada file yang akan dihapus.");

  const totals = { scanned: 0, deleted: 0, freedBytes: 0, skipped: 0, errors: 0 };

  await withFtpClient(async (client) => {
    for (const sub of subdirs) {
      const dir = path.posix.join(config.ftp.remoteDir, sub);
      const stats = await cleanupSubdir(client, dir, { cutoffMs, dryRun, deleteAll, match });
      mergeStats(totals, stats);
    }
  }, { timeoutMs: config.ftp.cleanupTimeoutMs, retries: 2 });

  const freedMb = (totals.freedBytes / 1048576).toFixed(1);
  console.log("---");
  console.log(`Selesai. Scanned=${totals.scanned}, deleted=${totals.deleted}, skipped=${totals.skipped}, errors=${totals.errors}, freed=${freedMb} MB.`);

  if (totals.errors > 0) process.exit(2);
}

main().catch((err) => {
  console.error("Cleanup gagal:", err.stack || err.message);
  process.exit(1);
});

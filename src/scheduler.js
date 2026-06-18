import { spawn } from "node:child_process";
import cron from "node-cron";
import { config } from "./config.js";
import { runWorkflow } from "./workflow.js";

console.log(`Scheduler active. Cron: ${config.postCron}`);
console.log(`Timezone: ${config.timezone}`);
console.log(`Auto publish: ${config.autoPublish && !config.dryRun ? "ON" : "OFF / dry-run"}`);

const task = cron.schedule(config.postCron, async () => {
  console.log(`[${new Date().toISOString()}] Scheduled workflow started`);
  try {
    await runWorkflow({
      theme: config.defaultTheme,
      publish: true,
      scheduled: true
    });
    console.log(`[${new Date().toISOString()}] Scheduled workflow finished`);
  } catch (error) {
    console.error("Scheduled workflow failed:", error);
  }
}, {
  timezone: config.timezone
});

// Run SFTP cleanup daily at 23:30 WIB (Asia/Jakarta)
const cleanupTask = cron.schedule("30 23 * * *", () => {
  console.log(`[${new Date().toISOString()}] Scheduled SFTP cleanup started`);
  const child = spawn("node", ["src/cleanup-ftp.js"], {
    cwd: config.rootDir,
    stdio: "inherit",
    shell: true
  });
  child.on("close", (code) => {
    console.log(`[${new Date().toISOString()}] Scheduled SFTP cleanup finished with code ${code}`);
  });
}, {
  timezone: config.timezone
});

console.log(`Next workflow run: ${task.getNextRun()?.toString() || "unknown"}`);
console.log(`Next cleanup run: ${cleanupTask.getNextRun()?.toString() || "unknown"}`);


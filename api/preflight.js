import {
  check,
  clean,
  configSummary,
  getRecentRuns,
  methodAllowed,
  readState,
  remoteConfig,
  remoteMissingEnv,
  requireAuth,
  sendJson
} from "./_utils.js";

export default async function handler(req, res) {
  if (!methodAllowed(req, res, ["POST", "GET"])) return;
  if (!requireAuth(req, res)) return;

  try {
    const state = await readState();
    const runs = await getRecentRuns(1);
    const remote = remoteConfig();
    const missingRemote = remoteMissingEnv(remote);
    const checks = [
      check("Dashboard PIN", Boolean(clean(process.env.AUTO_DASHBOARD_PIN)), "PIN aktif"),
      check("PUBLIC_BASE_URL", Boolean(clean(process.env.PUBLIC_BASE_URL)), clean(process.env.PUBLIC_BASE_URL)),
      check(`${remote.label} credential`, missingRemote.length === 0, missingRemote.length ? `missing env: ${missingRemote.join(", ")}` : "dibutuhkan untuk update queue"),
      check("Workflow token", Boolean(clean(process.env.GH_REPO_SECRET_TOKEN || process.env.GITHUB_TOKEN)), "dibutuhkan untuk tombol run"),
      check("data/videos.json", Array.isArray(state.videos), `${(state.videos || []).length} item`),
      check("data/jobs.json", Array.isArray(state.jobs), `${(state.jobs || []).length} item`),
      check("Workflow API", runs.length > 0, runs[0]?.html_url || "belum ada run terbaca", false),
      check("Config", true, JSON.stringify(configSummary()))
    ];

    sendJson(res, 200, { checks });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

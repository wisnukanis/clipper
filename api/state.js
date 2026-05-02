import {
  configSummary,
  getRecentRuns,
  methodAllowed,
  readState,
  requireAuth,
  sendJson
} from "./_utils.js";

export default async function handler(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  if (!requireAuth(req, res)) return;

  try {
    const state = await readState();
    const recentRuns = await getRecentRuns();
    const latestRun = recentRuns[0] || null;
    const activeRun = latestRun ? {
      id: String(latestRun.id),
      status: latestRun.status === "in_progress" || latestRun.status === "queued"
        ? "running"
        : latestRun.conclusion || latestRun.status,
      startedAt: latestRun.created_at,
      finishedAt: latestRun.status === "completed" ? latestRun.updated_at : "",
      error: latestRun.conclusion === "failure" ? "GitHub Actions gagal. Buka link run untuk detail." : "",
      result: {
        status: latestRun.conclusion || latestRun.status,
        url: latestRun.html_url
      },
      logs: [
        {
          at: latestRun.updated_at || latestRun.created_at,
          level: latestRun.conclusion === "failure" ? "error" : "system",
          text: `${latestRun.name} ${latestRun.status}${latestRun.conclusion ? `/${latestRun.conclusion}` : ""}: ${latestRun.html_url}`
        }
      ]
    } : null;

    sendJson(res, 200, {
      config: configSummary(),
      activeRun,
      recentRuns,
      themes: state.themes || [],
      videos: state.videos || [],
      prompts: state.prompts || [],
      jobs: state.jobs || [],
      history: state.history || []
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

import {
  clean,
  dispatchWorkflow,
  makeId,
  methodAllowed,
  readBody,
  requireAuth,
  sendJson
} from "./_utils.js";

export default async function handler(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  if (!requireAuth(req, res)) return;

  try {
    const body = await readBody(req);
    const inputs = {
      theme: clean(body.theme || "auto"),
      url: clean(body.url || ""),
      range: clean(body.range || ""),
      force_reprocess: body.force_reprocess === true || body.force_reprocess === "true" ? "true" : "false",
      quality_profile: clean(body.quality_profile || "standard"),
      deepgram_enabled: "1",
      subtitle_font: clean(body.subtitle_font || process.env.SUBTITLE_FONT_FAMILY || "Segoe UI"),
      subtitle_font_size: clean(body.subtitle_font_size || process.env.SUBTITLE_FONT_SIZE || "46"),
      subtitle_margin_v: clean(body.subtitle_margin_v || process.env.SUBTITLE_MARGIN_V || "400")
    };

    const dispatch = await dispatchWorkflow(inputs);
    const run = {
      id: makeId("run"),
      status: "queued",
      startedAt: new Date().toISOString(),
      finishedAt: "",
      error: "",
      result: {
        status: "workflow_dispatch_queued",
        repo: dispatch.repo,
        workflow: dispatch.workflow,
        ref: dispatch.ref
      },
      logs: [
        {
          at: new Date().toISOString(),
          level: "system",
          text: "GitHub Actions workflow berhasil dipicu. Refresh beberapa detik lagi untuk melihat status run."
        }
      ]
    };

    sendJson(res, 200, run);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

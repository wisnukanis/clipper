import {
  buildVideo,
  dispatchWorkflow,
  methodAllowed,
  readBody,
  readStateFile,
  requireAuth,
  sendJson,
  uploadStateFile,
  upsertById
} from "./_utils.js";

export default async function handler(req, res) {
  if (!methodAllowed(req, res, ["GET", "POST"])) return;
  if (!requireAuth(req, res)) return;

  try {
    if (req.method === "GET") {
      sendJson(res, 200, await readStateFile("videos.json"));
      return;
    }

    const body = await readBody(req);
    const video = buildVideo(body);
    const videos = upsertById(await readStateFile("videos.json"), video);
    await uploadStateFile("videos.json", videos);

    if (body.run_now === true || body.run_now === "true") {
      await dispatchWorkflow({
        theme: video.theme || "auto",
        url: video.url,
        range: video.manual_range || "",
        force_reprocess: video.force_reprocess ? "true" : "false",
        quality_profile: video.quality_profile || "standard",
        deepgram_enabled: "1",
        subtitle_font: video.subtitle_font || "Segoe UI",
        subtitle_font_size: String(video.subtitle_font_size || 46),
        subtitle_margin_v: String(video.subtitle_margin_v || 400)
      });
    }

    sendJson(res, 200, video);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

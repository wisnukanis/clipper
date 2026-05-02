import {
  methodAllowed,
  requireAuth,
  sendJson,
  settingsPayload
} from "./_utils.js";

export default async function handler(req, res) {
  if (!methodAllowed(req, res, ["GET", "POST"])) return;
  if (!requireAuth(req, res)) return;

  if (req.method === "GET") {
    sendJson(res, 200, settingsPayload());
    return;
  }

  sendJson(res, 400, {
    error: "Dashboard Vercel tidak bisa menulis .env langsung. Update nilai ini di Vercel Environment dan GitHub Secrets.",
    updated: [],
    settings: settingsPayload()
  });
}

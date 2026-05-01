import axios from "axios";
import { config } from "./config.js";

function apiUrl(apiPath) {
  return `https://graph.facebook.com/${config.graphApiVersion}/${apiPath}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertInstagramConfig() {
  const missing = [];
  if (!config.instagram.igUserId) missing.push("INSTAGRAM_IG_USER_ID");
  if (!config.instagram.accessToken) missing.push("INSTAGRAM_ACCESS_TOKEN");
  if (missing.length) throw new Error(`Missing Instagram config: ${missing.join(", ")}`);
}

async function postForm(apiPath, fields) {
  const body = new URLSearchParams({
    ...fields,
    access_token: config.instagram.accessToken
  });
  try {
    const response = await axios.post(apiUrl(apiPath), body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 60000
    });
    return response.data;
  } catch (error) {
    const apiError = error.response?.data?.error;
    if (apiError) {
      const wrapped = new Error(`Instagram API error (${error.response.status}): ${apiError.message} [code ${apiError.code}${apiError.error_subcode ? `, subcode ${apiError.error_subcode}` : ""}]`);
      wrapped.apiCode = apiError.code;
      wrapped.apiSubcode = apiError.error_subcode;
      throw wrapped;
    }
    throw error;
  }
}

async function getContainerStatus(containerId) {
  const response = await axios.get(apiUrl(containerId), {
    params: {
      fields: "id,status_code,status",
      access_token: config.instagram.accessToken
    },
    timeout: 30000
  });
  return response.data || {};
}

async function waitForContainerReady(containerId, label = "reel") {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const status = await getContainerStatus(containerId);
    const code = status.status_code || "";
    if (code === "FINISHED") return status;
    if (code === "ERROR" || code === "EXPIRED") {
      throw new Error(`Instagram ${label} gagal diproses: ${status.status || code}`);
    }
    await sleep(10000);
  }
  throw new Error(`Instagram ${label} belum siap setelah 10 menit: ${containerId}`);
}

export async function publishReel({ videoUrl, caption }) {
  assertInstagramConfig();
  const created = await postForm(`${config.instagram.igUserId}/media`, {
    media_type: "REELS",
    video_url: videoUrl,
    caption,
    share_to_feed: "true"
  });
  await waitForContainerReady(created.id, "reel video");
  const published = await postForm(`${config.instagram.igUserId}/media_publish`, {
    creation_id: created.id
  });
  return {
    mediaId: published.id,
    containerId: created.id,
    type: "reel_video",
    videoUrl
  };
}

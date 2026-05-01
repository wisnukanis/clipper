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

  if (missing.length) {
    throw new Error(`Missing Instagram config: ${missing.join(", ")}`);
  }
}

function isMetaMediaUploadFailed2207076(error) {
  const message = String(error?.message || "");
  const apiSubcode = error?.apiSubcode;
  const apiError = error?.apiError || {};

  return (
    message.includes("2207076") ||
    apiSubcode === 2207076 ||
    apiError.error_subcode === 2207076 ||
    message.toLowerCase().includes("media upload has failed")
  );
}

function getReelUploadMethod() {
  return String(process.env.INSTAGRAM_REEL_UPLOAD_METHOD || "auto")
    .trim()
    .toLowerCase();
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
      const wrapped = new Error(
        `Instagram API error (${error.response.status}): ${apiError.message} ` +
          `[code ${apiError.code}${apiError.error_subcode ? `, subcode ${apiError.error_subcode}` : ""}]`
      );

      wrapped.apiCode = apiError.code;
      wrapped.apiSubcode = apiError.error_subcode;
      wrapped.apiError = apiError;
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
  for (let attempt = 1; attempt <= 90; attempt += 1) {
    const status = await getContainerStatus(containerId);
    const code = status.status_code || "";

    console.log("IG CONTAINER STATUS:", {
      attempt,
      containerId,
      status_code: status.status_code,
      status: status.status
    });

    if (code === "FINISHED") return status;

    if (code === "ERROR" || code === "EXPIRED") {
      throw new Error(
        `Instagram ${label} gagal diproses. ` +
          `container=${containerId}, status_code=${code}, status=${status.status || ""}`
      );
    }

    await sleep(10000);
  }

  throw new Error(`Instagram ${label} belum siap setelah 15 menit: ${containerId}`);
}

async function assertPublicVideoUrl(videoUrl) {
  if (!videoUrl) {
    throw new Error("videoUrl kosong, tidak bisa publish Reels.");
  }

  console.log("IG REEL VIDEO URL:", videoUrl);

  try {
    const response = await axios.head(videoUrl, {
      headers: { "User-Agent": "facebookexternalhit/1.1" },
      timeout: 30000,
      maxRedirects: 5,
      validateStatus: () => true
    });

    const contentType = response.headers?.["content-type"] || "";
    const contentLength = response.headers?.["content-length"] || "";

    console.log("IG VIDEO URL HEAD:", {
      status: response.status,
      contentType,
      contentLength
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Video URL tidak bisa diakses publik. status=${response.status}, url=${videoUrl}`);
    }

    if (!contentType.toLowerCase().includes("video/mp4")) {
      throw new Error(`Content-Type video salah: ${contentType || "kosong"}. url=${videoUrl}`);
    }

    return {
      contentType,
      contentLength: contentLength ? Number(contentLength) : 0
    };
  } catch (error) {
    if (error.response) throw error;
    throw new Error(`Gagal validasi video URL sebelum publish: ${error.message}`);
  }
}

async function publishContainer(containerId) {
  const published = await postForm(`${config.instagram.igUserId}/media_publish`, {
    creation_id: containerId
  });

  console.log("IG REEL PUBLISHED:", published.id);

  return published;
}

async function publishReelViaVideoUrl({ videoUrl, caption }) {
  await assertPublicVideoUrl(videoUrl);

  console.log("IG upload method: video_url");

  const created = await postForm(`${config.instagram.igUserId}/media`, {
    media_type: "REELS",
    video_url: videoUrl,
    caption: caption || "",
    share_to_feed: "true"
  });

  console.log("IG REEL CONTAINER CREATED:", created.id);

  await waitForContainerReady(created.id, "reel video_url");

  const published = await publishContainer(created.id);

  return {
    mediaId: published.id,
    containerId: created.id,
    type: "reel_video",
    uploadMethod: "video_url",
    videoUrl
  };
}

async function downloadVideoBuffer(videoUrl) {
  console.log("Downloading video for resumable upload:", videoUrl);

  const response = await axios.get(videoUrl, {
    responseType: "arraybuffer",
    timeout: 180000,
    maxRedirects: 5,
    headers: {
      "User-Agent": "facebookexternalhit/1.1"
    }
  });

  const buffer = Buffer.from(response.data);
  const contentType = response.headers?.["content-type"] || "";
  const contentLength = response.headers?.["content-length"] || "";

  console.log("Downloaded video for resumable upload:", {
    bytes: buffer.length,
    contentType,
    contentLength
  });

  if (!buffer.length) {
    throw new Error("Video buffer kosong saat resumable upload.");
  }

  return buffer;
}

async function createResumableContainer({ caption }) {
  console.log("IG upload method: resumable");

  const created = await postForm(`${config.instagram.igUserId}/media`, {
    media_type: "REELS",
    upload_type: "resumable",
    caption: caption || "",
    share_to_feed: "true"
  });

  console.log("IG RESUMABLE CONTAINER CREATED:", created);

  if (!created.id) {
    throw new Error(`Resumable container tidak mengembalikan id: ${JSON.stringify(created)}`);
  }

  if (!created.uri) {
    throw new Error(`Resumable container tidak mengembalikan uri: ${JSON.stringify(created)}`);
  }

  return created;
}

async function uploadVideoToRupload({ uploadUri, videoBuffer }) {
  console.log("Uploading video binary to Meta rupload:", {
    uploadUri,
    bytes: videoBuffer.length
  });

  try {
    const response = await axios.post(uploadUri, videoBuffer, {
      headers: {
        Authorization: `OAuth ${config.instagram.accessToken}`,
        offset: "0",
        file_size: String(videoBuffer.length),
        "Content-Type": "application/octet-stream"
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 300000,
      validateStatus: () => true
    });

    console.log("IG RESUMABLE UPLOAD RESPONSE:", {
      status: response.status,
      data: response.data
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Rupload gagal. status=${response.status}, data=${JSON.stringify(response.data)}`
      );
    }

    return response.data;
  } catch (error) {
    const apiError = error.response?.data?.error;

    if (apiError) {
      const wrapped = new Error(
        `Instagram rupload error (${error.response.status}): ${apiError.message} ` +
          `[code ${apiError.code}${apiError.error_subcode ? `, subcode ${apiError.error_subcode}` : ""}]`
      );

      wrapped.apiCode = apiError.code;
      wrapped.apiSubcode = apiError.error_subcode;
      wrapped.apiError = apiError;
      throw wrapped;
    }

    throw error;
  }
}

async function publishReelViaResumable({ videoUrl, caption }) {
  await assertPublicVideoUrl(videoUrl);

  const videoBuffer = await downloadVideoBuffer(videoUrl);
  const created = await createResumableContainer({ caption });

  await uploadVideoToRupload({
    uploadUri: created.uri,
    videoBuffer
  });

  await waitForContainerReady(created.id, "reel resumable");

  const published = await publishContainer(created.id);

  return {
    mediaId: published.id,
    containerId: created.id,
    type: "reel_video",
    uploadMethod: "resumable",
    videoUrl
  };
}

export async function publishReel({ videoUrl, caption }) {
  assertInstagramConfig();

  const method = getReelUploadMethod();

  console.log("IG GRAPH VERSION:", config.graphApiVersion);
  console.log("IG REEL UPLOAD METHOD:", method);

  if (method === "resumable") {
    return publishReelViaResumable({ videoUrl, caption });
  }

  if (method === "video_url") {
    return publishReelViaVideoUrl({ videoUrl, caption });
  }

  try {
    return await publishReelViaVideoUrl({ videoUrl, caption });
  } catch (error) {
    if (!isMetaMediaUploadFailed2207076(error)) {
      throw error;
    }

    console.log("IG video_url gagal dengan 2207076. Mencoba fallback resumable upload.", {
      message: error.message
    });

    return publishReelViaResumable({ videoUrl, caption });
  }
}

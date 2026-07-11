import assert from "node:assert/strict";
import test from "node:test";
import { ytDlpCommonArgs } from "../src/video-discovery.js";

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("video discovery forwards custom yt-dlp extractor args", () => {
  const args = withEnv({
    YTDLP_COOKIES_FILE: undefined,
    YTDLP_EXTRACTOR_ARGS: "youtube:player_client=web",
    YTDLP_SKIP_AUTHCHECK: "0"
  }, () => ytDlpCommonArgs());

  assert.deepEqual(args.slice(-2), ["--extractor-args", "youtube:player_client=web"]);
});

test("video discovery keeps youtubetab authcheck skip enabled by default", () => {
  const args = withEnv({
    YTDLP_COOKIES_FILE: undefined,
    YTDLP_EXTRACTOR_ARGS: undefined,
    YTDLP_SKIP_AUTHCHECK: undefined
  }, () => ytDlpCommonArgs());

  assert.ok(args.includes("youtubetab:skip=authcheck"));
});

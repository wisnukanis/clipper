import assert from "node:assert/strict";
import test from "node:test";
import {
  assertYoutubePublishContract,
  isExpectedPublishNoop,
  youtubeUploadIds
} from "../src/publish-contract.js";

test("collects only destination YouTube upload ids from clip results", () => {
  const result = {
    discoveryResult: { added: [{ youtube_video_id: "source-id-must-not-count" }] },
    clips: [
      { youtube_video_id: "uploaded-1" },
      { platformResults: { youtube: { videoId: "uploaded-2" } } }
    ]
  };
  assert.deepEqual(youtubeUploadIds(result), ["uploaded-1", "uploaded-2"]);
});

test("publish contract rejects a green-looking result without a YouTube id", () => {
  assert.throws(
    () => assertYoutubePublishContract({ status: "mixed_daily_publish_done", clips: [] }, { required: true }),
    /YOUTUBE_PUBLISH_REQUIRED/
  );
});

test("publish contract accepts a confirmed YouTube id", () => {
  const ids = assertYoutubePublishContract({
    status: "published",
    clips: [{ youtube_video_id: "abc123" }]
  }, { required: true });
  assert.deepEqual(ids, ["abc123"]);
});

test("daily-limit scheduled skip is an explicit no-op", () => {
  const result = { status: "scheduled_skip", reason: "daily_limit_reached" };
  assert.equal(isExpectedPublishNoop(result), true);
  assert.deepEqual(assertYoutubePublishContract(result, { required: true }), []);
});

test("pending upload confirmation satisfies the contract", () => {
  const result = {
    pending_uploads: {
      uploaded: [{ result: { videoId: "pending-upload-id" } }]
    }
  };
  assert.deepEqual(assertYoutubePublishContract(result, { required: true }), ["pending-upload-id"]);
});

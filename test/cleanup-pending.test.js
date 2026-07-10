import assert from "node:assert/strict";
import test from "node:test";
import { protectedPendingNames } from "../src/cleanup-ftp.js";

test("cleanup protects remote assets referenced by pending uploads", () => {
  const protectedNames = protectedPendingNames([{
    job_id: "JOB-20260710-1234-PODCAST-ABCD",
    status: "pending",
    created_at: new Date().toISOString(),
    video_url: "https://example.com/videos/custom-video.mp4"
  }]);

  assert.equal(protectedNames.videos.has("custom-video.mp4"), true);
  assert.equal(protectedNames.thumbnails.has("JOB-20260710-1234-PODCAST-ABCD-thumbnail.jpg"), true);
  assert.equal(protectedNames.metadata.has("JOB-20260710-1234-PODCAST-ABCD.json"), true);
});

test("cleanup does not protect expired pending uploads forever", () => {
  const protectedNames = protectedPendingNames([{
    job_id: "JOB-OLD",
    status: "pending",
    created_at: "2020-01-01T00:00:00Z"
  }]);
  assert.equal(protectedNames.videos.size, 0);
  assert.equal(protectedNames.thumbnails.size, 0);
  assert.equal(protectedNames.metadata.size, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  isPendingUploadExpired,
  pendingAssetUrl,
  pendingJobId
} from "../src/pending-uploads.js";

test("derives a stable job id from an expired Windows runner path", () => {
  const id = pendingJobId({
    video_path: "C:\\runner\\generated\\JOB-20260710-1234-PODCAST-ABCD-with-thumb-intro.mp4"
  });
  assert.equal(id, "JOB-20260710-1234-PODCAST-ABCD");
});

test("prefers persisted public asset URLs for a pending retry", () => {
  const item = {
    video_url: "https://example.com/videos/job.mp4",
    thumbnail_url: "https://example.com/thumbnails/job.jpg"
  };
  assert.equal(pendingAssetUrl(item, "video"), item.video_url);
  assert.equal(pendingAssetUrl(item, "thumbnail"), item.thumbnail_url);
});

test("expires old pending records before attempting an unavailable runner path", () => {
  const now = Date.parse("2026-07-10T00:00:00Z");
  assert.equal(isPendingUploadExpired({ created_at: "2026-06-01T00:00:00Z" }, now), true);
  assert.equal(isPendingUploadExpired({ created_at: "2026-07-09T00:00:00Z" }, now), false);
});

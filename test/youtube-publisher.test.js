import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertYoutubeVideoFile } from "../src/youtube-publisher.js";

test("rejects zero-byte and non-MP4 upload files", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clipper-youtube-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const empty = path.join(dir, "empty.mp4");
  await fs.writeFile(empty, "");
  await assert.rejects(() => assertYoutubeVideoFile(empty), /terlalu kecil\/kosong/);

  const invalid = path.join(dir, "invalid.mp4");
  await fs.writeFile(invalid, Buffer.alloc(70 * 1024, 1));
  await assert.rejects(() => assertYoutubeVideoFile(invalid), /bukan container MP4 valid/);
});

test("accepts a non-empty MP4 container header", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clipper-youtube-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "valid.mp4");
  const content = Buffer.alloc(70 * 1024);
  Buffer.from("0000ftypisom").copy(content, 0);
  await fs.writeFile(file, content);
  const stat = await assertYoutubeVideoFile(file);
  assert.equal(stat.size, content.length);
});

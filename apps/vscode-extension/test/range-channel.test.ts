import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CacheRangeChannel, MAX_RANGE_BYTES } from "../src/range-channel";

const CACHE_ID = "a".repeat(64);

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "dwg-range-test-"));
}

test("serves exact bounded cache ranges", async (context) => {
  const root = await temporaryDirectory();
  context.after(() => rm(root, { recursive: true, force: true }));
  const cachePath = path.join(root, "cache.bin");
  const source = Uint8Array.from({ length: 32 }, (_, index) => index);
  await writeFile(cachePath, source);

  let resolveResponse: ((message: unknown) => void) | undefined;
  const response = new Promise<unknown>((resolve) => {
    resolveResponse = resolve;
  });
  const channel = await CacheRangeChannel.open(
    CACHE_ID,
    cachePath,
    source.byteLength,
    (message) => {
      resolveResponse?.(message);
      return Promise.resolve(true);
    },
  );
  context.after(() => channel.dispose());

  assert.equal(
    channel.handleMessage({
      type: "dwg-cache-range-read/1",
      cacheId: CACHE_ID,
      requestId: 1,
      offset: 7,
      length: 9,
    }),
    true,
  );
  const message = (await response) as {
    cacheId: string;
    ok: boolean;
    bytes: ArrayBuffer;
  };
  assert.equal(message.cacheId, CACHE_ID);
  assert.equal(message.ok, true);
  assert.deepEqual(
    [...new Uint8Array(message.bytes)],
    [...source.slice(7, 16)],
  );
});

test("rejects mismatched, oversized, and out-of-bounds ranges", async (context) => {
  const root = await temporaryDirectory();
  context.after(() => rm(root, { recursive: true, force: true }));
  const cachePath = path.join(root, "cache.bin");
  await writeFile(cachePath, Buffer.alloc(64));
  const responses: Array<{ requestId: number; ok: boolean; error?: string }> =
    [];
  const channel = await CacheRangeChannel.open(
    CACHE_ID,
    cachePath,
    64,
    (message) => {
      responses.push(
        message as { requestId: number; ok: boolean; error?: string },
      );
      return Promise.resolve(true);
    },
  );
  context.after(() => channel.dispose());

  channel.handleMessage({
    type: "dwg-cache-range-read/1",
    cacheId: "b".repeat(64),
    requestId: 1,
    offset: 0,
    length: 1,
  });
  channel.handleMessage({
    type: "dwg-cache-range-read/1",
    cacheId: CACHE_ID,
    requestId: 2,
    offset: 0,
    length: MAX_RANGE_BYTES + 1,
  });
  channel.handleMessage({
    type: "dwg-cache-range-read/1",
    cacheId: CACHE_ID,
    requestId: 3,
    offset: 63,
    length: 2,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    responses.map(({ requestId, ok }) => ({ requestId, ok })),
    [
      { requestId: 1, ok: false },
      { requestId: 2, ok: false },
      { requestId: 3, ok: false },
    ],
  );
  assert.match(responses[1]?.error ?? "", /8 MiB/u);
});

test("ignores unrelated messages", async (context) => {
  const root = await temporaryDirectory();
  context.after(() => rm(root, { recursive: true, force: true }));
  const cachePath = path.join(root, "cache.bin");
  await writeFile(cachePath, Buffer.alloc(1));
  const channel = await CacheRangeChannel.open(
    CACHE_ID,
    cachePath,
    1,
    () => Promise.resolve(true),
  );
  context.after(() => channel.dispose());
  assert.equal(channel.handleMessage({ type: "something-else" }), false);
});

test("reports a short read if the cache changes after opening", async (context) => {
  const root = await temporaryDirectory();
  context.after(() => rm(root, { recursive: true, force: true }));
  const cachePath = path.join(root, "cache.bin");
  await writeFile(cachePath, Buffer.alloc(16));
  let resolveResponse: ((message: unknown) => void) | undefined;
  const response = new Promise<unknown>((resolve) => {
    resolveResponse = resolve;
  });
  const channel = await CacheRangeChannel.open(
    CACHE_ID,
    cachePath,
    16,
    (message) => {
      resolveResponse?.(message);
      return Promise.resolve(true);
    },
  );
  context.after(() => channel.dispose());
  await truncate(cachePath, 4);
  channel.handleMessage({
    type: "dwg-cache-range-read/1",
    cacheId: CACHE_ID,
    requestId: 1,
    offset: 0,
    length: 16,
  });

  const message = (await response) as { ok: boolean; error: string };
  assert.equal(message.ok, false);
  assert.equal(message.error, "cache range read failed");
});

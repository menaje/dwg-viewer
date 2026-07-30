import assert from "node:assert/strict";
import test from "node:test";

import { GpuBatchCache } from "../src/batch-cache.mjs";

test("evicts least-recently-used detail buffers above its byte budget", async () => {
  const evicted = [];
  const reader = {
    async readBatchVertices(batch) {
      return {
        buffer: new ArrayBuffer(batch.bytes),
        byteLength: batch.bytes,
        vertexCount: batch.bytes / 32,
      };
    },
  };
  const cache = new GpuBatchCache(reader, {
    maximumBytes: 100,
    onEvict(value, batchId) {
      evicted.push([batchId, value.byteLength]);
    },
  });
  await cache.get({ id: 1, bytes: 60 });
  await cache.get({ id: 2, bytes: 60 });

  assert.equal(cache.has(1), false);
  assert.equal(cache.has(2), true);
  assert.equal(cache.snapshot().bytes, 60);
  assert.deepEqual(evicted, [[1, 60]]);
});

test("coalesces simultaneous requests for the same GPU batch", async () => {
  let reads = 0;
  const reader = {
    async readBatchVertices() {
      reads += 1;
      await Promise.resolve();
      return {
        buffer: new ArrayBuffer(32),
        byteLength: 32,
        vertexCount: 1,
      };
    },
  };
  const cache = new GpuBatchCache(reader);
  await Promise.all([cache.get({ id: 7 }), cache.get({ id: 7 })]);
  assert.equal(reads, 1);
});

test("does not retain an in-flight batch after the cache is cleared", async () => {
  let finishRead;
  const evicted = [];
  const reader = {
    readBatchVertices() {
      return new Promise((resolve) => {
        finishRead = resolve;
      });
    },
  };
  const cache = new GpuBatchCache(reader, {
    onEvict(value, batchId) {
      evicted.push([batchId, value.byteLength]);
    },
  });
  const read = cache.get({ id: 9 });
  await Promise.resolve();

  cache.clear();
  finishRead({
    buffer: new ArrayBuffer(32),
    byteLength: 32,
    vertexCount: 1,
  });
  await read;

  assert.deepEqual(cache.snapshot(), {
    entries: 0,
    pending: 0,
    bytes: 0,
    maximumBytes: 128 * 1024 * 1024,
  });
  assert.deepEqual(evicted, [[9, 32]]);
});

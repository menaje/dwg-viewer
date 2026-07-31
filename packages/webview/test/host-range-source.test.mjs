import assert from "node:assert/strict";
import test from "node:test";

import {
  createVsCodeRangeSource,
  installWorkerRangeProxy,
  MAX_HOST_RANGE_BYTES,
  MessageRangeSource,
  WORKER_RANGE_REQUEST,
  WORKER_RANGE_RESPONSE,
} from "../src/host-range-source.mjs";

function messageHarness() {
  let listener;
  const sent = [];
  return {
    sent,
    send(message) {
      sent.push(message);
    },
    subscribe(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    receive(message) {
      listener?.(message);
    },
  };
}

test("reads one exact binary range through a bounded message channel", async () => {
  const channel = messageHarness();
  const source = new MessageRangeSource({
    size: 100,
    requestType: "read",
    responseType: "response",
    requestFields: { cacheId: "cache-123" },
    send: channel.send,
    subscribe: channel.subscribe,
  });
  const pending = source.read(10, 4);

  assert.deepEqual(channel.sent, [
    {
      type: "read",
      cacheId: "cache-123",
      requestId: 1,
      offset: 10,
      length: 4,
    },
  ]);
  channel.receive({
    type: "response",
    requestId: 1,
    ok: true,
    bytes: new Uint8Array([1, 2, 3, 4]),
  });
  assert.deepEqual(new Uint8Array(await pending), new Uint8Array([1, 2, 3, 4]));
  source.dispose();
});

test("rejects oversized, short, failed and disposed message ranges", async () => {
  const channel = messageHarness();
  const source = new MessageRangeSource({
    size: MAX_HOST_RANGE_BYTES + 1,
    requestType: "read",
    responseType: "response",
    send: channel.send,
    subscribe: channel.subscribe,
  });

  assert.throws(
    () => source.read(0, MAX_HOST_RANGE_BYTES + 1),
    /host limit/,
  );
  const short = source.read(0, 2);
  channel.receive({
    type: "response",
    requestId: 1,
    ok: true,
    bytes: new Uint8Array([1]),
  });
  await assert.rejects(short, /short range response/);
  const failed = source.read(0, 1);
  channel.receive({
    type: "response",
    requestId: 2,
    ok: false,
    error: "bounded failure",
  });
  await assert.rejects(failed, /bounded failure/);
  const disposed = source.read(0, 1);
  source.dispose();
  await assert.rejects(disposed, { name: "AbortError" });
  await assert.rejects(source.read(0, 1), { name: "AbortError" });
});

test("ignores a stale VS Code response from a replaced cache", async () => {
  const activeCacheId = "a".repeat(64);
  const staleCacheId = "b".repeat(64);
  const listeners = new Set();
  const sent = [];
  const target = {
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
  };
  const source = createVsCodeRangeSource(
    {
      postMessage(message) {
        sent.push(message);
      },
    },
    { cacheId: activeCacheId, size: 10 },
    target,
  );
  const pending = source.read(0, 2);
  const requestId = sent[0].requestId;
  for (const listener of listeners) {
    listener({
      data: {
        type: "dwg-cache-range-response/1",
        cacheId: staleCacheId,
        requestId,
        ok: true,
        bytes: new Uint8Array([9, 9]),
      },
    });
    listener({
      data: {
        type: "dwg-cache-range-response/1",
        cacheId: activeCacheId,
        requestId,
        ok: true,
        bytes: new Uint8Array([1, 2]),
      },
    });
  }
  assert.deepEqual(new Uint8Array(await pending), new Uint8Array([1, 2]));
  source.dispose();
});

test("proxies worker requests without retaining transferred buffers", async () => {
  const listeners = new Set();
  const posts = [];
  const worker = {
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    postMessage(message, transfers = []) {
      posts.push({ message, transfers });
    },
  };
  const dispose = installWorkerRangeProxy(worker, {
    async read(offset, length) {
      assert.equal(offset, 4);
      assert.equal(length, 3);
      return new Uint8Array([7, 8, 9]).buffer;
    },
  });

  for (const listener of listeners) {
    listener({
      data: {
        type: WORKER_RANGE_REQUEST,
        requestId: 9,
        offset: 4,
        length: 3,
      },
    });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].message.type, WORKER_RANGE_RESPONSE);
  assert.equal(posts[0].message.ok, true);
  assert.equal(posts[0].transfers[0], posts[0].message.bytes);
  dispose();
  assert.equal(listeners.size, 0);
});

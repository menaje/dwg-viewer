import assert from "node:assert/strict";
import test from "node:test";

import {
  readJsHeapSnapshot,
  WebviewMemoryTelemetry,
} from "../src/memory-telemetry.mjs";

function fakePerformance(memory) {
  return { memory };
}

test("reads Chromium heap counters without accepting invalid byte values", () => {
  assert.deepEqual(
    readJsHeapSnapshot(
      fakePerformance({
        usedJSHeapSize: 120,
        totalJSHeapSize: 240,
        jsHeapSizeLimit: 480,
      }),
    ),
    {
      usedJsHeapBytes: 120,
      totalJsHeapBytes: 240,
      jsHeapLimitBytes: 480,
    },
  );
  assert.deepEqual(
    readJsHeapSnapshot(
      fakePerformance({
        usedJSHeapSize: 120.9,
        totalJSHeapSize: Number.NaN,
        jsHeapSizeLimit: -1,
      }),
    ),
    {
      usedJsHeapBytes: 120,
      totalJsHeapBytes: null,
      jsHeapLimitBytes: null,
    },
  );
  assert.equal(readJsHeapSnapshot(fakePerformance(undefined)), null);
  assert.equal(
    readJsHeapSnapshot(fakePerformance({ usedJSHeapSize: Infinity })),
    null,
  );
});

test("tracks per-drawing JS and GPU peaks against the hard limit", () => {
  const memory = {
    usedJSHeapSize: 100,
    totalJSHeapSize: 200,
    jsHeapSizeLimit: 1_000,
  };
  const telemetry = new WebviewMemoryTelemetry({
    performanceObject: fakePerformance(memory),
    hardLimitBytes: 150,
  });

  assert.deepEqual(telemetry.sample(40), {
    jsHeapAvailable: true,
    usedJsHeapBytes: 100,
    totalJsHeapBytes: 200,
    jsHeapLimitBytes: 1_000,
    peakUsedJsHeapBytes: 100,
    gpuTrackedBytes: 40,
    peakGpuTrackedBytes: 40,
    hardLimitBytes: 150,
    hardLimitExceeded: false,
  });

  memory.usedJSHeapSize = 160;
  assert.equal(telemetry.sample(30).hardLimitExceeded, true);
  memory.usedJSHeapSize = 80;
  const final = telemetry.sample(50);
  assert.equal(final.peakUsedJsHeapBytes, 160);
  assert.equal(final.peakGpuTrackedBytes, 50);
  assert.equal(final.hardLimitExceeded, true);
});

test("keeps GPU telemetry available when heap counters are unsupported", () => {
  const telemetry = new WebviewMemoryTelemetry({
    performanceObject: {},
  });
  const snapshot = telemetry.sample(64);

  assert.equal(snapshot.jsHeapAvailable, false);
  assert.equal(snapshot.usedJsHeapBytes, null);
  assert.equal(snapshot.peakUsedJsHeapBytes, null);
  assert.equal(snapshot.gpuTrackedBytes, 64);
  assert.equal(snapshot.peakGpuTrackedBytes, 64);
  assert.throws(() => telemetry.sample(-1), /tracked GPU bytes/);
});

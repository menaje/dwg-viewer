import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryRangeSource,
  TrackedRangeSource,
} from "../src/range-source.mjs";
import {
  GPU_LINE_VERTEX_RECORD_SIZE,
  SceneCacheReader,
  SectionKind,
} from "../src/scene-cache.mjs";
import { makeFixtureCache } from "./cache-fixture.mjs";

test("opens the header and directory without reading the full cache", async () => {
  const buffer = makeFixtureCache();
  const source = new TrackedRangeSource(new MemoryRangeSource(buffer));
  const reader = await SceneCacheReader.open(source);

  assert.equal(reader.header.major, 1);
  assert.equal(reader.header.minor, 2);
  assert.equal(reader.header.fileSize, buffer.byteLength);
  assert.equal(reader.sections.size, 6);
  assert.deepEqual(source.requests, [
    { offset: 0, length: 64 },
    { offset: 64, length: 6 * 40 },
  ]);
  assert.ok(source.bytesRead < buffer.byteLength / 2);
});

test("accepts the Scene Cache v1.3 header", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache({ minorVersion: 3 })),
  );

  assert.equal(reader.header.major, 1);
  assert.equal(reader.header.minor, 3);
});

test("rejects a newer unsupported Scene Cache minor version", async () => {
  await assert.rejects(
    SceneCacheReader.open(
      new MemoryRangeSource(makeFixtureCache({ minorVersion: 5 })),
    ),
    /unsupported scene-cache version 1\.5/,
  );
});

test("preserves v1.4 Korean source text, style fonts and MTEXT columns", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache({ minorVersion: 4 })),
  );
  const styles = await reader.readTextStyles();
  const texts = await reader.readTextEntities();

  assert.equal(reader.header.minor, 4);
  assert.equal(styles[0].fontFile, "txt.shx");
  assert.equal(styles[0].bigFontFile, "hztxt.shx");
  assert.equal(texts.length, 2);
  assert.equal(texts.get(0).value, "한글");
  assert.equal(texts.get(0).style, styles[0]);
  assert.equal(texts.get(1).value, "{\\H1.2x;배관}\\P점검");
  assert.deepEqual([...texts.get(1).columnHeights], [10, 11]);
  const displayRecord = {
    insertionPoint: [0, 0, 0],
    normal: [0, 0, 1],
  };
  assert.equal(texts.readDisplayRecord(0, displayRecord), displayRecord);
  assert.equal(displayRecord.valueByteLength, 6);
  assert.equal(displayRecord.style, styles[0]);
  assert.equal(texts.readValue(0), "한글");
});

test("parses render metadata and reads one contiguous overview prefix", async () => {
  const source = new TrackedRangeSource(
    new MemoryRangeSource(makeFixtureCache()),
  );
  const reader = await SceneCacheReader.open(source);
  const metadata = await reader.readRenderMetadata();

  assert.equal(metadata.layers[0].name, "0");
  assert.equal(metadata.blocks[1].name, "BLOCK_A");
  assert.deepEqual(metadata.blocks[1].basePoint, [10, 0, 0]);
  assert.equal(metadata.inserts.length, 2);
  assert.equal(metadata.batches.length, 3);
  assert.equal(metadata.batches.overviewVertexCount, 4);

  const beforeOverview = source.snapshot();
  const overview = await reader.readOverviewVertices();
  const vertexSection = reader.getSection(SectionKind.GpuLineVertices);
  assert.equal(overview.byteLength, 4 * GPU_LINE_VERTEX_RECORD_SIZE);
  assert.deepEqual(source.requests.at(-1), {
    offset: vertexSection.offset,
    length: overview.byteLength,
  });
  assert.equal(
    source.bytesRead - beforeOverview.bytesRead,
    overview.byteLength,
  );
});

test("loads a detail batch as an independently bounded range", async () => {
  const source = new TrackedRangeSource(
    new MemoryRangeSource(makeFixtureCache()),
  );
  const reader = await SceneCacheReader.open(source);
  const batches = await reader.readGpuLineBatches();
  const detail = await reader.readBatchVertices(batches[2]);

  assert.equal(detail.byteLength, 64);
  assert.equal(detail.vertexCount, 2);
  assert.equal(source.requests.at(-1).length, 64);
});

test("rejects cache offsets above JavaScript's exact integer range", async () => {
  const buffer = makeFixtureCache();
  new DataView(buffer).setBigUint64(
    40,
    BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    true,
  );
  await assert.rejects(
    SceneCacheReader.open(new MemoryRangeSource(buffer)),
    /safe integer limit/,
  );
});

test("rejects an overview that exceeds the caller's memory budget", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache()),
  );
  await assert.rejects(
    reader.readOverviewVertices({ maximumBytes: 32 }),
    /above the 32-byte limit/,
  );
});

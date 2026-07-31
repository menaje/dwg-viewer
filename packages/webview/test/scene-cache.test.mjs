import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryRangeSource,
  TrackedRangeSource,
} from "../src/range-source.mjs";
import {
  DIRECTORY_ENTRY_SIZE,
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
      new MemoryRangeSource(makeFixtureCache({ minorVersion: 8 })),
    ),
    /unsupported scene-cache version 1\.8/,
  );
});

test("accepts the Scene Cache v1.5 HATCH-boundary header", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache({ minorVersion: 5 })),
  );

  assert.equal(reader.header.major, 1);
  assert.equal(reader.header.minor, 5);
});

test("reads bounded Scene Cache v1.6 HATCH source pools lazily", async () => {
  const source = new TrackedRangeSource(
    new MemoryRangeSource(makeFixtureCache({ minorVersion: 6 })),
  );
  const reader = await SceneCacheReader.open(source);
  const requestsAfterOpen = source.requests.length;
  const hatches = await reader.readHatchSource();

  assert.equal(reader.header.minor, 6);
  assert.equal(hatches.length, 1);
  assert.equal(hatches.loopCount, 2);
  assert.equal(hatches.vertexCount, 8);
  assert.equal(hatches.gradientColorCount, 2);
  assert.equal(hatches.seedPointCount, 1);
  assert.equal(hatches.get(0).patternName, "SOLID");
  assert.equal(hatches.get(0).gradientName, "LINEAR");
  assert.equal(hatches.get(0).loopCount, 2);

  const loop = hatches.readLoop(1, {});
  assert.equal(loop.firstVertex, 4);
  assert.equal(loop.vertexCount, 4);
  assert.equal(loop.signedArea, -16);
  assert.deepEqual(hatches.readVertex(6, [0, 0, 0]), [7, 7, 0]);
  assert.deepEqual(hatches.readSeedPoint(0, [0, 0]), [1, 1]);
  assert.equal(hatches.readGradientColor(1, {}).value, 1);
  assert.equal(source.requests.length - requestsAfterOpen, 5);
});

test("reads bounded Scene Cache v1.7 HATCH pattern definitions lazily", async () => {
  const source = new TrackedRangeSource(
    new MemoryRangeSource(makeFixtureCache({ minorVersion: 7 })),
  );
  const reader = await SceneCacheReader.open(source);
  const requestsAfterOpen = source.requests.length;
  const hatches = await reader.readHatchSource();

  assert.equal(hatches.patternLineCount, 2);
  assert.equal(hatches.patternDashCount, 2);
  assert.equal(hatches.get(0).firstPatternLine, 0);
  assert.equal(hatches.get(0).patternLineCount, 2);
  assert.deepEqual(hatches.readPatternLine(0, {}), {
    index: 0,
    hatchIndex: 0,
    sourceLineIndex: 0,
    angle: 0,
    basePoint: [0, 0],
    offset: [0, 2],
    firstDash: 0,
    dashCount: 2,
  });
  assert.equal(hatches.readPatternDash(0), 3);
  assert.equal(hatches.readPatternDash(1), -1);
  assert.equal(source.requests.length - requestsAfterOpen, 7);
});

test("rejects reserved metadata in a v1.7 HATCH pattern line", async () => {
  const buffer = makeFixtureCache({ minorVersion: 7 });
  const view = new DataView(buffer);
  const sectionCount = view.getUint32(16, true);
  const directoryOffset = Number(view.getBigUint64(32, true));
  let patternOffset;
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = directoryOffset + index * DIRECTORY_ENTRY_SIZE;
    if (view.getUint32(offset, true) === SectionKind.HatchPatternLines) {
      patternOffset = Number(view.getBigUint64(offset + 8, true));
      break;
    }
  }
  assert.notEqual(patternOffset, undefined);
  view.setUint32(patternOffset + 68, 1, true);

  const reader = await SceneCacheReader.open(new MemoryRangeSource(buffer));
  await assert.rejects(reader.readHatchSource(), /invalid metadata/);
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

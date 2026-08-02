import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryRangeSource,
  TrackedRangeSource,
} from "../src/range-source.mjs";
import {
  DIRECTORY_ENTRY_SIZE,
  LEGACY_GPU_LINE_VERTEX_RECORD_SIZE,
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
  assert.equal(reader.header.preview, false);
  assert.equal(reader.sections.size, 6);
  assert.deepEqual(source.requests, [
    { offset: 0, length: 64 },
    { offset: 64, length: 6 * 40 },
  ]);
  assert.ok(source.bytesRead < buffer.byteLength / 2);
});

test("identifies a bounded progressive preview cache", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(
      makeFixtureCache({ minorVersion: 11, preview: true }),
    ),
  );

  assert.equal(reader.header.preview, true);
});

test("rejects unsupported Scene Cache header flags", async () => {
  const buffer = makeFixtureCache();
  new DataView(buffer).setUint32(24, 2, true);
  await assert.rejects(
    SceneCacheReader.open(new MemoryRangeSource(buffer)),
    /unsupported header flags/u,
  );
});

test("accepts the Scene Cache v1.3 header", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache({ minorVersion: 3 })),
  );

  assert.equal(reader.header.major, 1);
  assert.equal(reader.header.minor, 3);
});

test("reads bounded exact ARC, CIRCLE, and ELLIPSE review geometry", async () => {
  const source = new TrackedRangeSource(
    new MemoryRangeSource(
      makeFixtureCache({ includeReviewCurves: true }),
    ),
  );
  const reader = await SceneCacheReader.open(source);
  const requestsAfterOpen = source.requests.length;
  const result = await reader.readReviewCurves();

  assert.equal(result.records, 3);
  assert.equal(result.truncated, false);
  assert.equal(result.curves.get(0x501n).kind, "arc");
  assert.deepEqual(result.curves.get(0x501n).center, [0, 0, 0]);
  assert.equal(result.curves.get(0x501n).radius, 10);
  assert.equal(result.curves.get(0x502n).kind, "circle");
  assert.deepEqual(result.curves.get(0x502n).center, [20, 0, 0]);
  assert.equal(result.curves.get(0x503n).kind, "ellipse");
  assert.deepEqual(result.curves.get(0x503n).majorAxis, [8, 0, 0]);
  assert.equal(result.curves.get(0x503n).minorAxisRatio, 0.5);
  assert.equal(source.requests.length - requestsAfterOpen, 3);

  const bounded = await reader.readReviewCurves({
    maximumBytes: 112,
  });
  assert.equal(bounded.records, 1);
  assert.equal(bounded.truncated, true);
});

test("rejects a newer unsupported Scene Cache minor version", async () => {
  await assert.rejects(
    SceneCacheReader.open(
      new MemoryRangeSource(makeFixtureCache({ minorVersion: 19 })),
    ),
    /unsupported scene-cache version 1\.19/,
  );
});

test("reads Scene Cache v1.14 drawing display settings", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(
      makeFixtureCache({
        minorVersion: 14,
        wipeoutFrame: 2,
        lineWeightDisplay: true,
        fillMode: false,
        modelSpaceActive: false,
      }),
    ),
  );
  const metadata = await reader.readRenderMetadata();

  assert.equal(metadata.drawing.wipeoutFrame, 2);
  assert.equal(metadata.drawing.lineWeightDisplay, true);
  assert.equal(metadata.drawing.fillMode, false);
  assert.equal(metadata.drawing.modelSpaceActive, false);
});

test("reads Scene Cache v1.15 linetype definitions and scale", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(
      makeFixtureCache({
        minorVersion: 15,
        globalLinetypeScale: 300,
      }),
    ),
  );
  const metadata = await reader.readRenderMetadata();

  assert.equal(metadata.drawing.globalLinetypeScale, 300);
  assert.equal(metadata.drawing.paperSpaceLinetypeScale, true);
  assert.equal(metadata.linetypes.length, 1);
  assert.equal(metadata.linetypes[0].name, "DASHED");
  assert.equal(metadata.linetypes[0].patternLength, 1.5);
  assert.deepEqual(
    metadata.linetypes[0].dashes.map((dash) => dash.length),
    [1, -0.5],
  );
});

test("reads Scene Cache v1.16 layouts, viewports and frozen layers", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache({ minorVersion: 16 })),
  );
  const metadata = await reader.readRenderMetadata();

  assert.equal(metadata.layouts.length, 2);
  assert.equal(metadata.layouts[0].name, "Model");
  assert.equal(metadata.layouts[0].blockIndex, 0);
  assert.equal(metadata.layouts[1].name, "배치1");
  assert.deepEqual(
    [metadata.layouts[1].paperWidth, metadata.layouts[1].paperHeight],
    [420, 297],
  );
  assert.equal(metadata.layouts[1].viewports.length, 2);
  assert.equal(metadata.layouts[1].viewports[1].id, 2);
  assert.deepEqual(
    metadata.layouts[1].viewports[1].frozenLayerIndices,
    [0],
  );
  assert.deepEqual(
    metadata.layouts[1].viewports[1].clipBoundaryVertices,
    [
      [40, 20, 0],
      [380, 20, 0],
      [360, 277, 0],
      [60, 277, 0],
    ],
  );
});

test("reads the Scene Cache v1.17 saved model view", async () => {
  const savedModelView = {
    center: [1_903_111.951778639, -372_937.2779705549, 0],
    height: 144_557.98890031595,
    width: 364_416.2807004749,
    twist: 0,
  };
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(
      makeFixtureCache({
        minorVersion: 17,
        savedModelView,
      }),
    ),
  );
  const metadata = await reader.readRenderMetadata();

  assert.deepEqual(metadata.drawing.savedModelView, savedModelView);
});

test("reads bounded Scene Cache v1.18 raster image references", async () => {
  const source = new TrackedRangeSource(
    new MemoryRangeSource(makeFixtureCache({ minorVersion: 18 })),
  );
  const reader = await SceneCacheReader.open(source);
  const requestsAfterOpen = source.requests.length;
  const images = await reader.readImageEntities();

  assert.equal(images.length, 1);
  assert.equal(images.clipVertexCount, 2);
  assert.equal(images.readPath(0), String.raw`.\image\한글 사진.png`);
  assert.equal(images.get(0).displayProperties, 7);
  assert.equal(images.get(0).clippingEnabled, true);
  assert.equal(images.get(0).brightness, 40);
  assert.equal(images.get(0).contrast, 60);
  assert.equal(images.get(0).fade, 10);
  assert.deepEqual(images.get(0).insertionPoint, [100, 200, 0]);
  assert.deepEqual(images.get(0).uVector, [2, 0, 0]);
  assert.deepEqual(images.get(0).vVector, [0, 3, 0]);
  assert.deepEqual(images.get(0).size, [8, 6]);
  assert.deepEqual(images.get(0).clipBoundaryVertices, [
    [1.5, 0.5],
    [6.5, 4.5],
  ]);
  assert.equal(source.requests.length - requestsAfterOpen, 2);
});

test("reads the original XREF path from Scene Cache v1.12", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache({ minorVersion: 12 })),
  );
  const blocks = await reader.readBlocks();

  assert.equal(blocks[0].xrefPath, "");
  assert.equal(blocks[2].xrefPath, String.raw`.\xref\외부도면.dwg`);
});

test("reads bounded INSERT XCLIP metadata from Scene Cache v1.13", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache({ minorVersion: 13 })),
  );
  const clips = await reader.readInsertClips();

  assert.equal(clips.length, 1);
  assert.equal(clips[0].insertHandle, 201n);
  assert.equal(clips[0].rectangular, true);
  assert.equal(clips[0].inverted, false);
  assert.deepEqual(clips[0].vertices, [
    [10, 20, 0],
    [30, 40, 0],
  ]);
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

test("reads bounded Scene Cache v1.8 POINT and SOLID source lazily", async () => {
  const source = new TrackedRangeSource(
    new MemoryRangeSource(makeFixtureCache({ minorVersion: 8 })),
  );
  const reader = await SceneCacheReader.open(source);
  const requestsAfterOpen = source.requests.length;
  const primitives = await reader.readPrimitiveSource();

  assert.equal(reader.header.minor, 8);
  assert.equal(primitives.points.length, 1);
  assert.equal(primitives.solids.length, 2);
  assert.equal(primitives.faces.length, 0);
  assert.deepEqual(primitives.points.get(0).location, [11, 2, 0]);
  assert.equal(primitives.points.get(0).displayMode, 66);
  assert.equal(primitives.points.get(0).displaySize, -3);
  assert.equal(primitives.solids.get(0).fillMode, true);
  assert.deepEqual(primitives.solids.get(0).corners[3], [0, 3, 0]);
  assert.equal(primitives.solids.get(1).fillMode, false);
  assert.equal(source.requests.length - requestsAfterOpen, 2);
});

test("reads bounded Scene Cache v1.9 3DFACE source lazily", async () => {
  const source = new TrackedRangeSource(
    new MemoryRangeSource(makeFixtureCache({ minorVersion: 9 })),
  );
  const reader = await SceneCacheReader.open(source);
  const requestsAfterOpen = source.requests.length;
  const primitives = await reader.readPrimitiveSource();

  assert.equal(reader.header.minor, 9);
  assert.equal(primitives.faces.length, 5);
  assert.deepEqual(
    [0, 1, 2, 3, 4].map(
      (index) => primitives.faces.get(index).invisibleEdges,
    ),
    [1, 2, 4, 8, 0],
  );
  assert.deepEqual(primitives.faces.get(0).corners[3], [20, 3, 0]);
  assert.deepEqual(
    primitives.faces.get(4).corners[3],
    primitives.faces.get(4).corners[2],
  );
  assert.equal(source.requests.length - requestsAfterOpen, 3);
});

test("reads bounded Scene Cache v1.10 WIPEOUT source lazily", async () => {
  const source = new TrackedRangeSource(
    new MemoryRangeSource(makeFixtureCache({ minorVersion: 10 })),
  );
  const reader = await SceneCacheReader.open(source);
  const wipeoutEntities = reader.getSection(SectionKind.WipeoutEntities);
  const wipeoutClipVertices = reader.getSection(
    SectionKind.WipeoutClipVertices,
  );
  const metadata = await reader.readRenderMetadata();

  assert.equal(metadata.drawing.wipeoutFrame, 1);
  assert.equal(
    source.requests.some(
      (request) =>
        request.offset === wipeoutEntities.offset ||
        request.offset === wipeoutClipVertices.offset,
    ),
    false,
  );

  const requestsBeforePrimitives = source.requests.length;
  const primitives = await reader.readPrimitiveSource();
  assert.equal(primitives.wipeouts.length, 3);
  assert.equal(primitives.wipeouts.clipVertexCount, 9);
  assert.equal(primitives.wipeouts.get(0).clipType, 2);
  assert.equal(primitives.wipeouts.get(0).displayProperties, 5);
  assert.deepEqual(
    primitives.wipeouts.get(0).clipBoundaryVertices,
    [
      [0, 0],
      [2, 0],
      [2, 1],
      [0, 1],
    ],
  );
  assert.equal(primitives.wipeouts.get(1).ownerHandle, 101n);
  assert.deepEqual(primitives.wipeouts.get(1).size, [8, 6]);
  assert.equal(primitives.wipeouts.get(2).clippingEnabled, false);
  assert.equal(source.requests.length - requestsBeforePrimitives, 5);
});

test("rejects invalid metadata in a v1.10 WIPEOUT record", async () => {
  const buffer = makeFixtureCache({ minorVersion: 10 });
  const view = new DataView(buffer);
  const sectionCount = view.getUint32(16, true);
  const directoryOffset = Number(view.getBigUint64(32, true));
  let wipeoutOffset;
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = directoryOffset + index * DIRECTORY_ENTRY_SIZE;
    if (view.getUint32(offset, true) === SectionKind.WipeoutEntities) {
      wipeoutOffset = Number(view.getBigUint64(offset + 8, true));
      break;
    }
  }
  assert.notEqual(wipeoutOffset, undefined);
  view.setUint8(wipeoutOffset + 40, 101);

  const reader = await SceneCacheReader.open(new MemoryRangeSource(buffer));
  await assert.rejects(
    reader.readWipeoutEntities(),
    /invalid metadata/,
  );
});

test("rejects a v1.10 WIPEOUT source table above its record cap", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(
      makeFixtureCache({
        minorVersion: 10,
        wipeoutRecordCount: 65_537,
      }),
    ),
  );

  await assert.rejects(
    reader.readWipeoutEntities(),
    /exceeds the 65536-record limit/,
  );
});

test("reads normalized Scene Cache v1.11 draw order lazily", async () => {
  const source = new TrackedRangeSource(
    new MemoryRangeSource(makeFixtureCache({ minorVersion: 11 })),
  );
  const reader = await SceneCacheReader.open(source);
  const tableSection = reader.getSection(SectionKind.DrawOrderTables);
  const entrySection = reader.getSection(SectionKind.DrawOrderEntries);
  await reader.readRenderMetadata();

  assert.equal(
    source.requests.some(
      (request) =>
        request.offset === tableSection.offset ||
        request.offset === entrySection.offset,
    ),
    false,
  );

  const requestsBeforeDrawOrder = source.requests.length;
  const drawOrder = await reader.readDrawOrder();
  assert.equal(source.requests.length - requestsBeforeDrawOrder, 2);
  assert.equal(drawOrder.length, 2);
  assert.equal(drawOrder.entryCount, 3);
  assert.equal(drawOrder.get(0).ownerHandle, 100n);
  assert.deepEqual(
    drawOrder.get(0).entries.map((entry) => [
      entry.entityHandle,
      entry.sortHandle,
    ]),
    [
      [0x301n, 0x102n],
      [0x302n, 0x101n],
    ],
  );
  assert.equal(drawOrder.readTable(1, {}).firstEntry, 2);
  assert.equal(drawOrder.readEntry(2, {}).entityHandle, 0x401n);
});

test("rejects a non-contiguous v1.11 draw-order range", async () => {
  const buffer = makeFixtureCache({ minorVersion: 11 });
  const view = new DataView(buffer);
  const sectionCount = view.getUint32(16, true);
  const directoryOffset = Number(view.getBigUint64(32, true));
  let tableOffset;
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = directoryOffset + index * DIRECTORY_ENTRY_SIZE;
    if (view.getUint32(offset, true) === SectionKind.DrawOrderTables) {
      tableOffset = Number(view.getBigUint64(offset + 8, true));
      break;
    }
  }
  assert.notEqual(tableOffset, undefined);
  view.setBigUint64(tableOffset + 16, 1n, true);

  const reader = await SceneCacheReader.open(new MemoryRangeSource(buffer));
  await assert.rejects(
    reader.readDrawOrder(),
    /invalid metadata/,
  );
});

test("rejects invalid flags in a v1.9 3DFACE record", async () => {
  const buffer = makeFixtureCache({ minorVersion: 9 });
  const view = new DataView(buffer);
  const sectionCount = view.getUint32(16, true);
  const directoryOffset = Number(view.getBigUint64(32, true));
  let faceOffset;
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = directoryOffset + index * DIRECTORY_ENTRY_SIZE;
    if (view.getUint32(offset, true) === SectionKind.FaceEntities) {
      faceOffset = Number(view.getBigUint64(offset + 8, true));
      break;
    }
  }
  assert.notEqual(faceOffset, undefined);
  view.setUint32(faceOffset + 32, 16, true);

  const reader = await SceneCacheReader.open(new MemoryRangeSource(buffer));
  await assert.rejects(
    reader.readFaceEntities(),
    /invalid flags or reserved metadata/,
  );
});

test("rejects a v1.9 3DFACE source table above its record cap", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(
      makeFixtureCache({
        minorVersion: 9,
        faceRecordCount: 131_073,
      }),
    ),
  );

  await assert.rejects(
    reader.readFaceEntities(),
    /exceeds the 131072-record limit/,
  );
});

test("rejects reserved metadata in a v1.8 POINT record", async () => {
  const buffer = makeFixtureCache({ minorVersion: 8 });
  const view = new DataView(buffer);
  const sectionCount = view.getUint32(16, true);
  const directoryOffset = Number(view.getBigUint64(32, true));
  let pointOffset;
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = directoryOffset + index * DIRECTORY_ENTRY_SIZE;
    if (view.getUint32(offset, true) === SectionKind.PointEntities) {
      pointOffset = Number(view.getBigUint64(offset + 8, true));
      break;
    }
  }
  assert.notEqual(pointOffset, undefined);
  view.setUint32(pointOffset + 108, 1, true);

  const reader = await SceneCacheReader.open(new MemoryRangeSource(buffer));
  await assert.rejects(
    reader.readPointEntities(),
    /nonzero reserved metadata/,
  );
});

test("rejects invalid flags in a v1.8 SOLID record", async () => {
  const buffer = makeFixtureCache({ minorVersion: 8 });
  const view = new DataView(buffer);
  const sectionCount = view.getUint32(16, true);
  const directoryOffset = Number(view.getBigUint64(32, true));
  let solidOffset;
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = directoryOffset + index * DIRECTORY_ENTRY_SIZE;
    if (view.getUint32(offset, true) === SectionKind.SolidEntities) {
      solidOffset = Number(view.getBigUint64(offset + 8, true));
      break;
    }
  }
  assert.notEqual(solidOffset, undefined);
  view.setUint32(solidOffset + 32, 2, true);

  const reader = await SceneCacheReader.open(new MemoryRangeSource(buffer));
  await assert.rejects(
    reader.readSolidEntities(),
    /invalid flags or reserved metadata/,
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
  assert.equal(
    overview.byteLength,
    4 * LEGACY_GPU_LINE_VERTEX_RECORD_SIZE,
  );
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

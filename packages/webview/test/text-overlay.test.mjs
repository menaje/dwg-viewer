import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInstanceGraph,
  createClipNode,
} from "../src/instance-graph.mjs";
import { translationMat4 } from "../src/math.mjs";
import { MemoryRangeSource } from "../src/range-source.mjs";
import { SceneCacheReader } from "../src/scene-cache.mjs";
import {
  CanvasTextOverlay,
  plainCadTextLines,
  registerLocalOutlineFont,
  systemFallbackFont,
  unregisterLocalOutlineFont,
  wrapCadTextLines,
} from "../src/text-overlay.mjs";
import { makeFixtureCache } from "./cache-fixture.mjs";

function fakeCanvas() {
  const calls = {
    fillText: 0,
    fillTextArguments: [],
    lineTo: 0,
    stroke: 0,
    transforms: [],
    clips: [],
    saves: 0,
    restores: 0,
  };
  const context = {
    beginPath() {},
    clip(rule) {
      calls.clips.push(rule);
    },
    closePath() {},
    clearRect() {},
    fillText(...arguments_) {
      calls.fillText += 1;
      calls.fillTextArguments.push(arguments_);
    },
    lineTo() {
      calls.lineTo += 1;
    },
    moveTo() {},
    rect() {},
    restore() {
      calls.restores += 1;
    },
    save() {
      calls.saves += 1;
    },
    setTransform(...values) {
      calls.transforms.push(values);
    },
    stroke() {
      calls.stroke += 1;
    },
  };
  return {
    calls,
    clientWidth: 800,
    clientHeight: 600,
    width: 0,
    height: 0,
    getContext(kind) {
      return kind === "2d" ? context : null;
    },
  };
}

async function textScene() {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache({ minorVersion: 4 })),
  );
  const metadata = await reader.readRenderMetadata();
  return {
    metadata,
    textEntities: await reader.readTextEntities(),
    instanceGraph: buildInstanceGraph(metadata.blocks, metadata.inserts),
  };
}

const camera = Object.freeze({
  origin: [105, 201, 0],
  worldWidth: 20,
  worldHeight: 15,
});

test("removes MTEXT controls without losing Korean or line breaks", () => {
  assert.deepEqual(
    plainCadTextLines("{\\H1.2x;배관}\\P점검\\U+00B0%%p", true),
    ["배관", "점검°±"],
  );
  assert.deepEqual(plainCadTextLines("한글%%d", false), ["한글°"]);
  assert.deepEqual(
    plainCadTextLines(
      String.raw`\U+B0B4\U+B824\U+AC10`,
      false,
    ),
    ["내려감"],
  );
  assert.equal(
    [...plainCadTextLines("한".repeat(5_000), false)[0]].length,
    4_096,
  );
});

test("wraps MTEXT to its stored paragraph width", () => {
  assert.deepEqual(
    wrapCadTextLines(
      ["가나다 라마바사", "", "abcdef"],
      5,
      () => 1,
    ),
    ["가나다", "라마바사", "", "abcde", "f"],
  );
  assert.deepEqual(
    wrapCadTextLines(["폭 정보 없음"], 0, () => 1),
    ["폭 정보 없음"],
  );
});

test("maps common CAD TrueType files to platform-safe Korean fallbacks", () => {
  assert.equal(
    systemFallbackFont({ fontFile: "C:\\Windows\\Fonts\\malgun.ttf" }),
    '1px "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif',
  );
  assert.equal(
    systemFallbackFont({ fontFile: "malgunbd.ttf" }),
    '700 1px "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif',
  );
  assert.equal(
    systemFallbackFont({ fontFile: "arial.ttf" }),
    '1px "Arial", "Helvetica Neue", Helvetica, sans-serif',
  );
  assert.equal(
    systemFallbackFont({ fontFile: "batang.ttf" }),
    '1px "Batang", "AppleMyungjo", "Noto Serif KR", serif',
  );
  assert.equal(
    registerLocalOutlineFont("굵은돋움체.TTF", "DwgLocalFont_1_7"),
    "굵은돋움체.ttf",
  );
  assert.equal(
    systemFallbackFont({ fontFile: "C:\\Fonts\\굵은돋움체.ttf" }),
    '1px "DwgLocalFont_1_7", "Noto Sans KR", "Apple SD Gothic Neo", sans-serif',
  );
  assert.equal(unregisterLocalOutlineFont("굵은돋움체.ttf"), true);
});

test("falls back to system Korean text within a hard glyph budget", async () => {
  const scene = await textScene();
  const canvas = fakeCanvas();
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: scene.textEntities,
    blocks: scene.metadata.blocks,
    layers: scene.metadata.layers,
    instanceGraph: scene.instanceGraph,
    glyphCache: { getGlyph: () => undefined },
    maximumFallbackGlyphs: 2,
    minimumPixelHeight: 0.1,
  });

  const metrics = overlay.redraw(camera, [true]);
  assert.equal(metrics.fallbackGlyphs, 2);
  assert.equal(metrics.truncated, true);
  assert.equal(canvas.calls.fillText, 2);
  assert.ok(
    canvas.calls.transforms.some(
      ([a, b, c, d]) => a > 0 && b === 0 && c === 0 && d > 0,
    ),
  );
});

test("uses the DWG-adjusted TEXT insertion point without applying justification twice", () => {
  const canvas = fakeCanvas();
  const record = {
    handle: 5n,
    ownerHandle: 100n,
    layerIndex: 0,
    color: (2 << 30) | 7,
    commonFlags: 0,
    kind: 0,
    flags: 1,
    insertionPoint: [105, 201, 0],
    alignmentPoint: [107, 201.5, 0],
    normal: [0, 0, 1],
    height: 1,
    widthFactor: 1,
    rotation: 0,
    obliqueAngle: 0,
    lineSpacingFactor: 1,
    sourceFlags: 0,
    horizontalAlignment: 1,
    verticalAlignment: 2,
    generationFlags: 0,
    attachment: 0,
    mtextType: 0,
    valueByteLength: 2,
    style: { fontFile: "arial.ttf", flags: 0, widthFactor: 1 },
  };
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: {
      length: 1,
      readDisplayRecord(_index, target) {
        Object.assign(target, record);
        target.insertionPoint = [...record.insertionPoint];
        target.alignmentPoint = [...record.alignmentPoint];
        target.normal = [...record.normal];
        return target;
      },
      readValue() {
        return "AB";
      },
    },
    blocks: [
      {
        index: 0,
        handle: 100n,
        name: "*Model_Space",
        basePoint: [0, 0, 0],
      },
    ],
    layers: [{ color: (2 << 30) | 7 }],
    instanceGraph: {
      instancesByBlock: new Map(),
      modelBlockIndices: new Set([0]),
    },
    glyphCache: { getGlyph: () => undefined },
    minimumPixelHeight: 0.1,
  });

  overlay.redraw(camera, [true]);

  assert.equal(canvas.calls.fillTextArguments[0][0], "A");
  assert.equal(canvas.calls.fillTextArguments[0][1], 0);
  assert.equal(Math.abs(canvas.calls.fillTextArguments[0][2]), 0);
  assert.equal(canvas.calls.fillTextArguments[1][0], "B");
  assert.equal(canvas.calls.fillTextArguments[1][1], 1);
  assert.equal(Math.abs(canvas.calls.fillTextArguments[1][2]), 0);
  assert.ok(
    canvas.calls.transforms.some(([a, b, c, d]) =>
      a === 80 && b === 0 && c === 0 && d === 40,
    ),
  );
});

test("uses MTEXT extents for middle-center attachment", () => {
  const canvas = fakeCanvas();
  const record = {
    handle: 6n,
    ownerHandle: 100n,
    layerIndex: 0,
    color: (2 << 30) | 7,
    commonFlags: 0,
    kind: 1,
    flags: 0,
    insertionPoint: [105, 201, 0],
    alignmentPoint: [0, 0, 0],
    normal: [0, 0, 1],
    height: 1,
    widthFactor: 1,
    rotation: 0,
    obliqueAngle: 0,
    rectangleWidth: 10,
    rectangleHeight: 4,
    extentsWidth: 10,
    extentsHeight: 4,
    lineSpacingFactor: 1,
    sourceFlags: 0,
    horizontalAlignment: 0,
    verticalAlignment: 0,
    generationFlags: 0,
    attachment: 5,
    mtextType: 0,
    valueByteLength: 2,
    style: { fontFile: "arial.ttf", flags: 0, widthFactor: 1 },
  };
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: {
      length: 1,
      readDisplayRecord(_index, target) {
        Object.assign(target, record);
        target.insertionPoint = [...record.insertionPoint];
        target.alignmentPoint = [...record.alignmentPoint];
        target.normal = [...record.normal];
        return target;
      },
      readValue() {
        return "AB";
      },
    },
    blocks: [
      {
        index: 0,
        handle: 100n,
        name: "*Model_Space",
        basePoint: [0, 0, 0],
      },
    ],
    layers: [{ color: (2 << 30) | 7 }],
    instanceGraph: {
      instancesByBlock: new Map(),
      modelBlockIndices: new Set([0]),
    },
    glyphCache: { getGlyph: () => undefined },
    minimumPixelHeight: 0.1,
  });

  overlay.redraw(camera, [true]);

  assert.deepEqual(canvas.calls.fillTextArguments[0], ["A", -1, -1]);
  assert.ok(
    canvas.calls.transforms.some(([a, b, c, d]) =>
      a === 200 && b === 0 && c === 0 && d === 40,
    ),
  );
});

test("draws cached SHX segments and obeys the frame segment cap", async () => {
  const scene = await textScene();
  const canvas = fakeCanvas();
  const glyph = Object.freeze({
    advance: 1,
    segmentCount: 1,
    vertices: new Float32Array([0, 0, 1, 0]),
  });
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: scene.textEntities,
    blocks: scene.metadata.blocks,
    layers: scene.metadata.layers,
    instanceGraph: scene.instanceGraph,
    glyphCache: { getGlyph: () => glyph },
    maximumSegments: 3,
    minimumPixelHeight: 0.1,
  });

  const metrics = overlay.redraw(camera, [true]);
  assert.equal(metrics.segments, 3);
  assert.equal(metrics.truncated, true);
  assert.equal(canvas.calls.lineTo, 3);
  assert.ok(canvas.calls.stroke > 0);
});

test("does not decode source strings that are outside the viewport", async () => {
  const scene = await textScene();
  const canvas = fakeCanvas();
  const readValue = scene.textEntities.readValue.bind(scene.textEntities);
  let decodedValues = 0;
  scene.textEntities.readValue = (index) => {
    decodedValues += 1;
    return readValue(index);
  };
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities: scene.textEntities,
    blocks: scene.metadata.blocks,
    layers: scene.metadata.layers,
    instanceGraph: scene.instanceGraph,
    glyphCache: { getGlyph: () => undefined },
    minimumPixelHeight: 0.1,
  });

  overlay.redraw(
    {
      origin: [1_000_000, 1_000_000, 0],
      worldWidth: 200,
      worldHeight: 150,
    },
    [true],
  );

  assert.equal(decodedValues, 0);
});

test("clips only text below a later WIPEOUT mask", () => {
  const canvas = fakeCanvas();
  const records = [
    {
      handle: 5n,
      ownerHandle: 100n,
      layerIndex: 0,
      color: (2 << 30) | 7,
      commonFlags: 0,
      kind: 0,
      insertionPoint: [105, 201, 0],
      normal: [0, 0, 1],
      height: 1,
      widthFactor: 1,
      rotation: 0,
      obliqueAngle: 0,
      lineSpacingFactor: 1,
      sourceFlags: 0,
      horizontalAlignment: 0,
      attachment: 0,
      mtextType: 0,
      valueByteLength: 3,
      style: null,
    },
    {
      handle: 15n,
      ownerHandle: 100n,
      layerIndex: 0,
      color: (2 << 30) | 7,
      commonFlags: 0,
      kind: 0,
      insertionPoint: [105, 201, 0],
      normal: [0, 0, 1],
      height: 1,
      widthFactor: 1,
      rotation: 0,
      obliqueAngle: 0,
      lineSpacingFactor: 1,
      sourceFlags: 0,
      horizontalAlignment: 0,
      attachment: 0,
      mtextType: 0,
      valueByteLength: 3,
      style: null,
    },
  ];
  const textEntities = {
    length: records.length,
    readDisplayRecord(index, target) {
      Object.assign(target, records[index]);
      target.insertionPoint = [...records[index].insertionPoint];
      target.normal = [...records[index].normal];
      return target;
    },
    readValue() {
      return "한";
    },
  };
  const maskOrder = {
    enabled: true,
    modelOwnerHandle: 100n,
    owners: new Map([
      [
        100n,
        {
          overrides: new Map(),
          events: [
            {
              kind: "mask",
              handle: 10n,
              key: 10n,
              prefix: 0,
              contribution: 1,
            },
          ],
        },
      ],
    ]),
    masks: [
      {
        handle: 10n,
        ownerHandle: 100n,
        layerIndex: 0,
        localBucket: 1,
        points: [
          [100, 196, 0],
          [110, 196, 0],
          [110, 206, 0],
          [100, 206, 0],
        ],
      },
    ],
  };
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities,
    blocks: [
      {
        index: 0,
        handle: 100n,
        name: "*Model_Space",
        basePoint: [0, 0, 0],
      },
    ],
    layers: [{ color: (2 << 30) | 7 }],
    instanceGraph: {
      instancesByBlock: new Map(),
      modelBlockIndices: new Set([0]),
    },
    glyphCache: { getGlyph: () => undefined },
    maskOrder,
    minimumPixelHeight: 0.1,
  });

  const metrics = overlay.redraw(camera, [true]);

  assert.equal(metrics.visibleOccurrences, 2);
  assert.equal(metrics.maskOccurrences, 1);
  assert.equal(metrics.clippedTextOccurrences, 1);
  assert.equal(metrics.maskClipOperations, 1);
  assert.deepEqual(canvas.calls.clips, ["evenodd"]);
  assert.equal(canvas.calls.saves, 1);
  assert.equal(canvas.calls.restores, 1);

  overlay.setMaskVisibility(false);
  const withoutMasks = overlay.redraw(camera, [true]);
  assert.equal(withoutMasks.maskOccurrences, 0);
  assert.equal(withoutMasks.clippedTextOccurrences, 0);
  assert.equal(withoutMasks.maskClipOperations, 0);
  assert.deepEqual(canvas.calls.clips, ["evenodd"]);
});

test("transforms and clips external ATTRIB text with its XREF root", () => {
  const canvas = fakeCanvas();
  const record = {
    handle: 5n,
    ownerHandle: 100n,
    layerIndex: 0,
    color: (2 << 30) | 7,
    commonFlags: 0,
    kind: 3,
    insertionPoint: [0, 0, 0],
    normal: [0, 0, 1],
    height: 1,
    widthFactor: 1,
    rotation: 0,
    obliqueAngle: 0,
    lineSpacingFactor: 1,
    sourceFlags: 0,
    horizontalAlignment: 0,
    attachment: 0,
    mtextType: 0,
    valueByteLength: 3,
    style: null,
  };
  const textEntities = {
    length: 1,
    readDisplayRecord(_index, target) {
      Object.assign(target, record);
      target.insertionPoint = [...record.insertionPoint];
      target.normal = [...record.normal];
      return target;
    },
    readValue() {
      return "한";
    },
  };
  const rootInstances = {
    data: translationMat4(100, 0, 0),
    maskBases: new Uint32Array([0]),
    clipIds: new Uint32Array([1]),
    count: 1,
    length: 1,
  };
  const overlay = new CanvasTextOverlay(canvas, {
    textEntities,
    blocks: [
      {
        index: 0,
        handle: 100n,
        name: "*Model_Space",
        basePoint: [0, 0, 0],
      },
    ],
    layers: [{ color: (2 << 30) | 7 }],
    instanceGraph: {
      instancesByBlock: new Map(),
      modelBlockIndices: new Set(),
      rootInstances,
      clipNodes: [
        createClipNode(1, 0, [
          [90, -10, 0],
          [110, -10, 0],
          [110, 10, 0],
          [90, 10, 0],
        ]),
      ],
    },
    glyphCache: { getGlyph: () => undefined },
    minimumPixelHeight: 0.1,
  });

  const metrics = overlay.redraw(
    {
      origin: [100, 0, 0],
      worldWidth: 20,
      worldHeight: 15,
    },
    [true],
  );

  assert.equal(metrics.visibleOccurrences, 1);
  assert.equal(metrics.xclipOccurrences, 1);
  assert.equal(metrics.xclipOperations, 1);
  assert.deepEqual(canvas.calls.clips, ["nonzero"]);
  assert.equal(canvas.calls.saves, 1);
  assert.equal(canvas.calls.restores, 1);
});

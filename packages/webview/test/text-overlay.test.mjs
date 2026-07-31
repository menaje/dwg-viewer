import assert from "node:assert/strict";
import test from "node:test";

import { buildInstanceGraph } from "../src/instance-graph.mjs";
import { MemoryRangeSource } from "../src/range-source.mjs";
import { SceneCacheReader } from "../src/scene-cache.mjs";
import {
  CanvasTextOverlay,
  plainCadTextLines,
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
  assert.equal(
    [...plainCadTextLines("한".repeat(5_000), false)[0]].length,
    4_096,
  );
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
});

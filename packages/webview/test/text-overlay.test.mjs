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
  };
  const context = {
    beginPath() {},
    clearRect() {},
    fillText(...arguments_) {
      calls.fillText += 1;
      calls.fillTextArguments.push(arguments_);
    },
    lineTo() {
      calls.lineTo += 1;
    },
    moveTo() {},
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

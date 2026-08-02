import assert from "node:assert/strict";
import test from "node:test";
import {
  collectComplexLinetypeSegments,
  VERTEX_STRIDE,
} from "../src/complex-linetype-overlay.mjs";
import { GpuLineBatchKind } from "../src/scene-cache.mjs";

function vertices(style = 3 << 5) {
  const buffer = new ArrayBuffer(VERTEX_STRIDE * 2);
  const view = new DataView(buffer);
  for (const [index, x, distance] of [
    [0, 0, 0],
    [1, 10, 10],
  ]) {
    const offset = index * VERTEX_STRIDE;
    view.setFloat32(offset, x, true);
    view.setUint32(offset + 12, 0, true);
    view.setUint32(offset + 16, (2 << 30) | 1, true);
    view.setUint32(offset + 28, style, true);
    view.setFloat32(offset + 32, distance, true);
  }
  return {
    buffer,
    byteLength: buffer.byteLength,
    vertexCount: 2,
    recordSize: VERTEX_STRIDE,
  };
}

const batch = Object.freeze({
  id: 0,
  kind: GpuLineBatchKind.ModelOverview,
  lodLevel: 0,
  firstVertex: 0,
  vertexCount: 2,
  origin: [100, 200, 0],
  bounds: { min: [100, 200, 0], max: [110, 200, 0] },
});

const complex = Object.freeze({
  code: 3,
  name: "UTILITY",
  flags: 1,
  patternLength: 5,
  dashes: Object.freeze([
    Object.freeze({
      flags: 10,
      length: -2,
      text: "HW",
      shapeCode: 0,
      textStyleIndex: 0,
      xOffset: 0,
      yOffset: 0,
      scale: 1,
      rotation: 0,
    }),
  ]),
});

test("collects bounded overview segments that use complex linetypes", () => {
  const result = collectComplexLinetypeSegments({
    vertices: vertices(),
    batches: [batch],
    linetypes: [complex],
    layers: [{ linetype: "Continuous" }],
  });

  assert.equal(result.sourceSegments, 1);
  assert.deepEqual(result.groups[0].segments[0].start, [100, 200, 0]);
  assert.deepEqual(result.groups[0].segments[0].end, [110, 200, 0]);
  assert.equal(result.groups[0].segments[0].linetypeCode, 3);
  assert.equal(result.truncated, false);
});

test("resolves ByLayer complex patterns and enforces the source cap", () => {
  const result = collectComplexLinetypeSegments({
    vertices: vertices(0),
    batches: [batch],
    linetypes: [
      complex,
      { code: 2, flags: 0, name: "Continuous", dashes: [] },
    ],
    layers: [{ linetype: "" }],
    maximumSegments: 1,
  });
  assert.equal(result.sourceSegments, 0);

  const byLayer = collectComplexLinetypeSegments({
    vertices: vertices(0),
    batches: [batch],
    linetypes: [
      complex,
      { code: 2, flags: 0, name: "Continuous", dashes: [] },
    ],
    layers: [{ linetype: "UTILITY" }],
    maximumSegments: 1,
  });
  assert.equal(byLayer.sourceSegments, 1);
});

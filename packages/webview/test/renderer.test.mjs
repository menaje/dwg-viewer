import assert from "node:assert/strict";
import test from "node:test";

import {
  patchLineMaskBuckets,
  WebGlLineRenderer,
} from "../src/renderer.mjs";
import { decodeMaskBucket } from "../src/mask-order.mjs";
import { GpuLineBatchKind } from "../src/scene-cache.mjs";

function makeFakeGl() {
  let nextId = 0;
  const calls = {
    bufferData: [],
    drawArraysInstanced: [],
    deletedBuffers: [],
    shaderSources: [],
    depthFunc: [],
  };
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    DYNAMIC_DRAW: 7,
    FLOAT: 8,
    UNSIGNED_INT: 9,
    TEXTURE0: 10,
    TEXTURE_2D: 11,
    TEXTURE_MIN_FILTER: 12,
    TEXTURE_MAG_FILTER: 13,
    TEXTURE_WRAP_S: 14,
    TEXTURE_WRAP_T: 15,
    NEAREST: 16,
    CLAMP_TO_EDGE: 17,
    RGBA: 18,
    UNSIGNED_BYTE: 19,
    COLOR_BUFFER_BIT: 20,
    DEPTH_BUFFER_BIT: 1 << 8,
    DEPTH_TEST: 21,
    BLEND: 22,
    SRC_ALPHA: 23,
    ONE_MINUS_SRC_ALPHA: 24,
    LINES: 25,
    TRIANGLES: 26,
    POINTS: 27,
    GEQUAL: 28,
    createShader: () => ({ id: ++nextId }),
    shaderSource(_shader, source) {
      calls.shaderSources.push(source);
    },
    compileShader() {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => "",
    deleteShader() {},
    createProgram: () => ({ id: ++nextId }),
    attachShader() {},
    linkProgram() {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    deleteProgram() {},
    createBuffer: () => ({ id: ++nextId }),
    createTexture: () => ({ id: ++nextId }),
    createVertexArray: () => ({ id: ++nextId }),
    getUniformLocation: (_program, name) => ({ name }),
    activeTexture() {},
    bindTexture() {},
    texParameteri() {},
    texImage2D() {},
    bindVertexArray() {},
    bindBuffer() {},
    bufferData(_target, value, usage) {
      calls.bufferData.push({
        buffer: ArrayBuffer.isView(value) ? value.buffer : value,
        byteLength: value.byteLength,
        usage,
      });
    },
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    vertexAttribIPointer() {},
    vertexAttribDivisor() {},
    deleteVertexArray() {},
    deleteBuffer(buffer) {
      calls.deletedBuffers.push(buffer.id);
    },
    viewport() {},
    clearColor() {},
    clearDepth() {},
    clear() {},
    depthFunc(value) {
      calls.depthFunc.push(value);
    },
    depthMask() {},
    disable() {},
    enable() {},
    blendFunc() {},
    useProgram() {},
    uniformMatrix4fv() {},
    uniform1i() {},
    uniform1f() {},
    drawArraysInstanced(mode, first, count, instances) {
      calls.drawArraysInstanced.push({ mode, first, count, instances });
    },
    deleteTexture() {},
  };
  return { gl, calls };
}

function oneMaskPlan() {
  return Object.freeze({
    enabled: true,
    modelOwnerHandle: 100n,
    owners: new Map([
      [
        100n,
        {
          ownerHandle: 100n,
          overrides: new Map(),
          events: Object.freeze([
            Object.freeze({
              kind: "mask",
              handle: 10n,
              key: 10n,
              prefix: 0,
              contribution: 1,
            }),
          ]),
        },
      ],
    ]),
  });
}

function batch({ id, kind, lodLevel, firstVertex }) {
  return {
    id,
    kind,
    lodLevel,
    firstVertex,
    vertexCount: 2,
    blockIndex: null,
    origin: [0, 0, 0],
    bounds: { min: [0, 0, 0], max: [1, 1, 0] },
  };
}

test("redraws overview and independently uploaded detail vertex ranges", () => {
  const { gl, calls } = makeFakeGl();
  const canvas = {
    clientWidth: 200,
    clientHeight: 100,
    width: 0,
    height: 0,
    getContext(name) {
      return name === "webgl2" ? gl : null;
    },
  };
  const renderer = new WebGlLineRenderer(canvas);
  const overview = batch({
    id: 0,
    kind: GpuLineBatchKind.ModelOverview,
    lodLevel: 0,
    firstVertex: 0,
  });
  const detail = batch({
    id: 1,
    kind: GpuLineBatchKind.ModelDetail,
    lodLevel: 1,
    firstVertex: 2,
  });
  const first = renderer.renderOverview({
    batches: [overview, detail],
    layers: [
      { color: 0, flags: 0 },
      { color: 0, flags: 1 },
    ],
    instanceGraph: { instancesByBlock: new Map() },
    vertices: {
      buffer: new ArrayBuffer(64),
      byteLength: 64,
      vertexCount: 2,
    },
  });

  assert.equal(first.drawCalls, 1);
  assert.equal(first.instanceScratchBytes, 68);
  assert.equal(first.instanceBufferBytes, 68);
  assert.equal(first.layerTextureBytes, 8);
  assert.equal(first.gpuTrackedBytes, 140);
  assert.deepEqual(renderer.getLayerVisibility(), [true, false]);
  renderer.setLayerVisibility(1, true);
  assert.deepEqual(renderer.getLayerVisibility(), [true, true]);
  assert.throws(() => renderer.setLayerVisibility(2, true), /invalid layer/);
  renderer.setAllLayersVisible(false);
  assert.deepEqual(renderer.getLayerVisibility(), [false, false]);
  assert.ok(
    calls.shaderSources.some((source) =>
      source.includes("v_layerIndex < uint(u_layerCount)"),
    ),
  );
  renderer.setAllLayersVisible(true);
  assert.deepEqual(calls.drawArraysInstanced.at(-1), {
    mode: gl.LINES,
    first: 0,
    count: 2,
    instances: 1,
  });

  renderer.addDetailBatch(detail, {
    buffer: new ArrayBuffer(64),
    byteLength: 64,
    vertexCount: 2,
  });
  renderer.setDetailSelections([
    { batch: detail, instanceIndices: null },
  ]);
  const redrawn = renderer.redraw(first.camera);

  assert.equal(redrawn.drawCalls, 2);
  assert.equal(redrawn.detailBatches, 1);
  assert.equal(redrawn.cachedDetailGpuBytes, 64);
  assert.equal(redrawn.instanceScratchBytes, 68);
  assert.equal(redrawn.gpuTrackedBytes, 204);
  assert.equal(redrawn.peakGpuTrackedBytes, 204);
  const instanceUploads = calls.bufferData.filter(
    (call) => call.usage === gl.DYNAMIC_DRAW,
  );
  assert.ok(instanceUploads.length >= 3);
  assert.equal(
    new Set(instanceUploads.map((call) => call.buffer)).size,
    1,
    "all instance draws must reuse one bounded backing buffer",
  );
  assert.deepEqual(calls.drawArraysInstanced.slice(-2), [
    { mode: gl.LINES, first: 0, count: 2, instances: 1 },
    { mode: gl.LINES, first: 0, count: 2, instances: 1 },
  ]);

  assert.equal(renderer.deleteDetailBatch(detail.id), true);
  renderer.dispose();
});

test("draws HATCH fills then patterns before boundary geometry", () => {
  const { gl, calls } = makeFakeGl();
  const canvas = {
    clientWidth: 200,
    clientHeight: 100,
    width: 0,
    height: 0,
    getContext(name) {
      return name === "webgl2" ? gl : null;
    },
  };
  const renderer = new WebGlLineRenderer(canvas);
  const overview = batch({
    id: 0,
    kind: GpuLineBatchKind.ModelOverview,
    lodLevel: 0,
    firstVertex: 0,
  });
  const first = renderer.renderOverview({
    batches: [overview],
    layers: [{ color: 0, flags: 0 }],
    instanceGraph: { instancesByBlock: new Map() },
    vertices: {
      buffer: new ArrayBuffer(64),
      byteLength: 64,
      vertexCount: 2,
    },
  });
  renderer.setHatchFills({
    batches: [
      {
        id: 0,
        kind: GpuLineBatchKind.ModelDetail,
        lodLevel: 1,
        firstVertex: 0,
        vertexCount: 3,
        blockIndex: null,
        origin: [0, 0, 0],
        bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      },
    ],
    vertices: {
      buffer: new ArrayBuffer(96),
      byteLength: 96,
      vertexCount: 3,
    },
    metrics: { triangles: 1 },
  });
  renderer.setHatchPatterns({
    batches: [
      {
        id: 0,
        kind: GpuLineBatchKind.ModelDetail,
        lodLevel: 1,
        firstVertex: 0,
        vertexCount: 2,
        blockIndex: null,
        origin: [0, 0, 0],
        bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      },
    ],
    vertices: {
      buffer: new ArrayBuffer(64),
      byteLength: 64,
      vertexCount: 2,
    },
    metrics: { segments: 1 },
  });

  const redrawn = renderer.redraw(first.camera);

  assert.equal(redrawn.hatchFillDrawCalls, 1);
  assert.equal(redrawn.hatchFillSubmittedVertices, 3);
  assert.equal(redrawn.hatchFillGpuBytes, 96);
  assert.equal(redrawn.hatchPatternDrawCalls, 1);
  assert.equal(redrawn.hatchPatternSubmittedVertices, 2);
  assert.equal(redrawn.hatchPatternGpuBytes, 64);
  assert.equal(redrawn.gpuVertexBytes, 224);
  assert.deepEqual(calls.drawArraysInstanced.slice(-3), [
    { mode: gl.TRIANGLES, first: 0, count: 3, instances: 1 },
    { mode: gl.LINES, first: 0, count: 2, instances: 1 },
    { mode: gl.LINES, first: 0, count: 2, instances: 1 },
  ]);
  renderer.dispose();
});

test("draws deferred SOLID fills and outlines before POINT markers", () => {
  const { gl, calls } = makeFakeGl();
  const canvas = {
    clientWidth: 200,
    clientHeight: 100,
    width: 0,
    height: 0,
    getContext(name) {
      return name === "webgl2" ? gl : null;
    },
  };
  const renderer = new WebGlLineRenderer(canvas);
  const overview = batch({
    id: 0,
    kind: GpuLineBatchKind.ModelOverview,
    lodLevel: 0,
    firstVertex: 0,
  });
  const first = renderer.renderOverview({
    batches: [overview],
    layers: [{ color: 0, flags: 0 }],
    instanceGraph: {
      instancesByBlock: new Map(),
      modelBlockIndices: new Set(),
    },
    vertices: {
      buffer: new ArrayBuffer(64),
      byteLength: 64,
      vertexCount: 2,
    },
  });
  const makePrimitiveBatch = (vertexCount) => ({
    id: 0,
    kind: GpuLineBatchKind.ModelDetail,
    lodLevel: 1,
    firstVertex: 0,
    vertexCount,
    blockIndex: null,
    origin: [0, 0, 0],
    bounds: { min: [0, 0, 0], max: [1, 1, 0] },
  });
  renderer.setPrimitiveMeshes({
    points: {
      batches: [makePrimitiveBatch(1)],
      vertices: {
        buffer: new ArrayBuffer(32),
        byteLength: 32,
        vertexCount: 1,
      },
    },
    solidFills: {
      batches: [makePrimitiveBatch(3)],
      vertices: {
        buffer: new ArrayBuffer(96),
        byteLength: 96,
        vertexCount: 3,
      },
    },
    solidOutlines: {
      batches: [makePrimitiveBatch(2)],
      vertices: {
        buffer: new ArrayBuffer(64),
        byteLength: 64,
        vertexCount: 2,
      },
    },
    metrics: { sourcePoints: 1, sourceSolids: 1, gpuBytes: 192 },
  });

  const redrawn = renderer.redraw(first.camera);

  assert.equal(redrawn.solidFillDrawCalls, 1);
  assert.equal(redrawn.solidOutlineDrawCalls, 1);
  assert.equal(redrawn.pointDrawCalls, 1);
  assert.equal(redrawn.solidFillGpuBytes, 96);
  assert.equal(redrawn.solidOutlineGpuBytes, 64);
  assert.equal(redrawn.pointGpuBytes, 32);
  assert.equal(redrawn.gpuVertexBytes, 256);
  assert.deepEqual(calls.drawArraysInstanced.slice(-4), [
    { mode: gl.TRIANGLES, first: 0, count: 3, instances: 1 },
    { mode: gl.LINES, first: 0, count: 2, instances: 1 },
    { mode: gl.LINES, first: 0, count: 2, instances: 1 },
    { mode: gl.POINTS, first: 0, count: 1, instances: 1 },
  ]);
  assert.ok(
    calls.shaderSources.some((source) =>
      source.includes("gl_PointCoord"),
    ),
  );
  renderer.dispose();
});

test("patches line buckets and draws WIPEOUT masks before depth-tested geometry", () => {
  const { gl, calls } = makeFakeGl();
  const canvas = {
    clientWidth: 200,
    clientHeight: 100,
    width: 0,
    height: 0,
    getContext(name) {
      return name === "webgl2" ? gl : null;
    },
  };
  const renderer = new WebGlLineRenderer(canvas);
  const overview = batch({
    id: 0,
    kind: GpuLineBatchKind.ModelOverview,
    lodLevel: 0,
    firstVertex: 0,
  });
  const overviewBuffer = new ArrayBuffer(64);
  const overviewView = new DataView(overviewBuffer);
  overviewView.setUint32(20, 5, true);
  overviewView.setUint32(52, 15, true);
  const blocks = [
    {
      index: 0,
      handle: 100n,
      name: "*Model_Space",
      basePoint: [0, 0, 0],
    },
  ];
  const initialGraph = {
    instancesByBlock: new Map(),
    modelBlockIndices: new Set([0]),
  };
  const first = renderer.renderOverview({
    batches: [overview],
    layers: [{ color: 0, flags: 0 }],
    blocks,
    instanceGraph: initialGraph,
    vertices: {
      buffer: overviewBuffer,
      byteLength: 64,
      vertexCount: 2,
    },
  });
  const maskOrder = oneMaskPlan();
  const orderedGraph = {
    ...initialGraph,
    maskOrderEnabled: true,
  };
  renderer.setMaskComposition({
    maskOrder,
    instanceGraph: orderedGraph,
    blocks,
    overviewVertices: {
      buffer: overviewBuffer,
      byteLength: 64,
      vertexCount: 2,
    },
  });
  assert.equal(decodeMaskBucket(overviewView.getUint32(28, true)), 0);
  assert.equal(decodeMaskBucket(overviewView.getUint32(60, true)), 1);

  const empty = {
    batches: [],
    vertices: {
      buffer: new ArrayBuffer(0),
      byteLength: 0,
      vertexCount: 0,
    },
  };
  renderer.setPrimitiveMeshes({
    points: empty,
    solidFills: empty,
    solidOutlines: empty,
    wipeoutMasks: {
      batches: [
        {
          ...overview,
          vertexCount: 3,
          firstVertex: 0,
          lodLevel: 1,
        },
      ],
      vertices: {
        buffer: new ArrayBuffer(96),
        byteLength: 96,
        vertexCount: 3,
      },
    },
  });
  const redrawn = renderer.redraw(first.camera);

  assert.equal(redrawn.wipeoutMaskDrawCalls, 1);
  assert.equal(redrawn.wipeoutMaskSubmittedVertices, 3);
  assert.equal(redrawn.wipeoutMaskGpuBytes, 96);
  assert.equal(calls.depthFunc.at(-1), gl.GEQUAL);
  assert.deepEqual(calls.drawArraysInstanced.slice(-2), [
    { mode: gl.TRIANGLES, first: 0, count: 3, instances: 1 },
    { mode: gl.LINES, first: 0, count: 2, instances: 1 },
  ]);
  assert.ok(
    calls.shaderSources.some((source) =>
      source.includes("a_maskBase + float(a_style >> 17u)"),
    ),
  );
  renderer.dispose();
});

test("patches a bounded detail buffer using its global vertex range", () => {
  const buffer = new ArrayBuffer(64);
  const view = new DataView(buffer);
  view.setUint32(20, 5, true);
  view.setUint32(52, 15, true);
  patchLineMaskBuckets(
    buffer,
    [
      {
        ...batch({
          id: 9,
          kind: GpuLineBatchKind.ModelDetail,
          lodLevel: 1,
          firstVertex: 20,
        }),
      },
    ],
    oneMaskPlan(),
    [{ index: 0, handle: 100n, name: "*Model_Space" }],
    20,
  );

  assert.equal(decodeMaskBucket(view.getUint32(28, true)), 0);
  assert.equal(decodeMaskBucket(view.getUint32(60, true)), 1);
});

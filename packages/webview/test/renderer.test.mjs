import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateOverviewBounds,
  makeClipTexturePayload,
  patchCurveReplacementMarkers,
  patchLineMaskBuckets,
  selectInteractiveInstanceIndices,
  WebGlLineRenderer,
} from "../src/renderer.mjs";
import { curveRefinementCameraKey } from "../src/curve-contract.mjs";
import { decodeMaskBucket } from "../src/mask-order.mjs";
import { GpuLineBatchKind } from "../src/scene-cache.mjs";
import { createClipNode } from "../src/instance-graph.mjs";
import { identityMat4 } from "../src/math.mjs";

function makeFakeGl() {
  let nextId = 0;
  let unpackAlignment = 4;
  const calls = {
    bufferData: [],
    drawArraysInstanced: [],
    deletedBuffers: [],
    shaderSources: [],
    bufferSubData: [],
    depthFunc: [],
    pixelStorei: [],
    texImage2D: [],
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
    TEXTURE3: 29,
    TEXTURE4: 33,
    TEXTURE5: 34,
    TEXTURE6: 35,
    TEXTURE_2D: 11,
    TEXTURE_MIN_FILTER: 12,
    TEXTURE_MAG_FILTER: 13,
    TEXTURE_WRAP_S: 14,
    TEXTURE_WRAP_T: 15,
    NEAREST: 16,
    CLAMP_TO_EDGE: 17,
    RGBA: 18,
    R16I: 30,
    RED_INTEGER: 31,
    SHORT: 32,
    R16UI: 36,
    R8UI: 40,
    R32F: 37,
    RED: 38,
    UNSIGNED_SHORT: 39,
    UNSIGNED_BYTE: 19,
    UNPACK_ALIGNMENT: 41,
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
    texImage2D(...arguments_) {
      calls.texImage2D.push(arguments_);
    },
    getParameter(parameter) {
      return parameter === gl.UNPACK_ALIGNMENT ? unpackAlignment : null;
    },
    pixelStorei(parameter, value) {
      if (parameter === gl.UNPACK_ALIGNMENT) {
        unpackAlignment = value;
      }
      calls.pixelStorei.push({ parameter, value });
    },
    bindVertexArray() {},
    bindBuffer() {},
    bufferData(_target, value, usage) {
      calls.bufferData.push({
        buffer: ArrayBuffer.isView(value) ? value.buffer : value,
        byteLength: value.byteLength,
        usage,
      });
    },
    bufferSubData(_target, offset, value) {
      calls.bufferSubData.push({
        offset,
        byteLength: value.byteLength,
      });
    },
    enableVertexAttribArray() {},
    disableVertexAttribArray() {},
    vertexAttrib1f() {},
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
    uniform2f() {},
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

test("limits fitted bounds and packs camera-relative INSERT clips", () => {
  const clipNodes = [
    createClipNode(1, 0, [
      [10, 20, 0],
      [30, 20, 0],
      [30, 40, 0],
      [10, 40, 0],
    ]),
  ];
  const instanceGraph = {
    instancesByBlock: new Map([
      [
        1,
        {
          data: identityMat4(),
          clipIds: new Uint32Array([1]),
          count: 1,
          length: 1,
        },
      ],
    ]),
    clipNodes,
  };
  const clippedBatch = {
    ...batch({
      id: 0,
      kind: GpuLineBatchKind.BlockDefinition,
      lodLevel: 0,
      firstVertex: 0,
    }),
    blockIndex: 1,
    bounds: { min: [0, 0, 0], max: [100, 100, 0] },
  };

  assert.deepEqual(calculateOverviewBounds([clippedBatch], instanceGraph), {
    min: [10, 20, 0],
    max: [30, 40, 0],
  });
  const payload = makeClipTexturePayload(instanceGraph, {
    origin: [10, 20, 0],
  });
  assert.equal(payload.nodeCount, 1);
  assert.deepEqual([...payload.data.slice(4, 6)], [0, 0]);
});

test("culls offscreen and sub-pixel instances during interaction", () => {
  const matrices = new Float64Array(32);
  matrices.set(identityMat4(), 0);
  matrices.set(identityMat4(), 16);
  matrices[28] = 100;
  matrices[29] = 100;
  const instanceGraph = {
    instancesByBlock: new Map([
      [
        1,
        {
          data: matrices,
          count: 2,
          length: 2,
        },
      ],
    ]),
  };
  const camera = {
    origin: [0, 0, 0],
    worldWidth: 20,
    worldHeight: 10,
    width: 200,
    height: 100,
  };
  const visible = selectInteractiveInstanceIndices(
    {
      ...batch({
        id: 0,
        kind: GpuLineBatchKind.BlockDefinition,
        lodLevel: 0,
        firstVertex: 0,
      }),
      blockIndex: 1,
    },
    instanceGraph,
    camera,
  );
  const tiny = selectInteractiveInstanceIndices(
    {
      ...batch({
        id: 1,
        kind: GpuLineBatchKind.BlockDefinition,
        lodLevel: 0,
        firstVertex: 0,
      }),
      blockIndex: 1,
      bounds: {
        min: [0, 0, 0],
        max: [0.001, 0.001, 0],
      },
    },
    instanceGraph,
    camera,
  );

  assert.deepEqual([...visible], [0]);
  assert.deepEqual([...tiny], []);
});

test("culls offscreen layout instances in a full-quality redraw", () => {
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
  const matrices = new Float64Array(32);
  matrices.set(identityMat4(), 0);
  matrices.set(identityMat4(), 16);
  matrices[28] = 100;
  matrices[29] = 100;
  const renderer = new WebGlLineRenderer(canvas);
  const rendered = renderer.renderOverview({
    batches: [
      batch({
        id: 0,
        kind: GpuLineBatchKind.ModelOverview,
        lodLevel: 0,
        firstVertex: 0,
      }),
    ],
    layers: [{ color: 0, flags: 0 }],
    instanceGraph: {
      instancesByBlock: new Map(),
      modelInstances: {
        data: matrices,
        count: 2,
        length: 2,
      },
    },
    vertices: {
      buffer: new ArrayBuffer(72),
      byteLength: 72,
      vertexCount: 2,
    },
    preferredView: {
      center: [0, 0, 0],
      height: 10,
    },
  });

  assert.equal(rendered.interactive, false);
  assert.equal(rendered.submittedInstances, 1);
  assert.deepEqual(calls.drawArraysInstanced.at(-1), {
    mode: gl.LINES,
    first: 0,
    count: 2,
    instances: 1,
  });
  renderer.dispose();
});

test("uploads odd-width viewport visibility rows without WebGL padding", () => {
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
  const layers = Array.from({ length: 70 }, () => ({
    color: 0,
    flags: 0,
    lineWeight: -3,
  }));
  const allVisible = new Uint8Array(70).fill(1);
  const viewportVisible = new Uint8Array(allVisible);
  viewportVisible[69] = 0;

  renderer.renderOverview({
    batches: [
      batch({
        id: 0,
        kind: GpuLineBatchKind.ModelOverview,
        lodLevel: 0,
        firstVertex: 0,
      }),
    ],
    layers,
    instanceGraph: {
      instancesByBlock: new Map(),
      layerVisibilityRows: [allVisible, viewportVisible],
    },
    vertices: {
      buffer: new ArrayBuffer(72),
      byteLength: 72,
      vertexCount: 2,
    },
  });

  const integerByteUploads = calls.texImage2D.filter(
    (arguments_) => arguments_[2] === gl.R8UI,
  );
  assert.equal(integerByteUploads.length, 2);
  assert.equal(integerByteUploads[1][3], 70);
  assert.equal(integerByteUploads[1][4], 2);
  assert.equal(integerByteUploads[1][8].byteLength, 140);
  assert.deepEqual(
    calls.pixelStorei.map(({ value }) => value),
    [1, 4, 1, 4],
  );
  renderer.dispose();
});

test("uses the saved model view without expanding to distant geometry", () => {
  const { gl } = makeFakeGl();
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
  const overview = {
    ...batch({
      id: 0,
      kind: GpuLineBatchKind.ModelOverview,
      lodLevel: 0,
      firstVertex: 0,
    }),
    bounds: {
      min: [-1_000_000, -1_000_000, 0],
      max: [1_000_000, 1_000_000, 0],
    },
  };
  const first = renderer.renderOverview({
    batches: [overview],
    layers: [{ color: 0, flags: 0 }],
    instanceGraph: { instancesByBlock: new Map() },
    vertices: {
      buffer: new ArrayBuffer(72),
      byteLength: 72,
      vertexCount: 2,
    },
    preferredView: {
      center: [1_903_111.95, -372_937.28, 0],
      height: 144_557.99,
    },
  });

  assert.deepEqual(first.camera.origin, [
    1_903_111.95,
    -372_937.28,
    0,
  ]);
  assert.equal(first.camera.worldHeight, 144_557.99);
  assert.deepEqual(renderer.fitCamera().origin, first.camera.origin);
  assert.equal(renderer.fitCamera().worldHeight, first.camera.worldHeight);
  assert.deepEqual(renderer.fitAllCamera().origin, [0, 0, 0]);
  assert.equal(renderer.fitAllCamera().worldHeight, 2_160_000);
  renderer.setInstanceGraph(
    { instancesByBlock: new Map() },
    {
      preferredBounds: {
        min: [-100, -50, 0],
        max: [700, 550, 0],
      },
      preferredView: {
        center: [1_903_111.95, -372_937.28, 0],
        height: 144_557.99,
      },
    },
  );
  assert.deepEqual(renderer.overviewScene.bounds, overview.bounds);
  assert.deepEqual(renderer.fitAllCamera().origin, [300, 250, 0]);
  assert.equal(renderer.fitAllCamera().worldHeight, 648);
  renderer.dispose();
});

test("renders and fits a drawing whose only drawable content is an IMAGE", () => {
  const { gl } = makeFakeGl();
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
  const rendered = renderer.renderOverview({
    batches: [],
    layers: [{ color: 0, flags: 0 }],
    instanceGraph: { instancesByBlock: new Map() },
    vertices: {
      buffer: new ArrayBuffer(0),
      byteLength: 0,
      vertexCount: 0,
    },
    supplementalBounds: {
      min: [10, 20, 0],
      max: [110, 70, 0],
    },
  });

  assert.deepEqual(rendered.camera.origin, [60, 45, 0]);
  assert.equal(rendered.camera.worldHeight, 54);
  renderer.setSupplementalBounds("image:xref", {
    min: [-90, -30, 0],
    max: [-40, 10, 0],
  });
  assert.deepEqual(renderer.fitAllCamera().origin, [10, 20, 0]);
  assert.equal(renderer.fitAllCamera().worldHeight, 108);
  renderer.dispose();
});

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
      buffer: new ArrayBuffer(72),
      byteLength: 72,
      vertexCount: 2,
    },
  });

  assert.equal(first.drawCalls, 1);
  assert.equal(first.instanceScratchBytes, 92);
  assert.equal(first.instanceBufferBytes, 92);
  assert.equal(first.layerTextureBytes, 8);
  assert.equal(first.lineWeightTextureBytes, 4);
  assert.equal(first.plotStyleTextureBytes, 514);
  assert.equal(first.aciTextureBytes, 1_024);
  assert.equal(first.clipTextureBytes, 16);
  assert.equal(first.viewportLayerVisibilityTextureBytes, 2);
  assert.equal(first.gpuTrackedBytes, 1_788);
  assert.deepEqual(renderer.getLayerVisibility(), [true, false]);
  renderer.setLayerVisibility(1, true);
  assert.deepEqual(renderer.getLayerVisibility(), [true, true]);
  assert.throws(() => renderer.setLayerVisibility(2, true), /invalid layer/);
  renderer.setAllLayersVisible(false);
  assert.deepEqual(renderer.getLayerVisibility(), [false, false]);
  assert.ok(
    calls.shaderSources.some((source) =>
      source.includes("resolvedLayerIndex() < uint(u_layerCount)"),
    ),
  );
  assert.ok(
    calls.shaderSources.some((source) =>
      source.includes("outsideInsertClips"),
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
    buffer: new ArrayBuffer(72),
    byteLength: 72,
    vertexCount: 2,
  });
  renderer.setDetailSelections([
    { batch: detail, instanceIndices: null },
  ]);
  const redrawn = renderer.redraw(first.camera);

  assert.equal(redrawn.drawCalls, 2);
  assert.equal(redrawn.detailBatches, 1);
  assert.equal(redrawn.cachedDetailGpuBytes, 72);
  assert.equal(redrawn.instanceScratchBytes, 92);
  assert.equal(redrawn.gpuTrackedBytes, 1_860);
  assert.equal(redrawn.peakGpuTrackedBytes, 1_860);
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

test("replaces only marked coarse curves for the matching stable camera", () => {
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
  const overviewBuffer = new ArrayBuffer(72);
  const overviewView = new DataView(overviewBuffer);
  for (let vertex = 0; vertex < 2; vertex += 1) {
    const offset = vertex * 36;
    overviewView.setFloat32(offset, vertex, true);
    overviewView.setUint32(offset + 12, 0, true);
    overviewView.setUint32(offset + 16, (2 << 30) | 7, true);
    overviewView.setUint32(offset + 20, 77, true);
    overviewView.setUint32(offset + 28, (5 << 17) | (1 << 21), true);
    overviewView.setFloat32(offset + 32, vertex, true);
  }
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
      buffer: overviewBuffer,
      byteLength: 72,
      vertexCount: 2,
      recordSize: 36,
    },
  });
  const refinedBuffer = overviewBuffer.slice(0);
  renderer.setCurveRefinement({
    entries: [
      {
        batch: {
          ...overview,
          id: 0,
          kind: GpuLineBatchKind.ModelDetail,
          firstVertex: 0,
          instanceIndices: null,
        },
        vertices: {
          buffer: refinedBuffer,
          byteLength: 72,
          vertexCount: 2,
        },
      },
    ],
    refinedHandleWords: new Uint32Array([77, 0]),
    cameraKey: curveRefinementCameraKey(first.camera),
    metrics: { refined: 1 },
  });

  assert.equal(overviewView.getFloat32(32, true), -1);
  assert.equal(overviewView.getFloat32(68, true), -2);
  assert.equal(calls.bufferSubData.at(-1).byteLength, 72);
  const stable = renderer.redraw(first.camera);
  assert.equal(stable.curveRefinementActive, true);
  assert.equal(stable.curveRefinementDrawCalls, 1);
  assert.equal(stable.curveRefinementGpuBytes, 72);
  const interactive = renderer.redraw(first.camera, {
    interactive: true,
  });
  assert.equal(interactive.curveRefinementActive, false);
  assert.equal(interactive.curveRefinementDrawCalls, 0);
  const moved = renderer.redraw({
    ...first.camera,
    origin: [first.camera.origin[0] + 1, first.camera.origin[1], 0],
  });
  assert.equal(moved.curveRefinementActive, false);

  renderer.clearCurveRefinement();
  assert.equal(overviewView.getFloat32(32, true), 0);
  assert.equal(overviewView.getFloat32(68, true), 1);
  assert.ok(
    calls.shaderSources.some((source) =>
      source.includes("u_curveReplacementEnabled"),
    ),
  );
  renderer.dispose();
});

test("curve replacement markers preserve style bits and round-trip distances", () => {
  const buffer = new ArrayBuffer(72);
  const view = new DataView(buffer);
  for (let vertex = 0; vertex < 2; vertex += 1) {
    const offset = vertex * 36;
    view.setUint32(offset + 20, 0x89abcdef, true);
    view.setUint32(offset + 24, 0x01234567, true);
    view.setUint32(offset + 28, 0xdeadbeef, true);
    view.setFloat32(offset + 32, vertex * 2.5, true);
  }
  const handle =
    0x89abcdefn | (0x01234567n << 32n);

  assert.equal(
    patchCurveReplacementMarkers(buffer, new Set([handle])),
    true,
  );
  assert.deepEqual(
    [view.getFloat32(32, true), view.getFloat32(68, true)],
    [-1, -3.5],
  );
  assert.equal(view.getUint32(28, true), 0xdeadbeef);
  assert.equal(
    patchCurveReplacementMarkers(buffer, new Set()),
    true,
  );
  assert.deepEqual(
    [view.getFloat32(32, true), view.getFloat32(68, true)],
    [0, 2.5],
  );
  assert.equal(view.getUint32(28, true), 0xdeadbeef);
});

test("draws independently cached XREF overview and detail geometry", () => {
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
  const renderer = new WebGlLineRenderer(canvas, {
    maximumExternalOverviewBytes: 72,
    maximumExternalDetailBytes: 72,
  });
  const root = batch({
    id: 0,
    kind: GpuLineBatchKind.ModelOverview,
    lodLevel: 0,
    firstVertex: 0,
  });
  renderer.renderOverview({
    batches: [root],
    layers: [{ color: 0, flags: 0 }],
    instanceGraph: { instancesByBlock: new Map() },
    vertices: {
      buffer: new ArrayBuffer(72),
      byteLength: 72,
      vertexCount: 2,
    },
  });
  const externalOverview = {
    ...batch({
      id: 0,
      kind: GpuLineBatchKind.BlockDefinition,
      lodLevel: 0,
      firstVertex: 0,
    }),
    blockIndex: 9,
    bounds: { min: [20, 0, 0], max: [21, 1, 0] },
  };
  const externalDetail = {
    ...batch({
      id: 1,
      kind: GpuLineBatchKind.BlockDefinition,
      lodLevel: 1,
      firstVertex: 2,
    }),
    blockIndex: 9,
    bounds: { min: [20, 0, 0], max: [22, 1, 0] },
  };
  const matrices = new Float64Array(16);
  matrices[0] = 1;
  matrices[5] = 1;
  matrices[10] = 1;
  matrices[15] = 1;
  const instanceGraph = {
    instancesByBlock: new Map([
      [9, { data: matrices, count: 1, length: 1 }],
    ]),
  };
  const external = renderer.addExternalOverview({
    id: "xref-1",
    batches: [externalOverview, externalDetail],
    instanceGraph,
    vertices: {
      buffer: new ArrayBuffer(72),
      byteLength: 72,
      vertexCount: 2,
    },
  });
  renderer.addExternalDetailBatch("xref-1", externalDetail, {
    buffer: new ArrayBuffer(72),
    byteLength: 72,
    vertexCount: 2,
  });
  assert.throws(
    () =>
      renderer.addExternalOverview({
        id: "xref-2",
        batches: [externalOverview],
        instanceGraph,
        vertices: {
          buffer: new ArrayBuffer(72),
          byteLength: 72,
          vertexCount: 2,
        },
      }),
    /external overview GPU data exceeds/,
  );
  assert.throws(
    () =>
      renderer.addExternalDetailBatch(
        "xref-1",
        { ...externalDetail, id: 2, firstVertex: 4 },
        {
          buffer: new ArrayBuffer(72),
          byteLength: 72,
          vertexCount: 2,
        },
      ),
    /external detail GPU data exceeds/,
  );
  renderer.setExternalDetailSelections("xref-1", [
    { batch: externalDetail, instanceIndices: null },
  ]);

  const redrawn = renderer.redraw(external.camera);

  assert.equal(redrawn.externalScenes, 1);
  assert.equal(redrawn.externalOverviewGpuBytes, 72);
  assert.equal(redrawn.externalDetailGpuBytes, 72);
  assert.equal(redrawn.externalDetailBatches, 1);
  assert.equal(redrawn.drawCalls, 3);
  assert.deepEqual(calls.drawArraysInstanced.slice(-3), [
    { mode: gl.LINES, first: 0, count: 2, instances: 1 },
    { mode: gl.LINES, first: 0, count: 2, instances: 1 },
    { mode: gl.LINES, first: 0, count: 2, instances: 1 },
  ]);
  assert.ok(redrawn.bounds.max[0] >= 21);
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
      buffer: new ArrayBuffer(72),
      byteLength: 72,
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
  assert.equal(redrawn.gpuVertexBytes, 232);
  assert.deepEqual(calls.drawArraysInstanced.slice(-3), [
    { mode: gl.TRIANGLES, first: 0, count: 3, instances: 1 },
    { mode: gl.LINES, first: 0, count: 2, instances: 1 },
    { mode: gl.LINES, first: 0, count: 2, instances: 1 },
  ]);
  const interactive = renderer.redraw(first.camera, {
    interactive: true,
  });
  assert.equal(interactive.interactive, true);
  assert.equal(interactive.hatchFillDrawCalls, 0);
  assert.equal(interactive.hatchPatternDrawCalls, 0);
  renderer.dispose();
});

test("drops view-specific HATCH patterns before switching instance graphs", () => {
  const { gl } = makeFakeGl();
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
  const identity = identityMat4();
  const initialInstances = {
    data: new Float64Array([...identity, ...identity]),
    count: 2,
    length: 2,
  };
  const overview = batch({
    id: 0,
    kind: GpuLineBatchKind.ModelOverview,
    lodLevel: 0,
    firstVertex: 0,
  });
  renderer.renderOverview({
    batches: [overview],
    layers: [{ color: 0, flags: 0 }],
    instanceGraph: {
      instancesByBlock: new Map(),
      modelInstances: initialInstances,
    },
    vertices: {
      buffer: new ArrayBuffer(72),
      byteLength: 72,
      vertexCount: 2,
    },
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
        instanceIndices: new Uint32Array([1]),
        origin: [0, 0, 0],
        bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      },
    ],
    vertices: {
      buffer: new ArrayBuffer(64),
      byteLength: 64,
      vertexCount: 2,
    },
  });

  assert.doesNotThrow(() =>
    renderer.setInstanceGraph({
      instancesByBlock: new Map(),
      modelInstances: {
        data: identity,
        count: 1,
        length: 1,
      },
    }),
  );
  assert.equal(renderer.hatchPatternScene, null);
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
      buffer: new ArrayBuffer(72),
      byteLength: 72,
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
  assert.equal(redrawn.gpuVertexBytes, 264);
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
  const overviewBuffer = new ArrayBuffer(72);
  const overviewView = new DataView(overviewBuffer);
  overviewView.setUint32(20, 5, true);
  overviewView.setUint32(56, 15, true);
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
      byteLength: 72,
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
      byteLength: 72,
      vertexCount: 2,
    },
  });
  assert.equal(decodeMaskBucket(overviewView.getUint32(28, true)), 0);
  assert.equal(decodeMaskBucket(overviewView.getUint32(64, true)), 1);

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

  renderer.setWipeoutMasksVisible(false);
  const withoutMasks = renderer.redraw(first.camera);
  assert.equal(withoutMasks.wipeoutMaskDrawCalls, 0);
  assert.deepEqual(calls.drawArraysInstanced.at(-1), {
    mode: gl.LINES,
    first: 0,
    count: 2,
    instances: 1,
  });

  renderer.setWipeoutMasksVisible(true);
  assert.equal(renderer.redraw(first.camera).wipeoutMaskDrawCalls, 1);
  renderer.dispose();
});

test("patches a bounded detail buffer using its global vertex range", () => {
  const buffer = new ArrayBuffer(72);
  const view = new DataView(buffer);
  view.setUint32(20, 5, true);
  view.setUint32(56, 15, true);
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
  assert.equal(decodeMaskBucket(view.getUint32(64, true)), 1);
});

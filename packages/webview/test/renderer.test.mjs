import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateOverviewBounds,
  makeClipTexturePayload,
  overlayCameraTransform,
  patchCurveReplacementMarkers,
  patchLineMaskBuckets,
  ROOT_RENDER_DELTA_SCENE_ID,
  selectInteractiveInstanceIndices,
  WebGlLineRenderer,
} from "../src/renderer.mjs";
import { curveRefinementCameraKey } from "../src/curve-contract.mjs";
import { decodeMaskBucket } from "../src/mask-order.mjs";
import {
  packRenderIdentityRanges,
} from "../src/render-identity-ranges.mjs";
import {
  GPU_LINE_VERTEX_RECORD_SIZE,
  GpuLineBatchKind,
} from "../src/scene-cache.mjs";
import { createClipNode } from "../src/instance-graph.mjs";
import { identityMat4 } from "../src/math.mjs";
import {
  normalizedRenderDeltaTextRecord,
} from "./render-delta-text-fixture.mjs";
import {
  normalizedRenderDeltaStyleRecord,
} from "./render-delta-style-fixture.mjs";
import {
  normalizedRenderDeltaTransformRecord,
  translatedTransformMatrix,
} from "./render-delta-transform-fixture.mjs";

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

function lineVerticesForHandles(handles) {
  const vertexCount = handles.length * 2;
  const buffer = new ArrayBuffer(
    vertexCount * GPU_LINE_VERTEX_RECORD_SIZE,
  );
  const view = new DataView(buffer);
  for (const [segment, handle] of handles.entries()) {
    for (let endpoint = 0; endpoint < 2; endpoint += 1) {
      const vertex = segment * 2 + endpoint;
      const offset = vertex * GPU_LINE_VERTEX_RECORD_SIZE;
      view.setFloat32(offset, segment + endpoint, true);
      view.setUint32(offset + 16, 7, true);
      view.setUint32(
        offset + 20,
        Number(handle & 0xffff_ffffn),
        true,
      );
      view.setUint32(
        offset + 24,
        Number(handle >> 32n),
        true,
      );
    }
  }
  return Object.freeze({
    buffer,
    byteLength: buffer.byteLength,
    vertexCount,
    recordSize: GPU_LINE_VERTEX_RECORD_SIZE,
  });
}

function deltaFillVertices() {
  const vertexCount = 3;
  const buffer = new ArrayBuffer(vertexCount * 32);
  const view = new DataView(buffer);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const offset = vertex * 32;
    view.setFloat32(offset, vertex === 1 ? 1 : 0, true);
    view.setFloat32(offset + 4, vertex === 2 ? 1 : 0, true);
    view.setUint32(offset + 12, 0, true);
    view.setUint32(offset + 16, (2 << 30) | 3, true);
    view.setUint32(offset + 20, (2 << 30) | 3, true);
  }
  return Object.freeze({
    buffer,
    byteLength: buffer.byteLength,
    vertexCount,
    recordSize: 32,
  });
}

function deltaPointVertices(vertexCount = 1) {
  const buffer = new ArrayBuffer(vertexCount * 32);
  const view = new DataView(buffer);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const offset = vertex * 32;
    view.setFloat32(offset, vertex + 0.5, true);
    view.setFloat32(offset + 4, 0.5, true);
    view.setUint32(offset + 12, 0, true);
    view.setUint32(offset + 16, (2 << 30) | 2, true);
    view.setFloat32(offset + 20, 0, true);
    view.setFloat32(offset + 24, 4, true);
    view.setUint32(offset + 28, 0, true);
  }
  return Object.freeze({
    buffer,
    byteLength: buffer.byteLength,
    vertexCount,
    recordSize: 32,
  });
}

function identityRangesFor(vertexCount, handle = 0x2an) {
  return packRenderIdentityRanges(
    vertexCount === 0
      ? []
      : [{ firstVertex: 0, vertexCount, handle }],
    vertexCount,
  );
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

test("maps a retained Canvas overlay from its stable camera to the interaction camera", () => {
  const transform = overlayCameraTransform(
    {
      origin: [0, 0, 0],
      worldWidth: 20,
      worldHeight: 10,
    },
    {
      origin: [2, -1, 0],
      worldWidth: 10,
      worldHeight: 5,
    },
    200,
    100,
  );

  assert.deepEqual(transform, {
    scaleX: 2,
    scaleY: 2,
    translateX: -140,
    translateY: -70,
  });
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
  renderer.setLayerVisibilityState([true, false]);
  assert.deepEqual(renderer.getLayerVisibility(), [true, false]);
  assert.throws(
    () => renderer.setLayerVisibilityState([true]),
    /invalid layer visibility state/,
  );
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
  const interactive = renderer.redraw(
    {
      ...first.camera,
      origin: [first.camera.origin[0] + 0.5, first.camera.origin[1], 0],
    },
    { interactive: true },
  );
  assert.equal(interactive.drawCalls, 2);
  assert.equal(interactive.detailBatches, 1);
  assert.equal(interactive.detailDrawCalls, 1);

  assert.equal(renderer.deleteDetailBatch(detail.id), true);
  renderer.dispose();
});

test("atomically overlays delta lines and suppresses matching base handles", () => {
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
  const overviewBatch = {
    ...batch({
      id: 0,
      kind: GpuLineBatchKind.ModelOverview,
      lodLevel: 0,
      firstVertex: 0,
    }),
    vertexCount: 4,
    bounds: { min: [0, 0, 0], max: [2, 1, 0] },
  };
  const first = renderer.renderOverview({
    batches: [overviewBatch],
    layers: [{ color: 0, flags: 0 }],
    instanceGraph: { instancesByBlock: new Map() },
    vertices: lineVerticesForHandles([0x2an, 0x2bn]),
  });
  const deltaBatch = batch({
    id: 10,
    kind: GpuLineBatchKind.ModelDetail,
    lodLevel: 1,
    firstVertex: 0,
  });
  const staged = renderer.stageRenderDeltaLine({
    key: "delta:1\u0000dwg:root:2A",
    sceneId: ROOT_RENDER_DELTA_SCENE_ID,
    batch: deltaBatch,
    vertices: lineVerticesForHandles([0x2an]),
  });

  renderer.activateRenderDelta({
    lines: [staged],
    baseSuppressions: [
      {
        sceneId: ROOT_RENDER_DELTA_SCENE_ID,
        handleLow: 0x2a,
        handleHigh: 0,
      },
    ],
    affectedWorldBounds: {
      min: [0, 0, 0],
      max: [3, 2, 0],
    },
  });
  const callCount = calls.drawArraysInstanced.length;
  const overlaid = renderer.redraw(first.camera);

  assert.deepEqual(
    calls.drawArraysInstanced.slice(callCount),
    [
      { mode: gl.LINES, first: 2, count: 2, instances: 1 },
      { mode: gl.LINES, first: 0, count: 2, instances: 1 },
    ],
  );
  assert.equal(overlaid.drawCalls, 2);
  assert.equal(overlaid.submittedVertices, 4);
  assert.equal(overlaid.renderDeltaDrawCalls, 1);
  assert.equal(overlaid.renderDeltaSubmittedVertices, 2);
  assert.equal(overlaid.renderDeltaBatches, 1);
  assert.equal(overlaid.renderDeltaGpuBytes, 72);
  assert.equal(overlaid.renderDeltaAllocatedGpuBytes, 72);
  assert.equal(overlaid.renderDeltaBaseSuppressions, 1);
  assert.deepEqual(overlaid.bounds, {
    min: [0, 0, 0],
    max: [3, 2, 0],
  });

  renderer.activateRenderDelta();
  assert.equal(renderer.releaseRenderDeltaLines([staged]), 1);
  const restoredCallCount = calls.drawArraysInstanced.length;
  const restored = renderer.redraw(first.camera);
  assert.deepEqual(
    calls.drawArraysInstanced.slice(restoredCallCount),
    [{ mode: gl.LINES, first: 0, count: 4, instances: 1 }],
  );
  assert.equal(restored.renderDeltaBatches, 0);
  assert.equal(restored.renderDeltaAllocatedGpuBytes, 0);
  assert.deepEqual(restored.bounds, {
    min: [0, 0, 0],
    max: [2, 1, 0],
  });

  renderer.dispose();
});

test("atomically overlays delta fills and restores base fills", () => {
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
  const overviewBatch = {
    ...batch({
      id: 0,
      kind: GpuLineBatchKind.ModelOverview,
      lodLevel: 0,
      firstVertex: 0,
    }),
    vertexCount: 4,
    bounds: { min: [0, 0, 0], max: [2, 1, 0] },
  };
  const first = renderer.renderOverview({
    batches: [overviewBatch],
    layers: [{ color: 0, flags: 0 }],
    instanceGraph: { instancesByBlock: new Map() },
    vertices: lineVerticesForHandles([0x2an, 0x2bn]),
  });
  renderer.setHatchFills({
    batches: [
      {
        ...batch({
          id: 20,
          kind: GpuLineBatchKind.ModelDetail,
          lodLevel: 1,
          firstVertex: 0,
        }),
        vertexCount: 3,
      },
    ],
    vertices: deltaFillVertices(),
    identityRanges: identityRangesFor(3, 0x2an),
  });
  const staged = renderer.stageRenderDeltaFill({
    key: "delta:fill\u0000dwg:root:2A",
    sceneId: ROOT_RENDER_DELTA_SCENE_ID,
    batch: {
      ...batch({
        id: 21,
        kind: GpuLineBatchKind.ModelDetail,
        lodLevel: 1,
        firstVertex: 0,
      }),
      vertexCount: 3,
    },
    vertices: deltaFillVertices(),
  });

  renderer.activateRenderDelta({
    fills: [staged],
    baseSuppressions: [
      {
        sceneId: ROOT_RENDER_DELTA_SCENE_ID,
        handleLow: 0x2a,
        handleHigh: 0,
      },
    ],
    affectedWorldBounds: {
      min: [0, 0, 0],
      max: [3, 2, 0],
    },
  });
  const callCount = calls.drawArraysInstanced.length;
  const overlaid = renderer.redraw(first.camera);

  assert.deepEqual(
    calls.drawArraysInstanced.slice(callCount),
    [
      { mode: gl.TRIANGLES, first: 0, count: 3, instances: 1 },
      { mode: gl.LINES, first: 2, count: 2, instances: 1 },
    ],
  );
  assert.equal(overlaid.hatchFillDrawCalls, 0);
  assert.equal(overlaid.renderDeltaBatches, 0);
  assert.equal(overlaid.renderDeltaFillDrawCalls, 1);
  assert.equal(overlaid.renderDeltaFillSubmittedVertices, 3);
  assert.equal(overlaid.renderDeltaFillBatches, 1);
  assert.equal(overlaid.renderDeltaLineGpuBytes, 0);
  assert.equal(overlaid.renderDeltaFillGpuBytes, 96);
  assert.equal(overlaid.renderDeltaGpuBytes, 96);
  assert.equal(overlaid.renderDeltaAllocatedGpuBytes, 96);

  renderer.activateRenderDelta();
  const deletedBuffers = calls.deletedBuffers.length;
  assert.equal(
    renderer.releaseRenderDeltaResources([staged]),
    1,
  );
  assert.equal(calls.deletedBuffers.length, deletedBuffers + 1);
  const restoredCallCount = calls.drawArraysInstanced.length;
  const restored = renderer.redraw(first.camera);
  assert.deepEqual(
    calls.drawArraysInstanced.slice(restoredCallCount),
    [
      { mode: gl.TRIANGLES, first: 0, count: 3, instances: 1 },
      { mode: gl.LINES, first: 0, count: 4, instances: 1 },
    ],
  );
  assert.equal(restored.hatchFillSubmittedVertices, 3);
  assert.equal(restored.renderDeltaFillBatches, 0);
  assert.equal(restored.renderDeltaAllocatedGpuBytes, 0);

  renderer.dispose();
});

test("atomically overlays delta points and restores base points", () => {
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
  const overviewBatch = {
    ...batch({
      id: 0,
      kind: GpuLineBatchKind.ModelOverview,
      lodLevel: 0,
      firstVertex: 0,
    }),
    vertexCount: 4,
    bounds: { min: [0, 0, 0], max: [2, 1, 0] },
  };
  const first = renderer.renderOverview({
    batches: [overviewBatch],
    layers: [{ color: 0, flags: 0 }],
    instanceGraph: { instancesByBlock: new Map() },
    vertices: lineVerticesForHandles([0x2an, 0x2bn]),
  });
  const empty = {
    batches: [],
    vertices: {
      buffer: new ArrayBuffer(0),
      byteLength: 0,
      vertexCount: 0,
    },
    identityRanges: identityRangesFor(0),
  };
  renderer.setPrimitiveMeshes({
    points: {
      batches: [
        {
          ...batch({
            id: 22,
            kind: GpuLineBatchKind.ModelDetail,
            lodLevel: 1,
            firstVertex: 0,
          }),
          vertexCount: 2,
        },
      ],
      vertices: deltaPointVertices(2),
      identityRanges: packRenderIdentityRanges(
        [
          { firstVertex: 0, vertexCount: 1, handle: 0x2an },
          { firstVertex: 1, vertexCount: 1, handle: 0x2bn },
        ],
        2,
      ),
    },
    solidFills: empty,
    solidOutlines: empty,
  });
  const staged = renderer.stageRenderDeltaPoint({
    key: "delta:point\u0000dwg:root:2A",
    sceneId: ROOT_RENDER_DELTA_SCENE_ID,
    batch: {
      ...batch({
        id: 23,
        kind: GpuLineBatchKind.ModelDetail,
        lodLevel: 1,
        firstVertex: 0,
      }),
      vertexCount: 1,
    },
    vertices: deltaPointVertices(),
  });

  renderer.activateRenderDelta({
    points: [staged],
    baseSuppressions: [
      {
        sceneId: ROOT_RENDER_DELTA_SCENE_ID,
        handleLow: 0x2a,
        handleHigh: 0,
      },
    ],
  });
  let callCount = calls.drawArraysInstanced.length;
  const overlaid = renderer.redraw(first.camera);

  assert.deepEqual(
    calls.drawArraysInstanced
      .slice(callCount)
      .filter((call) => call.mode === gl.POINTS),
    [
      { mode: gl.POINTS, first: 1, count: 1, instances: 1 },
      { mode: gl.POINTS, first: 0, count: 1, instances: 1 },
    ],
  );
  assert.equal(overlaid.pointSubmittedVertices, 1);
  assert.equal(overlaid.renderDeltaPointDrawCalls, 1);
  assert.equal(overlaid.renderDeltaPointSubmittedVertices, 1);
  assert.equal(overlaid.renderDeltaPointBatches, 1);
  assert.equal(overlaid.renderDeltaPointGpuBytes, 32);
  assert.equal(overlaid.renderDeltaGpuBytes, 32);
  assert.deepEqual(renderer.renderDeltaSnapshot(), {
    lineBatches: 0,
    fillBatches: 0,
    pointBatches: 1,
    activeGpuBytes: 32,
    textRecords: 0,
    activeTextBytes: 0,
    transformRecords: 0,
    activeTransformBytes: 0,
    styleRecords: 0,
    activeStyleBytes: 0,
    activeResourceBytes: 32,
    allocatedGpuBytes: 32,
    allocatedTextBytes: 0,
    allocatedTransformBytes: 0,
    allocatedStyleBytes: 0,
    allocatedResourceBytes: 32,
    baseSuppressions: 1,
    affectedWorldBounds: null,
  });

  renderer.activateRenderDelta();
  const deletedBuffers = calls.deletedBuffers.length;
  assert.equal(
    renderer.releaseRenderDeltaResources([staged]),
    1,
  );
  assert.equal(calls.deletedBuffers.length, deletedBuffers + 1);
  callCount = calls.drawArraysInstanced.length;
  const restored = renderer.redraw(first.camera);
  assert.deepEqual(
    calls.drawArraysInstanced
      .slice(callCount)
      .filter((call) => call.mode === gl.POINTS),
    [{ mode: gl.POINTS, first: 0, count: 2, instances: 1 }],
  );
  assert.equal(restored.pointSubmittedVertices, 2);
  assert.equal(restored.renderDeltaPointBatches, 0);
  assert.equal(restored.renderDeltaAllocatedGpuBytes, 0);

  renderer.dispose();
});

test("shares one render delta GPU budget across lines, fills, and points", () => {
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
  const renderer = new WebGlLineRenderer(canvas, {
    maximumRenderDeltaBytes: 199,
  });
  renderer.renderOverview({
    batches: [
      batch({
        id: 0,
        kind: GpuLineBatchKind.ModelOverview,
        lodLevel: 0,
        firstVertex: 0,
      }),
    ],
    layers: [{ color: 0, flags: 0 }],
    instanceGraph: { instancesByBlock: new Map() },
    vertices: lineVerticesForHandles([0x2an]),
  });
  const stagedLine = renderer.stageRenderDeltaLine({
    key: "delta:budget\u0000line",
    batch: batch({
      id: 30,
      kind: GpuLineBatchKind.ModelDetail,
      lodLevel: 1,
      firstVertex: 0,
    }),
    vertices: lineVerticesForHandles([0x2an]),
  });
  const stagedFill = renderer.stageRenderDeltaFill({
    key: "delta:budget\u0000fill",
    batch: {
      ...batch({
        id: 31,
        kind: GpuLineBatchKind.ModelDetail,
        lodLevel: 1,
        firstVertex: 0,
      }),
      vertexCount: 3,
    },
    vertices: deltaFillVertices(),
  });

  assert.throws(
    () =>
      renderer.stageRenderDeltaPoint({
        key: "delta:budget\u0000point",
        batch: {
          ...batch({
            id: 32,
            kind: GpuLineBatchKind.ModelDetail,
            lodLevel: 1,
            firstVertex: 0,
          }),
          vertexCount: 1,
        },
        vertices: deltaPointVertices(),
      }),
    /exceeds the 199-byte limit/u,
  );
  assert.equal(
    renderer.renderDeltaSnapshot().allocatedGpuBytes,
    168,
  );
  assert.equal(
    renderer.releaseRenderDeltaResources([stagedLine, stagedFill]),
    2,
  );
  assert.equal(
    renderer.renderDeltaSnapshot().allocatedGpuBytes,
    0,
  );
  renderer.dispose();
});

test("bounds, activates, rolls back, and releases Canvas text deltas", () => {
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
  const text = normalizedRenderDeltaTextRecord();
  const renderer = new WebGlLineRenderer(canvas, {
    maximumRenderDeltaTextBytes: text.buffer.byteLength,
  });
  renderer.renderOverview({
    batches: [
      batch({
        id: 0,
        kind: GpuLineBatchKind.ModelOverview,
        lodLevel: 0,
        firstVertex: 0,
      }),
    ],
    layers: [{ color: 0, flags: 0 }],
    instanceGraph: { instancesByBlock: new Map() },
    vertices: lineVerticesForHandles([0x2an]),
  });
  const states = [];
  renderer.setTextOverlay({
    setRenderDeltaState(state) {
      states.push(state);
    },
    dispose() {},
  });
  const staged = renderer.stageRenderDeltaText({
    key: "delta:text\u0000dwg:root:2A",
    sceneId: ROOT_RENDER_DELTA_SCENE_ID,
    record: text.record,
    byteLength: text.buffer.byteLength,
  });
  const secondText = normalizedRenderDeltaTextRecord({
    value: "두 번째",
  });

  assert.throws(
    () =>
      renderer.stageRenderDeltaText({
        key: "delta:text\u0000second",
        record: secondText.record,
        byteLength: secondText.buffer.byteLength,
      }),
    new RegExp(
      `exceeds the ${text.buffer.byteLength}-byte limit`,
      "u",
    ),
  );
  renderer.activateRenderDelta({
    texts: [staged],
    baseSuppressions: [
      {
        sceneId: ROOT_RENDER_DELTA_SCENE_ID,
        handleLow: 0x2a,
        handleHigh: 0,
      },
    ],
  });
  const active = renderer.renderDeltaSnapshot();
  assert.equal(states.at(-1).texts[0], staged);
  assert.equal(active.textRecords, 1);
  assert.equal(active.activeTextBytes, text.buffer.byteLength);
  assert.equal(active.activeGpuBytes, 0);
  assert.equal(
    active.activeResourceBytes,
    text.buffer.byteLength,
  );
  assert.equal(active.allocatedTextBytes, text.buffer.byteLength);
  assert.throws(
    () => renderer.releaseRenderDeltaResources([staged]),
    /cannot release an active/u,
  );

  renderer.activateRenderDelta();
  assert.equal(states.at(-1).texts.length, 0);
  assert.equal(
    renderer.releaseRenderDeltaResources([staged]),
    1,
  );
  assert.equal(
    renderer.renderDeltaSnapshot().allocatedResourceBytes,
    0,
  );
  renderer.dispose();
});

test("sparsely replaces a shared block occurrence transform", () => {
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
  const transform = normalizedRenderDeltaTransformRecord({
    matrix: translatedTransformMatrix(0.25, 0.25, 0),
    measurementMatrix: translatedTransformMatrix(
      0.5,
      0.5,
      0,
    ),
  });
  const renderer = new WebGlLineRenderer(canvas, {
    maximumRenderDeltaTransformBytes:
      transform.buffer.byteLength,
  });
  const instances = Object.freeze({
    data: identityMat4(),
    measurementData: identityMat4(),
    handles: new BigUint64Array([0x2an]),
    clipIds: new Uint32Array([0]),
    count: 1,
    length: 1,
  });
  const blockBatch = {
    ...batch({
      id: 0,
      kind: GpuLineBatchKind.BlockDefinition,
      lodLevel: 0,
      firstVertex: 0,
    }),
    blockIndex: 1,
  };
  const first = renderer.renderOverview({
    batches: [blockBatch],
    layers: [{ color: 0, flags: 0 }],
    instanceGraph: {
      instancesByBlock: new Map([[1, instances]]),
      insertsByOwner: new Map(),
    },
    vertices: lineVerticesForHandles([0x99n]),
  });
  const textStates = [];
  const imageStates = [];
  renderer.setTextOverlay({
    setRenderDeltaState(state) {
      textStates.push(state);
    },
    redraw() {
      return {};
    },
    dispose() {},
  });
  renderer.setImageOverlay({
    setRenderDeltaTransforms(entries) {
      imageStates.push(entries);
    },
    redraw() {
      return {};
    },
    dispose() {},
  });
  const staged = renderer.stageRenderDeltaTransform({
    key: "delta:transform\u0000dwg:root:2A",
    record: transform.record,
    byteLength: transform.buffer.byteLength,
  });

  assert.throws(
    () =>
      renderer.stageRenderDeltaTransform({
        key: "delta:transform\u0000second",
        record: transform.record,
        byteLength: transform.buffer.byteLength,
      }),
    new RegExp(
      `exceeds the ${transform.buffer.byteLength}-byte limit`,
      "u",
    ),
  );
  renderer.activateRenderDelta({ transforms: [staged] });
  const callCount = calls.bufferData.length;
  const overlaid = renderer.redraw(first.camera);
  const transformedUpload = calls.bufferData
    .slice(callCount)
    .findLast((call) => call.usage === gl.DYNAMIC_DRAW);
  const transformedMatrix = new Float32Array(
    transformedUpload.buffer.slice(0, 16 * 4),
  );

  assert.equal(textStates.at(-1).transforms[0], staged);
  assert.equal(imageStates.at(-1)[0], staged);
  assert.ok(Math.abs(transformedMatrix[12] + 0.25) < 1e-6);
  assert.ok(Math.abs(transformedMatrix[13] + 0.25) < 1e-6);
  assert.equal(overlaid.renderDeltaTransformRecords, 1);
  assert.equal(
    overlaid.renderDeltaTransformBytes,
    transform.buffer.byteLength,
  );
  assert.equal(overlaid.renderDeltaGpuBytes, 0);
  assert.deepEqual(renderer.renderDeltaSnapshot(), {
    lineBatches: 0,
    fillBatches: 0,
    pointBatches: 0,
    activeGpuBytes: 0,
    textRecords: 0,
    activeTextBytes: 0,
    transformRecords: 1,
    activeTransformBytes: transform.buffer.byteLength,
    styleRecords: 0,
    activeStyleBytes: 0,
    activeResourceBytes: transform.buffer.byteLength,
    allocatedGpuBytes: 0,
    allocatedTextBytes: 0,
    allocatedTransformBytes: transform.buffer.byteLength,
    allocatedStyleBytes: 0,
    allocatedResourceBytes: transform.buffer.byteLength,
    baseSuppressions: 0,
    affectedWorldBounds: null,
  });
  assert.throws(
    () => renderer.releaseRenderDeltaResources([staged]),
    /cannot release an active/u,
  );

  renderer.activateRenderDelta();
  assert.equal(textStates.at(-1).transforms.length, 0);
  assert.equal(imageStates.at(-1).length, 0);
  renderer.releaseRenderDeltaResources([staged]);
  const restoredCallCount = calls.bufferData.length;
  const restored = renderer.redraw(first.camera);
  const restoredUpload = calls.bufferData
    .slice(restoredCallCount)
    .findLast((call) => call.usage === gl.DYNAMIC_DRAW);
  const restoredMatrix = new Float32Array(
    restoredUpload.buffer.slice(0, 16 * 4),
  );
  assert.ok(Math.abs(restoredMatrix[12] + 0.5) < 1e-6);
  assert.ok(Math.abs(restoredMatrix[13] + 0.5) < 1e-6);
  assert.equal(restored.renderDeltaTransformRecords, 0);
  assert.equal(restored.renderDeltaAllocatedTransformBytes, 0);

  renderer.dispose();
});

test("sparsely replaces and hides shared block occurrence styles", () => {
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
  const style = normalizedRenderDeltaStyleRecord({
    color: 0x8000_0005,
    layerIndex: 1,
    opacity: 0.25,
    lineWeight: 35,
    linetypeCode: 7,
    visible: true,
  });
  const hidden = normalizedRenderDeltaStyleRecord({
    visible: false,
  });
  const renderer = new WebGlLineRenderer(canvas, {
    maximumRenderDeltaStyleBytes: style.buffer.byteLength,
  });
  const instances = Object.freeze({
    data: identityMat4(),
    measurementData: identityMat4(),
    handles: new BigUint64Array([0x2an]),
    clipIds: new Uint32Array([0]),
    colors: new Uint32Array([0x8000_0002]),
    layerIndices: new Uint32Array([0]),
    opacities: new Float32Array([0.75]),
    lineWeights: new Int16Array([25]),
    linetypeCodes: new Uint16Array([2]),
    visibilityRows: new Uint32Array([0]),
    count: 1,
    length: 1,
  });
  const blockBatch = {
    ...batch({
      id: 0,
      kind: GpuLineBatchKind.BlockDefinition,
      lodLevel: 0,
      firstVertex: 0,
    }),
    blockIndex: 1,
  };
  const first = renderer.renderOverview({
    batches: [blockBatch],
    layers: [
      { color: 0, flags: 0 },
      { color: 0, flags: 0 },
    ],
    instanceGraph: {
      instancesByBlock: new Map([[1, instances]]),
      insertsByOwner: new Map(),
    },
    vertices: lineVerticesForHandles([0x99n]),
  });
  const textStates = [];
  const imageStates = [];
  renderer.setTextOverlay({
    setRenderDeltaState(state) {
      textStates.push(state);
    },
    redraw() {
      return {};
    },
    dispose() {},
  });
  renderer.setImageOverlay({
    setRenderDeltaState(state) {
      imageStates.push(state);
    },
    redraw() {
      return {};
    },
    dispose() {},
  });
  const staged = renderer.stageRenderDeltaStyle({
    key: "delta:style\u0000dwg:root:2A",
    record: style.record,
    byteLength: style.buffer.byteLength,
  });

  assert.throws(
    () =>
      renderer.stageRenderDeltaStyle({
        key: "delta:style\u0000second",
        record: style.record,
        byteLength: style.buffer.byteLength,
      }),
    new RegExp(
      `exceeds the ${style.buffer.byteLength}-byte limit`,
      "u",
    ),
  );
  renderer.activateRenderDelta({ styles: [staged] });
  const callCount = calls.bufferData.length;
  const overlaid = renderer.redraw(first.camera);
  const styleUpload = calls.bufferData
    .slice(callCount)
    .findLast((call) => call.usage === gl.DYNAMIC_DRAW);
  const packedFloats = new Float32Array(
    styleUpload.buffer.slice(0, 23 * 4),
  );
  const packedIntegers = new Uint32Array(
    styleUpload.buffer.slice(0, 23 * 4),
  );

  assert.equal(textStates.at(-1).styles[0], staged);
  assert.equal(imageStates.at(-1).styles[0], staged);
  assert.equal(packedIntegers[18], 0x8000_0005);
  assert.equal(packedIntegers[19], 1);
  assert.equal(packedFloats[20], 0.25);
  assert.equal(packedFloats[21], 35);
  assert.equal(packedIntegers[22], 7);
  assert.equal(overlaid.renderDeltaStyleRecords, 1);
  assert.equal(
    overlaid.renderDeltaStyleBytes,
    style.buffer.byteLength,
  );
  assert.deepEqual(renderer.renderDeltaSnapshot(), {
    lineBatches: 0,
    fillBatches: 0,
    pointBatches: 0,
    activeGpuBytes: 0,
    textRecords: 0,
    activeTextBytes: 0,
    transformRecords: 0,
    activeTransformBytes: 0,
    styleRecords: 1,
    activeStyleBytes: style.buffer.byteLength,
    activeResourceBytes: style.buffer.byteLength,
    allocatedGpuBytes: 0,
    allocatedTextBytes: 0,
    allocatedTransformBytes: 0,
    allocatedStyleBytes: style.buffer.byteLength,
    allocatedResourceBytes: style.buffer.byteLength,
    baseSuppressions: 0,
    affectedWorldBounds: null,
  });

  renderer.activateRenderDelta();
  renderer.releaseRenderDeltaResources([staged]);
  const hiddenEntry = renderer.stageRenderDeltaStyle({
    key: "delta:style-hidden\u0000dwg:root:2A",
    record: hidden.record,
    byteLength: hidden.buffer.byteLength,
  });
  renderer.activateRenderDelta({ styles: [hiddenEntry] });
  const hiddenDrawCount = calls.drawArraysInstanced.length;
  const hiddenMetrics = renderer.redraw(first.camera);
  assert.equal(
    calls.drawArraysInstanced.length,
    hiddenDrawCount,
  );
  assert.equal(hiddenMetrics.submittedInstances, 0);

  renderer.activateRenderDelta();
  renderer.releaseRenderDeltaResources([hiddenEntry]);
  const restoredCallCount = calls.bufferData.length;
  const restored = renderer.redraw(first.camera);
  const restoredUpload = calls.bufferData
    .slice(restoredCallCount)
    .findLast((call) => call.usage === gl.DYNAMIC_DRAW);
  const restoredFloats = new Float32Array(
    restoredUpload.buffer.slice(0, 23 * 4),
  );
  const restoredIntegers = new Uint32Array(
    restoredUpload.buffer.slice(0, 23 * 4),
  );
  assert.equal(restoredIntegers[18], 0x8000_0002);
  assert.equal(restoredIntegers[19], 0);
  assert.equal(restoredFloats[20], 0.75);
  assert.equal(restoredFloats[21], 25);
  assert.equal(restoredIntegers[22], 2);
  assert.equal(restored.renderDeltaStyleRecords, 0);
  assert.equal(restored.renderDeltaAllocatedStyleBytes, 0);

  renderer.dispose();
});

test("retains and camera-transforms Canvas overlays during interaction", () => {
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
  const first = renderer.renderOverview({
    batches: [
      batch({
        id: 0,
        kind: GpuLineBatchKind.ModelOverview,
        lodLevel: 0,
        firstVertex: 0,
      }),
    ],
    layers: [{ color: 0, flags: 0 }],
    instanceGraph: { instancesByBlock: new Map() },
    vertices: {
      buffer: new ArrayBuffer(72),
      byteLength: 72,
      vertexCount: 2,
    },
  });
  const makeOverlay = (kind) => {
    const redraws = [];
    const liveContext = {
      clearRects: [],
      drawImages: [],
      transforms: [],
      setTransform(...values) {
        this.transforms.push(values);
      },
      clearRect(...values) {
        this.clearRects.push(values);
      },
      drawImage(...values) {
        this.drawImages.push(values);
      },
    };
    const snapshotCanvases = [];
    return {
      canvas: {
        clientWidth: 200,
        clientHeight: 100,
        width: 400,
        height: 200,
        style: {},
        getContext(name) {
          return name === "2d" ? liveContext : null;
        },
        ownerDocument: {
          createElement(name) {
            assert.equal(name, "canvas");
            const context = {
              clearRects: [],
              drawImages: [],
              transforms: [],
              setTransform(...values) {
                this.transforms.push(values);
              },
              clearRect(...values) {
                this.clearRects.push(values);
              },
              drawImage(...values) {
                this.drawImages.push(values);
              },
            };
            const snapshot = {
              width: 0,
              height: 0,
              getContext(contextName) {
                return contextName === "2d" ? context : null;
              },
              context,
            };
            snapshotCanvases.push(snapshot);
            return snapshot;
          },
        },
      },
      redraw(camera) {
        redraws.push(camera);
        return Object.freeze({ kind, redraws: redraws.length });
      },
      dispose() {},
      liveContext,
      redraws,
      snapshotCanvases,
    };
  };
  const imageOverlay = makeOverlay("image");
  const textOverlay = makeOverlay("text");
  renderer.setImageOverlay(imageOverlay);
  renderer.setTextOverlay(textOverlay);
  renderer.redraw(first.camera);
  const movedView = {
    ...first.camera,
    origin: [first.camera.origin[0] + 1, first.camera.origin[1] - 0.5, 0],
    worldHeight: first.camera.worldHeight * 0.5,
  };

  const interactive = renderer.redraw(movedView, { interactive: true });

  assert.equal(imageOverlay.redraws.length, 1);
  assert.equal(textOverlay.redraws.length, 1);
  assert.equal(interactive.retainedImageOverlay, true);
  assert.equal(interactive.retainedTextOverlay, true);
  assert.deepEqual(interactive.images, { kind: "image", redraws: 1 });
  assert.deepEqual(interactive.text, { kind: "text", redraws: 1 });
  assert.equal(imageOverlay.snapshotCanvases.length, 1);
  assert.equal(textOverlay.snapshotCanvases.length, 1);
  assert.equal(imageOverlay.liveContext.drawImages.length, 1);
  assert.equal(textOverlay.liveContext.drawImages.length, 1);
  assert.equal(
    imageOverlay.liveContext.drawImages[0][0],
    imageOverlay.snapshotCanvases[0],
  );
  assert.equal(
    textOverlay.liveContext.drawImages[0][0],
    textOverlay.snapshotCanvases[0],
  );
  assert.equal(imageOverlay.canvas.width, 200);
  assert.equal(imageOverlay.canvas.height, 100);
  assert.equal(imageOverlay.canvas.style.transform, "");
  assert.equal(textOverlay.canvas.style.transform, "");

  const settled = renderer.redraw(movedView);

  assert.equal(imageOverlay.redraws.length, 2);
  assert.equal(textOverlay.redraws.length, 2);
  assert.equal(settled.retainedImageOverlay, false);
  assert.equal(settled.retainedTextOverlay, false);
  assert.equal(imageOverlay.canvas.style.transform, "");
  assert.equal(textOverlay.canvas.style.transform, "");
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
      [
        9,
        {
          data: matrices,
          measurementData: matrices,
          handles: new BigUint64Array([0x2cn]),
          clipIds: new Uint32Array([0]),
          count: 1,
          length: 1,
        },
      ],
    ]),
    insertsByOwner: new Map(),
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
  const externalFill = renderer.stageRenderDeltaFill({
    key: "delta:xref-fill\u0000dwg:xref-1:2A",
    sceneId: "xref-1",
    batch: {
      ...externalOverview,
      id: 3,
      lodLevel: 1,
      firstVertex: 0,
      vertexCount: 3,
    },
    vertices: deltaFillVertices(),
  });
  const externalPoint = renderer.stageRenderDeltaPoint({
    key: "delta:xref-point\u0000dwg:xref-1:2B",
    sceneId: "xref-1",
    batch: {
      ...externalOverview,
      id: 4,
      lodLevel: 1,
      firstVertex: 0,
      vertexCount: 1,
    },
    vertices: deltaPointVertices(),
  });
  const externalTextFixture = normalizedRenderDeltaTextRecord({
    handle: "2b",
    ownerHandle: "64",
    value: "외부 문자",
  });
  const externalText = renderer.stageRenderDeltaText({
    key: "delta:xref-text\u0000dwg:xref-1:2B",
    sceneId: "xref-1",
    record: externalTextFixture.record,
    byteLength: externalTextFixture.buffer.byteLength,
  });
  const externalTransformFixture =
    normalizedRenderDeltaTransformRecord({
      blockIndex: 9,
      handle: 0x2cn,
      matrix: translatedTransformMatrix(0.25, 0, 0),
      measurementMatrix: translatedTransformMatrix(0.25, 0, 0),
    });
  const externalTransform = renderer.stageRenderDeltaTransform({
    key: "delta:xref-transform\u0000dwg:xref-1:2C",
    sceneId: "xref-1",
    record: externalTransformFixture.record,
    byteLength: externalTransformFixture.buffer.byteLength,
  });
  const externalStyleFixture = normalizedRenderDeltaStyleRecord({
    blockIndex: 9,
    handle: 0x2cn,
    opacity: 0.5,
  });
  const externalStyle = renderer.stageRenderDeltaStyle({
    key: "delta:xref-style\u0000dwg:xref-1:2C",
    sceneId: "xref-1",
    record: externalStyleFixture.record,
    byteLength: externalStyleFixture.buffer.byteLength,
  });
  renderer.activateRenderDelta({
    fills: [externalFill],
    points: [externalPoint],
    texts: [externalText],
    transforms: [externalTransform],
    styles: [externalStyle],
  });

  const redrawn = renderer.redraw(external.camera);

  assert.equal(redrawn.externalScenes, 1);
  assert.equal(redrawn.externalOverviewGpuBytes, 72);
  assert.equal(redrawn.externalDetailGpuBytes, 72);
  assert.equal(redrawn.externalDetailBatches, 1);
  assert.equal(redrawn.drawCalls, 5);
  assert.equal(redrawn.renderDeltaFillDrawCalls, 1);
  assert.equal(redrawn.renderDeltaPointDrawCalls, 1);
  assert.equal(redrawn.renderDeltaTextRecords, 1);
  assert.equal(redrawn.renderDeltaTransformRecords, 1);
  assert.equal(redrawn.renderDeltaStyleRecords, 1);
  assert.equal(
    redrawn.renderDeltaTextBytes,
    externalTextFixture.buffer.byteLength,
  );
  assert.deepEqual(calls.drawArraysInstanced.slice(-5), [
    { mode: gl.TRIANGLES, first: 0, count: 3, instances: 1 },
    { mode: gl.LINES, first: 0, count: 2, instances: 1 },
    { mode: gl.LINES, first: 0, count: 2, instances: 1 },
    { mode: gl.LINES, first: 0, count: 2, instances: 1 },
    { mode: gl.POINTS, first: 0, count: 1, instances: 1 },
  ]);
  assert.ok(redrawn.bounds.max[0] >= 21);
  renderer.activateRenderDelta();
  renderer.releaseRenderDeltaResources([
    externalFill,
    externalPoint,
    externalText,
    externalTransform,
    externalStyle,
  ]);
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
    identityRanges: identityRangesFor(3),
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
    identityRanges: identityRangesFor(2),
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
  assert.equal(interactive.hatchFillDrawCalls, 1);
  assert.equal(interactive.hatchPatternDrawCalls, 1);

  renderer.activateRenderDelta({
    baseSuppressions: [
      {
        sceneId: ROOT_RENDER_DELTA_SCENE_ID,
        handleLow: 0x2a,
        handleHigh: 0,
      },
    ],
  });
  const suppressed = renderer.redraw(first.camera);
  assert.equal(suppressed.hatchFillDrawCalls, 0);
  assert.equal(suppressed.hatchPatternDrawCalls, 0);

  renderer.activateRenderDelta();
  const restored = renderer.redraw(first.camera);
  assert.equal(restored.hatchFillSubmittedVertices, 3);
  assert.equal(restored.hatchPatternSubmittedVertices, 2);
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
    identityRanges: identityRangesFor(2),
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
      identityRanges: identityRangesFor(1),
    },
    solidFills: {
      batches: [makePrimitiveBatch(3)],
      vertices: {
        buffer: new ArrayBuffer(96),
        byteLength: 96,
        vertexCount: 3,
      },
      identityRanges: identityRangesFor(3),
    },
    solidOutlines: {
      batches: [makePrimitiveBatch(2)],
      vertices: {
        buffer: new ArrayBuffer(64),
        byteLength: 64,
        vertexCount: 2,
      },
      identityRanges: identityRangesFor(2),
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
  const interactive = renderer.redraw(first.camera, {
    interactive: true,
  });
  assert.equal(interactive.solidFillDrawCalls, 1);
  assert.equal(interactive.solidOutlineDrawCalls, 1);
  assert.equal(interactive.pointDrawCalls, 1);

  renderer.activateRenderDelta({
    baseSuppressions: [
      {
        sceneId: ROOT_RENDER_DELTA_SCENE_ID,
        handleLow: 0x2a,
        handleHigh: 0,
      },
    ],
  });
  const suppressed = renderer.redraw(first.camera);
  assert.equal(suppressed.solidFillDrawCalls, 0);
  assert.equal(suppressed.solidOutlineDrawCalls, 0);
  assert.equal(suppressed.pointDrawCalls, 0);

  renderer.activateRenderDelta();
  const restored = renderer.redraw(first.camera);
  assert.equal(restored.solidFillSubmittedVertices, 3);
  assert.equal(restored.solidOutlineSubmittedVertices, 2);
  assert.equal(restored.pointSubmittedVertices, 1);
  renderer.dispose();
});

test("suppresses only matching packed primitive identity ranges", () => {
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
  const empty = {
    batches: [],
    vertices: {
      buffer: new ArrayBuffer(0),
      byteLength: 0,
      vertexCount: 0,
    },
    identityRanges: identityRangesFor(0),
  };
  renderer.setPrimitiveMeshes({
    points: {
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
      identityRanges: packRenderIdentityRanges(
        [
          { firstVertex: 0, vertexCount: 1, handle: 0x2an },
          { firstVertex: 1, vertexCount: 1, handle: 0x2bn },
        ],
        2,
      ),
    },
    solidFills: empty,
    solidOutlines: empty,
  });

  renderer.activateRenderDelta({
    baseSuppressions: [
      {
        sceneId: ROOT_RENDER_DELTA_SCENE_ID,
        handleLow: 0x2a,
        handleHigh: 0,
      },
    ],
  });
  let callCount = calls.drawArraysInstanced.length;
  let redrawn = renderer.redraw(first.camera);
  assert.equal(redrawn.pointSubmittedVertices, 1);
  assert.deepEqual(
    calls.drawArraysInstanced
      .slice(callCount)
      .filter((call) => call.mode === gl.POINTS),
    [{ mode: gl.POINTS, first: 1, count: 1, instances: 1 }],
  );

  renderer.activateRenderDelta({
    baseSuppressions: [
      {
        sceneId: ROOT_RENDER_DELTA_SCENE_ID,
        handleLow: 0x2b,
        handleHigh: 0,
      },
    ],
  });
  callCount = calls.drawArraysInstanced.length;
  redrawn = renderer.redraw(first.camera);
  assert.equal(redrawn.pointSubmittedVertices, 1);
  assert.deepEqual(
    calls.drawArraysInstanced
      .slice(callCount)
      .filter((call) => call.mode === gl.POINTS),
    [{ mode: gl.POINTS, first: 0, count: 1, instances: 1 }],
  );

  renderer.activateRenderDelta();
  callCount = calls.drawArraysInstanced.length;
  redrawn = renderer.redraw(first.camera);
  assert.equal(redrawn.pointSubmittedVertices, 2);
  assert.deepEqual(
    calls.drawArraysInstanced
      .slice(callCount)
      .filter((call) => call.mode === gl.POINTS),
    [{ mode: gl.POINTS, first: 0, count: 2, instances: 1 }],
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
    identityRanges: identityRangesFor(0),
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
      identityRanges: identityRangesFor(3, 10n),
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
  const interactive = renderer.redraw(first.camera, {
    interactive: true,
  });
  assert.equal(interactive.wipeoutMaskDrawCalls, 1);

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

  renderer.activateRenderDelta({
    baseSuppressions: [
      {
        sceneId: ROOT_RENDER_DELTA_SCENE_ID,
        handleLow: 10,
        handleHigh: 0,
      },
    ],
  });
  assert.equal(renderer.redraw(first.camera).wipeoutMaskDrawCalls, 0);

  renderer.activateRenderDelta();
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

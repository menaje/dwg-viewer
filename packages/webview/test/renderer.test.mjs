import assert from "node:assert/strict";
import test from "node:test";

import { WebGlLineRenderer } from "../src/renderer.mjs";
import { GpuLineBatchKind } from "../src/scene-cache.mjs";

function makeFakeGl() {
  let nextId = 0;
  const calls = {
    bufferData: [],
    drawArraysInstanced: [],
    deletedBuffers: [],
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
    DEPTH_TEST: 21,
    BLEND: 22,
    SRC_ALPHA: 23,
    ONE_MINUS_SRC_ALPHA: 24,
    LINES: 25,
    createShader: () => ({ id: ++nextId }),
    shaderSource() {},
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
      calls.bufferData.push({ byteLength: value.byteLength, usage });
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
    clear() {},
    disable() {},
    enable() {},
    blendFunc() {},
    useProgram() {},
    uniformMatrix4fv() {},
    uniform1i() {},
    drawArraysInstanced(mode, first, count, instances) {
      calls.drawArraysInstanced.push({ mode, first, count, instances });
    },
    deleteTexture() {},
  };
  return { gl, calls };
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
    layers: [],
    instanceGraph: { instancesByBlock: new Map() },
    vertices: {
      buffer: new ArrayBuffer(64),
      byteLength: 64,
      vertexCount: 2,
    },
  });

  assert.equal(first.drawCalls, 1);
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
  assert.deepEqual(calls.drawArraysInstanced.slice(-2), [
    { mode: gl.LINES, first: 0, count: 2, instances: 1 },
    { mode: gl.LINES, first: 0, count: 2, instances: 1 },
  ]);

  assert.equal(renderer.deleteDetailBatch(detail.id), true);
  renderer.dispose();
});

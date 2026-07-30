import { GpuLineBatchKind } from "./scene-cache.mjs";
import {
  batchRelativeInstanceMatrix,
  boundsAreFinite,
  emptyBounds3,
  identityMat4,
  includeTransformedBounds,
  orthographic2D,
} from "./math.mjs";

const VERTEX_STRIDE = 32;
const INSTANCE_STRIDE = 64;
const MAX_INSTANCES_PER_DRAW = 16_384;
const MODEL_INSTANCES = Object.freeze({
  data: identityMat4(),
  count: 1,
  length: 1,
});
const EMPTY_INSTANCES = Object.freeze({
  data: new Float64Array(0),
  count: 0,
  length: 0,
});

const VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec3 a_localPosition;
layout(location = 1) in uint a_encodedColor;
layout(location = 2) in uint a_layerIndex;
layout(location = 3) in uint a_style;
layout(location = 4) in mat4 a_instanceMatrix;

uniform mat4 u_projection;

flat out uint v_encodedColor;
flat out uint v_layerIndex;
flat out uint v_style;

void main() {
  gl_Position = u_projection * a_instanceMatrix * vec4(a_localPosition, 1.0);
  v_encodedColor = a_encodedColor;
  v_layerIndex = a_layerIndex;
  v_style = a_style;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

flat in uint v_encodedColor;
flat in uint v_layerIndex;
flat in uint v_style;

uniform sampler2D u_layerColors;
uniform int u_layerCount;

out vec4 outColor;

vec3 aciColor(uint index) {
  if (index == 1u) return vec3(1.0, 0.18, 0.18);
  if (index == 2u) return vec3(1.0, 1.0, 0.2);
  if (index == 3u) return vec3(0.2, 1.0, 0.35);
  if (index == 4u) return vec3(0.2, 0.95, 1.0);
  if (index == 5u) return vec3(0.35, 0.55, 1.0);
  if (index == 6u) return vec3(1.0, 0.25, 1.0);
  if (index == 7u) return vec3(0.92);
  float gray = 0.35 + 0.6 * float(index % 16u) / 15.0;
  return vec3(gray);
}

vec4 resolveColor() {
  uint kind = v_encodedColor >> 30u;
  if (kind == 0u) {
    if (v_layerIndex >= uint(u_layerCount)) return vec4(0.92, 0.92, 0.92, 1.0);
    return texelFetch(u_layerColors, ivec2(int(v_layerIndex), 0), 0);
  }
  if (kind == 1u) return vec4(0.92, 0.92, 0.92, 1.0);
  if (kind == 2u) return vec4(aciColor(v_encodedColor & 255u), 1.0);
  return vec4(
    float((v_encodedColor >> 16u) & 255u) / 255.0,
    float((v_encodedColor >> 8u) & 255u) / 255.0,
    float(v_encodedColor & 255u) / 255.0,
    1.0
  );
}

void main() {
  if ((v_style & (1u << 16u)) != 0u) discard;
  outColor = resolveColor();
  if (outColor.a <= 0.0) discard;
}
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("cannot allocate WebGL shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`WebGL shader compilation failed: ${log}`);
  }
  return shader;
}

function createProgram(gl) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) {
    throw new Error("cannot allocate WebGL program");
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`WebGL program link failed: ${log}`);
  }
  return program;
}

function aciRgb(index) {
  switch (index) {
    case 1:
      return [255, 46, 46];
    case 2:
      return [255, 255, 51];
    case 3:
      return [51, 255, 89];
    case 4:
      return [51, 242, 255];
    case 5:
      return [89, 140, 255];
    case 6:
      return [255, 64, 255];
    case 7:
      return [235, 235, 235];
    default: {
      const gray = Math.round(89 + (153 * (index % 16)) / 15);
      return [gray, gray, gray];
    }
  }
}

function decodeColor(encoded) {
  const kind = encoded >>> 30;
  if (kind === 2) {
    return aciRgb(encoded & 255);
  }
  if (kind === 3) {
    return [(encoded >>> 16) & 255, (encoded >>> 8) & 255, encoded & 255];
  }
  return [235, 235, 235];
}

function makeLayerPixels(layers) {
  const pixels = new Uint8Array(Math.max(layers.length, 1) * 4);
  if (layers.length === 0) {
    pixels.set([235, 235, 235, 255]);
    return pixels;
  }
  for (let index = 0; index < layers.length; index += 1) {
    const [red, green, blue] = decodeColor(layers[index].color);
    const hidden = (layers[index].flags & 0b11) !== 0;
    pixels.set([red, green, blue, hidden ? 0 : 255], index * 4);
  }
  return pixels;
}

function makeCameraFromView(origin, worldHeight, width, height) {
  const safeWidth = Math.max(width, 1);
  const safeHeight = Math.max(height, 1);
  const safeWorldHeight = Math.max(worldHeight, Number.EPSILON);
  const worldWidth = safeWorldHeight * (safeWidth / safeHeight);
  return Object.freeze({
    origin: [...origin],
    worldHeight: safeWorldHeight,
    worldWidth,
    width: safeWidth,
    height: safeHeight,
    projection: orthographic2D(safeWidth, safeHeight, safeWorldHeight),
  });
}

function makeCamera(bounds, width, height, padding = 1.08) {
  const origin = [
    bounds.min[0] * 0.5 + bounds.max[0] * 0.5,
    bounds.min[1] * 0.5 + bounds.max[1] * 0.5,
    bounds.min[2] * 0.5 + bounds.max[2] * 0.5,
  ];
  const drawingWidth = Math.max(bounds.max[0] - bounds.min[0], 1e-6);
  const drawingHeight = Math.max(bounds.max[1] - bounds.min[1], 1e-6);
  const aspect = Math.max(width, 1) / Math.max(height, 1);
  const worldHeight = Math.max(drawingHeight, drawingWidth / aspect) * padding;
  return makeCameraFromView(origin, worldHeight, width, height);
}

function instancesForBatch(batch, instanceGraph) {
  if (batch.kind !== GpuLineBatchKind.BlockDefinition) {
    return MODEL_INSTANCES;
  }
  return (
    instanceGraph.instancesByBlock.get(batch.blockIndex) ?? EMPTY_INSTANCES
  );
}

function calculateOverviewBounds(batches, instanceGraph) {
  const bounds = emptyBounds3();
  for (const batch of batches) {
    if (batch.lodLevel !== 0) {
      break;
    }
    const instances = instancesForBatch(batch, instanceGraph);
    for (let index = 0; index < instances.count; index += 1) {
      includeTransformedBounds(
        bounds,
        batch.bounds,
        instances.data,
        index * 16,
      );
    }
  }
  return bounds;
}

export class WebGlLineRenderer {
  constructor(canvas) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: true,
      depth: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!gl) {
      throw new Error("WebGL2 is required for the DWG viewer");
    }
    this.canvas = canvas;
    this.gl = gl;
    this.program = createProgram(gl);
    this.instanceBuffer = gl.createBuffer();
    this.layerTexture = gl.createTexture();
    this.vertexResources = new Set();
    this.detailResources = new Map();
    this.detailSelections = new Map();
    this.overviewScene = null;
    if (!this.instanceBuffer || !this.layerTexture) {
      throw new Error("cannot allocate WebGL buffers");
    }
    this.projectionLocation = gl.getUniformLocation(this.program, "u_projection");
    this.layerCountLocation = gl.getUniformLocation(this.program, "u_layerCount");
    this.layerTextureLocation = gl.getUniformLocation(this.program, "u_layerColors");
    this.layerCount = 0;
  }

  setLayers(layers) {
    const gl = this.gl;
    const pixels = makeLayerPixels(layers);
    this.layerCount = layers.length;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      Math.max(layers.length, 1),
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
  }

  uploadVertices(arrayBuffer) {
    const gl = this.gl;
    const vertexBuffer = gl.createBuffer();
    const vertexArray = gl.createVertexArray();
    if (!vertexBuffer || !vertexArray) {
      throw new Error("cannot allocate WebGL vertex resources");
    }
    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, arrayBuffer, gl.STATIC_DRAW);

    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, VERTEX_STRIDE, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, VERTEX_STRIDE, 16);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, VERTEX_STRIDE, 12);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, VERTEX_STRIDE, 28);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    for (let column = 0; column < 4; column += 1) {
      const location = 4 + column;
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(
        location,
        4,
        gl.FLOAT,
        false,
        INSTANCE_STRIDE,
        column * 16,
      );
      gl.vertexAttribDivisor(location, 1);
    }
    gl.bindVertexArray(null);

    const resource = Object.freeze({
      vertexBuffer,
      vertexArray,
      byteLength: arrayBuffer.byteLength,
    });
    this.vertexResources.add(resource);
    return resource;
  }

  deleteVertices(resource) {
    if (!this.vertexResources.delete(resource)) {
      return;
    }
    this.gl.deleteVertexArray(resource.vertexArray);
    this.gl.deleteBuffer(resource.vertexBuffer);
  }

  resize() {
    const ratio = Math.min(globalThis.devicePixelRatio ?? 1, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.gl.viewport(0, 0, width, height);
    return { width, height };
  }

  renderOverview({ batches, layers, instanceGraph, vertices }) {
    const size = this.resize();
    this.setLayers(layers);
    const bounds = calculateOverviewBounds(batches, instanceGraph);
    if (!boundsAreFinite(bounds)) {
      throw new Error("overview does not contain any drawable model-space geometry");
    }
    const camera = makeCamera(bounds, size.width, size.height);
    const resource = this.uploadVertices(vertices.buffer);
    this.overviewScene = Object.freeze({
      batches,
      bounds,
      camera,
      instanceGraph,
      resource,
    });
    return Object.freeze({ ...this.redraw(camera), resource });
  }

  addDetailBatch(batch, vertices) {
    const existing = this.detailResources.get(batch.id);
    if (existing) {
      return existing;
    }
    if (
      vertices.vertexCount !== batch.vertexCount ||
      vertices.byteLength !== batch.vertexCount * VERTEX_STRIDE
    ) {
      throw new Error(`GPU detail batch ${batch.id} has an invalid vertex payload`);
    }
    const entry = Object.freeze({
      batch,
      resource: this.uploadVertices(vertices.buffer),
      byteLength: vertices.byteLength,
    });
    this.detailResources.set(batch.id, entry);
    return entry;
  }

  deleteDetailBatch(batchId) {
    const entry = this.detailResources.get(batchId);
    if (!entry) {
      return false;
    }
    this.detailResources.delete(batchId);
    this.deleteVertices(entry.resource);
    return true;
  }

  setDetailSelections(candidates) {
    this.detailSelections = new Map(
      candidates.map((candidate) => [candidate.batch.id, candidate]),
    );
  }

  drawBatch(
    batch,
    resource,
    instanceGraph,
    camera,
    metrics,
    {
      detail = false,
      firstVertex = batch.firstVertex,
      instanceIndices = null,
    } = {},
  ) {
    const gl = this.gl;
    const instances = instancesForBatch(batch, instanceGraph);
    const totalInstances = instanceIndices?.length ?? instances.count;
    if (totalInstances === 0) {
      return;
    }
    gl.bindVertexArray(resource.vertexArray);
    for (
      let firstInstance = 0;
      firstInstance < totalInstances;
      firstInstance += MAX_INSTANCES_PER_DRAW
    ) {
      const instanceCount = Math.min(
        MAX_INSTANCES_PER_DRAW,
        totalInstances - firstInstance,
      );
      const packed = new Float32Array(instanceCount * 16);
      for (let index = 0; index < instanceCount; index += 1) {
        const matrixIndex =
          instanceIndices?.[firstInstance + index] ?? firstInstance + index;
        if (matrixIndex >= instances.count) {
          throw new Error(
            `GPU batch ${batch.id} references an invalid instance index`,
          );
        }
        batchRelativeInstanceMatrix(
          instances.data,
          batch.origin,
          camera.origin,
          matrixIndex * 16,
          packed,
          index * 16,
        );
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, packed, gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(
        gl.LINES,
        firstVertex,
        batch.vertexCount,
        instanceCount,
      );
      metrics.drawCalls += 1;
      metrics.submittedInstances += instanceCount;
      metrics.submittedVertices += batch.vertexCount * instanceCount;
      metrics.instanceUploadBytes += packed.byteLength;
      metrics.maximumInstanceBufferBytes = Math.max(
        metrics.maximumInstanceBufferBytes,
        packed.byteLength,
      );
      if (detail) {
        metrics.detailDrawCalls += 1;
        metrics.detailSubmittedVertices += batch.vertexCount * instanceCount;
      }
    }
  }

  redraw(view = this.overviewScene?.camera) {
    if (!this.overviewScene || !view) {
      throw new Error("cannot redraw before the overview is initialized");
    }
    const gl = this.gl;
    const size = this.resize();
    const camera = makeCameraFromView(
      view.origin,
      view.worldHeight,
      size.width,
      size.height,
    );
    let cachedDetailGpuBytes = 0;
    for (const entry of this.detailResources.values()) {
      cachedDetailGpuBytes += entry.byteLength;
    }
    const metrics = {
      drawCalls: 0,
      detailDrawCalls: 0,
      detailBatches: 0,
      submittedInstances: 0,
      submittedVertices: 0,
      detailSubmittedVertices: 0,
      instanceUploadBytes: 0,
      maximumInstanceBufferBytes: 0,
      gpuVertexBytes:
        this.overviewScene.resource.byteLength + cachedDetailGpuBytes,
      cachedDetailGpuBytes,
      cachedDetailBatches: this.detailResources.size,
      bounds: this.overviewScene.bounds,
      camera,
    };

    gl.clearColor(0.055, 0.063, 0.075, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.projectionLocation, false, camera.projection);
    gl.uniform1i(this.layerCountLocation, this.layerCount);
    gl.uniform1i(this.layerTextureLocation, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTexture);

    for (const batch of this.overviewScene.batches) {
      if (batch.lodLevel !== 0) {
        break;
      }
      this.drawBatch(
        batch,
        this.overviewScene.resource,
        this.overviewScene.instanceGraph,
        camera,
        metrics,
      );
    }
    for (const [batchId, candidate] of this.detailSelections) {
      const entry = this.detailResources.get(batchId);
      if (!entry) {
        continue;
      }
      this.drawBatch(
        entry.batch,
        entry.resource,
        this.overviewScene.instanceGraph,
        camera,
        metrics,
        {
          detail: true,
          firstVertex: 0,
          instanceIndices: candidate.instanceIndices,
        },
      );
      metrics.detailBatches += 1;
    }
    gl.bindVertexArray(null);
    return Object.freeze(metrics);
  }

  dispose() {
    for (const resource of [...this.vertexResources]) {
      this.deleteVertices(resource);
    }
    this.gl.deleteBuffer(this.instanceBuffer);
    this.gl.deleteTexture(this.layerTexture);
    this.gl.deleteProgram(this.program);
    this.detailResources.clear();
    this.detailSelections.clear();
    this.overviewScene = null;
  }
}

export {
  MAX_INSTANCES_PER_DRAW,
  calculateOverviewBounds,
  instancesForBatch,
  makeCamera,
  makeCameraFromView,
};

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
const FILL_VERTEX_STRIDE = 32;
const INSTANCE_STRIDE = 64;
const MAX_INSTANCES_PER_DRAW = 16_384;
const MAX_PRIMITIVE_GPU_BYTES = 32 * 1024 * 1024;
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
  if (
    v_layerIndex < uint(u_layerCount) &&
    texelFetch(u_layerColors, ivec2(int(v_layerIndex), 0), 0).a <= 0.0
  ) discard;
  outColor = resolveColor();
  if (outColor.a <= 0.0) discard;
}
`;

const FILL_VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec3 a_localPosition;
layout(location = 1) in uint a_layerIndex;
layout(location = 2) in uint a_firstColor;
layout(location = 3) in uint a_lastColor;
layout(location = 4) in float a_mix;
layout(location = 5) in uint a_style;
layout(location = 6) in mat4 a_instanceMatrix;

uniform mat4 u_projection;

flat out uint v_layerIndex;
flat out uint v_firstColor;
flat out uint v_lastColor;
flat out uint v_style;
out float v_mix;

void main() {
  gl_Position = u_projection * a_instanceMatrix * vec4(a_localPosition, 1.0);
  v_layerIndex = a_layerIndex;
  v_firstColor = a_firstColor;
  v_lastColor = a_lastColor;
  v_style = a_style;
  v_mix = a_mix;
}
`;

const FILL_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

flat in uint v_layerIndex;
flat in uint v_firstColor;
flat in uint v_lastColor;
flat in uint v_style;
in float v_mix;

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

vec4 resolveColor(uint encodedColor) {
  uint kind = encodedColor >> 30u;
  if (kind == 0u) {
    if (v_layerIndex >= uint(u_layerCount)) return vec4(0.92, 0.92, 0.92, 1.0);
    return texelFetch(u_layerColors, ivec2(int(v_layerIndex), 0), 0);
  }
  if (kind == 1u) return vec4(0.92, 0.92, 0.92, 1.0);
  if (kind == 2u) return vec4(aciColor(encodedColor & 255u), 1.0);
  return vec4(
    float((encodedColor >> 16u) & 255u) / 255.0,
    float((encodedColor >> 8u) & 255u) / 255.0,
    float(encodedColor & 255u) / 255.0,
    1.0
  );
}

void main() {
  if ((v_style & (1u << 16u)) != 0u) discard;
  if (
    v_layerIndex < uint(u_layerCount) &&
    texelFetch(u_layerColors, ivec2(int(v_layerIndex), 0), 0).a <= 0.0
  ) discard;
  vec4 firstColor = resolveColor(v_firstColor);
  vec4 lastColor = resolveColor(v_lastColor);
  outColor = mix(firstColor, lastColor, clamp(v_mix, 0.0, 1.0));
  if (outColor.a <= 0.0) discard;
}
`;

const POINT_VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec3 a_localPosition;
layout(location = 1) in uint a_encodedColor;
layout(location = 2) in uint a_layerIndex;
layout(location = 3) in uint a_style;
layout(location = 4) in float a_angle;
layout(location = 5) in float a_displaySize;
layout(location = 6) in mat4 a_instanceMatrix;

uniform mat4 u_projection;
uniform float u_viewportHeight;
uniform float u_pixelsPerWorld;

flat out uint v_encodedColor;
flat out uint v_layerIndex;
flat out uint v_style;
flat out float v_angle;
flat out float v_markerSize;

void main() {
  gl_Position = u_projection * a_instanceMatrix * vec4(a_localPosition, 1.0);
  uint mode = a_style & 65535u;
  float markerSize =
    a_displaySize > 0.0
      ? a_displaySize * u_pixelsPerWorld
      : (a_displaySize < 0.0
          ? -a_displaySize * u_viewportHeight * 0.01
          : u_viewportHeight * 0.05);
  gl_PointSize = mode == 0u
    ? 3.0
    : clamp(markerSize, 5.0, 64.0);
  v_encodedColor = a_encodedColor;
  v_layerIndex = a_layerIndex;
  v_style = a_style;
  v_angle = a_angle;
  v_markerSize = gl_PointSize;
}
`;

const POINT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

flat in uint v_encodedColor;
flat in uint v_layerIndex;
flat in uint v_style;
flat in float v_angle;
flat in float v_markerSize;

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
  if (
    v_layerIndex < uint(u_layerCount) &&
    texelFetch(u_layerColors, ivec2(int(v_layerIndex), 0), 0).a <= 0.0
  ) discard;

  uint mode = v_style & 65535u;
  if (mode == 1u) discard;
  vec2 point = gl_PointCoord * 2.0 - 1.0;
  float cosine = cos(v_angle);
  float sine = sin(v_angle);
  point = mat2(cosine, -sine, sine, cosine) * point;
  float lineWidth = clamp(2.0 / max(v_markerSize, 1.0), 0.04, 0.2);
  uint base = mode & 31u;
  bool visible = false;
  if (base == 0u) {
    visible = length(point) <= 0.35;
  } else if (base == 2u) {
    visible = min(abs(point.x), abs(point.y)) <= lineWidth;
  } else if (base == 3u) {
    visible =
      min(abs(point.x - point.y), abs(point.x + point.y)) <=
      lineWidth * 1.41421356;
  } else if (base == 4u) {
    visible = abs(point.x) <= lineWidth && point.y >= -lineWidth;
  } else {
    visible = length(point) <= 0.2;
  }
  if ((mode & 32u) != 0u) {
    visible = visible || abs(length(point) - 0.78) <= lineWidth;
  }
  if ((mode & 64u) != 0u) {
    visible =
      visible || abs(max(abs(point.x), abs(point.y)) - 0.78) <= lineWidth;
  }
  if (!visible) discard;
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

function createProgram(
  gl,
  vertexSource = VERTEX_SHADER,
  fragmentSource = FRAGMENT_SHADER,
) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
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

function makeLayerPixels(layers, visibility) {
  const pixels = new Uint8Array(Math.max(layers.length, 1) * 4);
  if (layers.length === 0) {
    pixels.set([235, 235, 235, 255]);
    return pixels;
  }
  for (let index = 0; index < layers.length; index += 1) {
    const [red, green, blue] = decodeColor(layers[index].color);
    pixels.set(
      [red, green, blue, visibility[index] ? 255 : 0],
      index * 4,
    );
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

function validatePackedScene(
  scene,
  verticesPerPrimitive,
  label,
) {
  if (
    !scene ||
    !Array.isArray(scene.batches) ||
    !scene.vertices ||
    !(scene.vertices.buffer instanceof ArrayBuffer) ||
    scene.vertices.byteLength !==
      scene.vertices.vertexCount * VERTEX_STRIDE ||
    scene.vertices.buffer.byteLength !== scene.vertices.byteLength
  ) {
    throw new Error(`${label} vertex payload is inconsistent`);
  }
  let expectedFirstVertex = 0;
  for (const batch of scene.batches) {
    if (
      batch.firstVertex !== expectedFirstVertex ||
      batch.vertexCount <= 0 ||
      batch.vertexCount % verticesPerPrimitive !== 0
    ) {
      throw new Error(`${label} batch ${batch.id} has an invalid range`);
    }
    expectedFirstVertex += batch.vertexCount;
  }
  if (expectedFirstVertex !== scene.vertices.vertexCount) {
    throw new Error(`${label} batches do not cover the vertex buffer`);
  }
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
    this.fillProgram = createProgram(
      gl,
      FILL_VERTEX_SHADER,
      FILL_FRAGMENT_SHADER,
    );
    this.pointProgram = createProgram(
      gl,
      POINT_VERTEX_SHADER,
      POINT_FRAGMENT_SHADER,
    );
    this.instanceBuffer = gl.createBuffer();
    this.layerTexture = gl.createTexture();
    this.vertexResources = new Set();
    this.detailResources = new Map();
    this.detailSelections = new Map();
    this.overviewScene = null;
    this.hatchFillScene = null;
    this.hatchPatternScene = null;
    this.pointScene = null;
    this.solidFillScene = null;
    this.solidOutlineScene = null;
    this.primitiveMetrics = null;
    this.textOverlay = null;
    if (!this.instanceBuffer || !this.layerTexture) {
      throw new Error("cannot allocate WebGL buffers");
    }
    this.projectionLocation = gl.getUniformLocation(this.program, "u_projection");
    this.layerCountLocation = gl.getUniformLocation(this.program, "u_layerCount");
    this.layerTextureLocation = gl.getUniformLocation(this.program, "u_layerColors");
    this.fillProjectionLocation = gl.getUniformLocation(
      this.fillProgram,
      "u_projection",
    );
    this.fillLayerCountLocation = gl.getUniformLocation(
      this.fillProgram,
      "u_layerCount",
    );
    this.fillLayerTextureLocation = gl.getUniformLocation(
      this.fillProgram,
      "u_layerColors",
    );
    this.pointProjectionLocation = gl.getUniformLocation(
      this.pointProgram,
      "u_projection",
    );
    this.pointLayerCountLocation = gl.getUniformLocation(
      this.pointProgram,
      "u_layerCount",
    );
    this.pointLayerTextureLocation = gl.getUniformLocation(
      this.pointProgram,
      "u_layerColors",
    );
    this.pointViewportHeightLocation = gl.getUniformLocation(
      this.pointProgram,
      "u_viewportHeight",
    );
    this.pointPixelsPerWorldLocation = gl.getUniformLocation(
      this.pointProgram,
      "u_pixelsPerWorld",
    );
    this.layerCount = 0;
    this.layers = Object.freeze([]);
    this.layerVisibility = [];
  }

  setLayers(layers) {
    this.layers = layers;
    this.layerVisibility = layers.map((layer) => (layer.flags & 0b11) === 0);
    this.uploadLayerTexture();
  }

  uploadLayerTexture() {
    const gl = this.gl;
    const pixels = makeLayerPixels(this.layers, this.layerVisibility);
    this.layerCount = this.layers.length;
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
      Math.max(this.layers.length, 1),
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
  }

  getLayerVisibility() {
    return [...this.layerVisibility];
  }

  setLayerVisibility(layerIndex, visible) {
    if (
      !Number.isInteger(layerIndex) ||
      layerIndex < 0 ||
      layerIndex >= this.layerVisibility.length
    ) {
      throw new RangeError(`invalid layer index ${layerIndex}`);
    }
    this.layerVisibility[layerIndex] = Boolean(visible);
    this.uploadLayerTexture();
  }

  setAllLayersVisible(visible) {
    this.layerVisibility.fill(Boolean(visible));
    this.uploadLayerTexture();
  }

  setTextOverlay(overlay) {
    if (this.textOverlay && this.textOverlay !== overlay) {
      this.textOverlay.dispose();
    }
    this.textOverlay = overlay ?? null;
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

  uploadHatchFillVertices(arrayBuffer) {
    const gl = this.gl;
    const vertexBuffer = gl.createBuffer();
    const vertexArray = gl.createVertexArray();
    if (!vertexBuffer || !vertexArray) {
      throw new Error("cannot allocate HATCH fill WebGL resources");
    }
    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, arrayBuffer, gl.STATIC_DRAW);

    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, FILL_VERTEX_STRIDE, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(
      1,
      1,
      gl.UNSIGNED_INT,
      FILL_VERTEX_STRIDE,
      12,
    );
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(
      2,
      1,
      gl.UNSIGNED_INT,
      FILL_VERTEX_STRIDE,
      16,
    );
    gl.enableVertexAttribArray(3);
    gl.vertexAttribIPointer(
      3,
      1,
      gl.UNSIGNED_INT,
      FILL_VERTEX_STRIDE,
      20,
    );
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, FILL_VERTEX_STRIDE, 24);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribIPointer(
      5,
      1,
      gl.UNSIGNED_INT,
      FILL_VERTEX_STRIDE,
      28,
    );

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    for (let column = 0; column < 4; column += 1) {
      const location = 6 + column;
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

  uploadPointVertices(arrayBuffer) {
    const gl = this.gl;
    const vertexBuffer = gl.createBuffer();
    const vertexArray = gl.createVertexArray();
    if (!vertexBuffer || !vertexArray) {
      throw new Error("cannot allocate POINT WebGL resources");
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
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, VERTEX_STRIDE, 20);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, VERTEX_STRIDE, 24);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    for (let column = 0; column < 4; column += 1) {
      const location = 6 + column;
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

  setHatchFills({ batches, vertices, metrics = null }) {
    if (
      !vertices ||
      vertices.byteLength !== vertices.vertexCount * FILL_VERTEX_STRIDE ||
      vertices.buffer.byteLength !== vertices.byteLength
    ) {
      throw new Error("HATCH fill vertex payload is inconsistent");
    }
    let expectedFirstVertex = 0;
    for (const batch of batches) {
      if (
        batch.firstVertex !== expectedFirstVertex ||
        batch.vertexCount % 3 !== 0
      ) {
        throw new Error(`HATCH fill batch ${batch.id} has an invalid range`);
      }
      expectedFirstVertex += batch.vertexCount;
    }
    if (expectedFirstVertex !== vertices.vertexCount) {
      throw new Error("HATCH fill batches do not cover the vertex buffer");
    }
    if (this.hatchFillScene?.resource) {
      this.deleteVertices(this.hatchFillScene.resource);
    }
    const resource =
      vertices.byteLength > 0
        ? this.uploadHatchFillVertices(vertices.buffer)
        : null;
    this.hatchFillScene = Object.freeze({
      batches,
      metrics,
      resource,
    });
  }

  setHatchPatterns({ batches, vertices, metrics = null }) {
    if (
      !vertices ||
      vertices.byteLength !== vertices.vertexCount * VERTEX_STRIDE ||
      vertices.buffer.byteLength !== vertices.byteLength
    ) {
      throw new Error("HATCH pattern vertex payload is inconsistent");
    }
    let expectedFirstVertex = 0;
    for (const batch of batches) {
      if (
        batch.firstVertex !== expectedFirstVertex ||
        batch.vertexCount % 2 !== 0
      ) {
        throw new Error(`HATCH pattern batch ${batch.id} has an invalid range`);
      }
      expectedFirstVertex += batch.vertexCount;
    }
    if (expectedFirstVertex !== vertices.vertexCount) {
      throw new Error("HATCH pattern batches do not cover the vertex buffer");
    }
    if (this.hatchPatternScene?.resource) {
      this.deleteVertices(this.hatchPatternScene.resource);
    }
    const resource =
      vertices.byteLength > 0 ? this.uploadVertices(vertices.buffer) : null;
    this.hatchPatternScene = Object.freeze({
      batches,
      metrics,
      resource,
    });
  }

  setPrimitiveMeshes({
    points,
    solidFills,
    solidOutlines,
    metrics = null,
  }) {
    validatePackedScene(points, 1, "POINT");
    validatePackedScene(solidFills, 3, "SOLID fill");
    validatePackedScene(solidOutlines, 2, "surface outline");
    const gpuBytes =
      points.vertices.byteLength +
      solidFills.vertices.byteLength +
      solidOutlines.vertices.byteLength;
    if (gpuBytes > MAX_PRIMITIVE_GPU_BYTES) {
      throw new Error(
        `primitive GPU payload exceeds the ${MAX_PRIMITIVE_GPU_BYTES}-byte limit`,
      );
    }
    for (const scene of [
      this.pointScene,
      this.solidFillScene,
      this.solidOutlineScene,
    ]) {
      if (scene?.resource) {
        this.deleteVertices(scene.resource);
      }
    }
    this.pointScene = Object.freeze({
      batches: points.batches,
      resource:
        points.vertices.byteLength > 0
          ? this.uploadPointVertices(points.vertices.buffer)
          : null,
    });
    this.solidFillScene = Object.freeze({
      batches: solidFills.batches,
      resource:
        solidFills.vertices.byteLength > 0
          ? this.uploadHatchFillVertices(solidFills.vertices.buffer)
          : null,
    });
    this.solidOutlineScene = Object.freeze({
      batches: solidOutlines.batches,
      resource:
        solidOutlines.vertices.byteLength > 0
          ? this.uploadVertices(solidOutlines.vertices.buffer)
          : null,
    });
    this.primitiveMetrics = metrics;
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
      fill = false,
      pattern = false,
      point = false,
      solidFill = false,
      solidOutline = false,
      firstVertex = batch.firstVertex,
      instanceIndices = null,
      primitive = this.gl.LINES,
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
        primitive,
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
      if (fill) {
        metrics.hatchFillDrawCalls += 1;
        metrics.hatchFillSubmittedVertices +=
          batch.vertexCount * instanceCount;
      }
      if (pattern) {
        metrics.hatchPatternDrawCalls += 1;
        metrics.hatchPatternSubmittedVertices +=
          batch.vertexCount * instanceCount;
      }
      if (point) {
        metrics.pointDrawCalls += 1;
        metrics.pointSubmittedVertices += batch.vertexCount * instanceCount;
      }
      if (solidFill) {
        metrics.solidFillDrawCalls += 1;
        metrics.solidFillSubmittedVertices +=
          batch.vertexCount * instanceCount;
      }
      if (solidOutline) {
        metrics.solidOutlineDrawCalls += 1;
        metrics.solidOutlineSubmittedVertices +=
          batch.vertexCount * instanceCount;
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
    const hatchFillGpuBytes = this.hatchFillScene?.resource?.byteLength ?? 0;
    const hatchPatternGpuBytes =
      this.hatchPatternScene?.resource?.byteLength ?? 0;
    const pointGpuBytes = this.pointScene?.resource?.byteLength ?? 0;
    const solidFillGpuBytes =
      this.solidFillScene?.resource?.byteLength ?? 0;
    const solidOutlineGpuBytes =
      this.solidOutlineScene?.resource?.byteLength ?? 0;
    const metrics = {
      drawCalls: 0,
      detailDrawCalls: 0,
      detailBatches: 0,
      hatchFillDrawCalls: 0,
      hatchFillSubmittedVertices: 0,
      hatchFillGpuBytes,
      hatchFill: this.hatchFillScene?.metrics ?? null,
      hatchPatternDrawCalls: 0,
      hatchPatternSubmittedVertices: 0,
      hatchPatternGpuBytes,
      hatchPattern: this.hatchPatternScene?.metrics ?? null,
      pointDrawCalls: 0,
      pointSubmittedVertices: 0,
      pointGpuBytes,
      solidFillDrawCalls: 0,
      solidFillSubmittedVertices: 0,
      solidFillGpuBytes,
      solidOutlineDrawCalls: 0,
      solidOutlineSubmittedVertices: 0,
      solidOutlineGpuBytes,
      primitives: this.primitiveMetrics,
      submittedInstances: 0,
      submittedVertices: 0,
      detailSubmittedVertices: 0,
      instanceUploadBytes: 0,
      maximumInstanceBufferBytes: 0,
      gpuVertexBytes:
        this.overviewScene.resource.byteLength +
        cachedDetailGpuBytes +
        hatchFillGpuBytes +
        hatchPatternGpuBytes +
        pointGpuBytes +
        solidFillGpuBytes +
        solidOutlineGpuBytes,
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
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTexture);

    if (
      this.solidFillScene?.resource ||
      this.hatchFillScene?.resource
    ) {
      gl.useProgram(this.fillProgram);
      gl.uniformMatrix4fv(
        this.fillProjectionLocation,
        false,
        camera.projection,
      );
      gl.uniform1i(this.fillLayerCountLocation, this.layerCount);
      gl.uniform1i(this.fillLayerTextureLocation, 0);
      if (this.solidFillScene?.resource) {
        for (const batch of this.solidFillScene.batches) {
          this.drawBatch(
            batch,
            this.solidFillScene.resource,
            this.overviewScene.instanceGraph,
            camera,
            metrics,
            {
              solidFill: true,
              primitive: gl.TRIANGLES,
            },
          );
        }
      }
      if (this.hatchFillScene?.resource) {
        for (const batch of this.hatchFillScene.batches) {
          this.drawBatch(
            batch,
            this.hatchFillScene.resource,
            this.overviewScene.instanceGraph,
            camera,
            metrics,
            {
              fill: true,
              primitive: gl.TRIANGLES,
            },
          );
        }
      }
    }

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.projectionLocation, false, camera.projection);
    gl.uniform1i(this.layerCountLocation, this.layerCount);
    gl.uniform1i(this.layerTextureLocation, 0);
    if (this.hatchPatternScene?.resource) {
      for (const batch of this.hatchPatternScene.batches) {
        this.drawBatch(
          batch,
          this.hatchPatternScene.resource,
          this.overviewScene.instanceGraph,
          camera,
          metrics,
          {
            pattern: true,
            instanceIndices: batch.instanceIndices,
          },
        );
      }
    }
    if (this.solidOutlineScene?.resource) {
      for (const batch of this.solidOutlineScene.batches) {
        this.drawBatch(
          batch,
          this.solidOutlineScene.resource,
          this.overviewScene.instanceGraph,
          camera,
          metrics,
          {
            solidOutline: true,
          },
        );
      }
    }
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
    if (this.pointScene?.resource) {
      gl.useProgram(this.pointProgram);
      gl.uniformMatrix4fv(
        this.pointProjectionLocation,
        false,
        camera.projection,
      );
      gl.uniform1i(this.pointLayerCountLocation, this.layerCount);
      gl.uniform1i(this.pointLayerTextureLocation, 0);
      gl.uniform1f(this.pointViewportHeightLocation, camera.height);
      gl.uniform1f(
        this.pointPixelsPerWorldLocation,
        camera.height / camera.worldHeight,
      );
      for (const batch of this.pointScene.batches) {
        this.drawBatch(
          batch,
          this.pointScene.resource,
          this.overviewScene.instanceGraph,
          camera,
          metrics,
          {
            point: true,
            primitive: gl.POINTS,
          },
        );
      }
    }
    gl.bindVertexArray(null);
    metrics.text = this.textOverlay?.redraw(camera, this.layerVisibility) ?? null;
    return Object.freeze(metrics);
  }

  dispose() {
    for (const resource of [...this.vertexResources]) {
      this.deleteVertices(resource);
    }
    this.gl.deleteBuffer(this.instanceBuffer);
    this.gl.deleteTexture(this.layerTexture);
    this.gl.deleteProgram(this.program);
    this.gl.deleteProgram(this.fillProgram);
    this.gl.deleteProgram(this.pointProgram);
    this.detailResources.clear();
    this.detailSelections.clear();
    this.textOverlay?.dispose();
    this.textOverlay = null;
    this.hatchFillScene = null;
    this.hatchPatternScene = null;
    this.pointScene = null;
    this.solidFillScene = null;
    this.solidOutlineScene = null;
    this.primitiveMetrics = null;
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

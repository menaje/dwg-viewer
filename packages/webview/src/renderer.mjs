import { GpuLineBatchKind } from "./scene-cache.mjs";
import {
  curveRefinementCameraKey,
  MAX_CURVE_REFINEMENT_BATCH_BYTES,
  MAX_CURVE_REFINEMENT_GPU_BYTES,
} from "./curve-contract.mjs";
import {
  cadColorAci,
  decodeCadColor,
  decodeCadOpacity,
  DEFAULT_ACI_PALETTE,
} from "./cad-color.mjs";
import { makeLinetypeTextureData } from "./cad-linetype.mjs";
import {
  batchRelativeInstanceMatrix,
  boundsAreFinite,
  emptyBounds3,
  identityMat4,
  includeTransformedBounds,
  orthographic2D,
  packedBoundsIntersect2D,
  transformedBounds2D,
} from "./math.mjs";
import {
  encodeMaskBucket,
  MAX_GLOBAL_MASK_BUCKET,
  maskBucketFor,
} from "./mask-order.mjs";
import { effectiveClipBounds } from "./instance-graph.mjs";
import {
  RENDER_IDENTITY_RANGE_WORDS,
  validateRenderIdentityRanges,
} from "./render-identity-ranges.mjs";
import {
  dwgRenderDeltaTextByteLength,
  isNormalizedDwgRenderDeltaTextRecord,
} from "./render-delta-text.mjs";
import {
  dwgRenderDeltaStyleByteLength,
  indexDwgRenderDeltaStyles,
  isNormalizedDwgRenderDeltaStyleRecord,
  renderDeltaInstanceStyle,
} from "./render-delta-style.mjs";
import {
  dwgRenderDeltaTransformByteLength,
  indexDwgRenderDeltaTransforms,
  isNormalizedDwgRenderDeltaTransformRecord,
  renderDeltaInstanceTransform,
} from "./render-delta-transform.mjs";

const VERTEX_STRIDE = 36;
const FILL_VERTEX_STRIDE = 32;
const PRIMITIVE_VERTEX_STRIDE = 32;
const INSTANCE_VALUES = 23;
const INSTANCE_STRIDE = INSTANCE_VALUES * 4;
const CLIP_ID_BITS = 16;
const MAX_PACKED_CLIP_ID = (1 << CLIP_ID_BITS) - 1;
const MAX_VISIBILITY_ROWS = 256;
const CLIP_TEXTURE_WIDTH = 1024;
const MAX_INSTANCES_PER_DRAW = 16_384;
const MAX_PRIMITIVE_GPU_BYTES = 40 * 1024 * 1024;
const MAX_EXTERNAL_OVERVIEW_GPU_BYTES = 32 * 1024 * 1024;
const MAX_EXTERNAL_DETAIL_GPU_BYTES = 32 * 1024 * 1024;
const MAX_RENDER_DELTA_GPU_BYTES = 64 * 1024 * 1024;
const MAX_RENDER_DELTA_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_RENDER_DELTA_TRANSFORM_BYTES = 8 * 1024 * 1024;
const MAX_RENDER_DELTA_STYLE_BYTES = 8 * 1024 * 1024;
const ROOT_RENDER_DELTA_SCENE_ID = "root";
const INTERACTIVE_MINIMUM_PIXEL_SPAN = 0.75;
const EMPTY_INSTANCE_INDICES = new Uint32Array(0);
const MODEL_INSTANCES = Object.freeze({
  data: identityMat4(),
  maskBases: new Uint32Array([0]),
  clipIds: new Uint32Array([0]),
  colors: new Uint32Array([(2 << 30) | 7]),
  layerIndices: new Uint32Array([0xffffffff]),
  opacities: new Float32Array([1]),
  lineWeights: new Int16Array([-3]),
  linetypeCodes: new Uint16Array([2]),
  visibilityRows: new Uint32Array([0]),
  count: 1,
  length: 1,
});
const EMPTY_INSTANCES = Object.freeze({
  data: new Float64Array(0),
  maskBases: new Uint32Array(0),
  clipIds: new Uint32Array(0),
  colors: new Uint32Array(0),
  layerIndices: new Uint32Array(0),
  opacities: new Float32Array(0),
  lineWeights: new Int16Array(0),
  linetypeCodes: new Uint16Array(0),
  visibilityRows: new Uint32Array(0),
  count: 0,
  length: 0,
});
const EMPTY_PACKED_SCENE = Object.freeze({
  batches: Object.freeze([]),
  vertices: Object.freeze({
    buffer: new ArrayBuffer(0),
    byteLength: 0,
    vertexCount: 0,
  }),
  identityRanges: Object.freeze({
    data: new Uint32Array(0),
    count: 0,
  }),
});

const CLIP_FRAGMENT_SOURCE = `
uniform sampler2D u_clipData;
uniform int u_clipTextureWidth;
uniform int u_clipNodeCount;

vec4 readClipTexel(int index) {
  return texelFetch(
    u_clipData,
    ivec2(index % u_clipTextureWidth, index / u_clipTextureWidth),
    0
  );
}

bool pointInsideClipPolygon(int firstVertex, int vertexCount, vec2 point) {
  bool inside = false;
  vec2 previous = readClipTexel(firstVertex + vertexCount - 1).xy;
  for (int index = 0; index < 256; index++) {
    if (index >= vertexCount) break;
    vec2 current = readClipTexel(firstVertex + index).xy;
    bool crosses =
      (current.y > point.y) != (previous.y > point.y) &&
      point.x <
        (previous.x - current.x) * (point.y - current.y) /
          (previous.y - current.y) +
        current.x;
    if (crosses) inside = !inside;
    previous = current;
  }
  return inside;
}

bool outsideInsertClips(int clipId, vec2 point) {
  int current = clipId;
  for (int depth = 0; depth < 64; depth++) {
    if (current == 0) return false;
    if (current < 0 || current > u_clipNodeCount) return true;
    vec4 header = readClipTexel(current - 1);
    int parent = int(header.x + 0.5);
    int firstVertex = int(header.y + 0.5);
    int vertexCount = int(header.z + 0.5);
    bool inverted = header.w > 0.5;
    bool inside =
      vertexCount >= 3 &&
      pointInsideClipPolygon(firstVertex, vertexCount, point);
    if ((!inverted && !inside) || (inverted && inside)) return true;
    current = parent;
  }
  return current != 0;
}
`;

const CAD_OPACITY_FRAGMENT_SOURCE = `
float layerOpacity(uint layerIndex) {
  if (layerIndex >= uint(u_layerCount)) return 1.0;
  float packed =
    texelFetch(u_layerColors, ivec2(int(layerIndex), 0), 0).a * 255.0;
  if (packed <= 0.5) return 0.0;
  return clamp((packed - 1.0) / 254.0, 0.0, 1.0);
}

float resolveOpacity(uint encodedColor) {
  uint code = (encodedColor >> 24u) & 63u;
  if (code == 0u) return 1.0;
  if (code == 1u) return layerOpacity(resolvedLayerIndex());
  if (code == 2u) return clamp(v_instanceOpacity, 0.0, 1.0);
  return clamp(float(code - 3u) / 60.0, 0.0, 1.0);
}
`;

const VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec3 a_localPosition;
layout(location = 1) in uint a_encodedColor;
layout(location = 2) in uint a_layerIndex;
layout(location = 3) in uint a_style;
layout(location = 4) in mat4 a_instanceMatrix;
layout(location = 8) in float a_maskBase;
layout(location = 9) in float a_clipId;
layout(location = 10) in uint a_instanceColor;
layout(location = 11) in uint a_instanceLayerIndex;
layout(location = 12) in float a_instanceOpacity;
layout(location = 13) in float a_instanceLineWeight;
layout(location = 14) in float a_patternDistance;
layout(location = 15) in uint a_instanceLinetype;

uniform mat4 u_projection;
uniform vec2 u_lineOffset;

flat out uint v_encodedColor;
flat out uint v_layerIndex;
flat out uint v_style;
flat out int v_clipId;
flat out uint v_instanceColor;
flat out uint v_instanceLayerIndex;
flat out float v_instanceOpacity;
flat out float v_instanceLineWeight;
flat out uint v_instanceLinetype;
flat out int v_visibilityRow;
flat out uint v_curveReplacement;
out float v_patternDistance;
out vec2 v_viewPosition;

void main() {
  vec4 viewPosition = a_instanceMatrix * vec4(a_localPosition, 1.0);
  gl_Position = u_projection * viewPosition;
  float orderDepth =
    (a_maskBase + float(a_style >> 17u)) / ${MAX_GLOBAL_MASK_BUCKET}.0;
  gl_Position.z = (orderDepth * 2.0 - 1.0) * gl_Position.w;
  gl_Position.xy += u_lineOffset * gl_Position.w;
  v_encodedColor = a_encodedColor;
  v_layerIndex = a_layerIndex;
  v_style = a_style;
  int packedClipVisibility = int(a_clipId + 0.5);
  v_clipId = packedClipVisibility & ${MAX_PACKED_CLIP_ID};
  v_visibilityRow = packedClipVisibility >> ${CLIP_ID_BITS};
  v_instanceColor = a_instanceColor;
  v_instanceLayerIndex = a_instanceLayerIndex;
  v_instanceOpacity = a_instanceOpacity;
  v_instanceLineWeight = a_instanceLineWeight;
  v_instanceLinetype = a_instanceLinetype;
  v_curveReplacement = a_patternDistance < 0.0 ? 1u : 0u;
  v_patternDistance =
    v_curveReplacement != 0u
      ? -a_patternDistance - 1.0
      : a_patternDistance;
  v_viewPosition = viewPosition.xy;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp isampler2D;
precision highp usampler2D;

flat in uint v_encodedColor;
flat in uint v_layerIndex;
flat in uint v_style;
flat in int v_clipId;
flat in uint v_instanceColor;
flat in uint v_instanceLayerIndex;
flat in float v_instanceOpacity;
flat in float v_instanceLineWeight;
flat in uint v_instanceLinetype;
flat in int v_visibilityRow;
flat in uint v_curveReplacement;
in float v_patternDistance;
in vec2 v_viewPosition;

uniform sampler2D u_layerColors;
uniform sampler2D u_aciColors;
uniform isampler2D u_layerLineWeights;
uniform isampler2D u_plotStyleLineWeights;
uniform usampler2D u_layerPlotStyleIndices;
uniform usampler2D u_layerLinetypes;
uniform sampler2D u_linetypeHeaders;
uniform sampler2D u_linetypeDashes;
uniform usampler2D u_viewportLayerVisibility;
uniform int u_layerCount;
uniform int u_linetypeCount;
uniform int u_layerZeroIndex;
uniform bool u_plotStylesEnabled;
uniform bool u_curveReplacementEnabled;
uniform float u_lineWeightThreshold;
uniform float u_globalLinetypeScale;
uniform float u_worldPerPixel;
${CLIP_FRAGMENT_SOURCE}

out vec4 outColor;

vec3 aciColor(uint index) {
  return texelFetch(u_aciColors, ivec2(int(index), 0), 0).rgb;
}

uint resolvedLayerIndex() {
  return
    u_layerZeroIndex >= 0 &&
    v_layerIndex == uint(u_layerZeroIndex) &&
    v_instanceLayerIndex != 0xffffffffu
      ? v_instanceLayerIndex
      : v_layerIndex;
}

bool layerVisibleInViewport(uint layerIndex) {
  return
    layerIndex >= uint(u_layerCount) ||
    texelFetch(
      u_viewportLayerVisibility,
      ivec2(int(layerIndex), v_visibilityRow),
      0
    ).r != 0u;
}
${CAD_OPACITY_FRAGMENT_SOURCE}

int decodedLineWeight() {
  uint code = v_style & 31u;
  const int values[27] = int[27](
    -3, -2, -1, 0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40,
    50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211
  );
  return code < 27u ? values[int(code)] : -1;
}

uint resolvedPlotStyleIndex() {
  uint kind = v_encodedColor >> 30u;
  if (kind == 2u) return v_encodedColor & 255u;
  if (kind == 1u) {
    uint instanceKind = v_instanceColor >> 30u;
    return instanceKind == 2u ? v_instanceColor & 255u : 0u;
  }
  uint layerIndex = resolvedLayerIndex();
  return layerIndex < uint(u_layerCount)
    ? texelFetch(
        u_layerPlotStyleIndices,
        ivec2(int(layerIndex), 0),
        0
      ).r
    : 0u;
}

int resolvedLineWeight() {
  if (u_plotStylesEnabled) {
    uint plotStyleIndex = resolvedPlotStyleIndex();
    if (plotStyleIndex > 0u && plotStyleIndex < 256u) {
      int overrideValue = texelFetch(
        u_plotStyleLineWeights,
        ivec2(int(plotStyleIndex), 0),
        0
      ).r;
      if (overrideValue >= 0) return overrideValue;
    }
  }
  int value = decodedLineWeight();
  if (value == -1) {
    uint layerIndex = resolvedLayerIndex();
    if (layerIndex < uint(u_layerCount)) {
      value = texelFetch(
        u_layerLineWeights,
        ivec2(int(layerIndex), 0),
        0
      ).r;
    }
  } else if (value == -2) {
    value = int(round(v_instanceLineWeight));
  }
  return value < 0 ? 25 : value;
}

uint resolvedLinetypeCode() {
  uint code = (v_style >> 5u) & 2047u;
  if (code == 0u) {
    uint layerIndex = resolvedLayerIndex();
    return layerIndex < uint(u_layerCount)
      ? texelFetch(u_layerLinetypes, ivec2(int(layerIndex), 0), 0).r
      : 2u;
  }
  if (code == 1u) return max(v_instanceLinetype, 2u);
  return code;
}

bool linetypeVisible() {
  uint code = resolvedLinetypeCode();
  if (code <= 2u || code >= uint(u_linetypeCount)) return true;
  vec4 header =
    texelFetch(u_linetypeHeaders, ivec2(int(code), 0), 0);
  float scale = max(u_globalLinetypeScale, 1.0e-9);
  float patternLength = header.x * scale;
  int firstDash = int(header.y + 0.5);
  int dashCount = int(header.z + 0.5);
  if (patternLength <= 1.0e-9 || dashCount <= 0) return true;
  float phase = mod(max(v_patternDistance, 0.0), patternLength);
  float cursor = 0.0;
  for (int index = 0; index < 64; index++) {
    if (index >= dashCount) break;
    float dash = texelFetch(
      u_linetypeDashes,
      ivec2(firstDash + index, 0),
      0
    ).r;
    if (abs(dash) <= 1.0e-12) {
      if (
        abs(phase - cursor) <= max(u_worldPerPixel * 0.75, 1.0e-9)
      ) return true;
      continue;
    }
    float next = cursor + abs(dash) * scale;
    if (phase >= cursor && phase < next) return dash > 0.0;
    cursor = next;
  }
  return true;
}

float displayedLineWidth() {
  return clamp(
    max(1.0, float(resolvedLineWeight()) / 25.0),
    1.0,
    4.0
  );
}

vec4 resolveColor() {
  uint kind = v_encodedColor >> 30u;
  if (kind == 0u) {
    uint layerIndex = resolvedLayerIndex();
    if (layerIndex >= uint(u_layerCount)) return vec4(1.0);
    return vec4(
      texelFetch(u_layerColors, ivec2(int(layerIndex), 0), 0).rgb,
      1.0
    );
  }
  if (kind == 1u) {
    uint instanceKind = v_instanceColor >> 30u;
    if (instanceKind == 2u) {
      return vec4(aciColor(v_instanceColor & 255u), 1.0);
    }
    if (instanceKind == 3u) {
      return vec4(
        float((v_instanceColor >> 16u) & 255u) / 255.0,
        float((v_instanceColor >> 8u) & 255u) / 255.0,
        float(v_instanceColor & 255u) / 255.0,
        1.0
      );
    }
    return vec4(1.0);
  }
  if (kind == 2u) return vec4(aciColor(v_encodedColor & 255u), 1.0);
  return vec4(
    float((v_encodedColor >> 16u) & 255u) / 255.0,
    float((v_encodedColor >> 8u) & 255u) / 255.0,
    float(v_encodedColor & 255u) / 255.0,
    1.0
  );
}

void main() {
  if (outsideInsertClips(v_clipId, v_viewPosition)) discard;
  if (u_curveReplacementEnabled && v_curveReplacement != 0u) discard;
  if ((v_style & (1u << 16u)) != 0u) discard;
  if (!layerVisibleInViewport(resolvedLayerIndex())) discard;
  if (!linetypeVisible()) discard;
  if (u_lineWeightThreshold > displayedLineWidth()) discard;
  if (
    resolvedLayerIndex() < uint(u_layerCount) &&
    texelFetch(
      u_layerColors,
      ivec2(int(resolvedLayerIndex()), 0),
      0
    ).a <= 0.0
  ) discard;
  outColor = resolveColor();
  outColor.a = resolveOpacity(v_encodedColor);
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
layout(location = 10) in float a_maskBase;
layout(location = 11) in float a_clipId;
layout(location = 12) in uint a_instanceColor;
layout(location = 13) in uint a_instanceLayerIndex;
layout(location = 14) in float a_instanceOpacity;

uniform mat4 u_projection;

flat out uint v_layerIndex;
flat out uint v_firstColor;
flat out uint v_lastColor;
flat out uint v_style;
out float v_mix;
flat out int v_clipId;
flat out uint v_instanceColor;
flat out uint v_instanceLayerIndex;
flat out float v_instanceOpacity;
flat out int v_visibilityRow;
out vec2 v_viewPosition;

void main() {
  vec4 viewPosition = a_instanceMatrix * vec4(a_localPosition, 1.0);
  gl_Position = u_projection * viewPosition;
  float orderDepth =
    (a_maskBase + float(a_style >> 17u)) / ${MAX_GLOBAL_MASK_BUCKET}.0;
  gl_Position.z = (orderDepth * 2.0 - 1.0) * gl_Position.w;
  v_layerIndex = a_layerIndex;
  v_firstColor = a_firstColor;
  v_lastColor = a_lastColor;
  v_style = a_style;
  v_mix = a_mix;
  int packedClipVisibility = int(a_clipId + 0.5);
  v_clipId = packedClipVisibility & ${MAX_PACKED_CLIP_ID};
  v_visibilityRow = packedClipVisibility >> ${CLIP_ID_BITS};
  v_instanceColor = a_instanceColor;
  v_instanceLayerIndex = a_instanceLayerIndex;
  v_instanceOpacity = a_instanceOpacity;
  v_viewPosition = viewPosition.xy;
}
`;

const FILL_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

flat in uint v_layerIndex;
flat in uint v_firstColor;
flat in uint v_lastColor;
flat in uint v_style;
in float v_mix;
flat in int v_clipId;
flat in uint v_instanceColor;
flat in uint v_instanceLayerIndex;
flat in float v_instanceOpacity;
flat in int v_visibilityRow;
in vec2 v_viewPosition;

uniform sampler2D u_layerColors;
uniform sampler2D u_aciColors;
uniform usampler2D u_viewportLayerVisibility;
uniform int u_layerCount;
uniform int u_layerZeroIndex;
${CLIP_FRAGMENT_SOURCE}

out vec4 outColor;

vec3 aciColor(uint index) {
  return texelFetch(u_aciColors, ivec2(int(index), 0), 0).rgb;
}

uint resolvedLayerIndex() {
  return
    u_layerZeroIndex >= 0 &&
    v_layerIndex == uint(u_layerZeroIndex) &&
    v_instanceLayerIndex != 0xffffffffu
      ? v_instanceLayerIndex
      : v_layerIndex;
}

bool layerVisibleInViewport(uint layerIndex) {
  return
    layerIndex >= uint(u_layerCount) ||
    texelFetch(
      u_viewportLayerVisibility,
      ivec2(int(layerIndex), v_visibilityRow),
      0
    ).r != 0u;
}
${CAD_OPACITY_FRAGMENT_SOURCE}

vec4 resolveColor(uint encodedColor) {
  uint kind = encodedColor >> 30u;
  if (kind == 0u) {
    uint layerIndex = resolvedLayerIndex();
    if (layerIndex >= uint(u_layerCount)) return vec4(1.0);
    return vec4(
      texelFetch(u_layerColors, ivec2(int(layerIndex), 0), 0).rgb,
      1.0
    );
  }
  if (kind == 1u) {
    uint instanceKind = v_instanceColor >> 30u;
    if (instanceKind == 2u) {
      return vec4(aciColor(v_instanceColor & 255u), 1.0);
    }
    if (instanceKind == 3u) {
      return vec4(
        float((v_instanceColor >> 16u) & 255u) / 255.0,
        float((v_instanceColor >> 8u) & 255u) / 255.0,
        float(v_instanceColor & 255u) / 255.0,
        1.0
      );
    }
    return vec4(1.0);
  }
  if (kind == 2u) return vec4(aciColor(encodedColor & 255u), 1.0);
  return vec4(
    float((encodedColor >> 16u) & 255u) / 255.0,
    float((encodedColor >> 8u) & 255u) / 255.0,
    float(encodedColor & 255u) / 255.0,
    1.0
  );
}

void main() {
  if (outsideInsertClips(v_clipId, v_viewPosition)) discard;
  if ((v_style & (1u << 16u)) != 0u) discard;
  if (!layerVisibleInViewport(resolvedLayerIndex())) discard;
  if (
    resolvedLayerIndex() < uint(u_layerCount) &&
    texelFetch(
      u_layerColors,
      ivec2(int(resolvedLayerIndex()), 0),
      0
    ).a <= 0.0
  ) discard;
  vec4 firstColor = resolveColor(v_firstColor);
  vec4 lastColor = resolveColor(v_lastColor);
  outColor = mix(firstColor, lastColor, clamp(v_mix, 0.0, 1.0));
  outColor.a = mix(
    resolveOpacity(v_firstColor),
    resolveOpacity(v_lastColor),
    clamp(v_mix, 0.0, 1.0)
  );
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
layout(location = 10) in float a_maskBase;
layout(location = 11) in float a_clipId;
layout(location = 12) in uint a_instanceColor;
layout(location = 13) in uint a_instanceLayerIndex;
layout(location = 14) in float a_instanceOpacity;

uniform mat4 u_projection;
uniform float u_viewportHeight;
uniform float u_pixelsPerWorld;

flat out uint v_encodedColor;
flat out uint v_layerIndex;
flat out uint v_style;
flat out float v_angle;
flat out float v_markerSize;
flat out int v_clipId;
flat out uint v_instanceColor;
flat out uint v_instanceLayerIndex;
flat out float v_instanceOpacity;
flat out int v_visibilityRow;
out vec2 v_viewPosition;

void main() {
  vec4 viewPosition = a_instanceMatrix * vec4(a_localPosition, 1.0);
  gl_Position = u_projection * viewPosition;
  float orderDepth =
    (a_maskBase + float(a_style >> 17u)) / ${MAX_GLOBAL_MASK_BUCKET}.0;
  gl_Position.z = (orderDepth * 2.0 - 1.0) * gl_Position.w;
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
  int packedClipVisibility = int(a_clipId + 0.5);
  v_clipId = packedClipVisibility & ${MAX_PACKED_CLIP_ID};
  v_visibilityRow = packedClipVisibility >> ${CLIP_ID_BITS};
  v_instanceColor = a_instanceColor;
  v_instanceLayerIndex = a_instanceLayerIndex;
  v_instanceOpacity = a_instanceOpacity;
  v_viewPosition = viewPosition.xy;
}
`;

const POINT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

flat in uint v_encodedColor;
flat in uint v_layerIndex;
flat in uint v_style;
flat in float v_angle;
flat in float v_markerSize;
flat in int v_clipId;
flat in uint v_instanceColor;
flat in uint v_instanceLayerIndex;
flat in float v_instanceOpacity;
flat in int v_visibilityRow;
in vec2 v_viewPosition;

uniform sampler2D u_layerColors;
uniform sampler2D u_aciColors;
uniform usampler2D u_viewportLayerVisibility;
uniform int u_layerCount;
uniform int u_layerZeroIndex;
${CLIP_FRAGMENT_SOURCE}

out vec4 outColor;

vec3 aciColor(uint index) {
  return texelFetch(u_aciColors, ivec2(int(index), 0), 0).rgb;
}

uint resolvedLayerIndex() {
  return
    u_layerZeroIndex >= 0 &&
    v_layerIndex == uint(u_layerZeroIndex) &&
    v_instanceLayerIndex != 0xffffffffu
      ? v_instanceLayerIndex
      : v_layerIndex;
}

bool layerVisibleInViewport(uint layerIndex) {
  return
    layerIndex >= uint(u_layerCount) ||
    texelFetch(
      u_viewportLayerVisibility,
      ivec2(int(layerIndex), v_visibilityRow),
      0
    ).r != 0u;
}
${CAD_OPACITY_FRAGMENT_SOURCE}

vec4 resolveColor() {
  uint kind = v_encodedColor >> 30u;
  if (kind == 0u) {
    uint layerIndex = resolvedLayerIndex();
    if (layerIndex >= uint(u_layerCount)) return vec4(1.0);
    return vec4(
      texelFetch(u_layerColors, ivec2(int(layerIndex), 0), 0).rgb,
      1.0
    );
  }
  if (kind == 1u) {
    uint instanceKind = v_instanceColor >> 30u;
    if (instanceKind == 2u) {
      return vec4(aciColor(v_instanceColor & 255u), 1.0);
    }
    if (instanceKind == 3u) {
      return vec4(
        float((v_instanceColor >> 16u) & 255u) / 255.0,
        float((v_instanceColor >> 8u) & 255u) / 255.0,
        float(v_instanceColor & 255u) / 255.0,
        1.0
      );
    }
    return vec4(1.0);
  }
  if (kind == 2u) return vec4(aciColor(v_encodedColor & 255u), 1.0);
  return vec4(
    float((v_encodedColor >> 16u) & 255u) / 255.0,
    float((v_encodedColor >> 8u) & 255u) / 255.0,
    float(v_encodedColor & 255u) / 255.0,
    1.0
  );
}

void main() {
  if (outsideInsertClips(v_clipId, v_viewPosition)) discard;
  if ((v_style & (1u << 16u)) != 0u) discard;
  if (!layerVisibleInViewport(resolvedLayerIndex())) discard;
  if (
    resolvedLayerIndex() < uint(u_layerCount) &&
    texelFetch(
      u_layerColors,
      ivec2(int(resolvedLayerIndex()), 0),
      0
    ).a <= 0.0
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
  outColor.a = resolveOpacity(v_encodedColor);
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

function makeLayerPixels(
  layers,
  visibility,
  palette = DEFAULT_ACI_PALETTE,
) {
  const pixels = new Uint8Array(Math.max(layers.length, 1) * 4);
  if (layers.length === 0) {
    pixels.set([235, 235, 235, 255]);
    return pixels;
  }
  for (let index = 0; index < layers.length; index += 1) {
    const [red, green, blue] = decodeCadColor(layers[index].color, {
      palette,
    });
    const opacity = decodeCadOpacity(layers[index].color);
    const packedOpacity = visibility[index]
      ? 1 + Math.round(opacity * 254)
      : 0;
    pixels.set(
      [red, green, blue, packedOpacity],
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

function normalizePreferredView(view) {
  if (!view) {
    return null;
  }
  if (
    !Array.isArray(view.center) ||
    view.center.length !== 3 ||
    !view.center.every(Number.isFinite) ||
    !Number.isFinite(view.height) ||
    view.height <= 0
  ) {
    throw new TypeError("preferred drawing view is invalid");
  }
  return Object.freeze({
    origin: Object.freeze([...view.center]),
    worldHeight: view.height,
  });
}

function instancesForBatch(batch, instanceGraph) {
  if (batch.kind !== GpuLineBatchKind.BlockDefinition) {
    return instanceGraph.modelInstances ?? MODEL_INSTANCES;
  }
  return (
    instanceGraph.instancesByBlock.get(batch.blockIndex) ?? EMPTY_INSTANCES
  );
}

function interactiveCullContext(camera) {
  const halfWidth = camera.worldWidth * 0.5;
  const halfHeight = camera.worldHeight * 0.5;
  return {
    viewport: {
      min: [
        camera.origin[0] - halfWidth,
        camera.origin[1] - halfHeight,
      ],
      max: [
        camera.origin[0] + halfWidth,
        camera.origin[1] + halfHeight,
      ],
    },
    clipBoundsByGraph: new WeakMap(),
    transformed: new Float64Array(4),
  };
}

function selectInteractiveInstanceIndices(
  batch,
  instanceGraph,
  camera,
  {
    minimumPixelSpan = INTERACTIVE_MINIMUM_PIXEL_SPAN,
    context = interactiveCullContext(camera),
    transformIndex = null,
    styleIndex = null,
  } = {},
) {
  const instances = instancesForBatch(batch, instanceGraph);
  if (instances.count === 0) {
    return EMPTY_INSTANCE_INDICES;
  }
  let clipBoundsCache = context.clipBoundsByGraph.get(instanceGraph);
  if (!clipBoundsCache) {
    clipBoundsCache = new Map();
    context.clipBoundsByGraph.set(instanceGraph, clipBoundsCache);
  }
  const visible = [];
  const pixelsPerWorldX = camera.width / camera.worldWidth;
  const pixelsPerWorldY = camera.height / camera.worldHeight;
  for (let index = 0; index < instances.count; index += 1) {
    if (
      renderDeltaInstanceStyle(styleIndex, instances, index)
        ?.visible === false
    ) {
      continue;
    }
    const clipId = instances.clipIds?.[index] ?? 0;
    let clipBounds = null;
    if (clipId > 0) {
      clipBounds = clipBoundsCache.get(clipId);
      if (clipBounds === undefined) {
        clipBounds = effectiveClipBounds(
          instanceGraph.clipNodes,
          clipId,
        );
        clipBoundsCache.set(clipId, clipBounds);
      }
      if (
        !clipBounds ||
        !(
          clipBounds.max[0] >= context.viewport.min[0] &&
          clipBounds.min[0] <= context.viewport.max[0] &&
          clipBounds.max[1] >= context.viewport.min[1] &&
          clipBounds.min[1] <= context.viewport.max[1]
        )
      ) {
        continue;
      }
    }
    const replacement = renderDeltaInstanceTransform(
      transformIndex,
      instances,
      index,
    );
    const transformed = transformedBounds2D(
      batch.bounds,
      replacement?.matrix ?? instances.data,
      replacement ? 0 : index * 16,
      context.transformed,
    );
    if (clipBounds) {
      transformed[0] = Math.max(transformed[0], clipBounds.min[0]);
      transformed[1] = Math.max(transformed[1], clipBounds.min[1]);
      transformed[2] = Math.min(transformed[2], clipBounds.max[0]);
      transformed[3] = Math.min(transformed[3], clipBounds.max[1]);
    }
    if (
      transformed[0] > transformed[2] ||
      transformed[1] > transformed[3] ||
      !packedBoundsIntersect2D(transformed, context.viewport)
    ) {
      continue;
    }
    const pixelSpan = Math.max(
      (transformed[2] - transformed[0]) * pixelsPerWorldX,
      (transformed[3] - transformed[1]) * pixelsPerWorldY,
    );
    if (pixelSpan < minimumPixelSpan) {
      continue;
    }
    visible.push(index);
  }
  if (visible.length === instances.count) {
    return null;
  }
  return visible.length > 0
    ? Uint32Array.from(visible)
    : EMPTY_INSTANCE_INDICES;
}

function visibleRenderDeltaInstanceIndices(
  instanceIndices,
  instances,
  styleIndex,
) {
  if (!styleIndex?.hiddenInstances?.has(instances)) {
    return instanceIndices;
  }
  const total = instanceIndices?.length ?? instances.count;
  const visible = [];
  for (let index = 0; index < total; index += 1) {
    const instanceIndex = instanceIndices?.[index] ?? index;
    if (
      renderDeltaInstanceStyle(
        styleIndex,
        instances,
        instanceIndex,
      )?.visible !== false
    ) {
      visible.push(instanceIndex);
    }
  }
  if (visible.length === total) {
    return instanceIndices;
  }
  return visible.length > 0
    ? Uint32Array.from(visible)
    : EMPTY_INSTANCE_INDICES;
}

function overlayCameraTransform(anchor, camera, width, height) {
  if (
    !anchor ||
    !camera ||
    !Array.isArray(anchor.origin) ||
    !Array.isArray(camera.origin) ||
    !Number.isFinite(anchor.worldWidth) ||
    anchor.worldWidth <= 0 ||
    !Number.isFinite(anchor.worldHeight) ||
    anchor.worldHeight <= 0 ||
    !Number.isFinite(camera.worldWidth) ||
    camera.worldWidth <= 0 ||
    !Number.isFinite(camera.worldHeight) ||
    camera.worldHeight <= 0 ||
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    throw new TypeError("overlay camera transform requires valid cameras");
  }
  const scaleX = anchor.worldWidth / camera.worldWidth;
  const scaleY = anchor.worldHeight / camera.worldHeight;
  return Object.freeze({
    scaleX,
    scaleY,
    translateX:
      width * 0.5 * (1 - scaleX) +
      ((anchor.origin[0] - camera.origin[0]) / camera.worldWidth) *
        width,
    translateY:
      height * 0.5 * (1 - scaleY) -
      ((anchor.origin[1] - camera.origin[1]) / camera.worldHeight) *
        height,
  });
}

function resetOverlayTransform(overlay) {
  const style = overlay?.canvas?.style;
  if (!style) {
    return false;
  }
  style.transform = "";
  style.transformOrigin = "";
  style.willChange = "";
  return true;
}

function releaseOverlaySnapshot(snapshot) {
  if (!snapshot) {
    return;
  }
  snapshot.width = 1;
  snapshot.height = 1;
}

function createOverlaySnapshotCanvas(canvas, width, height) {
  let snapshot = null;
  if (typeof globalThis.OffscreenCanvas === "function") {
    snapshot = new globalThis.OffscreenCanvas(width, height);
  } else {
    snapshot = canvas?.ownerDocument?.createElement?.("canvas") ?? null;
    if (snapshot) {
      snapshot.width = width;
      snapshot.height = height;
    }
  }
  return snapshot;
}

function captureOverlaySnapshot(overlay, previous = null) {
  const canvas = overlay?.canvas;
  if (
    !canvas ||
    canvas.width <= 0 ||
    canvas.height <= 0 ||
    canvas.clientWidth <= 0 ||
    canvas.clientHeight <= 0
  ) {
    releaseOverlaySnapshot(previous);
    return null;
  }
  const width = Math.max(1, Math.round(canvas.clientWidth));
  const height = Math.max(1, Math.round(canvas.clientHeight));
  const snapshot =
    previous ?? createOverlaySnapshotCanvas(canvas, width, height);
  const context = snapshot?.getContext?.("2d", { alpha: true });
  if (!snapshot || !context) {
    releaseOverlaySnapshot(previous);
    return null;
  }
  if (snapshot.width !== width || snapshot.height !== height) {
    snapshot.width = width;
    snapshot.height = height;
  }
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    canvas,
    0,
    0,
    canvas.width,
    canvas.height,
    0,
    0,
    width,
    height,
  );
  return snapshot;
}

function drawOverlaySnapshot(overlay, snapshot, anchor, camera) {
  const canvas = overlay?.canvas;
  if (
    !canvas ||
    !snapshot ||
    !anchor ||
    canvas.clientWidth <= 0 ||
    canvas.clientHeight <= 0 ||
    snapshot.width <= 0 ||
    snapshot.height <= 0
  ) {
    return false;
  }
  resetOverlayTransform(overlay);
  if (
    canvas.width !== snapshot.width ||
    canvas.height !== snapshot.height
  ) {
    canvas.width = snapshot.width;
    canvas.height = snapshot.height;
  }
  const context = canvas.getContext?.("2d", { alpha: true });
  if (!context) {
    return false;
  }
  const transform = overlayCameraTransform(
    anchor,
    camera,
    canvas.clientWidth,
    canvas.clientHeight,
  );
  const backingScaleX = canvas.width / canvas.clientWidth;
  const backingScaleY = canvas.height / canvas.clientHeight;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  context.filter = "none";
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.setTransform(
    transform.scaleX * (canvas.width / snapshot.width),
    0,
    0,
    transform.scaleY * (canvas.height / snapshot.height),
    transform.translateX * backingScaleX,
    transform.translateY * backingScaleY,
  );
  context.drawImage(snapshot, 0, 0);
  context.setTransform(1, 0, 0, 1, 0, 0);
  return true;
}

function retainOverlayForCamera(
  overlay,
  snapshot,
  anchor,
  camera,
) {
  if (drawOverlaySnapshot(overlay, snapshot, anchor, camera)) {
    return true;
  }
  const canvas = overlay?.canvas;
  const style = canvas?.style;
  if (
    !canvas ||
    !style ||
    !anchor ||
    canvas.clientWidth <= 0 ||
    canvas.clientHeight <= 0
  ) {
    return false;
  }
  const transform = overlayCameraTransform(
    anchor,
    camera,
    canvas.clientWidth,
    canvas.clientHeight,
  );
  style.transformOrigin = "0 0";
  style.willChange = "transform";
  style.transform =
    `matrix(${transform.scaleX},0,0,${transform.scaleY},` +
    `${transform.translateX},${transform.translateY})`;
  return true;
}

function modelOwnerHandle(blocks) {
  const modelBlocks = blocks.filter(
    (block) => block.name.toUpperCase() === "*MODEL_SPACE",
  );
  return modelBlocks.length === 1 ? modelBlocks[0].handle : null;
}

function patchLineMaskBuckets(
  buffer,
  batches,
  maskOrder,
  blocks,
  firstBufferVertex = 0,
) {
  if (!maskOrder?.enabled || buffer.byteLength === 0) {
    return;
  }
  const view = new DataView(buffer);
  const vertexCount = buffer.byteLength / VERTEX_STRIDE;
  const modelHandle = modelOwnerHandle(blocks);
  for (const batch of batches) {
    const first = Math.max(batch.firstVertex, firstBufferVertex);
    const end = Math.min(
      batch.firstVertex + batch.vertexCount,
      firstBufferVertex + vertexCount,
    );
    if (first >= end) {
      continue;
    }
    const ownerHandle =
      batch.blockIndex === null || batch.blockIndex === undefined
        ? modelHandle
        : blocks[batch.blockIndex]?.handle;
    if (ownerHandle === null || ownerHandle === undefined) {
      throw new Error("mask order requires one resolvable model owner");
    }
    for (let vertex = first; vertex < end; vertex += 1) {
      const localVertex = vertex - firstBufferVertex;
      const offset = localVertex * VERTEX_STRIDE;
      const handle =
        BigInt(view.getUint32(offset + 20, true)) |
        (BigInt(view.getUint32(offset + 24, true)) << 32n);
      const bucket = maskBucketFor(maskOrder, ownerHandle, handle);
      const style = view.getUint32(offset + 28, true);
      view.setUint32(
        offset + 28,
        encodeMaskBucket(style, bucket),
        true,
      );
    }
  }
}

function curveHandleSet(handleWords) {
  if (!(handleWords instanceof Uint32Array) || handleWords.length % 2 !== 0) {
    throw new TypeError("curve refinement handles must be low/high u32 pairs");
  }
  const handles = new Set();
  for (let index = 0; index < handleWords.length; index += 2) {
    handles.add(
      BigInt(handleWords[index]) |
        (BigInt(handleWords[index + 1]) << 32n),
    );
  }
  return handles;
}

function patchCurveReplacementMarkers(
  buffer,
  refinedHandles,
  { recordSize = VERTEX_STRIDE } = {},
) {
  if (
    !(buffer instanceof ArrayBuffer) ||
    !(refinedHandles instanceof Set) ||
    recordSize < VERTEX_STRIDE ||
    buffer.byteLength % recordSize !== 0
  ) {
    throw new TypeError("curve replacement marker payload is invalid");
  }
  const view = new DataView(buffer);
  const vertexCount = buffer.byteLength / recordSize;
  let changed = false;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const offset = vertex * recordSize;
    const handle =
      BigInt(view.getUint32(offset + 20, true)) |
      (BigInt(view.getUint32(offset + 24, true)) << 32n);
    const distance = view.getFloat32(offset + 32, true);
    if (!Number.isFinite(distance)) {
      continue;
    }
    const marked = distance < 0;
    const replacement = refinedHandles.has(handle);
    if (marked === replacement) {
      continue;
    }
    view.setFloat32(
      offset + 32,
      -distance - 1,
      true,
    );
    changed = true;
  }
  return changed;
}

function makeClipTexturePayload(instanceGraph, camera) {
  const nodes = instanceGraph?.clipNodes ?? [];
  const vertexCount = nodes.reduce(
    (total, node) => total + node.points.length,
    0,
  );
  const texelCount = Math.max(nodes.length + vertexCount, 1);
  const width = Math.min(CLIP_TEXTURE_WIDTH, texelCount);
  const height = Math.ceil(texelCount / width);
  const data = new Float32Array(width * height * 4);
  let firstVertex = nodes.length;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const offset = index * 4;
    data[offset] = node.parentId;
    data[offset + 1] = firstVertex;
    data[offset + 2] = node.points.length;
    data[offset + 3] = node.inverted ? 1 : 0;
    for (const point of node.points) {
      const vertexOffset = firstVertex * 4;
      data[vertexOffset] = point[0] - camera.origin[0];
      data[vertexOffset + 1] = point[1] - camera.origin[1];
      firstVertex += 1;
    }
  }
  return Object.freeze({
    data,
    width,
    height,
    nodeCount: nodes.length,
    byteLength: data.byteLength,
  });
}

function includeClippedTransformedBounds(
  target,
  source,
  instances,
  instanceIndex,
  instanceGraph,
  clipBoundsCache,
  focusBounds = null,
  focusSearchBounds = null,
) {
  const transformed = emptyBounds3();
  includeTransformedBounds(
    transformed,
    source,
    instances.data,
    instanceIndex * 16,
  );
  const clipId = instances.clipIds?.[instanceIndex] ?? 0;
  if (clipId > 0) {
    let clipBounds = clipBoundsCache.get(clipId);
    if (clipBounds === undefined) {
      clipBounds = effectiveClipBounds(instanceGraph.clipNodes, clipId);
      clipBoundsCache.set(clipId, clipBounds);
    }
    if (!clipBounds) {
      return target;
    }
    transformed.min[0] = Math.max(
      transformed.min[0],
      clipBounds.min[0],
    );
    transformed.min[1] = Math.max(
      transformed.min[1],
      clipBounds.min[1],
    );
    transformed.max[0] = Math.min(
      transformed.max[0],
      clipBounds.max[0],
    );
    transformed.max[1] = Math.min(
      transformed.max[1],
      clipBounds.max[1],
    );
    if (
      transformed.min[0] > transformed.max[0] ||
      transformed.min[1] > transformed.max[1]
    ) {
      return target;
    }
  }
  for (let axis = 0; axis < 3; axis += 1) {
    target.min[axis] = Math.min(target.min[axis], transformed.min[axis]);
    target.max[axis] = Math.max(target.max[axis], transformed.max[axis]);
  }
  if (
    focusBounds &&
    focusSearchBounds &&
    transformed.max[0] >= focusSearchBounds.min[0] &&
    transformed.min[0] <= focusSearchBounds.max[0] &&
    transformed.max[1] >= focusSearchBounds.min[1] &&
    transformed.min[1] <= focusSearchBounds.max[1]
  ) {
    for (let axis = 0; axis < 3; axis += 1) {
      focusBounds.min[axis] = Math.min(
        focusBounds.min[axis],
        transformed.min[axis],
      );
      focusBounds.max[axis] = Math.max(
        focusBounds.max[axis],
        transformed.max[axis],
      );
    }
  }
  return target;
}

function calculateOverviewBounds(batches, instanceGraph) {
  const bounds = emptyBounds3();
  const clipBoundsCache = new Map();
  const rootClips = (instanceGraph.clipNodes ?? []).filter(
    (node) => node.parentId === 0 && !node.inverted,
  );
  const focusBounds = rootClips.length > 0 ? emptyBounds3() : null;
  for (const node of rootClips) {
    focusBounds.min[0] = Math.min(focusBounds.min[0], node.bounds.min[0]);
    focusBounds.min[1] = Math.min(focusBounds.min[1], node.bounds.min[1]);
    focusBounds.min[2] = Math.min(focusBounds.min[2], 0);
    focusBounds.max[0] = Math.max(focusBounds.max[0], node.bounds.max[0]);
    focusBounds.max[1] = Math.max(focusBounds.max[1], node.bounds.max[1]);
    focusBounds.max[2] = Math.max(focusBounds.max[2], 0);
  }
  const focusSearchBounds = focusBounds
    ? {
        min: [
          focusBounds.min[0] - (focusBounds.max[0] - focusBounds.min[0]),
          focusBounds.min[1] - (focusBounds.max[1] - focusBounds.min[1]),
        ],
        max: [
          focusBounds.max[0] + (focusBounds.max[0] - focusBounds.min[0]),
          focusBounds.max[1] + (focusBounds.max[1] - focusBounds.min[1]),
        ],
      }
    : null;
  for (const batch of batches) {
    if (batch.lodLevel !== 0) {
      break;
    }
    const instances = instancesForBatch(batch, instanceGraph);
    for (let index = 0; index < instances.count; index += 1) {
      includeClippedTransformedBounds(
        bounds,
        batch.bounds,
        instances,
        index,
        instanceGraph,
        clipBoundsCache,
        focusBounds,
        focusSearchBounds,
      );
    }
  }
  if (focusBounds && boundsAreFinite(focusBounds)) {
    const fullWidth = bounds.max[0] - bounds.min[0];
    const fullHeight = bounds.max[1] - bounds.min[1];
    const focusWidth = focusBounds.max[0] - focusBounds.min[0];
    const focusHeight = focusBounds.max[1] - focusBounds.min[1];
    if (
      fullWidth > Math.max(focusWidth * 4, 1e-6) ||
      fullHeight > Math.max(focusHeight * 4, 1e-6)
    ) {
      return focusBounds;
    }
  }
  return bounds;
}

function includeFiniteBounds(target, source) {
  if (!source || !boundsAreFinite(source)) {
    return target;
  }
  for (let axis = 0; axis < 3; axis += 1) {
    target.min[axis] = Math.min(target.min[axis], source.min[axis]);
    target.max[axis] = Math.max(target.max[axis], source.max[axis]);
  }
  return target;
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
      scene.vertices.vertexCount * PRIMITIVE_VERTEX_STRIDE ||
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
  validateRenderIdentityRanges(scene.identityRanges, {
    vertexCount: scene.vertices.vertexCount,
    verticesPerPrimitive,
    label: `${label} render identity ranges`,
  });
}

function renderDeltaIdentityKey(sceneId, handleLow, handleHigh) {
  return `${sceneId}\u0000${handleHigh}:${handleLow}`;
}

function normalizeRenderDeltaIdentity(value) {
  const sceneId = String(value?.sceneId ?? "");
  const handleLow = value?.handleLow;
  const handleHigh = value?.handleHigh;
  if (
    sceneId.length === 0 ||
    sceneId.length > 512 ||
    !Number.isInteger(handleLow) ||
    handleLow < 0 ||
    handleLow > 0xffff_ffff ||
    !Number.isInteger(handleHigh) ||
    handleHigh < 0 ||
    handleHigh > 0xffff_ffff
  ) {
    throw new TypeError("render delta identity is invalid");
  }
  return Object.freeze({
    sceneId,
    handleLow,
    handleHigh,
    key: renderDeltaIdentityKey(sceneId, handleLow, handleHigh),
  });
}

function cloneRenderDeltaBatch(
  batch,
  {
    verticesPerPrimitive,
    label,
  },
) {
  if (
    !batch ||
    !Number.isSafeInteger(batch.id) ||
    batch.id < 0 ||
    !Object.values(GpuLineBatchKind).includes(batch.kind) ||
    !Number.isSafeInteger(batch.lodLevel) ||
    batch.lodLevel < 0 ||
    batch.lodLevel > 1 ||
    batch.firstVertex !== 0 ||
    !Number.isSafeInteger(batch.vertexCount) ||
    batch.vertexCount <= 0 ||
    batch.vertexCount % verticesPerPrimitive !== 0 ||
    !Number.isSafeInteger(batch.blockIndex ?? 0) ||
    (batch.blockIndex ?? 0) < 0 ||
    (batch.kind === GpuLineBatchKind.BlockDefinition
      ? !Number.isSafeInteger(batch.blockIndex) ||
        batch.blockIndex < 0
      : batch.blockIndex !== null &&
        batch.blockIndex !== undefined) ||
    !Array.isArray(batch.origin) ||
    batch.origin.length !== 3 ||
    !batch.origin.every(Number.isFinite) ||
    !boundsAreFinite(batch.bounds)
  ) {
    throw new TypeError(`render delta ${label} batch is invalid`);
  }
  return Object.freeze({
    ...batch,
    origin: Object.freeze([...batch.origin]),
    bounds: Object.freeze({
      min: Object.freeze([...batch.bounds.min]),
      max: Object.freeze([...batch.bounds.max]),
    }),
  });
}

function lineVisibilityRanges(
  vertices,
  batch,
  firstBufferVertex,
  sceneId,
  suppressions,
) {
  if (suppressions.size === 0) {
    return null;
  }
  if (
    !(vertices?.buffer instanceof ArrayBuffer) ||
    (vertices.recordSize ?? VERTEX_STRIDE) !== VERTEX_STRIDE ||
    vertices.buffer.byteLength !== vertices.byteLength ||
    vertices.byteLength !== vertices.vertexCount * VERTEX_STRIDE ||
    !Number.isSafeInteger(firstBufferVertex) ||
    firstBufferVertex < 0
  ) {
    throw new TypeError("render delta line visibility payload is invalid");
  }
  const localFirstVertex = batch.firstVertex - firstBufferVertex;
  if (
    localFirstVertex < 0 ||
    localFirstVertex + batch.vertexCount > vertices.vertexCount
  ) {
    throw new RangeError("render delta line visibility range is invalid");
  }
  const view = new DataView(vertices.buffer);
  const ranges = [];
  let firstVisible = -1;
  for (let local = 0; local < batch.vertexCount; local += 2) {
    const physical = localFirstVertex + local;
    const byteOffset = physical * VERTEX_STRIDE;
    const handleLow = view.getUint32(byteOffset + 20, true);
    const handleHigh = view.getUint32(byteOffset + 24, true);
    const hidden = suppressions.has(
      renderDeltaIdentityKey(sceneId, handleLow, handleHigh),
    );
    if (!hidden && firstVisible < 0) {
      firstVisible = physical;
    }
    if (hidden && firstVisible >= 0) {
      ranges.push(
        Object.freeze({
          firstVertex: firstVisible,
          vertexCount: physical - firstVisible,
        }),
      );
      firstVisible = -1;
    }
  }
  if (firstVisible >= 0) {
    ranges.push(
      Object.freeze({
        firstVertex: firstVisible,
        vertexCount:
          localFirstVertex + batch.vertexCount - firstVisible,
      }),
    );
  }
  return Object.freeze(ranges);
}

function identityVisibilityRanges(
  identityRanges,
  batch,
  sceneId,
  suppressions,
) {
  if (suppressions.size === 0) {
    return null;
  }
  const data = identityRanges.data;
  const batchEnd = batch.firstVertex + batch.vertexCount;
  let low = 0;
  let high = identityRanges.count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const offset = middle * RENDER_IDENTITY_RANGE_WORDS;
    const end = data[offset] + data[offset + 1];
    if (end <= batch.firstVertex) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const ranges = [];
  let firstVisible = -1;
  let visibleEnd = -1;
  for (let index = low; index < identityRanges.count; index += 1) {
    const offset = index * RENDER_IDENTITY_RANGE_WORDS;
    const first = data[offset];
    if (first >= batchEnd) {
      break;
    }
    const end = Math.min(first + data[offset + 1], batchEnd);
    const clippedFirst = Math.max(first, batch.firstVertex);
    const hidden = suppressions.has(
      renderDeltaIdentityKey(
        sceneId,
        data[offset + 2],
        data[offset + 3],
      ),
    );
    if (!hidden) {
      if (firstVisible < 0) {
        firstVisible = clippedFirst;
      }
      visibleEnd = end;
    } else if (firstVisible >= 0) {
      ranges.push(
        Object.freeze({
          firstVertex: firstVisible,
          vertexCount: visibleEnd - firstVisible,
        }),
      );
      firstVisible = -1;
      visibleEnd = -1;
    }
  }
  if (firstVisible >= 0) {
    ranges.push(
      Object.freeze({
        firstVertex: firstVisible,
        vertexCount: visibleEnd - firstVisible,
      }),
    );
  }
  return Object.freeze(ranges);
}

export class WebGlLineRenderer {
  constructor(
    canvas,
    {
      maximumExternalOverviewBytes = MAX_EXTERNAL_OVERVIEW_GPU_BYTES,
      maximumExternalDetailBytes = MAX_EXTERNAL_DETAIL_GPU_BYTES,
      maximumRenderDeltaBytes = MAX_RENDER_DELTA_GPU_BYTES,
      maximumRenderDeltaTextBytes = MAX_RENDER_DELTA_TEXT_BYTES,
      maximumRenderDeltaTransformBytes =
        MAX_RENDER_DELTA_TRANSFORM_BYTES,
      maximumRenderDeltaStyleBytes =
        MAX_RENDER_DELTA_STYLE_BYTES,
    } = {},
  ) {
    if (
      !Number.isSafeInteger(maximumExternalOverviewBytes) ||
      maximumExternalOverviewBytes <= 0 ||
      !Number.isSafeInteger(maximumExternalDetailBytes) ||
      maximumExternalDetailBytes <= 0 ||
      !Number.isSafeInteger(maximumRenderDeltaBytes) ||
      maximumRenderDeltaBytes <= 0 ||
      !Number.isSafeInteger(maximumRenderDeltaTextBytes) ||
      maximumRenderDeltaTextBytes <= 0 ||
      !Number.isSafeInteger(maximumRenderDeltaTransformBytes) ||
      maximumRenderDeltaTransformBytes <= 0 ||
      !Number.isSafeInteger(maximumRenderDeltaStyleBytes) ||
      maximumRenderDeltaStyleBytes <= 0
    ) {
      throw new RangeError("renderer byte budgets must be positive");
    }
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: true,
      depth: true,
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
    this.clipTexture = gl.createTexture();
    this.aciTexture = gl.createTexture();
    this.lineWeightTexture = gl.createTexture();
    this.plotStyleLineWeightTexture = gl.createTexture();
    this.layerPlotStyleIndexTexture = gl.createTexture();
    this.layerLinetypeTexture = gl.createTexture();
    this.linetypeHeaderTexture = gl.createTexture();
    this.linetypeDashTexture = gl.createTexture();
    this.viewportLayerVisibilityTexture = gl.createTexture();
    this.vertexResources = new Set();
    this.detailResources = new Map();
    this.detailSelections = new Map();
    this.curveRefinementScene = null;
    this.curveReplacementHandles = new Set();
    this.externalScenes = new Map();
    this.supplementalBounds = new Map();
    this.maximumExternalOverviewBytes = maximumExternalOverviewBytes;
    this.maximumExternalDetailBytes = maximumExternalDetailBytes;
    this.maximumRenderDeltaBytes = maximumRenderDeltaBytes;
    this.maximumRenderDeltaTextBytes =
      maximumRenderDeltaTextBytes;
    this.maximumRenderDeltaTransformBytes =
      maximumRenderDeltaTransformBytes;
    this.maximumRenderDeltaStyleBytes =
      maximumRenderDeltaStyleBytes;
    this.renderDeltaResources = new Set();
    this.renderDeltaResourceBytes = 0;
    this.renderDeltaTextResourceBytes = 0;
    this.renderDeltaTransformResourceBytes = 0;
    this.renderDeltaStyleResourceBytes = 0;
    this.renderDeltaState = Object.freeze({
      lines: Object.freeze([]),
      fills: Object.freeze([]),
      points: Object.freeze([]),
      texts: Object.freeze([]),
      transforms: Object.freeze([]),
      styles: Object.freeze([]),
      baseSuppressions: Object.freeze([]),
      suppressionKeys: new Set(),
      affectedWorldBounds: null,
    });
    this.renderDeltaTransformIndexesByGraph = new WeakMap();
    this.renderDeltaStyleIndexesByGraph = new WeakMap();
    this.renderDeltaRangeCache = new WeakMap();
    this.overviewScene = null;
    this.combinedBounds = null;
    this.hatchFillScene = null;
    this.hatchPatternScene = null;
    this.pointScene = null;
    this.solidFillScene = null;
    this.solidOutlineScene = null;
    this.wipeoutMaskScene = null;
    this.instanceScratch = new Float32Array(0);
    this.instanceBufferBytes = 0;
    this.clipTextureBytes = 0;
    this.viewportLayerVisibilityTextureBytes = 0;
    this.peakInstanceBufferBytes = 0;
    this.peakGpuTrackedBytes = 0;
    this.primitiveMetrics = null;
    this.imageOverlay = null;
    this.textOverlay = null;
    this.imageOverlaySnapshot = null;
    this.textOverlaySnapshot = null;
    this.imageOverlayCamera = null;
    this.textOverlayCamera = null;
    this.lastImageMetrics = null;
    this.lastTextMetrics = null;
    this.maskOrder = null;
    this.wipeoutMasksVisible = true;
    this.lineWeightsVisible = false;
    this.blocks = Object.freeze([]);
    if (
      !this.instanceBuffer ||
      !this.layerTexture ||
      !this.clipTexture ||
      !this.aciTexture ||
      !this.lineWeightTexture ||
      !this.plotStyleLineWeightTexture ||
      !this.layerPlotStyleIndexTexture ||
      !this.layerLinetypeTexture ||
      !this.linetypeHeaderTexture ||
      !this.linetypeDashTexture ||
      !this.viewportLayerVisibilityTexture
    ) {
      throw new Error("cannot allocate WebGL buffers");
    }
    this.projectionLocation = gl.getUniformLocation(this.program, "u_projection");
    this.layerCountLocation = gl.getUniformLocation(this.program, "u_layerCount");
    this.layerZeroIndexLocation = gl.getUniformLocation(
      this.program,
      "u_layerZeroIndex",
    );
    this.layerTextureLocation = gl.getUniformLocation(this.program, "u_layerColors");
    this.aciTextureLocation = gl.getUniformLocation(this.program, "u_aciColors");
    this.lineWeightTextureLocation = gl.getUniformLocation(
      this.program,
      "u_layerLineWeights",
    );
    this.plotStyleLineWeightTextureLocation = gl.getUniformLocation(
      this.program,
      "u_plotStyleLineWeights",
    );
    this.layerPlotStyleIndexTextureLocation = gl.getUniformLocation(
      this.program,
      "u_layerPlotStyleIndices",
    );
    this.plotStylesEnabledLocation = gl.getUniformLocation(
      this.program,
      "u_plotStylesEnabled",
    );
    this.curveReplacementEnabledLocation = gl.getUniformLocation(
      this.program,
      "u_curveReplacementEnabled",
    );
    this.lineOffsetLocation = gl.getUniformLocation(
      this.program,
      "u_lineOffset",
    );
    this.lineWeightThresholdLocation = gl.getUniformLocation(
      this.program,
      "u_lineWeightThreshold",
    );
    this.layerLinetypeTextureLocation = gl.getUniformLocation(
      this.program,
      "u_layerLinetypes",
    );
    this.linetypeHeaderTextureLocation = gl.getUniformLocation(
      this.program,
      "u_linetypeHeaders",
    );
    this.linetypeDashTextureLocation = gl.getUniformLocation(
      this.program,
      "u_linetypeDashes",
    );
    this.linetypeCountLocation = gl.getUniformLocation(
      this.program,
      "u_linetypeCount",
    );
    this.globalLinetypeScaleLocation = gl.getUniformLocation(
      this.program,
      "u_globalLinetypeScale",
    );
    this.worldPerPixelLocation = gl.getUniformLocation(
      this.program,
      "u_worldPerPixel",
    );
    this.viewportLayerVisibilityLocation = gl.getUniformLocation(
      this.program,
      "u_viewportLayerVisibility",
    );
    this.clipLocations = Object.freeze({
      texture: gl.getUniformLocation(this.program, "u_clipData"),
      width: gl.getUniformLocation(this.program, "u_clipTextureWidth"),
      count: gl.getUniformLocation(this.program, "u_clipNodeCount"),
    });
    this.fillProjectionLocation = gl.getUniformLocation(
      this.fillProgram,
      "u_projection",
    );
    this.fillLayerCountLocation = gl.getUniformLocation(
      this.fillProgram,
      "u_layerCount",
    );
    this.fillLayerZeroIndexLocation = gl.getUniformLocation(
      this.fillProgram,
      "u_layerZeroIndex",
    );
    this.fillLayerTextureLocation = gl.getUniformLocation(
      this.fillProgram,
      "u_layerColors",
    );
    this.fillAciTextureLocation = gl.getUniformLocation(
      this.fillProgram,
      "u_aciColors",
    );
    this.fillViewportLayerVisibilityLocation = gl.getUniformLocation(
      this.fillProgram,
      "u_viewportLayerVisibility",
    );
    this.fillClipLocations = Object.freeze({
      texture: gl.getUniformLocation(this.fillProgram, "u_clipData"),
      width: gl.getUniformLocation(
        this.fillProgram,
        "u_clipTextureWidth",
      ),
      count: gl.getUniformLocation(this.fillProgram, "u_clipNodeCount"),
    });
    this.pointProjectionLocation = gl.getUniformLocation(
      this.pointProgram,
      "u_projection",
    );
    this.pointLayerCountLocation = gl.getUniformLocation(
      this.pointProgram,
      "u_layerCount",
    );
    this.pointLayerZeroIndexLocation = gl.getUniformLocation(
      this.pointProgram,
      "u_layerZeroIndex",
    );
    this.pointLayerTextureLocation = gl.getUniformLocation(
      this.pointProgram,
      "u_layerColors",
    );
    this.pointAciTextureLocation = gl.getUniformLocation(
      this.pointProgram,
      "u_aciColors",
    );
    this.pointViewportLayerVisibilityLocation = gl.getUniformLocation(
      this.pointProgram,
      "u_viewportLayerVisibility",
    );
    this.pointClipLocations = Object.freeze({
      texture: gl.getUniformLocation(this.pointProgram, "u_clipData"),
      width: gl.getUniformLocation(
        this.pointProgram,
        "u_clipTextureWidth",
      ),
      count: gl.getUniformLocation(this.pointProgram, "u_clipNodeCount"),
    });
    this.pointViewportHeightLocation = gl.getUniformLocation(
      this.pointProgram,
      "u_viewportHeight",
    );
    this.pointPixelsPerWorldLocation = gl.getUniformLocation(
      this.pointProgram,
      "u_pixelsPerWorld",
    );
    this.layerCount = 0;
    this.layerZeroIndex = -1;
    this.layers = Object.freeze([]);
    this.layerVisibility = [];
    this.layerLineWeights = new Int16Array([-3]);
    this.plotStyleLineWeights = new Int16Array(256);
    this.plotStyleLineWeights.fill(-1);
    this.layerPlotStyleIndices = new Uint8Array([0]);
    this.plotStylesEnabled = false;
    this.layerLinetypeCodes = new Uint16Array([2]);
    this.linetypeTextureData = makeLinetypeTextureData([]);
    this.globalLinetypeScale = 1;
    this.viewportLayerVisibilityRows = 1;
    this.aciPalette = new Uint8Array(DEFAULT_ACI_PALETTE);
    this.uploadAciTexture();
    this.uploadPlotStyleTextures();
    this.uploadLinetypeTextures();
  }

  instanceScratchView(instanceCount) {
    if (
      !Number.isSafeInteger(instanceCount) ||
      instanceCount <= 0 ||
      instanceCount > MAX_INSTANCES_PER_DRAW
    ) {
      throw new RangeError("instance scratch count is outside the draw limit");
    }
    const requiredValues = instanceCount * INSTANCE_VALUES;
    if (this.instanceScratch.length < requiredValues) {
      let capacity = Math.max(
        1,
        Math.floor(this.instanceScratch.length / INSTANCE_VALUES),
      );
      while (capacity < instanceCount) {
        capacity *= 2;
      }
      capacity = Math.min(capacity, MAX_INSTANCES_PER_DRAW);
      this.instanceScratch = new Float32Array(capacity * INSTANCE_VALUES);
    }
    return this.instanceScratch.subarray(0, requiredValues);
  }

  setLayers(layers) {
    this.layers = layers;
    this.layerZeroIndex = layers.findIndex(
      (layer) =>
        layer.name?.normalize("NFC").toLocaleLowerCase("en-US") === "0",
    );
    this.layerVisibility = layers.map((layer) => (layer.flags & 0b11) === 0);
    this.uploadLayerTexture();
    this.uploadLineWeightTexture();
    this.uploadLayerPlotStyleIndexTexture();
  }

  uploadLayerTexture() {
    const gl = this.gl;
    const pixels = makeLayerPixels(
      this.layers,
      this.layerVisibility,
      this.aciPalette,
    );
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

  setViewportLayerVisibility(instanceGraph) {
    const sourceRows = instanceGraph?.layerVisibilityRows;
    const rows =
      Array.isArray(sourceRows) && sourceRows.length > 0
        ? sourceRows
        : [new Uint8Array(this.layers.length).fill(1)];
    if (rows.length > MAX_VISIBILITY_ROWS) {
      throw new RangeError(
        `viewport layer visibility exceeds ${MAX_VISIBILITY_ROWS} rows`,
      );
    }
    const width = Math.max(this.layers.length, 1);
    const data = new Uint8Array(width * rows.length);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      if (!(row instanceof Uint8Array) || row.length !== this.layers.length) {
        throw new TypeError(
          `viewport layer visibility row ${rowIndex} is invalid`,
        );
      }
      if (this.layers.length > 0) {
        data.set(row, rowIndex * width);
      } else {
        data[rowIndex * width] = 1;
      }
    }
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(
      gl.TEXTURE_2D,
      this.viewportLayerVisibilityTexture,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const unpackAlignment = gl.getParameter(gl.UNPACK_ALIGNMENT);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    try {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R8UI,
        width,
        rows.length,
        0,
        gl.RED_INTEGER,
        gl.UNSIGNED_BYTE,
        data,
      );
    } finally {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, unpackAlignment);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTexture);
    this.viewportLayerVisibilityRows = rows.length;
    this.viewportLayerVisibilityTextureBytes = data.byteLength;
  }

  bindViewportLayerVisibility(location) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(
      gl.TEXTURE_2D,
      this.viewportLayerVisibilityTexture,
    );
    gl.uniform1i(location, 7);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTexture);
  }

  uploadAciTexture() {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.aciTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      256,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.aciPalette,
    );
    gl.activeTexture(gl.TEXTURE0);
  }

  uploadLineWeightTexture() {
    const gl = this.gl;
    this.layerLineWeights = new Int16Array(Math.max(this.layers.length, 1));
    this.layerLineWeights.fill(-3);
    for (let index = 0; index < this.layers.length; index += 1) {
      const value = this.layers[index].lineWeight;
      this.layerLineWeights[index] =
        Number.isInteger(value) && value >= -3 && value <= 211
          ? value
          : -3;
    }
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.lineWeightTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R16I,
      this.layerLineWeights.length,
      1,
      0,
      gl.RED_INTEGER,
      gl.SHORT,
      this.layerLineWeights,
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTexture);
  }

  uploadLayerPlotStyleIndexTexture() {
    const gl = this.gl;
    this.layerPlotStyleIndices = Uint8Array.from(
      this.layers.length > 0 ? this.layers : [{}],
      (layer) => cadColorAci(layer.color ?? 0),
    );
    gl.activeTexture(gl.TEXTURE0 + 9);
    gl.bindTexture(gl.TEXTURE_2D, this.layerPlotStyleIndexTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const unpackAlignment = gl.getParameter(gl.UNPACK_ALIGNMENT);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    try {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R8UI,
        this.layerPlotStyleIndices.length,
        1,
        0,
        gl.RED_INTEGER,
        gl.UNSIGNED_BYTE,
        this.layerPlotStyleIndices,
      );
    } finally {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, unpackAlignment);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTexture);
  }

  uploadPlotStyleTextures() {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + 8);
    gl.bindTexture(gl.TEXTURE_2D, this.plotStyleLineWeightTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R16I,
      this.plotStyleLineWeights.length,
      1,
      0,
      gl.RED_INTEGER,
      gl.SHORT,
      this.plotStyleLineWeights,
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTexture);
  }

  setLinetypes(
    linetypes,
    layerCodes,
    globalScale = 1,
  ) {
    this.linetypeTextureData = makeLinetypeTextureData(linetypes);
    this.layerLinetypeCodes =
      layerCodes instanceof Uint16Array &&
      layerCodes.length === this.layers.length
        ? new Uint16Array(layerCodes)
        : new Uint16Array(Math.max(this.layers.length, 1)).fill(2);
    this.globalLinetypeScale =
      Number.isFinite(globalScale) && globalScale > 0 ? globalScale : 1;
    this.uploadLinetypeTextures();
  }

  uploadLinetypeTextures() {
    const gl = this.gl;
    const layerCodes =
      this.layerLinetypeCodes.length > 0
        ? this.layerLinetypeCodes
        : new Uint16Array([2]);
    const { headers, dashes } = this.linetypeTextureData;
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.layerLinetypeTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R16UI,
      layerCodes.length,
      1,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_SHORT,
      layerCodes,
    );
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.linetypeHeaderTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA32F,
      Math.max(headers.length / 4, 1),
      1,
      0,
      gl.RGBA,
      gl.FLOAT,
      headers,
    );
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.linetypeDashTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R32F,
      dashes.length,
      1,
      0,
      gl.RED,
      gl.FLOAT,
      dashes,
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTexture);
  }

  setAciPalette(palette) {
    if (!(palette instanceof Uint8Array) || palette.length !== 256 * 4) {
      throw new TypeError("ACI palette must contain 256 RGBA colors");
    }
    this.aciPalette = new Uint8Array(palette);
    this.uploadAciTexture();
    this.uploadLayerTexture();
  }

  setPlotStyle(palette, lineWeights) {
    if (
      !(lineWeights instanceof Int16Array) ||
      lineWeights.length !== 256
    ) {
      throw new TypeError("plot style lineweights must contain 256 values");
    }
    this.setAciPalette(palette);
    this.plotStyleLineWeights = new Int16Array(lineWeights);
    this.plotStylesEnabled = true;
    this.uploadPlotStyleTextures();
  }

  clearPlotStyle() {
    this.plotStylesEnabled = false;
    this.plotStyleLineWeights.fill(-1);
    this.setAciPalette(DEFAULT_ACI_PALETTE);
    this.uploadPlotStyleTextures();
  }

  bindAciTexture(location) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.aciTexture);
    gl.uniform1i(location, 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTexture);
  }

  bindLineWeightTexture() {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.lineWeightTexture);
    gl.uniform1i(this.lineWeightTextureLocation, 3);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTexture);
  }

  bindPlotStyleTextures() {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + 8);
    gl.bindTexture(gl.TEXTURE_2D, this.plotStyleLineWeightTexture);
    gl.uniform1i(this.plotStyleLineWeightTextureLocation, 8);
    gl.activeTexture(gl.TEXTURE0 + 9);
    gl.bindTexture(gl.TEXTURE_2D, this.layerPlotStyleIndexTexture);
    gl.uniform1i(this.layerPlotStyleIndexTextureLocation, 9);
    gl.uniform1i(
      this.plotStylesEnabledLocation,
      this.plotStylesEnabled ? 1 : 0,
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTexture);
  }

  bindLinetypeTextures() {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.layerLinetypeTexture);
    gl.uniform1i(this.layerLinetypeTextureLocation, 4);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.linetypeHeaderTexture);
    gl.uniform1i(this.linetypeHeaderTextureLocation, 5);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.linetypeDashTexture);
    gl.uniform1i(this.linetypeDashTextureLocation, 6);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTexture);
  }

  setLineWeightsVisible(visible) {
    this.lineWeightsVisible = Boolean(visible);
    return this.lineWeightsVisible;
  }

  bindClipTexture(instanceGraph, camera, locations) {
    const gl = this.gl;
    const originX = camera.origin[0];
    const originY = camera.origin[1];
    if (
      this.boundClipGraph !== instanceGraph ||
      this.boundClipOriginX !== originX ||
      this.boundClipOriginY !== originY
    ) {
      const payload = makeClipTexturePayload(instanceGraph, camera);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.clipTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_WRAP_S,
        gl.CLAMP_TO_EDGE,
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_WRAP_T,
        gl.CLAMP_TO_EDGE,
      );
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        payload.width,
        payload.height,
        0,
        gl.RGBA,
        gl.FLOAT,
        payload.data,
      );
      this.boundClipGraph = instanceGraph;
      this.boundClipOriginX = originX;
      this.boundClipOriginY = originY;
      this.boundClipPayload = payload;
      this.clipTextureBytes = payload.byteLength;
    }
    gl.uniform1i(locations.texture, 1);
    gl.uniform1i(
      locations.width,
      this.boundClipPayload?.width ?? 1,
    );
    gl.uniform1i(
      locations.count,
      this.boundClipPayload?.nodeCount ?? 0,
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTexture);
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

  setLayerVisibilityState(visibility) {
    if (
      !Array.isArray(visibility) ||
      visibility.length !== this.layerVisibility.length
    ) {
      throw new RangeError("invalid layer visibility state");
    }
    for (let index = 0; index < visibility.length; index += 1) {
      this.layerVisibility[index] = Boolean(visibility[index]);
    }
    this.uploadLayerTexture();
  }

  setTextOverlay(overlay) {
    if (
      overlay &&
      typeof overlay.setRenderDeltaState !== "function" &&
      ((this.renderDeltaState.texts.length > 0 &&
        typeof overlay.setRenderDeltaTexts !== "function") ||
        (this.renderDeltaState.transforms.length > 0 &&
          typeof overlay.setRenderDeltaTransforms !== "function") ||
        (this.renderDeltaState.styles.length > 0 &&
          typeof overlay.setRenderDeltaStyles !== "function"))
    ) {
      throw new TypeError(
        "text overlay cannot apply active render delta text",
      );
    }
    if (this.textOverlay && this.textOverlay !== overlay) {
      resetOverlayTransform(this.textOverlay);
      this.textOverlay.dispose();
    }
    releaseOverlaySnapshot(this.textOverlaySnapshot);
    this.textOverlay = overlay ?? null;
    this.textOverlaySnapshot = null;
    this.textOverlayCamera = null;
    this.lastTextMetrics = null;
    resetOverlayTransform(this.textOverlay);
    this.textOverlay?.setMaskVisibility?.(this.wipeoutMasksVisible);
    this.applyTextRenderDeltaState(this.renderDeltaState);
  }

  applyTextRenderDeltaState(state) {
    if (!this.textOverlay) {
      return;
    }
    if (typeof this.textOverlay.setRenderDeltaState === "function") {
      this.textOverlay.setRenderDeltaState({
        suppressions: state.baseSuppressions,
        texts: state.texts,
        transforms: state.transforms,
        styles: state.styles,
      });
      return;
    }
    if (
      state.texts.length > 0 &&
      typeof this.textOverlay.setRenderDeltaTexts !== "function"
    ) {
      throw new TypeError(
        "text overlay cannot apply render delta text",
      );
    }
    this.textOverlay.setRenderDeltaTexts?.(state.texts);
    if (
      state.transforms.length > 0 &&
      typeof this.textOverlay.setRenderDeltaTransforms !== "function"
    ) {
      throw new TypeError(
        "text overlay cannot apply render delta transforms",
      );
    }
    this.textOverlay.setRenderDeltaTransforms?.(state.transforms);
    if (
      state.styles.length > 0 &&
      typeof this.textOverlay.setRenderDeltaStyles !== "function"
    ) {
      throw new TypeError(
        "text overlay cannot apply render delta styles",
      );
    }
    this.textOverlay.setRenderDeltaStyles?.(state.styles);
    this.textOverlay.setRenderDeltaSuppressions?.(
      state.baseSuppressions,
    );
  }

  setImageOverlay(overlay) {
    if (
      overlay &&
      typeof overlay.setRenderDeltaState !== "function" &&
      ((this.renderDeltaState.transforms.length > 0 &&
        typeof overlay.setRenderDeltaTransforms !== "function") ||
        (this.renderDeltaState.styles.length > 0 &&
          typeof overlay.setRenderDeltaStyles !== "function"))
    ) {
      throw new TypeError(
        "image overlay cannot apply active render delta transforms",
      );
    }
    if (this.imageOverlay && this.imageOverlay !== overlay) {
      resetOverlayTransform(this.imageOverlay);
      this.imageOverlay.dispose();
    }
    releaseOverlaySnapshot(this.imageOverlaySnapshot);
    this.imageOverlay = overlay ?? null;
    this.imageOverlaySnapshot = null;
    this.imageOverlayCamera = null;
    this.lastImageMetrics = null;
    resetOverlayTransform(this.imageOverlay);
    this.applyImageRenderDeltaState(this.renderDeltaState);
  }

  applyImageRenderDeltaState(state) {
    if (!this.imageOverlay) {
      return;
    }
    if (typeof this.imageOverlay.setRenderDeltaState === "function") {
      this.imageOverlay.setRenderDeltaState({
        transforms: state.transforms,
        styles: state.styles,
      });
      return;
    }
    if (
      state.transforms.length > 0 &&
      typeof this.imageOverlay.setRenderDeltaTransforms !== "function"
    ) {
      throw new TypeError(
        "image overlay cannot apply render delta transforms",
      );
    }
    this.imageOverlay.setRenderDeltaTransforms?.(
      state.transforms,
    );
    if (
      state.styles.length > 0 &&
      typeof this.imageOverlay.setRenderDeltaStyles !== "function"
    ) {
      throw new TypeError(
        "image overlay cannot apply render delta styles",
      );
    }
    this.imageOverlay.setRenderDeltaStyles?.(state.styles);
  }

  applyOverlayRenderDeltaState(state) {
    const previous = this.renderDeltaState;
    try {
      this.applyImageRenderDeltaState(state);
      this.applyTextRenderDeltaState(state);
    } catch (error) {
      try {
        this.applyImageRenderDeltaState(previous);
        this.applyTextRenderDeltaState(previous);
      } catch {
        // Preserve the original atomic activation failure.
      }
      throw error;
    }
  }

  setWipeoutMasksVisible(visible) {
    this.wipeoutMasksVisible = Boolean(visible);
    this.textOverlay?.setMaskVisibility?.(this.wipeoutMasksVisible);
    return this.wipeoutMasksVisible;
  }

  uploadVertices(
    arrayBuffer,
    {
      stride = VERTEX_STRIDE,
      patternDistance = stride >= VERTEX_STRIDE,
    } = {},
  ) {
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
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, stride, 16);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, stride, 12);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, stride, 28);
    if (patternDistance) {
      gl.enableVertexAttribArray(14);
      gl.vertexAttribPointer(14, 1, gl.FLOAT, false, stride, 32);
    } else {
      gl.disableVertexAttribArray(14);
      gl.vertexAttrib1f(14, 0);
    }

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
    gl.enableVertexAttribArray(8);
    gl.vertexAttribPointer(8, 1, gl.FLOAT, false, INSTANCE_STRIDE, 64);
    gl.vertexAttribDivisor(8, 1);
    gl.enableVertexAttribArray(9);
    gl.vertexAttribPointer(9, 1, gl.FLOAT, false, INSTANCE_STRIDE, 68);
    gl.vertexAttribDivisor(9, 1);
    gl.enableVertexAttribArray(10);
    gl.vertexAttribIPointer(
      10,
      1,
      gl.UNSIGNED_INT,
      INSTANCE_STRIDE,
      72,
    );
    gl.vertexAttribDivisor(10, 1);
    gl.enableVertexAttribArray(11);
    gl.vertexAttribIPointer(
      11,
      1,
      gl.UNSIGNED_INT,
      INSTANCE_STRIDE,
      76,
    );
    gl.vertexAttribDivisor(11, 1);
    gl.enableVertexAttribArray(12);
    gl.vertexAttribPointer(
      12,
      1,
      gl.FLOAT,
      false,
      INSTANCE_STRIDE,
      80,
    );
    gl.vertexAttribDivisor(12, 1);
    gl.enableVertexAttribArray(13);
    gl.vertexAttribPointer(
      13,
      1,
      gl.FLOAT,
      false,
      INSTANCE_STRIDE,
      84,
    );
    gl.vertexAttribDivisor(13, 1);
    gl.enableVertexAttribArray(15);
    gl.vertexAttribIPointer(
      15,
      1,
      gl.UNSIGNED_INT,
      INSTANCE_STRIDE,
      88,
    );
    gl.vertexAttribDivisor(15, 1);
    gl.bindVertexArray(null);

    const resource = Object.freeze({
      vertexBuffer,
      vertexArray,
      byteLength: arrayBuffer.byteLength,
      stride,
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
    gl.enableVertexAttribArray(10);
    gl.vertexAttribPointer(10, 1, gl.FLOAT, false, INSTANCE_STRIDE, 64);
    gl.vertexAttribDivisor(10, 1);
    gl.enableVertexAttribArray(11);
    gl.vertexAttribPointer(11, 1, gl.FLOAT, false, INSTANCE_STRIDE, 68);
    gl.vertexAttribDivisor(11, 1);
    gl.enableVertexAttribArray(12);
    gl.vertexAttribIPointer(
      12,
      1,
      gl.UNSIGNED_INT,
      INSTANCE_STRIDE,
      72,
    );
    gl.vertexAttribDivisor(12, 1);
    gl.enableVertexAttribArray(13);
    gl.vertexAttribIPointer(
      13,
      1,
      gl.UNSIGNED_INT,
      INSTANCE_STRIDE,
      76,
    );
    gl.vertexAttribDivisor(13, 1);
    gl.enableVertexAttribArray(14);
    gl.vertexAttribPointer(
      14,
      1,
      gl.FLOAT,
      false,
      INSTANCE_STRIDE,
      80,
    );
    gl.vertexAttribDivisor(14, 1);
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
    gl.vertexAttribPointer(
      0,
      3,
      gl.FLOAT,
      false,
      PRIMITIVE_VERTEX_STRIDE,
      0,
    );
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(
      1,
      1,
      gl.UNSIGNED_INT,
      PRIMITIVE_VERTEX_STRIDE,
      16,
    );
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(
      2,
      1,
      gl.UNSIGNED_INT,
      PRIMITIVE_VERTEX_STRIDE,
      12,
    );
    gl.enableVertexAttribArray(3);
    gl.vertexAttribIPointer(
      3,
      1,
      gl.UNSIGNED_INT,
      PRIMITIVE_VERTEX_STRIDE,
      28,
    );
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(
      4,
      1,
      gl.FLOAT,
      false,
      PRIMITIVE_VERTEX_STRIDE,
      20,
    );
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(
      5,
      1,
      gl.FLOAT,
      false,
      PRIMITIVE_VERTEX_STRIDE,
      24,
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
    gl.enableVertexAttribArray(10);
    gl.vertexAttribPointer(10, 1, gl.FLOAT, false, INSTANCE_STRIDE, 64);
    gl.vertexAttribDivisor(10, 1);
    gl.enableVertexAttribArray(11);
    gl.vertexAttribPointer(11, 1, gl.FLOAT, false, INSTANCE_STRIDE, 68);
    gl.vertexAttribDivisor(11, 1);
    gl.enableVertexAttribArray(12);
    gl.vertexAttribIPointer(
      12,
      1,
      gl.UNSIGNED_INT,
      INSTANCE_STRIDE,
      72,
    );
    gl.vertexAttribDivisor(12, 1);
    gl.enableVertexAttribArray(13);
    gl.vertexAttribIPointer(
      13,
      1,
      gl.UNSIGNED_INT,
      INSTANCE_STRIDE,
      76,
    );
    gl.vertexAttribDivisor(13, 1);
    gl.enableVertexAttribArray(14);
    gl.vertexAttribPointer(
      14,
      1,
      gl.FLOAT,
      false,
      INSTANCE_STRIDE,
      80,
    );
    gl.vertexAttribDivisor(14, 1);
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

  stageRenderDeltaLine({
    key,
    sceneId = ROOT_RENDER_DELTA_SCENE_ID,
    batch,
    vertices,
    instanceIndices = null,
  }) {
    if (!this.overviewScene) {
      throw new Error("cannot stage a render delta before the overview");
    }
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      key.length > 1_024 ||
      typeof sceneId !== "string" ||
      sceneId.length === 0 ||
      sceneId.length > 512 ||
      (sceneId !== ROOT_RENDER_DELTA_SCENE_ID &&
        !this.externalScenes.has(sceneId))
    ) {
      throw new TypeError("render delta line target is invalid");
    }
    const normalizedBatch = cloneRenderDeltaBatch(batch, {
      verticesPerPrimitive: 2,
      label: "line",
    });
    const instanceGraph =
      sceneId === ROOT_RENDER_DELTA_SCENE_ID
        ? this.overviewScene.instanceGraph
        : this.externalScenes.get(sceneId).instanceGraph;
    if (
      !(vertices?.buffer instanceof ArrayBuffer) ||
      (vertices.recordSize ?? VERTEX_STRIDE) !== VERTEX_STRIDE ||
      vertices.vertexCount !== normalizedBatch.vertexCount ||
      vertices.byteLength !==
        normalizedBatch.vertexCount * VERTEX_STRIDE ||
      vertices.buffer.byteLength !== vertices.byteLength ||
      (instanceIndices !== null &&
        !(instanceIndices instanceof Uint32Array))
    ) {
      throw new TypeError("render delta line vertex payload is invalid");
    }
    const instanceCount = instancesForBatch(
      normalizedBatch,
      instanceGraph,
    ).count;
    if (
      instanceIndices !== null &&
      instanceIndices.some((index) => index >= instanceCount)
    ) {
      throw new RangeError(
        "render delta line references an invalid instance",
      );
    }
    if (
      vertices.byteLength >
      this.maximumRenderDeltaBytes - this.renderDeltaResourceBytes
    ) {
      throw new RangeError(
        `render delta GPU data exceeds the ${this.maximumRenderDeltaBytes}-byte limit`,
      );
    }
    const resource = this.uploadVertices(vertices.buffer);
    const entry = Object.freeze({
      key,
      resourceKind: "line",
      sceneId,
      batch: normalizedBatch,
      resource,
      byteLength: vertices.byteLength,
      instanceIndices:
        instanceIndices === null
          ? null
          : new Uint32Array(instanceIndices),
    });
    this.renderDeltaResources.add(entry);
    this.renderDeltaResourceBytes += entry.byteLength;
    return entry;
  }

  stageRenderDeltaFill({
    key,
    sceneId = ROOT_RENDER_DELTA_SCENE_ID,
    batch,
    vertices,
    instanceIndices = null,
  }) {
    if (!this.overviewScene) {
      throw new Error("cannot stage a render delta before the overview");
    }
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      key.length > 1_024 ||
      typeof sceneId !== "string" ||
      sceneId.length === 0 ||
      sceneId.length > 512 ||
      (sceneId !== ROOT_RENDER_DELTA_SCENE_ID &&
        !this.externalScenes.has(sceneId))
    ) {
      throw new TypeError("render delta fill target is invalid");
    }
    const normalizedBatch = cloneRenderDeltaBatch(batch, {
      verticesPerPrimitive: 3,
      label: "fill",
    });
    const instanceGraph =
      sceneId === ROOT_RENDER_DELTA_SCENE_ID
        ? this.overviewScene.instanceGraph
        : this.externalScenes.get(sceneId).instanceGraph;
    if (
      !(vertices?.buffer instanceof ArrayBuffer) ||
      (vertices.recordSize ?? FILL_VERTEX_STRIDE) !==
        FILL_VERTEX_STRIDE ||
      vertices.vertexCount !== normalizedBatch.vertexCount ||
      vertices.byteLength !==
        normalizedBatch.vertexCount * FILL_VERTEX_STRIDE ||
      vertices.buffer.byteLength !== vertices.byteLength ||
      (instanceIndices !== null &&
        !(instanceIndices instanceof Uint32Array))
    ) {
      throw new TypeError("render delta fill vertex payload is invalid");
    }
    const instanceCount = instancesForBatch(
      normalizedBatch,
      instanceGraph,
    ).count;
    if (
      instanceIndices !== null &&
      instanceIndices.some((index) => index >= instanceCount)
    ) {
      throw new RangeError(
        "render delta fill references an invalid instance",
      );
    }
    if (
      vertices.byteLength >
      this.maximumRenderDeltaBytes - this.renderDeltaResourceBytes
    ) {
      throw new RangeError(
        `render delta GPU data exceeds the ${this.maximumRenderDeltaBytes}-byte limit`,
      );
    }
    const resource = this.uploadHatchFillVertices(vertices.buffer);
    const entry = Object.freeze({
      key,
      resourceKind: "fill",
      sceneId,
      batch: normalizedBatch,
      resource,
      byteLength: vertices.byteLength,
      instanceIndices:
        instanceIndices === null
          ? null
          : new Uint32Array(instanceIndices),
    });
    this.renderDeltaResources.add(entry);
    this.renderDeltaResourceBytes += entry.byteLength;
    return entry;
  }

  stageRenderDeltaPoint({
    key,
    sceneId = ROOT_RENDER_DELTA_SCENE_ID,
    batch,
    vertices,
    instanceIndices = null,
  }) {
    if (!this.overviewScene) {
      throw new Error("cannot stage a render delta before the overview");
    }
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      key.length > 1_024 ||
      typeof sceneId !== "string" ||
      sceneId.length === 0 ||
      sceneId.length > 512 ||
      (sceneId !== ROOT_RENDER_DELTA_SCENE_ID &&
        !this.externalScenes.has(sceneId))
    ) {
      throw new TypeError("render delta point target is invalid");
    }
    const normalizedBatch = cloneRenderDeltaBatch(batch, {
      verticesPerPrimitive: 1,
      label: "point",
    });
    const instanceGraph =
      sceneId === ROOT_RENDER_DELTA_SCENE_ID
        ? this.overviewScene.instanceGraph
        : this.externalScenes.get(sceneId).instanceGraph;
    if (
      !(vertices?.buffer instanceof ArrayBuffer) ||
      (vertices.recordSize ?? PRIMITIVE_VERTEX_STRIDE) !==
        PRIMITIVE_VERTEX_STRIDE ||
      vertices.vertexCount !== normalizedBatch.vertexCount ||
      vertices.byteLength !==
        normalizedBatch.vertexCount * PRIMITIVE_VERTEX_STRIDE ||
      vertices.buffer.byteLength !== vertices.byteLength ||
      (instanceIndices !== null &&
        !(instanceIndices instanceof Uint32Array))
    ) {
      throw new TypeError("render delta point vertex payload is invalid");
    }
    const instanceCount = instancesForBatch(
      normalizedBatch,
      instanceGraph,
    ).count;
    if (
      instanceIndices !== null &&
      instanceIndices.some((index) => index >= instanceCount)
    ) {
      throw new RangeError(
        "render delta point references an invalid instance",
      );
    }
    if (
      vertices.byteLength >
      this.maximumRenderDeltaBytes - this.renderDeltaResourceBytes
    ) {
      throw new RangeError(
        `render delta GPU data exceeds the ${this.maximumRenderDeltaBytes}-byte limit`,
      );
    }
    const resource = this.uploadPointVertices(vertices.buffer);
    const entry = Object.freeze({
      key,
      resourceKind: "point",
      sceneId,
      batch: normalizedBatch,
      resource,
      byteLength: vertices.byteLength,
      instanceIndices:
        instanceIndices === null
          ? null
          : new Uint32Array(instanceIndices),
    });
    this.renderDeltaResources.add(entry);
    this.renderDeltaResourceBytes += entry.byteLength;
    return entry;
  }

  stageRenderDeltaText({
    key,
    sceneId = ROOT_RENDER_DELTA_SCENE_ID,
    record,
    byteLength,
  }) {
    if (!this.overviewScene) {
      throw new Error("cannot stage a render delta before the overview");
    }
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      key.length > 1_024 ||
      typeof sceneId !== "string" ||
      sceneId.length === 0 ||
      sceneId.length > 512 ||
      (sceneId !== ROOT_RENDER_DELTA_SCENE_ID &&
        !this.externalScenes.has(sceneId))
    ) {
      throw new TypeError("render delta text target is invalid");
    }
    if (
      !isNormalizedDwgRenderDeltaTextRecord(record) ||
      !Number.isSafeInteger(byteLength) ||
      byteLength <= 0 ||
      dwgRenderDeltaTextByteLength(record) !== byteLength
    ) {
      throw new TypeError("render delta text payload is invalid");
    }
    if (
      byteLength >
      this.maximumRenderDeltaTextBytes -
        this.renderDeltaTextResourceBytes
    ) {
      throw new RangeError(
        `render delta text data exceeds the ${this.maximumRenderDeltaTextBytes}-byte limit`,
      );
    }
    const entry = Object.freeze({
      key,
      resourceKind: "text",
      sceneId,
      record,
      byteLength,
    });
    this.renderDeltaResources.add(entry);
    this.renderDeltaTextResourceBytes += byteLength;
    return entry;
  }

  stageRenderDeltaTransform({
    key,
    sceneId = ROOT_RENDER_DELTA_SCENE_ID,
    record,
    byteLength,
  }) {
    if (!this.overviewScene) {
      throw new Error("cannot stage a render delta before the overview");
    }
    const scene =
      sceneId === ROOT_RENDER_DELTA_SCENE_ID
        ? this.overviewScene
        : this.externalScenes.get(sceneId);
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      key.length > 1_024 ||
      typeof sceneId !== "string" ||
      sceneId.length === 0 ||
      sceneId.length > 512 ||
      !scene
    ) {
      throw new TypeError(
        "render delta transform target is invalid",
      );
    }
    if (
      !isNormalizedDwgRenderDeltaTransformRecord(record) ||
      !Number.isSafeInteger(byteLength) ||
      byteLength <= 0 ||
      dwgRenderDeltaTransformByteLength(record) !== byteLength
    ) {
      throw new TypeError(
        "render delta transform payload is invalid",
      );
    }
    if (
      byteLength >
      this.maximumRenderDeltaTransformBytes -
        this.renderDeltaTransformResourceBytes
    ) {
      throw new RangeError(
        `render delta transform data exceeds the ${this.maximumRenderDeltaTransformBytes}-byte limit`,
      );
    }
    const entry = Object.freeze({
      key,
      resourceKind: "transform",
      sceneId,
      record,
      byteLength,
    });
    indexDwgRenderDeltaTransforms([entry], {
      sourceId: sceneId,
      instanceGraph: scene.instanceGraph,
      requireComplete: false,
    });
    this.renderDeltaResources.add(entry);
    this.renderDeltaTransformResourceBytes += byteLength;
    return entry;
  }

  stageRenderDeltaStyle({
    key,
    sceneId = ROOT_RENDER_DELTA_SCENE_ID,
    record,
    byteLength,
  }) {
    if (!this.overviewScene) {
      throw new Error("cannot stage a render delta before the overview");
    }
    const scene =
      sceneId === ROOT_RENDER_DELTA_SCENE_ID
        ? this.overviewScene
        : this.externalScenes.get(sceneId);
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      key.length > 1_024 ||
      typeof sceneId !== "string" ||
      sceneId.length === 0 ||
      sceneId.length > 512 ||
      !scene
    ) {
      throw new TypeError("render delta style target is invalid");
    }
    if (
      !isNormalizedDwgRenderDeltaStyleRecord(record) ||
      !Number.isSafeInteger(byteLength) ||
      byteLength <= 0 ||
      dwgRenderDeltaStyleByteLength(record) !== byteLength
    ) {
      throw new TypeError("render delta style payload is invalid");
    }
    if (
      record.layerIndex !== null &&
      record.layerIndex !== 0xffff_ffff &&
      record.layerIndex >= this.layerVisibility.length
    ) {
      throw new RangeError(
        "render delta style layer target is invalid",
      );
    }
    if (
      byteLength >
      this.maximumRenderDeltaStyleBytes -
        this.renderDeltaStyleResourceBytes
    ) {
      throw new RangeError(
        `render delta style data exceeds the ${this.maximumRenderDeltaStyleBytes}-byte limit`,
      );
    }
    const entry = Object.freeze({
      key,
      resourceKind: "style",
      sceneId,
      record,
      byteLength,
    });
    indexDwgRenderDeltaStyles([entry], {
      sourceId: sceneId,
      instanceGraph: scene.instanceGraph,
      requireComplete: false,
    });
    this.renderDeltaResources.add(entry);
    this.renderDeltaStyleResourceBytes += byteLength;
    return entry;
  }

  activateRenderDelta({
    lines = Object.freeze([]),
    fills = Object.freeze([]),
    points = Object.freeze([]),
    texts = Object.freeze([]),
    transforms = Object.freeze([]),
    styles = Object.freeze([]),
    baseSuppressions = Object.freeze([]),
    affectedWorldBounds = null,
  } = {}) {
    if (!this.overviewScene) {
      throw new Error("cannot activate a render delta before the overview");
    }
    if (
      !Array.isArray(lines) ||
      !Array.isArray(fills) ||
      !Array.isArray(points) ||
      !Array.isArray(texts) ||
      !Array.isArray(transforms) ||
      !Array.isArray(styles) ||
      !Array.isArray(baseSuppressions)
    ) {
      throw new TypeError("render delta state is invalid");
    }
    const resourceKeys = new Set();
    const normalizedLines = [];
    for (const entry of lines) {
      if (
        !this.renderDeltaResources.has(entry) ||
        entry.resourceKind !== "line" ||
        resourceKeys.has(entry.key) ||
        (entry.sceneId !== ROOT_RENDER_DELTA_SCENE_ID &&
          !this.externalScenes.has(entry.sceneId))
      ) {
        throw new TypeError("render delta line resource is invalid");
      }
      resourceKeys.add(entry.key);
      normalizedLines.push(entry);
    }
    const normalizedFills = [];
    for (const entry of fills) {
      if (
        !this.renderDeltaResources.has(entry) ||
        entry.resourceKind !== "fill" ||
        resourceKeys.has(entry.key) ||
        (entry.sceneId !== ROOT_RENDER_DELTA_SCENE_ID &&
          !this.externalScenes.has(entry.sceneId))
      ) {
        throw new TypeError("render delta fill resource is invalid");
      }
      resourceKeys.add(entry.key);
      normalizedFills.push(entry);
    }
    const normalizedPoints = [];
    for (const entry of points) {
      if (
        !this.renderDeltaResources.has(entry) ||
        entry.resourceKind !== "point" ||
        resourceKeys.has(entry.key) ||
        (entry.sceneId !== ROOT_RENDER_DELTA_SCENE_ID &&
          !this.externalScenes.has(entry.sceneId))
      ) {
        throw new TypeError("render delta point resource is invalid");
      }
      resourceKeys.add(entry.key);
      normalizedPoints.push(entry);
    }
    const normalizedTexts = [];
    for (const entry of texts) {
      if (
        !this.renderDeltaResources.has(entry) ||
        entry.resourceKind !== "text" ||
        resourceKeys.has(entry.key) ||
        (entry.sceneId !== ROOT_RENDER_DELTA_SCENE_ID &&
          !this.externalScenes.has(entry.sceneId))
      ) {
        throw new TypeError("render delta text resource is invalid");
      }
      resourceKeys.add(entry.key);
      normalizedTexts.push(entry);
    }
    const normalizedTransforms = [];
    for (const entry of transforms) {
      if (
        !this.renderDeltaResources.has(entry) ||
        entry.resourceKind !== "transform" ||
        resourceKeys.has(entry.key) ||
        (entry.sceneId !== ROOT_RENDER_DELTA_SCENE_ID &&
          !this.externalScenes.has(entry.sceneId))
      ) {
        throw new TypeError(
          "render delta transform resource is invalid",
        );
      }
      resourceKeys.add(entry.key);
      normalizedTransforms.push(entry);
    }
    const normalizedStyles = [];
    for (const entry of styles) {
      if (
        !this.renderDeltaResources.has(entry) ||
        entry.resourceKind !== "style" ||
        resourceKeys.has(entry.key) ||
        (entry.sceneId !== ROOT_RENDER_DELTA_SCENE_ID &&
          !this.externalScenes.has(entry.sceneId))
      ) {
        throw new TypeError(
          "render delta style resource is invalid",
        );
      }
      resourceKeys.add(entry.key);
      normalizedStyles.push(entry);
    }
    const normalizedSuppressions = [];
    const suppressionKeys = new Set();
    for (const value of baseSuppressions) {
      const identity = normalizeRenderDeltaIdentity(value);
      if (
        identity.sceneId !== ROOT_RENDER_DELTA_SCENE_ID &&
        !this.externalScenes.has(identity.sceneId)
      ) {
        throw new TypeError(
          "render delta suppression target is unavailable",
        );
      }
      if (suppressionKeys.has(identity.key)) {
        continue;
      }
      suppressionKeys.add(identity.key);
      normalizedSuppressions.push(identity);
    }
    if (
      affectedWorldBounds !== null &&
      !boundsAreFinite(affectedWorldBounds)
    ) {
      throw new TypeError("render delta affected bounds are invalid");
    }
    const next = Object.freeze({
      lines: Object.freeze(normalizedLines),
      fills: Object.freeze(normalizedFills),
      points: Object.freeze(normalizedPoints),
      texts: Object.freeze(normalizedTexts),
      transforms: Object.freeze(normalizedTransforms),
      styles: Object.freeze(normalizedStyles),
      baseSuppressions: Object.freeze(normalizedSuppressions),
      suppressionKeys,
      affectedWorldBounds:
        affectedWorldBounds === null
          ? null
          : Object.freeze({
              min: Object.freeze([...affectedWorldBounds.min]),
              max: Object.freeze([...affectedWorldBounds.max]),
            }),
    });
    const transformIndexesByGraph = new WeakMap();
    const rootTransformIndex = indexDwgRenderDeltaTransforms(
      normalizedTransforms,
      {
        sourceId: ROOT_RENDER_DELTA_SCENE_ID,
        instanceGraph: this.overviewScene.instanceGraph,
      },
    );
    transformIndexesByGraph.set(
      this.overviewScene.instanceGraph,
      rootTransformIndex,
    );
    for (const scene of this.externalScenes.values()) {
      transformIndexesByGraph.set(
        scene.instanceGraph,
        indexDwgRenderDeltaTransforms(normalizedTransforms, {
          sourceId: scene.id,
          instanceGraph: scene.instanceGraph,
        }),
      );
    }
    const styleIndexesByGraph = new WeakMap();
    const rootStyleIndex = indexDwgRenderDeltaStyles(
      normalizedStyles,
      {
        sourceId: ROOT_RENDER_DELTA_SCENE_ID,
        instanceGraph: this.overviewScene.instanceGraph,
      },
    );
    styleIndexesByGraph.set(
      this.overviewScene.instanceGraph,
      rootStyleIndex,
    );
    for (const scene of this.externalScenes.values()) {
      styleIndexesByGraph.set(
        scene.instanceGraph,
        indexDwgRenderDeltaStyles(normalizedStyles, {
          sourceId: scene.id,
          instanceGraph: scene.instanceGraph,
        }),
      );
    }
    this.applyOverlayRenderDeltaState(next);
    this.renderDeltaState = next;
    this.renderDeltaTransformIndexesByGraph =
      transformIndexesByGraph;
    this.renderDeltaStyleIndexesByGraph = styleIndexesByGraph;
    this.renderDeltaRangeCache = new WeakMap();
    this.recalculateCombinedBounds();
    return this.renderDeltaSnapshot();
  }

  releaseRenderDeltaResources(resources) {
    if (!Array.isArray(resources)) {
      throw new TypeError(
        "render delta resource disposal requires an array",
      );
    }
    const active = new Set([
      ...this.renderDeltaState.lines,
      ...this.renderDeltaState.fills,
      ...this.renderDeltaState.points,
      ...this.renderDeltaState.texts,
      ...this.renderDeltaState.transforms,
      ...this.renderDeltaState.styles,
    ]);
    const unique = [...new Set(resources)];
    for (const entry of unique) {
      if (
        !this.renderDeltaResources.has(entry) ||
        active.has(entry)
      ) {
        throw new TypeError(
          "cannot release an active or unknown render delta resource",
        );
      }
    }
    for (const entry of unique) {
      this.renderDeltaResources.delete(entry);
      if (entry.resourceKind === "text") {
        this.renderDeltaTextResourceBytes -= entry.byteLength;
      } else if (entry.resourceKind === "transform") {
        this.renderDeltaTransformResourceBytes -= entry.byteLength;
      } else if (entry.resourceKind === "style") {
        this.renderDeltaStyleResourceBytes -= entry.byteLength;
      } else {
        this.renderDeltaResourceBytes -= entry.byteLength;
        this.deleteVertices(entry.resource);
      }
    }
    return unique.length;
  }

  releaseRenderDeltaLines(lines) {
    return this.releaseRenderDeltaResources(lines);
  }

  renderDeltaSnapshot() {
    const activeBytes = [
      ...this.renderDeltaState.lines,
      ...this.renderDeltaState.fills,
      ...this.renderDeltaState.points,
    ].reduce((total, entry) => total + entry.byteLength, 0);
    const activeTextBytes = this.renderDeltaState.texts.reduce(
      (total, entry) => total + entry.byteLength,
      0,
    );
    const activeTransformBytes =
      this.renderDeltaState.transforms.reduce(
        (total, entry) => total + entry.byteLength,
        0,
      );
    const activeStyleBytes = this.renderDeltaState.styles.reduce(
      (total, entry) => total + entry.byteLength,
      0,
    );
    return Object.freeze({
      lineBatches: this.renderDeltaState.lines.length,
      fillBatches: this.renderDeltaState.fills.length,
      pointBatches: this.renderDeltaState.points.length,
      activeGpuBytes: activeBytes,
      textRecords: this.renderDeltaState.texts.length,
      activeTextBytes,
      transformRecords: this.renderDeltaState.transforms.length,
      activeTransformBytes,
      styleRecords: this.renderDeltaState.styles.length,
      activeStyleBytes,
      activeResourceBytes:
        activeBytes +
        activeTextBytes +
        activeTransformBytes +
        activeStyleBytes,
      allocatedGpuBytes: this.renderDeltaResourceBytes,
      allocatedTextBytes: this.renderDeltaTextResourceBytes,
      allocatedTransformBytes:
        this.renderDeltaTransformResourceBytes,
      allocatedStyleBytes: this.renderDeltaStyleResourceBytes,
      allocatedResourceBytes:
        this.renderDeltaResourceBytes +
        this.renderDeltaTextResourceBytes +
        this.renderDeltaTransformResourceBytes +
        this.renderDeltaStyleResourceBytes,
      baseSuppressions:
        this.renderDeltaState.baseSuppressions.length,
      affectedWorldBounds:
        this.renderDeltaState.affectedWorldBounds,
    });
  }

  renderDeltaLineRanges(
    sceneId,
    batch,
    vertices,
    firstBufferVertex,
    resource,
  ) {
    if (this.renderDeltaState.suppressionKeys.size === 0) {
      return null;
    }
    let entries = this.renderDeltaRangeCache.get(resource);
    if (!entries) {
      entries = new Map();
      this.renderDeltaRangeCache.set(resource, entries);
    }
    const key =
      `${sceneId}\u0000${batch.id}\u0000${batch.firstVertex}` +
      `\u0000${batch.vertexCount}\u0000${firstBufferVertex}`;
    let ranges = entries.get(key);
    if (!ranges) {
      ranges = lineVisibilityRanges(
        vertices,
        batch,
        firstBufferVertex,
        sceneId,
        this.renderDeltaState.suppressionKeys,
      );
      entries.set(key, ranges);
    }
    return ranges;
  }

  renderDeltaIdentityRanges(
    sceneId,
    batch,
    identityRanges,
    resource,
  ) {
    if (this.renderDeltaState.suppressionKeys.size === 0) {
      return null;
    }
    let entries = this.renderDeltaRangeCache.get(resource);
    if (!entries) {
      entries = new Map();
      this.renderDeltaRangeCache.set(resource, entries);
    }
    const key =
      `identity\u0000${sceneId}\u0000${batch.id}` +
      `\u0000${batch.firstVertex}\u0000${batch.vertexCount}`;
    let ranges = entries.get(key);
    if (!ranges) {
      ranges = identityVisibilityRanges(
        identityRanges,
        batch,
        sceneId,
        this.renderDeltaState.suppressionKeys,
      );
      entries.set(key, ranges);
    }
    return ranges;
  }

  resize(targetSize = null) {
    const ratio = Math.min(globalThis.devicePixelRatio ?? 1, 2);
    const width = targetSize
      ? targetSize.width
      : Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = targetSize
      ? targetSize.height
      : Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      !Number.isSafeInteger(height) ||
      height <= 0
    ) {
      throw new RangeError("render target size must use positive integers");
    }
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.gl.viewport(0, 0, width, height);
    return { width, height };
  }

  cameraForView(view = this.overviewScene?.camera, targetSize = null) {
    if (!view || !Array.isArray(view.origin)) {
      throw new TypeError("cannot resolve an invalid camera view");
    }
    const size = this.resize(targetSize);
    return makeCameraFromView(
      view.origin,
      view.worldHeight,
      size.width,
      size.height,
    );
  }

  renderOverview({
    batches,
    layers,
    blocks = Object.freeze([]),
    instanceGraph,
    vertices,
    lineWeightDisplay = false,
    linetypes = Object.freeze([]),
    layerLinetypeCodes = new Uint16Array(0),
    globalLinetypeScale = 1,
    preferredBounds = null,
    preferredView = null,
    supplementalBounds = null,
  }) {
    const size = this.resize();
    this.setLayers(layers);
    this.setViewportLayerVisibility(instanceGraph);
    this.setLinetypes(
      linetypes,
      layerLinetypeCodes,
      globalLinetypeScale,
    );
    this.setLineWeightsVisible(lineWeightDisplay);
    this.blocks = blocks;
    let bounds = calculateOverviewBounds(batches, instanceGraph);
    includeFiniteBounds(bounds, supplementalBounds);
    if (preferredBounds && boundsAreFinite(preferredBounds)) {
      if (!boundsAreFinite(bounds)) {
        bounds = {
          min: [...preferredBounds.min],
          max: [...preferredBounds.max],
        };
      } else {
        bounds = {
          min: bounds.min.map((value, axis) =>
            Math.min(value, preferredBounds.min[axis]),
          ),
          max: bounds.max.map((value, axis) =>
            Math.max(value, preferredBounds.max[axis]),
          ),
        };
      }
    }
    if (!boundsAreFinite(bounds)) {
      throw new Error("overview does not contain any drawable model-space geometry");
    }
    const fitBounds =
      preferredBounds && boundsAreFinite(preferredBounds)
        ? {
            min: [...preferredBounds.min],
            max: [...preferredBounds.max],
          }
        : {
            min: [...bounds.min],
            max: [...bounds.max],
          };
    const fittedView = normalizePreferredView(preferredView);
    const camera = fittedView
      ? makeCameraFromView(
          fittedView.origin,
          fittedView.worldHeight,
          size.width,
          size.height,
        )
      : makeCamera(bounds, size.width, size.height);
    const resource = this.uploadVertices(vertices.buffer);
    this.overviewScene = Object.freeze({
      batches,
      bounds,
      fitBounds,
      camera,
      preferredView: fittedView,
      instanceGraph,
      resource,
      vertices,
    });
    this.supplementalBounds.clear();
    if (supplementalBounds && boundsAreFinite(supplementalBounds)) {
      this.supplementalBounds.set("root", {
        min: [...supplementalBounds.min],
        max: [...supplementalBounds.max],
      });
    }
    this.recalculateCombinedBounds();
    return Object.freeze({ ...this.redraw(camera), resource });
  }

  setInstanceGraph(
    instanceGraph,
    {
      preferredBounds = null,
      preferredView = null,
      supplementalBounds = null,
      clearExternal = true,
    } = {},
  ) {
    if (!this.overviewScene) {
      throw new Error("cannot switch a view before rendering an overview");
    }
    this.clearCurveRefinement();
    let bounds = calculateOverviewBounds(
      this.overviewScene.batches,
      instanceGraph,
    );
    includeFiniteBounds(bounds, supplementalBounds);
    if (preferredBounds && boundsAreFinite(preferredBounds)) {
      if (!boundsAreFinite(bounds)) {
        bounds = {
          min: [...preferredBounds.min],
          max: [...preferredBounds.max],
        };
      } else {
        bounds = {
          min: bounds.min.map((value, axis) =>
            Math.min(value, preferredBounds.min[axis]),
          ),
          max: bounds.max.map((value, axis) =>
            Math.max(value, preferredBounds.max[axis]),
          ),
        };
      }
    }
    if (!boundsAreFinite(bounds)) {
      throw new Error("selected layout does not contain drawable geometry");
    }
    const fitBounds =
      preferredBounds && boundsAreFinite(preferredBounds)
        ? {
            min: [...preferredBounds.min],
            max: [...preferredBounds.max],
          }
        : {
            min: [...bounds.min],
            max: [...bounds.max],
          };
    this.setViewportLayerVisibility(instanceGraph);
    this.detailSelections.clear();
    this.clearHatchPatterns();
    this.overviewScene = Object.freeze({
      ...this.overviewScene,
      bounds,
      fitBounds,
      preferredView: normalizePreferredView(preferredView),
      instanceGraph,
    });
    if (clearExternal) {
      for (const scene of this.externalScenes.values()) {
        this.deleteVertices(scene.resource);
        for (const entry of scene.detailResources.values()) {
          this.deleteVertices(entry.resource);
        }
      }
      this.externalScenes.clear();
    }
    this.supplementalBounds.clear();
    if (supplementalBounds && boundsAreFinite(supplementalBounds)) {
      this.supplementalBounds.set("root", {
        min: [...supplementalBounds.min],
        max: [...supplementalBounds.max],
      });
    }
    this.recalculateCombinedBounds();
    const camera = this.fitCamera();
    return Object.freeze({ ...this.redraw(camera), camera });
  }

  addExternalOverview({
    id,
    batches,
    instanceGraph,
    vertices,
  }) {
    if (!this.overviewScene || typeof id !== "string" || !id) {
      throw new Error("cannot add an external overview before the root scene");
    }
    if (
      !vertices ||
      vertices.byteLength !== vertices.vertexCount * VERTEX_STRIDE ||
      vertices.buffer.byteLength !== vertices.byteLength
    ) {
      throw new Error("external overview vertex payload is inconsistent");
    }
    const bounds = calculateOverviewBounds(batches, instanceGraph);
    if (!boundsAreFinite(bounds)) {
      throw new Error("external reference has no drawable overview geometry");
    }
    const previous = this.externalScenes.get(id);
    const currentBytes = [...this.externalScenes.values()].reduce(
      (total, scene) => total + scene.resource.byteLength,
      0,
    );
    const nextBytes =
      currentBytes -
      (previous?.resource.byteLength ?? 0) +
      vertices.byteLength;
    if (nextBytes > this.maximumExternalOverviewBytes) {
      throw new Error(
        `external overview GPU data exceeds the ${this.maximumExternalOverviewBytes}-byte limit`,
      );
    }
    if (previous) {
      this.deleteVertices(previous.resource);
      for (const entry of previous.detailResources.values()) {
        this.deleteVertices(entry.resource);
      }
    }
    const scene = {
      id,
      batches,
      bounds,
      instanceGraph,
      resource: this.uploadVertices(vertices.buffer),
      vertices,
      detailResources: new Map(),
      detailSelections: new Map(),
    };
    this.externalScenes.set(id, scene);
    this.recalculateCombinedBounds();
    return Object.freeze({
      bounds,
      camera: this.fitCamera(),
      resource: scene.resource,
    });
  }

  setSupplementalBounds(id, bounds) {
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError("supplemental bounds require a stable id");
    }
    if (bounds === null || bounds === undefined) {
      this.supplementalBounds.delete(id);
    } else {
      if (!boundsAreFinite(bounds)) {
        throw new TypeError("supplemental bounds must be finite");
      }
      this.supplementalBounds.set(id, {
        min: [...bounds.min],
        max: [...bounds.max],
      });
    }
    this.recalculateCombinedBounds();
    return Object.freeze({
      bounds: this.combinedBounds,
      camera: this.overviewScene ? this.fitCamera() : null,
    });
  }

  recalculateCombinedBounds() {
    if (!this.overviewScene) {
      this.combinedBounds = null;
      return;
    }
    const combined = {
      min: [
        ...(this.overviewScene.fitBounds ?? this.overviewScene.bounds).min,
      ],
      max: [
        ...(this.overviewScene.fitBounds ?? this.overviewScene.bounds).max,
      ],
    };
    for (const scene of this.externalScenes.values()) {
      for (let axis = 0; axis < 3; axis += 1) {
        combined.min[axis] = Math.min(
          combined.min[axis],
          scene.bounds.min[axis],
        );
        combined.max[axis] = Math.max(
          combined.max[axis],
          scene.bounds.max[axis],
        );
      }
    }
    for (const bounds of this.supplementalBounds.values()) {
      includeFiniteBounds(combined, bounds);
    }
    includeFiniteBounds(
      combined,
      this.renderDeltaState.affectedWorldBounds,
    );
    this.combinedBounds = combined;
  }

  fitCamera(targetSize = null) {
    if (this.overviewScene?.preferredView) {
      const size = this.resize(targetSize);
      return makeCameraFromView(
        this.overviewScene.preferredView.origin,
        this.overviewScene.preferredView.worldHeight,
        size.width,
        size.height,
      );
    }
    return this.fitAllCamera(targetSize);
  }

  fitAllCamera(targetSize = null) {
    if (!this.combinedBounds || !boundsAreFinite(this.combinedBounds)) {
      throw new Error("viewer has no finite fitted bounds");
    }
    const size = this.resize(targetSize);
    return makeCamera(
      this.combinedBounds,
      size.width,
      size.height,
    );
  }

  addExternalDetailBatch(sceneId, batch, vertices) {
    const scene = this.externalScenes.get(sceneId);
    if (!scene) {
      throw new Error("external scene is not available");
    }
    const existing = scene.detailResources.get(batch.id);
    if (existing) {
      return existing;
    }
    if (
      vertices.vertexCount !== batch.vertexCount ||
      vertices.byteLength !== batch.vertexCount * VERTEX_STRIDE
    ) {
      throw new Error(
        `external GPU detail batch ${batch.id} has an invalid vertex payload`,
      );
    }
    const currentBytes = [...this.externalScenes.values()].reduce(
      (total, externalScene) =>
        total +
        [...externalScene.detailResources.values()].reduce(
          (sceneTotal, entry) => sceneTotal + entry.byteLength,
          0,
        ),
      0,
    );
    if (
      vertices.byteLength >
      this.maximumExternalDetailBytes - currentBytes
    ) {
      throw new Error(
        `external detail GPU data exceeds the ${this.maximumExternalDetailBytes}-byte limit`,
      );
    }
    const entry = Object.freeze({
      batch,
      resource: this.uploadVertices(vertices.buffer),
      byteLength: vertices.byteLength,
      vertices,
    });
    scene.detailResources.set(batch.id, entry);
    return entry;
  }

  deleteExternalDetailBatch(sceneId, batchId) {
    const scene = this.externalScenes.get(sceneId);
    const entry = scene?.detailResources.get(batchId);
    if (!scene || !entry) {
      return false;
    }
    scene.detailResources.delete(batchId);
    this.deleteVertices(entry.resource);
    return true;
  }

  setExternalDetailSelections(sceneId, candidates) {
    const scene = this.externalScenes.get(sceneId);
    if (!scene) {
      return;
    }
    scene.detailSelections = new Map(
      candidates.map((candidate) => [candidate.batch.id, candidate]),
    );
  }

  setMaskComposition({
    maskOrder,
    instanceGraph,
    blocks = this.blocks,
    overviewVertices,
  }) {
    if (!this.overviewScene) {
      throw new Error("cannot enable mask composition before the overview");
    }
    if (this.detailResources.size > 0) {
      throw new Error("mask composition must precede detail streaming");
    }
    this.blocks = blocks;
    const enabled =
      Boolean(maskOrder?.enabled) &&
      Boolean(instanceGraph?.maskOrderEnabled);
    this.maskOrder = enabled ? maskOrder : null;
    if (enabled) {
      patchLineMaskBuckets(
        overviewVertices.buffer,
        this.overviewScene.batches,
        maskOrder,
        blocks,
      );
    }
    const previous = this.overviewScene.resource;
    const resource = this.uploadVertices(overviewVertices.buffer);
    this.overviewScene = Object.freeze({
      ...this.overviewScene,
      instanceGraph,
      resource,
      vertices: overviewVertices,
    });
    this.deleteVertices(previous);
    return enabled;
  }

  setHatchFills({
    batches,
    vertices,
    identityRanges,
    metrics = null,
  }) {
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
    validateRenderIdentityRanges(identityRanges, {
      vertexCount: vertices.vertexCount,
      verticesPerPrimitive: 3,
      label: "HATCH fill render identity ranges",
    });
    if (this.hatchFillScene?.resource) {
      this.deleteVertices(this.hatchFillScene.resource);
    }
    const resource =
      vertices.byteLength > 0
        ? this.uploadHatchFillVertices(vertices.buffer)
        : null;
    this.hatchFillScene = Object.freeze({
      batches,
      identityRanges,
      metrics,
      resource,
    });
  }

  setHatchPatterns({
    batches,
    vertices,
    identityRanges,
    metrics = null,
  }) {
    if (
      !vertices ||
      vertices.byteLength !==
        vertices.vertexCount * PRIMITIVE_VERTEX_STRIDE ||
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
    validateRenderIdentityRanges(identityRanges, {
      vertexCount: vertices.vertexCount,
      verticesPerPrimitive: 2,
      label: "HATCH pattern render identity ranges",
    });
    this.clearHatchPatterns();
    const resource =
      vertices.byteLength > 0
        ? this.uploadVertices(vertices.buffer, {
            stride: PRIMITIVE_VERTEX_STRIDE,
            patternDistance: false,
          })
        : null;
    this.hatchPatternScene = Object.freeze({
      batches,
      identityRanges,
      metrics,
      resource,
    });
  }

  clearHatchPatterns() {
    if (this.hatchPatternScene?.resource) {
      this.deleteVertices(this.hatchPatternScene.resource);
    }
    this.hatchPatternScene = null;
  }

  setPrimitiveMeshes({
    points,
    solidFills,
    solidOutlines,
    wipeoutMasks = EMPTY_PACKED_SCENE,
    metrics = null,
  }) {
    validatePackedScene(points, 1, "POINT");
    validatePackedScene(solidFills, 3, "SOLID fill");
    validatePackedScene(solidOutlines, 2, "surface outline");
    validatePackedScene(wipeoutMasks, 3, "WIPEOUT mask");
    const gpuBytes =
      points.vertices.byteLength +
      solidFills.vertices.byteLength +
      solidOutlines.vertices.byteLength +
      wipeoutMasks.vertices.byteLength;
    if (gpuBytes > MAX_PRIMITIVE_GPU_BYTES) {
      throw new Error(
        `primitive GPU payload exceeds the ${MAX_PRIMITIVE_GPU_BYTES}-byte limit`,
      );
    }
    for (const scene of [
      this.pointScene,
      this.solidFillScene,
      this.solidOutlineScene,
      this.wipeoutMaskScene,
    ]) {
      if (scene?.resource) {
        this.deleteVertices(scene.resource);
      }
    }
    this.pointScene = Object.freeze({
      batches: points.batches,
      identityRanges: points.identityRanges,
      resource:
        points.vertices.byteLength > 0
          ? this.uploadPointVertices(points.vertices.buffer)
          : null,
    });
    this.solidFillScene = Object.freeze({
      batches: solidFills.batches,
      identityRanges: solidFills.identityRanges,
      resource:
        solidFills.vertices.byteLength > 0
          ? this.uploadHatchFillVertices(solidFills.vertices.buffer)
          : null,
    });
    this.solidOutlineScene = Object.freeze({
      batches: solidOutlines.batches,
      identityRanges: solidOutlines.identityRanges,
      resource:
        solidOutlines.vertices.byteLength > 0
          ? this.uploadVertices(solidOutlines.vertices.buffer, {
              stride: PRIMITIVE_VERTEX_STRIDE,
              patternDistance: false,
            })
          : null,
    });
    this.wipeoutMaskScene = Object.freeze({
      batches: wipeoutMasks.batches,
      identityRanges: wipeoutMasks.identityRanges,
      resource:
        wipeoutMasks.vertices.byteLength > 0
          ? this.uploadHatchFillVertices(wipeoutMasks.vertices.buffer)
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
    if (this.maskOrder) {
      patchLineMaskBuckets(
        vertices.buffer,
        [batch],
        this.maskOrder,
        this.blocks,
        batch.firstVertex,
      );
    }
    if (this.curveReplacementHandles.size > 0) {
      patchCurveReplacementMarkers(
        vertices.buffer,
        this.curveReplacementHandles,
        { recordSize: vertices.recordSize ?? VERTEX_STRIDE },
      );
    }
    const entry = Object.freeze({
      batch,
      resource: this.uploadVertices(vertices.buffer),
      byteLength: vertices.byteLength,
      vertices,
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

  updateLineVertexResource(resource, vertices) {
    if (
      !resource ||
      !vertices ||
      !(vertices.buffer instanceof ArrayBuffer) ||
      resource.byteLength !== vertices.buffer.byteLength
    ) {
      throw new Error("line vertex update payload is inconsistent");
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, resource.vertexBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices.buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  applyCurveReplacementHandles(refinedHandles) {
    const patch = (vertices, resource) => {
      if (
        !vertices ||
        (vertices.recordSize ?? VERTEX_STRIDE) < VERTEX_STRIDE
      ) {
        return;
      }
      if (
        patchCurveReplacementMarkers(
          vertices.buffer,
          refinedHandles,
          { recordSize: vertices.recordSize ?? VERTEX_STRIDE },
        )
      ) {
        this.updateLineVertexResource(resource, vertices);
      }
    };
    patch(
      this.overviewScene?.vertices,
      this.overviewScene?.resource,
    );
    for (const entry of this.detailResources.values()) {
      patch(entry.vertices, entry.resource);
    }
    this.curveReplacementHandles = refinedHandles;
  }

  setCurveRefinement({
    entries,
    refinedHandleWords,
    cameraKey,
    metrics = null,
  }) {
    if (!this.overviewScene) {
      throw new Error("cannot set curve refinement before the overview");
    }
    if (!Array.isArray(entries) || typeof cameraKey !== "string") {
      throw new TypeError("curve refinement scene is invalid");
    }
    const refinedHandles = curveHandleSet(refinedHandleWords);
    let byteLength = 0;
    for (const [index, entry] of entries.entries()) {
      const { batch, vertices } = entry ?? {};
      if (
        !batch ||
        !vertices ||
        !(vertices.buffer instanceof ArrayBuffer) ||
        batch.id !== index ||
        batch.firstVertex !== 0 ||
        batch.vertexCount <= 0 ||
        batch.vertexCount % 2 !== 0 ||
        vertices.vertexCount !== batch.vertexCount ||
        vertices.byteLength !==
          vertices.vertexCount * VERTEX_STRIDE ||
        vertices.buffer.byteLength !== vertices.byteLength ||
        vertices.byteLength > MAX_CURVE_REFINEMENT_BATCH_BYTES
      ) {
        throw new Error(`curve refinement batch ${index} is invalid`);
      }
      byteLength += vertices.byteLength;
    }
    if (
      byteLength > MAX_CURVE_REFINEMENT_GPU_BYTES ||
      (refinedHandles.size === 0 && byteLength !== 0)
    ) {
      throw new Error("curve refinement GPU payload exceeds its limit");
    }
    if (this.curveRefinementScene) {
      for (const entry of this.curveRefinementScene.entries) {
        this.deleteVertices(entry.resource);
      }
    }
    this.applyCurveReplacementHandles(refinedHandles);
    const uploaded = entries.map((entry) =>
      Object.freeze({
        batch: entry.batch,
        resource: this.uploadVertices(entry.vertices.buffer),
        byteLength: entry.vertices.byteLength,
        vertices: entry.vertices,
      }),
    );
    this.curveRefinementScene = Object.freeze({
      entries: Object.freeze(uploaded),
      cameraKey,
      byteLength,
      metrics,
    });
    return this.curveRefinementScene;
  }

  clearCurveRefinement() {
    if (this.curveRefinementScene) {
      for (const entry of this.curveRefinementScene.entries) {
        this.deleteVertices(entry.resource);
      }
      this.curveRefinementScene = null;
    }
    if (this.curveReplacementHandles.size > 0) {
      this.applyCurveReplacementHandles(new Set());
    }
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
      wipeoutMask = false,
      curveRefinement = false,
      renderDelta = false,
      renderDeltaFill = false,
      renderDeltaPoint = false,
      firstVertex = batch.firstVertex,
      instanceIndices = null,
      primitive = this.gl.LINES,
      vertexRanges = null,
    } = {},
  ) {
    const gl = this.gl;
    const instances = instancesForBatch(batch, instanceGraph);
    const styleIndex =
      this.renderDeltaStyleIndexesByGraph.get(instanceGraph);
    const visibleInstanceIndices =
      visibleRenderDeltaInstanceIndices(
        instanceIndices,
        instances,
        styleIndex,
      );
    const totalInstances =
      visibleInstanceIndices?.length ?? instances.count;
    const ranges =
      vertexRanges ??
      Object.freeze([
        Object.freeze({
          firstVertex,
          vertexCount: batch.vertexCount,
        }),
      ]);
    if (totalInstances === 0 || ranges.length === 0) {
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
      const packed = this.instanceScratchView(instanceCount);
      const packedIntegers = new Uint32Array(
        packed.buffer,
        packed.byteOffset,
        packed.length,
      );
      for (let index = 0; index < instanceCount; index += 1) {
        const matrixIndex =
          visibleInstanceIndices?.[firstInstance + index] ??
          firstInstance + index;
        if (matrixIndex >= instances.count) {
          throw new Error(
            `GPU batch ${batch.id} references an invalid instance index`,
          );
        }
        const transform = renderDeltaInstanceTransform(
          this.renderDeltaTransformIndexesByGraph.get(
            instanceGraph,
          ),
          instances,
          matrixIndex,
        );
        const style = renderDeltaInstanceStyle(
          styleIndex,
          instances,
          matrixIndex,
        );
        batchRelativeInstanceMatrix(
          transform?.matrix ?? instances.data,
          batch.origin,
          camera.origin,
          transform ? 0 : matrixIndex * 16,
          packed,
          index * INSTANCE_VALUES,
        );
        packed[index * INSTANCE_VALUES + 16] =
          instances.maskBases?.[matrixIndex] ?? 0;
        const clipId = instances.clipIds?.[matrixIndex] ?? 0;
        const visibilityRow =
          instances.visibilityRows?.[matrixIndex] ?? 0;
        if (
          clipId < 0 ||
          clipId > MAX_PACKED_CLIP_ID ||
          visibilityRow < 0 ||
          visibilityRow >= MAX_VISIBILITY_ROWS
        ) {
          throw new RangeError(
            "instance clip or viewport visibility index exceeds its packed range",
          );
        }
        packed[index * INSTANCE_VALUES + 17] =
          clipId + visibilityRow * (1 << CLIP_ID_BITS);
        packedIntegers[index * INSTANCE_VALUES + 18] =
          style?.color ??
          instances.colors?.[matrixIndex] ??
          ((2 << 30) | 7);
        packedIntegers[index * INSTANCE_VALUES + 19] =
          style?.layerIndex ??
          instances.layerIndices?.[matrixIndex] ??
          0xffffffff;
        packed[index * INSTANCE_VALUES + 20] =
          style?.opacity ?? instances.opacities?.[matrixIndex] ?? 1;
        packed[index * INSTANCE_VALUES + 21] =
          style?.lineWeight ??
          instances.lineWeights?.[matrixIndex] ??
          -3;
        packedIntegers[index * INSTANCE_VALUES + 22] =
          style?.linetypeCode ??
          instances.linetypeCodes?.[matrixIndex] ??
          2;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, packed, gl.DYNAMIC_DRAW);
      this.instanceBufferBytes = packed.byteLength;
      this.peakInstanceBufferBytes = Math.max(
        this.peakInstanceBufferBytes,
        packed.byteLength,
      );
      metrics.instanceUploadBytes += packed.byteLength;
      metrics.maximumInstanceBufferBytes = Math.max(
        metrics.maximumInstanceBufferBytes,
        packed.byteLength,
      );
      for (const range of ranges) {
        gl.drawArraysInstanced(
          primitive,
          range.firstVertex,
          range.vertexCount,
          instanceCount,
        );
        metrics.drawCalls += 1;
        metrics.submittedInstances += instanceCount;
        metrics.submittedVertices +=
          range.vertexCount * instanceCount;
        if (detail) {
          metrics.detailDrawCalls += 1;
          metrics.detailSubmittedVertices +=
            range.vertexCount * instanceCount;
        }
        if (fill) {
          metrics.hatchFillDrawCalls += 1;
          metrics.hatchFillSubmittedVertices +=
            range.vertexCount * instanceCount;
        }
        if (pattern) {
          metrics.hatchPatternDrawCalls += 1;
          metrics.hatchPatternSubmittedVertices +=
            range.vertexCount * instanceCount;
        }
        if (point) {
          metrics.pointDrawCalls += 1;
          metrics.pointSubmittedVertices +=
            range.vertexCount * instanceCount;
        }
        if (solidFill) {
          metrics.solidFillDrawCalls += 1;
          metrics.solidFillSubmittedVertices +=
            range.vertexCount * instanceCount;
        }
        if (solidOutline) {
          metrics.solidOutlineDrawCalls += 1;
          metrics.solidOutlineSubmittedVertices +=
            range.vertexCount * instanceCount;
        }
        if (wipeoutMask) {
          metrics.wipeoutMaskDrawCalls += 1;
          metrics.wipeoutMaskSubmittedVertices +=
            range.vertexCount * instanceCount;
        }
        if (curveRefinement) {
          metrics.curveRefinementDrawCalls += 1;
          metrics.curveRefinementSubmittedVertices +=
            range.vertexCount * instanceCount;
        }
        if (renderDelta) {
          metrics.renderDeltaDrawCalls += 1;
          metrics.renderDeltaSubmittedVertices +=
            range.vertexCount * instanceCount;
        }
        if (renderDeltaFill) {
          metrics.renderDeltaFillDrawCalls += 1;
          metrics.renderDeltaFillSubmittedVertices +=
            range.vertexCount * instanceCount;
        }
        if (renderDeltaPoint) {
          metrics.renderDeltaPointDrawCalls += 1;
          metrics.renderDeltaPointSubmittedVertices +=
            range.vertexCount * instanceCount;
        }
      }
    }
  }

  redraw(
    view = this.overviewScene?.camera,
    {
      interactive = false,
      targetSize = null,
      updateOverlaySnapshots = targetSize === null,
    } = {},
  ) {
    if (!this.overviewScene || !view) {
      throw new Error("cannot redraw before the overview is initialized");
    }
    const gl = this.gl;
    const camera = this.cameraForView(view, targetSize);
    let cachedDetailGpuBytes = 0;
    for (const entry of this.detailResources.values()) {
      cachedDetailGpuBytes += entry.byteLength;
    }
    let externalOverviewGpuBytes = 0;
    let externalDetailGpuBytes = 0;
    let externalDetailBatches = 0;
    for (const scene of this.externalScenes.values()) {
      externalOverviewGpuBytes += scene.resource.byteLength;
      externalDetailBatches += scene.detailResources.size;
      for (const entry of scene.detailResources.values()) {
        externalDetailGpuBytes += entry.byteLength;
      }
    }
    const hatchFillGpuBytes = this.hatchFillScene?.resource?.byteLength ?? 0;
    const hatchPatternGpuBytes =
      this.hatchPatternScene?.resource?.byteLength ?? 0;
    const pointGpuBytes = this.pointScene?.resource?.byteLength ?? 0;
    const solidFillGpuBytes =
      this.solidFillScene?.resource?.byteLength ?? 0;
    const solidOutlineGpuBytes =
      this.solidOutlineScene?.resource?.byteLength ?? 0;
    const wipeoutMaskGpuBytes =
      this.wipeoutMaskScene?.resource?.byteLength ?? 0;
    const curveRefinementActive =
      !interactive &&
      Boolean(this.curveRefinementScene) &&
      this.curveRefinementScene.cameraKey ===
        curveRefinementCameraKey(camera);
    const curveRefinementGpuBytes =
      this.curveRefinementScene?.byteLength ?? 0;
    const renderDeltaLineGpuBytes =
      this.renderDeltaState.lines.reduce(
        (total, entry) => total + entry.byteLength,
        0,
      );
    const renderDeltaFillGpuBytes =
      this.renderDeltaState.fills.reduce(
        (total, entry) => total + entry.byteLength,
        0,
      );
    const renderDeltaPointGpuBytes =
      this.renderDeltaState.points.reduce(
        (total, entry) => total + entry.byteLength,
        0,
      );
    const renderDeltaGpuBytes =
      renderDeltaLineGpuBytes +
      renderDeltaFillGpuBytes +
      renderDeltaPointGpuBytes;
    const renderDeltaTextBytes =
      this.renderDeltaState.texts.reduce(
        (total, entry) => total + entry.byteLength,
        0,
      );
    const renderDeltaTransformBytes =
      this.renderDeltaState.transforms.reduce(
        (total, entry) => total + entry.byteLength,
        0,
      );
    const renderDeltaStyleBytes =
      this.renderDeltaState.styles.reduce(
        (total, entry) => total + entry.byteLength,
        0,
      );
    const metrics = {
      drawCalls: 0,
      detailDrawCalls: 0,
      detailBatches: 0,
      renderDeltaDrawCalls: 0,
      renderDeltaSubmittedVertices: 0,
      renderDeltaBatches: this.renderDeltaState.lines.length,
      renderDeltaLineGpuBytes,
      renderDeltaFillDrawCalls: 0,
      renderDeltaFillSubmittedVertices: 0,
      renderDeltaFillBatches: this.renderDeltaState.fills.length,
      renderDeltaFillGpuBytes,
      renderDeltaPointDrawCalls: 0,
      renderDeltaPointSubmittedVertices: 0,
      renderDeltaPointBatches: this.renderDeltaState.points.length,
      renderDeltaPointGpuBytes,
      renderDeltaTextRecords: this.renderDeltaState.texts.length,
      renderDeltaTextBytes,
      renderDeltaTransformRecords:
        this.renderDeltaState.transforms.length,
      renderDeltaTransformBytes,
      renderDeltaStyleRecords:
        this.renderDeltaState.styles.length,
      renderDeltaStyleBytes,
      renderDeltaGpuBytes,
      renderDeltaAllocatedGpuBytes:
        this.renderDeltaResourceBytes,
      renderDeltaAllocatedTextBytes:
        this.renderDeltaTextResourceBytes,
      renderDeltaAllocatedTransformBytes:
        this.renderDeltaTransformResourceBytes,
      renderDeltaAllocatedStyleBytes:
        this.renderDeltaStyleResourceBytes,
      renderDeltaAllocatedBytes:
        this.renderDeltaResourceBytes +
        this.renderDeltaTextResourceBytes +
        this.renderDeltaTransformResourceBytes +
        this.renderDeltaStyleResourceBytes,
      renderDeltaBaseSuppressions:
        this.renderDeltaState.baseSuppressions.length,
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
      wipeoutMaskDrawCalls: 0,
      wipeoutMaskSubmittedVertices: 0,
      wipeoutMaskGpuBytes,
      curveRefinementActive,
      curveRefinementDrawCalls: 0,
      curveRefinementSubmittedVertices: 0,
      curveRefinementGpuBytes,
      curveRefinement:
        this.curveRefinementScene?.metrics ?? null,
      primitives: this.primitiveMetrics,
      submittedInstances: 0,
      submittedVertices: 0,
      detailSubmittedVertices: 0,
      interactive,
      instanceUploadBytes: 0,
      maximumInstanceBufferBytes: 0,
      gpuVertexBytes:
        this.overviewScene.resource.byteLength +
        cachedDetailGpuBytes +
        externalOverviewGpuBytes +
        externalDetailGpuBytes +
        hatchFillGpuBytes +
        hatchPatternGpuBytes +
        pointGpuBytes +
        solidFillGpuBytes +
        solidOutlineGpuBytes +
        wipeoutMaskGpuBytes +
        curveRefinementGpuBytes +
        this.renderDeltaResourceBytes,
      cachedDetailGpuBytes,
      cachedDetailBatches: this.detailResources.size,
      externalScenes: this.externalScenes.size,
      externalOverviewGpuBytes,
      externalDetailGpuBytes,
      externalDetailBatches,
      bounds: this.combinedBounds ?? this.overviewScene.bounds,
      camera,
    };

    const maskCompositionEnabled =
      this.wipeoutMasksVisible &&
      Boolean(this.maskOrder) &&
      Boolean(this.wipeoutMaskScene?.resource);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (maskCompositionEnabled) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.GEQUAL);
      gl.depthMask(true);
    } else {
      gl.disable(gl.DEPTH_TEST);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTexture);

    if (
      this.wipeoutMaskScene?.resource ||
      this.solidFillScene?.resource ||
      this.hatchFillScene?.resource ||
      this.renderDeltaState.fills.length > 0
    ) {
      gl.useProgram(this.fillProgram);
      gl.uniformMatrix4fv(
        this.fillProjectionLocation,
        false,
        camera.projection,
      );
      gl.uniform1i(this.fillLayerCountLocation, this.layerCount);
      gl.uniform1i(
        this.fillLayerZeroIndexLocation,
        this.layerZeroIndex,
      );
      gl.uniform1i(this.fillLayerTextureLocation, 0);
      this.bindAciTexture(this.fillAciTextureLocation);
      this.bindViewportLayerVisibility(
        this.fillViewportLayerVisibilityLocation,
      );
      this.bindClipTexture(
        this.overviewScene.instanceGraph,
        camera,
        this.fillClipLocations,
      );
      if (maskCompositionEnabled) {
        gl.disable(gl.BLEND);
        for (const batch of this.wipeoutMaskScene.batches) {
          this.drawBatch(
            batch,
            this.wipeoutMaskScene.resource,
            this.overviewScene.instanceGraph,
            camera,
            metrics,
            {
              wipeoutMask: true,
              primitive: gl.TRIANGLES,
              vertexRanges: this.renderDeltaIdentityRanges(
                ROOT_RENDER_DELTA_SCENE_ID,
                batch,
                this.wipeoutMaskScene.identityRanges,
                this.wipeoutMaskScene.resource,
              ),
            },
          );
        }
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
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
              vertexRanges: this.renderDeltaIdentityRanges(
                ROOT_RENDER_DELTA_SCENE_ID,
                batch,
                this.solidFillScene.identityRanges,
                this.solidFillScene.resource,
              ),
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
              vertexRanges: this.renderDeltaIdentityRanges(
                ROOT_RENDER_DELTA_SCENE_ID,
                batch,
                this.hatchFillScene.identityRanges,
                this.hatchFillScene.resource,
              ),
            },
          );
        }
      }
      for (const entry of this.renderDeltaState.fills) {
        const scene =
          entry.sceneId === ROOT_RENDER_DELTA_SCENE_ID
            ? this.overviewScene
            : this.externalScenes.get(entry.sceneId);
        if (!scene) {
          continue;
        }
        this.bindClipTexture(
          scene.instanceGraph,
          camera,
          this.fillClipLocations,
        );
        this.drawBatch(
          entry.batch,
          entry.resource,
          scene.instanceGraph,
          camera,
          metrics,
          {
            renderDeltaFill: true,
            firstVertex: 0,
            instanceIndices: entry.instanceIndices,
            primitive: gl.TRIANGLES,
          },
        );
      }
    }
    if (
      !this.wipeoutMaskScene?.resource &&
      !this.solidFillScene?.resource &&
      !this.hatchFillScene?.resource &&
      this.renderDeltaState.fills.length === 0
    ) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.projectionLocation, false, camera.projection);
    gl.uniform1i(this.layerCountLocation, this.layerCount);
    gl.uniform1i(this.layerZeroIndexLocation, this.layerZeroIndex);
    gl.uniform1i(this.layerTextureLocation, 0);
    this.bindAciTexture(this.aciTextureLocation);
    this.bindLineWeightTexture();
    this.bindPlotStyleTextures();
    this.bindLinetypeTextures();
    this.bindViewportLayerVisibility(
      this.viewportLayerVisibilityLocation,
    );
    gl.uniform1i(
      this.linetypeCountLocation,
      this.linetypeTextureData.maximumCode + 1,
    );
    gl.uniform1f(
      this.globalLinetypeScaleLocation,
      this.globalLinetypeScale,
    );
    gl.uniform1f(
      this.worldPerPixelLocation,
      camera.worldHeight / camera.height,
    );
    gl.uniform1i(
      this.curveReplacementEnabledLocation,
      curveRefinementActive ? 1 : 0,
    );
    const linePasses = interactive
      ? [[0, 0, 0]]
      : this.lineWeightsVisible
      ? [
          [0, 0, 0],
          [0.75, 0, 1.5],
          [-0.75, 0, 1.5],
          [0, 0.75, 1.5],
          [0, -0.75, 1.5],
          [0.65, 0.65, 2.5],
          [-0.65, 0.65, 2.5],
          [0.65, -0.65, 2.5],
          [-0.65, -0.65, 2.5],
          [1.5, 0, 3.5],
          [-1.5, 0, 3.5],
          [0, 1.5, 3.5],
          [0, -1.5, 3.5],
        ]
      : [[0, 0, 0]];
    const cullContext = interactiveCullContext(camera);
    const minimumPixelSpan = interactive
      ? INTERACTIVE_MINIMUM_PIXEL_SPAN
      : 0;
    const overviewInstanceIndices = new Map();
    for (const batch of this.overviewScene.batches) {
      if (batch.lodLevel !== 0) {
        break;
      }
      overviewInstanceIndices.set(
        batch,
        selectInteractiveInstanceIndices(
          batch,
          this.overviewScene.instanceGraph,
          camera,
          {
            context: cullContext,
            minimumPixelSpan,
            transformIndex:
              this.renderDeltaTransformIndexesByGraph.get(
                this.overviewScene.instanceGraph,
              ),
            styleIndex:
              this.renderDeltaStyleIndexesByGraph.get(
                this.overviewScene.instanceGraph,
              ),
          },
        ),
      );
    }
    const externalInstanceIndices = new Map();
    for (const scene of this.externalScenes.values()) {
      const selections = new Map();
      for (const batch of scene.batches) {
        if (batch.lodLevel !== 0) {
          break;
        }
        selections.set(
          batch,
          selectInteractiveInstanceIndices(
            batch,
            scene.instanceGraph,
            camera,
            {
              context: cullContext,
              minimumPixelSpan,
              transformIndex:
                this.renderDeltaTransformIndexesByGraph.get(
                  scene.instanceGraph,
                ),
              styleIndex:
                this.renderDeltaStyleIndexesByGraph.get(
                  scene.instanceGraph,
                ),
            },
          ),
        );
      }
      externalInstanceIndices.set(scene, selections);
    }
    for (
      let linePassIndex = 0;
      linePassIndex < linePasses.length;
      linePassIndex += 1
    ) {
      const [offsetX, offsetY, threshold] = linePasses[linePassIndex];
      gl.uniform2f(
        this.lineOffsetLocation,
        (offsetX * 2) / camera.width,
        (offsetY * 2) / camera.height,
      );
      gl.uniform1f(this.lineWeightThresholdLocation, threshold);
      this.bindClipTexture(
        this.overviewScene.instanceGraph,
        camera,
        this.clipLocations,
      );
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
              vertexRanges: this.renderDeltaIdentityRanges(
                ROOT_RENDER_DELTA_SCENE_ID,
                batch,
                this.hatchPatternScene.identityRanges,
                this.hatchPatternScene.resource,
              ),
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
              vertexRanges: this.renderDeltaIdentityRanges(
                ROOT_RENDER_DELTA_SCENE_ID,
                batch,
                this.solidOutlineScene.identityRanges,
                this.solidOutlineScene.resource,
              ),
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
          {
            instanceIndices: overviewInstanceIndices.get(batch),
            vertexRanges: this.renderDeltaLineRanges(
              ROOT_RENDER_DELTA_SCENE_ID,
              batch,
              this.overviewScene.vertices,
              0,
              this.overviewScene.resource,
            ),
          },
        );
      }
      for (const scene of this.externalScenes.values()) {
        this.bindClipTexture(
          scene.instanceGraph,
          camera,
          this.clipLocations,
        );
        for (const batch of scene.batches) {
          if (batch.lodLevel !== 0) {
            break;
          }
          this.drawBatch(
            batch,
            scene.resource,
            scene.instanceGraph,
            camera,
            metrics,
            {
              instanceIndices:
                externalInstanceIndices.get(scene)?.get(batch) ?? null,
              vertexRanges: this.renderDeltaLineRanges(
                scene.id,
                batch,
                scene.vertices,
                0,
                scene.resource,
              ),
            },
          );
        }
        for (const [batchId, candidate] of scene.detailSelections) {
          const entry = scene.detailResources.get(batchId);
          if (!entry) {
            continue;
          }
          this.drawBatch(
            entry.batch,
            entry.resource,
            scene.instanceGraph,
            camera,
            metrics,
            {
              detail: true,
              firstVertex: 0,
              instanceIndices: candidate.instanceIndices,
              vertexRanges: this.renderDeltaLineRanges(
                scene.id,
                entry.batch,
                entry.vertices,
                entry.batch.firstVertex,
                entry.resource,
              ),
            },
          );
          if (linePassIndex === 0) {
            metrics.detailBatches += 1;
          }
        }
      }
      this.bindClipTexture(
        this.overviewScene.instanceGraph,
        camera,
        this.clipLocations,
      );
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
            vertexRanges: this.renderDeltaLineRanges(
              ROOT_RENDER_DELTA_SCENE_ID,
              entry.batch,
              entry.vertices,
              entry.batch.firstVertex,
              entry.resource,
            ),
          },
        );
        if (linePassIndex === 0) {
          metrics.detailBatches += 1;
        }
      }
      for (const entry of this.renderDeltaState.lines) {
        const scene =
          entry.sceneId === ROOT_RENDER_DELTA_SCENE_ID
            ? this.overviewScene
            : this.externalScenes.get(entry.sceneId);
        if (!scene) {
          continue;
        }
        this.bindClipTexture(
          scene.instanceGraph,
          camera,
          this.clipLocations,
        );
        this.drawBatch(
          entry.batch,
          entry.resource,
          scene.instanceGraph,
          camera,
          metrics,
          {
            renderDelta: true,
            firstVertex: 0,
            instanceIndices: entry.instanceIndices,
          },
        );
      }
      if (curveRefinementActive) {
        for (const entry of this.curveRefinementScene.entries) {
          this.drawBatch(
            entry.batch,
            entry.resource,
            this.overviewScene.instanceGraph,
            camera,
            metrics,
            {
              curveRefinement: true,
              firstVertex: 0,
              instanceIndices: entry.batch.instanceIndices,
              vertexRanges: this.renderDeltaLineRanges(
                ROOT_RENDER_DELTA_SCENE_ID,
                entry.batch,
                entry.vertices,
                0,
                entry.resource,
              ),
            },
          );
        }
      }
    }
    if (
      this.pointScene?.resource ||
      this.renderDeltaState.points.length > 0
    ) {
      gl.useProgram(this.pointProgram);
      gl.uniformMatrix4fv(
        this.pointProjectionLocation,
        false,
        camera.projection,
      );
      gl.uniform1i(this.pointLayerCountLocation, this.layerCount);
      gl.uniform1i(
        this.pointLayerZeroIndexLocation,
        this.layerZeroIndex,
      );
      gl.uniform1i(this.pointLayerTextureLocation, 0);
      this.bindAciTexture(this.pointAciTextureLocation);
      this.bindViewportLayerVisibility(
        this.pointViewportLayerVisibilityLocation,
      );
      gl.uniform1f(this.pointViewportHeightLocation, camera.height);
      gl.uniform1f(
        this.pointPixelsPerWorldLocation,
        camera.height / camera.worldHeight,
      );
      if (this.pointScene?.resource) {
        this.bindClipTexture(
          this.overviewScene.instanceGraph,
          camera,
          this.pointClipLocations,
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
              vertexRanges: this.renderDeltaIdentityRanges(
                ROOT_RENDER_DELTA_SCENE_ID,
                batch,
                this.pointScene.identityRanges,
                this.pointScene.resource,
              ),
            },
          );
        }
      }
      for (const entry of this.renderDeltaState.points) {
        const scene =
          entry.sceneId === ROOT_RENDER_DELTA_SCENE_ID
            ? this.overviewScene
            : this.externalScenes.get(entry.sceneId);
        if (!scene) {
          continue;
        }
        this.bindClipTexture(
          scene.instanceGraph,
          camera,
          this.pointClipLocations,
        );
        this.drawBatch(
          entry.batch,
          entry.resource,
          scene.instanceGraph,
          camera,
          metrics,
          {
            renderDeltaPoint: true,
            firstVertex: 0,
            instanceIndices: entry.instanceIndices,
            primitive: gl.POINTS,
          },
        );
      }
    }
    gl.bindVertexArray(null);
    if (interactive) {
      metrics.images = this.lastImageMetrics;
      metrics.text = this.lastTextMetrics;
      metrics.retainedImageOverlay = retainOverlayForCamera(
        this.imageOverlay,
        this.imageOverlaySnapshot,
        this.imageOverlayCamera,
        camera,
      );
      metrics.retainedTextOverlay = retainOverlayForCamera(
        this.textOverlay,
        this.textOverlaySnapshot,
        this.textOverlayCamera,
        camera,
      );
    } else {
      resetOverlayTransform(this.imageOverlay);
      resetOverlayTransform(this.textOverlay);
      const overlayOptions = targetSize
        ? { size: targetSize }
        : undefined;
      this.lastImageMetrics =
        this.imageOverlay?.redraw(
          camera,
          this.layerVisibility,
          overlayOptions,
        ) ?? null;
      this.lastTextMetrics =
        this.textOverlay?.redraw(
          camera,
          this.layerVisibility,
          overlayOptions,
        ) ?? null;
      if (updateOverlaySnapshots) {
        this.imageOverlaySnapshot = captureOverlaySnapshot(
          this.imageOverlay,
          this.imageOverlaySnapshot,
        );
        this.textOverlaySnapshot = captureOverlaySnapshot(
          this.textOverlay,
          this.textOverlaySnapshot,
        );
        this.imageOverlayCamera = this.imageOverlay ? camera : null;
        this.textOverlayCamera = this.textOverlay ? camera : null;
      }
      metrics.images = this.lastImageMetrics;
      metrics.text = this.lastTextMetrics;
      metrics.retainedImageOverlay = false;
      metrics.retainedTextOverlay = false;
    }
    metrics.instanceScratchBytes = this.instanceScratch.byteLength;
    metrics.instanceBufferBytes = this.instanceBufferBytes;
    metrics.peakInstanceBufferBytes = this.peakInstanceBufferBytes;
    metrics.layerTextureBytes = Math.max(this.layerCount, 1) * 4;
    metrics.lineWeightTextureBytes = this.layerLineWeights.byteLength;
    metrics.plotStyleTextureBytes =
      this.plotStyleLineWeights.byteLength +
      this.layerPlotStyleIndices.byteLength;
    metrics.layerLinetypeTextureBytes =
      this.layerLinetypeCodes.byteLength;
    metrics.linetypeTextureBytes =
      this.linetypeTextureData.headers.byteLength +
      this.linetypeTextureData.dashes.byteLength;
    metrics.complexLinetypes =
      this.linetypeTextureData.complexCount;
    metrics.truncatedLinetypes =
      this.linetypeTextureData.truncatedCount;
    metrics.aciTextureBytes = this.aciPalette.byteLength;
    metrics.clipTextureBytes = this.clipTextureBytes;
    metrics.viewportLayerVisibilityTextureBytes =
      this.viewportLayerVisibilityTextureBytes;
    metrics.gpuTrackedBytes =
      metrics.gpuVertexBytes +
      metrics.instanceBufferBytes +
      metrics.layerTextureBytes +
      metrics.lineWeightTextureBytes +
      metrics.plotStyleTextureBytes +
      metrics.layerLinetypeTextureBytes +
      metrics.linetypeTextureBytes +
      metrics.aciTextureBytes +
      metrics.clipTextureBytes +
      metrics.viewportLayerVisibilityTextureBytes;
    this.peakGpuTrackedBytes = Math.max(
      this.peakGpuTrackedBytes,
      metrics.gpuTrackedBytes,
    );
    metrics.peakGpuTrackedBytes = this.peakGpuTrackedBytes;
    return Object.freeze(metrics);
  }

  maximumRasterSize() {
    const dimensions = this.gl.getParameter(this.gl.MAX_VIEWPORT_DIMS);
    return Object.freeze({
      width: Math.max(1, Number(dimensions?.[0]) || 1),
      height: Math.max(1, Number(dimensions?.[1]) || 1),
    });
  }

  captureRaster(
    view = this.overviewScene?.camera,
    {
      width,
      height,
      background = "#ffffff",
    } = {},
  ) {
    const maximum = this.maximumRasterSize();
    if (
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      width > maximum.width ||
      !Number.isSafeInteger(height) ||
      height <= 0 ||
      height > maximum.height
    ) {
      throw new RangeError(
        `raster output must fit within ${maximum.width} × ${maximum.height}`,
      );
    }
    const metrics = this.redraw(view, {
      interactive: false,
      targetSize: { width, height },
      updateOverlaySnapshots: false,
    });
    const pixels = new Uint8Array(width * height * 4);
    this.gl.finish();
    this.gl.readPixels(
      0,
      0,
      width,
      height,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      pixels,
    );
    const rowBytes = width * 4;
    const row = new Uint8Array(rowBytes);
    for (let top = 0, bottom = height - 1; top < bottom; top += 1, bottom -= 1) {
      const topOffset = top * rowBytes;
      const bottomOffset = bottom * rowBytes;
      row.set(pixels.subarray(topOffset, topOffset + rowBytes));
      pixels.copyWithin(topOffset, bottomOffset, bottomOffset + rowBytes);
      pixels.set(row, bottomOffset);
    }
    const output = this.canvas.ownerDocument.createElement("canvas");
    output.width = width;
    output.height = height;
    const context = output.getContext("2d", { alpha: true });
    if (!context) {
      throw new Error("cannot create the raster output canvas");
    }
    const imageData = new ImageData(
      new Uint8ClampedArray(pixels.buffer),
      width,
      height,
    );
    context.putImageData(imageData, 0, 0);
    context.globalCompositeOperation = "destination-over";
    if (this.imageOverlay?.canvas) {
      context.drawImage(this.imageOverlay.canvas, 0, 0, width, height);
    }
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    context.globalCompositeOperation = "source-over";
    if (this.textOverlay?.canvas) {
      context.drawImage(this.textOverlay.canvas, 0, 0, width, height);
    }
    return Object.freeze({ canvas: output, metrics });
  }

  dispose() {
    for (const resource of [...this.vertexResources]) {
      this.deleteVertices(resource);
    }
    this.gl.deleteBuffer(this.instanceBuffer);
    this.gl.deleteTexture(this.layerTexture);
    this.gl.deleteTexture(this.clipTexture);
    this.gl.deleteTexture(this.aciTexture);
    this.gl.deleteTexture(this.lineWeightTexture);
    this.gl.deleteTexture(this.plotStyleLineWeightTexture);
    this.gl.deleteTexture(this.layerPlotStyleIndexTexture);
    this.gl.deleteTexture(this.layerLinetypeTexture);
    this.gl.deleteTexture(this.linetypeHeaderTexture);
    this.gl.deleteTexture(this.linetypeDashTexture);
    this.gl.deleteTexture(this.viewportLayerVisibilityTexture);
    this.gl.deleteProgram(this.program);
    this.gl.deleteProgram(this.fillProgram);
    this.gl.deleteProgram(this.pointProgram);
    this.detailResources.clear();
    this.detailSelections.clear();
    this.renderDeltaResources.clear();
    this.renderDeltaResourceBytes = 0;
    this.renderDeltaTextResourceBytes = 0;
    this.renderDeltaTransformResourceBytes = 0;
    this.renderDeltaStyleResourceBytes = 0;
    this.renderDeltaState = Object.freeze({
      lines: Object.freeze([]),
      fills: Object.freeze([]),
      points: Object.freeze([]),
      texts: Object.freeze([]),
      transforms: Object.freeze([]),
      styles: Object.freeze([]),
      baseSuppressions: Object.freeze([]),
      suppressionKeys: new Set(),
      affectedWorldBounds: null,
    });
    this.renderDeltaTransformIndexesByGraph = new WeakMap();
    this.renderDeltaStyleIndexesByGraph = new WeakMap();
    this.renderDeltaRangeCache = new WeakMap();
    this.curveRefinementScene = null;
    this.curveReplacementHandles.clear();
    this.externalScenes.clear();
    this.supplementalBounds.clear();
    resetOverlayTransform(this.imageOverlay);
    this.imageOverlay?.dispose();
    this.imageOverlay = null;
    releaseOverlaySnapshot(this.imageOverlaySnapshot);
    this.imageOverlaySnapshot = null;
    resetOverlayTransform(this.textOverlay);
    this.textOverlay?.dispose();
    this.textOverlay = null;
    releaseOverlaySnapshot(this.textOverlaySnapshot);
    this.textOverlaySnapshot = null;
    this.imageOverlayCamera = null;
    this.textOverlayCamera = null;
    this.lastImageMetrics = null;
    this.lastTextMetrics = null;
    this.hatchFillScene = null;
    this.hatchPatternScene = null;
    this.pointScene = null;
    this.solidFillScene = null;
    this.solidOutlineScene = null;
    this.wipeoutMaskScene = null;
    this.instanceScratch = new Float32Array(0);
    this.instanceBufferBytes = 0;
    this.clipTextureBytes = 0;
    this.viewportLayerVisibilityTextureBytes = 0;
    this.boundClipGraph = null;
    this.boundClipPayload = null;
    this.boundClipOriginX = undefined;
    this.boundClipOriginY = undefined;
    this.peakInstanceBufferBytes = 0;
    this.peakGpuTrackedBytes = 0;
    this.primitiveMetrics = null;
    this.maskOrder = null;
    this.wipeoutMasksVisible = true;
    this.blocks = Object.freeze([]);
    this.overviewScene = null;
    this.combinedBounds = null;
  }
}

export {
  MAX_EXTERNAL_DETAIL_GPU_BYTES,
  MAX_EXTERNAL_OVERVIEW_GPU_BYTES,
  MAX_RENDER_DELTA_GPU_BYTES,
  MAX_RENDER_DELTA_TEXT_BYTES,
  MAX_RENDER_DELTA_TRANSFORM_BYTES,
  MAX_RENDER_DELTA_STYLE_BYTES,
  MAX_INSTANCES_PER_DRAW,
  ROOT_RENDER_DELTA_SCENE_ID,
  INTERACTIVE_MINIMUM_PIXEL_SPAN,
  calculateOverviewBounds,
  instancesForBatch,
  makeCamera,
  makeCameraFromView,
  patchCurveReplacementMarkers,
  patchLineMaskBuckets,
  overlayCameraTransform,
  selectInteractiveInstanceIndices,
  makeClipTexturePayload,
};

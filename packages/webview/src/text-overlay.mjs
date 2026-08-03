import {
  TextEntityKind,
} from "./scene-cache.mjs?v=1.18.8";
import {
  decodeCadColor,
  decodeCadOpacity,
  DEFAULT_ACI_PALETTE,
} from "./cad-color.mjs";
import {
  arbitraryAxisMat4,
  identityMat4,
  multiplyMat4,
  rotationZMat4,
  scalingMat4,
  transformPoint,
  translationMat4,
} from "./math.mjs";
import { maskBucketFor } from "./mask-order.mjs";
import {
  cadMTextParagraphStart,
  DEFAULT_MTEXT_PARAGRAPH,
  DEFAULT_MTEXT_FORMAT,
  measureCadMTextLine,
  nextCadMTextTabAdvance,
  parseCadMTextRuns,
  plainCadMTextLines,
  wrapCadMTextRuns,
} from "./mtext-format.mjs";

const DEFAULT_MAXIMUM_SOURCE_TEXTS = 50_000;
const DEFAULT_MAXIMUM_OCCURRENCES = 10_000;
const DEFAULT_MAXIMUM_SEGMENTS = 250_000;
const DEFAULT_MAXIMUM_FALLBACK_GLYPHS = 50_000;
const DEFAULT_MINIMUM_PIXEL_HEIGHT = 0.5;
const DEFAULT_MAXIMUM_MASK_OCCURRENCES = 10_000;
const MAXIMUM_CODE_POINTS_PER_ENTITY = 4_096;
const MAXIMUM_MTEXT_COLUMNS = 64;
const STACK_TEXT_SCALE = 0.7;
const DEFAULT_DRAWING_BACKGROUND = "rgb(14, 16, 19)";
const LOCAL_OUTLINE_FONTS = new Map();
const IDENTITY_INSTANCES = Object.freeze({
  data: identityMat4(),
  maskBases: new Uint32Array([0]),
  opacities: new Float32Array([1]),
  count: 1,
});

function replacePercentCodes(value) {
  return value
    .replace(/\\U\+([0-9a-f]{4})/gi, (_match, hexadecimal) =>
      String.fromCodePoint(Number.parseInt(hexadecimal, 16)),
    )
    .replace(/%%d/gi, "°")
    .replace(/%%p/gi, "±")
    .replace(/%%c/gi, "⌀");
}

function normalizedFontFile(style) {
  const value =
    typeof style?.trueTypeFont === "string" && style.trueTypeFont.trim()
      ? style.trueTypeFont
      : style?.fontFile;
  if (typeof value !== "string") {
    return "";
  }
  return value
    .trim()
    .replace(/^["']|["']$/g, "")
    .split(/[\\/]/)
    .at(-1)
    ?.toLocaleLowerCase("en-US") ?? "";
}

export function registerLocalOutlineFont(name, family) {
  const key = normalizedFontFile({
    fontFile: name,
    trueTypeFont: "",
  });
  if (
    !key ||
    typeof family !== "string" ||
    !/^DwgLocalFont_[A-Za-z0-9_]+$/.test(family)
  ) {
    throw new TypeError("local outline font registration is invalid");
  }
  LOCAL_OUTLINE_FONTS.set(key, family);
  return key;
}

export function unregisterLocalOutlineFont(name) {
  const key = normalizedFontFile({
    fontFile: name,
    trueTypeFont: "",
  });
  return key ? LOCAL_OUTLINE_FONTS.delete(key) : false;
}

export function systemFallbackFont(style) {
  const name = normalizedFontFile(style);
  const localFamily = LOCAL_OUTLINE_FONTS.get(name);
  const italic = style?.inlineItalic === true ? "italic " : "";
  const bold =
    style?.inlineBold === true ||
    /(?:bold|black|heavy|semibold|demi)/.test(name) ||
    /bd(?:\.[^.]+)?$/.test(name);
  const weight = bold ? "700 " : "";
  if (localFamily) {
    return `${italic}${weight}1px "${localFamily}", "Noto Sans KR", "Apple SD Gothic Neo", sans-serif`;
  }
  const requestedFamily =
    typeof style?.inlineFontFamily === "string" &&
    style.inlineFontFamily.length > 0 &&
    style.inlineFontFamily.length <= 128
      ? `"${style.inlineFontFamily.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}", `
      : "";
  if (/^(?:arial|helvetica)/.test(name)) {
    return `${italic}${weight}1px ${requestedFamily}"Arial", "Helvetica Neue", Helvetica, sans-serif`;
  }
  if (/(?:^|[ _-])(?:batang|gungsuh|궁서|바탕)/.test(name)) {
    return `${italic}${weight}1px ${requestedFamily}"Batang", "AppleMyungjo", "Noto Serif KR", serif`;
  }
  if (/(?:^|[ _-])(?:malgun|dotum|gulim|돋움|굴림|맑은)/.test(name)) {
    return `${italic}${weight}1px ${requestedFamily}"Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`;
  }
  return `${italic}${weight}1px ${requestedFamily}"Noto Sans KR", "Apple SD Gothic Neo", sans-serif`;
}

function baseTextHeight(record) {
  return Number.isFinite(record.height) && record.height > 0
    ? record.height
    : record.style?.height > 0
      ? record.style.height
      : record.style?.lastHeight > 0
        ? record.style.lastHeight
        : 1;
}

function unformattedRichLines(lines) {
  return Object.freeze(
    lines.map((line) =>
      Object.freeze(
        line.length === 0
          ? []
          : [
              Object.freeze({
                text: line,
                format: DEFAULT_MTEXT_FORMAT,
              }),
            ],
      ),
    ),
  );
}

function plainLinesFromRich(lines) {
  return Object.freeze(
    lines.map((line) => line.map((run) => run.text).join("")),
  );
}

function styleForMTextFormat(style, format) {
  if (!format.fontFile && format.bold === null && format.italic === null) {
    return style;
  }
  return Object.freeze({
    ...style,
    fontFile: format.fontFile || style?.fontFile || "",
    trueTypeFont: format.fontFile || style?.trueTypeFont || "",
    inlineFontFamily: format.fontFile,
    inlineBold: format.bold,
    inlineItalic: format.italic,
  });
}

export function plainCadTextLines(value, isMText = false) {
  if (typeof value !== "string" || value.length === 0) {
    return Object.freeze([""]);
  }
  if (!isMText) {
    return Object.freeze([
      [...replacePercentCodes(value)]
        .slice(0, MAXIMUM_CODE_POINTS_PER_ENTITY)
        .join(""),
    ]);
  }
  return plainCadMTextLines(value, {
    maximumCodePoints: MAXIMUM_CODE_POINTS_PER_ENTITY,
  });
}

export function wrapCadTextLines(
  lines,
  maximumAdvance,
  measureAdvance = () => 1,
) {
  if (!Array.isArray(lines)) {
    throw new TypeError("CAD text lines must be an array");
  }
  if (
    !Number.isFinite(maximumAdvance) ||
    maximumAdvance <= 0 ||
    typeof measureAdvance !== "function"
  ) {
    return Object.freeze([...lines]);
  }
  const measured = (character) => {
    const advance = measureAdvance(character);
    return Number.isFinite(advance) && advance > 0 ? advance : 1;
  };
  const measure = (value) =>
    [...value].reduce(
      (total, character) => total + measured(character),
      0,
    );
  const wrapped = [];

  for (const source of lines) {
    const firstWrappedLine = wrapped.length;
    const value = typeof source === "string" ? source : String(source ?? "");
    if (value.length === 0) {
      wrapped.push("");
      continue;
    }
    const tokens = value.match(/\s+|\S+/gu) ?? [value];
    let current = "";
    let currentAdvance = 0;
    let whitespace = "";
    let whitespaceAdvance = 0;
    const flush = () => {
      if (current.length > 0) {
        wrapped.push(current.trimEnd());
      }
      current = "";
      currentAdvance = 0;
      whitespace = "";
      whitespaceAdvance = 0;
    };

    for (const token of tokens) {
      if (/^\s+$/u.test(token)) {
        if (current.length > 0) {
          whitespace += token;
          whitespaceAdvance += measure(token);
        }
        continue;
      }
      const tokenAdvance = measure(token);
      if (
        current.length > 0 &&
        currentAdvance + whitespaceAdvance + tokenAdvance <= maximumAdvance
      ) {
        current += whitespace + token;
        currentAdvance += whitespaceAdvance + tokenAdvance;
        whitespace = "";
        whitespaceAdvance = 0;
        continue;
      }
      if (current.length > 0) {
        flush();
      }
      if (tokenAdvance <= maximumAdvance) {
        current = token;
        currentAdvance = tokenAdvance;
        continue;
      }
      for (const character of token) {
        const advance = measured(character);
        if (
          current.length > 0 &&
          currentAdvance + advance > maximumAdvance
        ) {
          flush();
        }
        current += character;
        currentAdvance += advance;
      }
    }
    flush();
    if (wrapped.length === firstWrappedLine) {
      wrapped.push("");
    }
  }
  return Object.freeze(wrapped);
}

export function layoutCadTextColumns(
  lines,
  {
    count = 1,
    width = 0,
    gutter = 0,
    heights = [],
    lineStep = 1.667,
    flowReversed = false,
  } = {},
) {
  if (!Array.isArray(lines)) {
    throw new TypeError("CAD text column lines must be an array");
  }
  const columnCount = Math.min(
    Math.max(Number.isInteger(count) ? count : 1, 1),
    MAXIMUM_MTEXT_COLUMNS,
  );
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 0;
  const safeGutter =
    Number.isFinite(gutter) && gutter > 0 ? gutter : 0;
  const safeLineStep =
    Number.isFinite(lineStep) && lineStep > 0 ? lineStep : 1.667;
  const sourceHeights =
    Array.isArray(heights) || ArrayBuffer.isView(heights)
      ? heights
      : [];
  const columns = [];
  let lineOffset = 0;
  for (let index = 0; index < columnCount; index += 1) {
    const remaining = lines.length - lineOffset;
    const storedHeight = sourceHeights[index];
    const capacity =
      Number.isFinite(storedHeight) && storedHeight > 0
        ? Math.max(1, Math.floor(storedHeight / safeLineStep))
        : Math.max(
            1,
            Math.ceil(Math.max(remaining, 0) / (columnCount - index)),
          );
    const lineCount =
      index === columnCount - 1
        ? Math.max(remaining, 0)
        : Math.min(Math.max(remaining, 0), capacity);
    const visualIndex = flowReversed
      ? columnCount - index - 1
      : index;
    columns.push(
      Object.freeze({
        index,
        visualIndex,
        x: visualIndex * (safeWidth + safeGutter),
        width: safeWidth,
        height:
          Number.isFinite(storedHeight) && storedHeight > 0
            ? storedHeight
            : Math.max(lineCount, 1) * safeLineStep,
        lines: Object.freeze(
          lines.slice(lineOffset, lineOffset + lineCount),
        ),
      }),
    );
    lineOffset += lineCount;
  }
  return Object.freeze(columns);
}

function shearXMat4(angle) {
  const matrix = identityMat4();
  const shear = Math.tan(angle);
  matrix[4] = Number.isFinite(shear) ? shear : 0;
  return matrix;
}

function normalizeVector3(vector, fallback = [0, 0, 1]) {
  const values =
    Array.isArray(vector) || ArrayBuffer.isView(vector)
      ? vector
      : fallback;
  const length = Math.hypot(
    Number(values[0]),
    Number(values[1]),
    Number(values[2]),
  );
  if (!Number.isFinite(length) || length < 1e-12) {
    return [...fallback];
  }
  return [
    Number(values[0]) / length,
    Number(values[1]) / length,
    Number(values[2]) / length,
  ];
}

function crossVector3(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function mtextWorldBasisMat4(record, normal) {
  const direction = record.xAxisDirection;
  if (
    !direction ||
    ![direction[0], direction[1], direction[2]].every(Number.isFinite)
  ) {
    return multiplyMat4(
      arbitraryAxisMat4(normal),
      rotationZMat4(Number.isFinite(record.rotation) ? record.rotation : 0),
    );
  }
  const unitNormal = normalizeVector3(normal);
  const normalProjection =
    direction[0] * unitNormal[0] +
    direction[1] * unitNormal[1] +
    direction[2] * unitNormal[2];
  const projected = [
    direction[0] - normalProjection * unitNormal[0],
    direction[1] - normalProjection * unitNormal[1],
    direction[2] - normalProjection * unitNormal[2],
  ];
  const projectedLength = Math.hypot(...projected);
  if (!Number.isFinite(projectedLength) || projectedLength < 1e-12) {
    return multiplyMat4(
      arbitraryAxisMat4(normal),
      rotationZMat4(Number.isFinite(record.rotation) ? record.rotation : 0),
    );
  }
  const xAxis = projected.map((value) => value / projectedLength);
  const yAxis = normalizeVector3(
    crossVector3(unitNormal, xAxis),
    [0, 1, 0],
  );
  return new Float64Array([
    xAxis[0], xAxis[1], xAxis[2], 0,
    yAxis[0], yAxis[1], yAxis[2], 0,
    unitNormal[0], unitNormal[1], unitNormal[2], 0,
    0, 0, 0, 1,
  ]);
}

export function cadTextEntityMatrix(record, style) {
  const styleHeight =
    style?.height > 0 ? style.height : style?.lastHeight > 0 ? style.lastHeight : 1;
  const height =
    Number.isFinite(record.height) && record.height > 0
      ? record.height
      : styleHeight;
  const entityWidth =
    Number.isFinite(record.widthFactor) && record.widthFactor !== 0
      ? record.widthFactor
      : 1;
  const styleWidth =
    Number.isFinite(style?.widthFactor) && style.widthFactor !== 0
      ? style.widthFactor
      : 1;
  const oblique =
    (Number.isFinite(record.obliqueAngle) ? record.obliqueAngle : 0) +
    (Number.isFinite(style?.obliqueAngle) ? style.obliqueAngle : 0);
  const normal = record.normal.every(Number.isFinite)
    ? record.normal
    : [0, 0, 1];
  const generationFlags =
    (Number.isInteger(record.generationFlags) ? record.generationFlags : 0) |
    ((style?.flags & 1) !== 0 ? 2 : 0) |
    ((style?.flags & 2) !== 0 ? 4 : 0);
  const horizontalDirection = (generationFlags & 2) !== 0 ? -1 : 1;
  const verticalDirection = (generationFlags & 4) !== 0 ? -1 : 1;
  const placement =
    record.kind === TextEntityKind.MText
      ? [
          translationMat4(...record.insertionPoint),
          mtextWorldBasisMat4(record, normal),
        ]
      : [
          arbitraryAxisMat4(normal),
          translationMat4(...record.insertionPoint),
          rotationZMat4(
            Number.isFinite(record.rotation) ? record.rotation : 0,
          ),
        ];
  return [
    ...placement,
    shearXMat4(oblique),
    scalingMat4(
      height * entityWidth * styleWidth * horizontalDirection,
      height * verticalDirection,
      height,
    ),
  ].reduce(multiplyMat4);
}

function isMTextRecord(record) {
  return (
    record.kind === TextEntityKind.MText ||
    (Number.isInteger(record.mtextType) && record.mtextType !== 0)
  );
}

export function cadMTextFlowsVertically(record) {
  return (
    isMTextRecord(record) &&
    (record.flowDirection === 2 ||
      (record.flowDirection === 3 &&
        (record.style?.flags & (1 << 4)) !== 0))
  );
}

function textHorizontalScale(record, style) {
  const styleHeight =
    style?.height > 0 ? style.height : style?.lastHeight > 0 ? style.lastHeight : 1;
  const height =
    Number.isFinite(record.height) && record.height > 0
      ? record.height
      : styleHeight;
  const entityWidth =
    Number.isFinite(record.widthFactor) && record.widthFactor !== 0
      ? Math.abs(record.widthFactor)
      : 1;
  const styleWidth =
    Number.isFinite(style?.widthFactor) && style.widthFactor !== 0
      ? Math.abs(style.widthFactor)
      : 1;
  return height * entityWidth * styleWidth;
}

function normalizedStoredExtent(value, scale) {
  return Number.isFinite(value) && value > 0 && scale > 0
    ? value / scale
    : 0;
}

function normalizedColumnHeights(record, scale) {
  if (!(Number.isFinite(scale) && scale > 0)) {
    return Object.freeze([]);
  }
  const direct = record.columnHeights;
  const pool = record.columnHeightPool;
  const first = Number.isInteger(record.firstColumnHeight)
    ? record.firstColumnHeight
    : 0;
  const count = Math.min(
    Math.max(
      Number.isInteger(record.columnHeightCount)
        ? record.columnHeightCount
        : direct?.length ?? 0,
      0,
    ),
    MAXIMUM_MTEXT_COLUMNS,
  );
  const values = direct ?? pool;
  if (!values || count === 0) {
    return Object.freeze([]);
  }
  const output = [];
  for (let index = 0; index < count; index += 1) {
    const value = values[direct ? index : first + index];
    output.push(
      Number.isFinite(value) && value > 0 ? value / scale : 0,
    );
  }
  return Object.freeze(output);
}

export function cadTextAlignmentWidth(record) {
  if (
    isMTextRecord(record) ||
    ![3, 5].includes(record.horizontalAlignment) ||
    record.verticalAlignment !== 0 ||
    !record.alignmentPoint?.every(Number.isFinite) ||
    !record.insertionPoint?.every(Number.isFinite)
  ) {
    return 0;
  }
  const deltaX = record.alignmentPoint[0] - record.insertionPoint[0];
  const deltaY = record.alignmentPoint[1] - record.insertionPoint[1];
  return normalizedStoredExtent(
    Math.hypot(deltaX, deltaY),
    textHorizontalScale(record, record.style),
  );
}

function measuredFallbackAdvance(context, character) {
  if (typeof context.measureText !== "function") {
    return 1;
  }
  const measured = context.measureText(character)?.width;
  return Number.isFinite(measured) && measured > 0
    ? Math.min(Math.max(measured, 0.1), 4)
    : 1;
}

function decodeColor(
  encoded,
  layer,
  byBlock = null,
  palette = DEFAULT_ACI_PALETTE,
) {
  return decodeCadColor(encoded, { layer, byBlock, palette });
}

function instancesForText(record, ownerBlockIndex, instanceGraph) {
  const rootInstances = instanceGraph.rootInstances ?? IDENTITY_INSTANCES;
  if (
    ownerBlockIndex === undefined ||
    instanceGraph.modelBlockIndices?.has(ownerBlockIndex) ||
    record.kind === TextEntityKind.Attribute
  ) {
    return rootInstances;
  }
  return (
    instanceGraph.instancesByBlock.get(ownerBlockIndex) ??
    Object.freeze({ data: new Float64Array(0), count: 0 })
  );
}

function visibleInInstanceViewport(
  instanceGraph,
  instances,
  instanceIndex,
  layerIndex,
) {
  if (layerIndex === 0xffffffff) {
    return true;
  }
  const rowIndex = instances.visibilityRows?.[instanceIndex] ?? 0;
  const row = instanceGraph.layerVisibilityRows?.[rowIndex];
  return !row || row[layerIndex] !== 0;
}

function screenTransform(matrix, camera, width, height) {
  const scaleX = width / camera.worldWidth;
  const scaleY = height / camera.worldHeight;
  const originX = (matrix[12] - camera.origin[0]) * scaleX + width * 0.5;
  const originY = height * 0.5 - (matrix[13] - camera.origin[1]) * scaleY;
  return {
    a: matrix[0] * scaleX,
    b: -matrix[1] * scaleY,
    c: matrix[4] * scaleX,
    d: -matrix[5] * scaleY,
    e: originX,
    f: originY,
    pixelHeight: Math.hypot(matrix[4] * scaleX, matrix[5] * scaleY),
    pixelWidth: Math.hypot(matrix[0] * scaleX, matrix[1] * scaleY),
  };
}

function pointToScreen(matrix, x, y, camera, width, height) {
  const worldX = matrix[0] * x + matrix[4] * y + matrix[12];
  const worldY = matrix[1] * x + matrix[5] * y + matrix[13];
  return [
    ((worldX - camera.origin[0]) / camera.worldWidth + 0.5) * width,
    (0.5 - (worldY - camera.origin[1]) / camera.worldHeight) * height,
  ];
}

function worldPointToScreen(point, camera, width, height) {
  return [
    ((point[0] - camera.origin[0]) / camera.worldWidth + 0.5) * width,
    (0.5 - (point[1] - camera.origin[1]) / camera.worldHeight) * height,
  ];
}

function screenPointInPolygon(point, polygon) {
  let inside = false;
  let previous = polygon.at(-1);
  for (const current of polygon) {
    const crosses =
      (current[1] > point[1]) !== (previous[1] > point[1]) &&
      point[0] <
        ((previous[0] - current[0]) * (point[1] - current[1])) /
          (previous[1] - current[1]) +
          current[0];
    if (crosses) {
      inside = !inside;
    }
    previous = current;
  }
  return inside;
}

function screenSegmentDistance(point, first, last) {
  const dx = last[0] - first[0];
  const dy = last[1] - first[1];
  const lengthSquared = dx * dx + dy * dy;
  const parameter =
    lengthSquared <= Number.EPSILON
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((point[0] - first[0]) * dx +
              (point[1] - first[1]) * dy) /
              lengthSquared,
          ),
        );
  return Math.hypot(
    point[0] - (first[0] + dx * parameter),
    point[1] - (first[1] + dy * parameter),
  );
}

function screenPolygonDistance(point, polygon) {
  if (screenPointInPolygon(point, polygon)) {
    return 0;
  }
  let distance = Infinity;
  for (let index = 0; index < polygon.length; index += 1) {
    distance = Math.min(
      distance,
      screenSegmentDistance(
        point,
        polygon[index],
        polygon[(index + 1) % polygon.length],
      ),
    );
  }
  return distance;
}

export class CanvasTextOverlay {
  constructor(
    canvas,
    {
      textEntities,
      blocks,
      layers,
      instanceGraph,
      glyphCache,
      maximumSourceTexts = DEFAULT_MAXIMUM_SOURCE_TEXTS,
      maximumOccurrences = DEFAULT_MAXIMUM_OCCURRENCES,
      maximumSegments = DEFAULT_MAXIMUM_SEGMENTS,
      maximumFallbackGlyphs = DEFAULT_MAXIMUM_FALLBACK_GLYPHS,
      minimumPixelHeight = DEFAULT_MINIMUM_PIXEL_HEIGHT,
      maximumMaskOccurrences = DEFAULT_MAXIMUM_MASK_OCCURRENCES,
      maskOrder = null,
      palette = DEFAULT_ACI_PALETTE,
      drawingBackground = DEFAULT_DRAWING_BACKGROUND,
      onInlineFonts = null,
      sourceId = "root",
      sourceLabel = "현재 도면",
      hitTestingEnabled = false,
    },
  ) {
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) {
      throw new Error("Canvas2D is required for the text overlay");
    }
    this.canvas = canvas;
    this.context = context;
    this.textEntities = textEntities;
    this.blocks = blocks;
    this.layers = layers;
    this.instanceGraph = instanceGraph;
    this.glyphCache = glyphCache;
    this.maximumSourceTexts = maximumSourceTexts;
    this.maximumOccurrences = maximumOccurrences;
    this.maximumSegments = maximumSegments;
    this.maximumFallbackGlyphs = maximumFallbackGlyphs;
    this.minimumPixelHeight = minimumPixelHeight;
    this.maximumMaskOccurrences = maximumMaskOccurrences;
    this.palette =
      palette instanceof Uint8Array && palette.length === 256 * 4
        ? new Uint8Array(palette)
        : new Uint8Array(DEFAULT_ACI_PALETTE);
    this.drawingBackground =
      typeof drawingBackground === "string" &&
      drawingBackground.length > 0 &&
      drawingBackground.length <= 128
        ? drawingBackground
        : DEFAULT_DRAWING_BACKGROUND;
    this.onInlineFonts =
      typeof onInlineFonts === "function" ? onInlineFonts : null;
    this.sourceId = String(sourceId || "root");
    this.sourceLabel = String(sourceLabel || "현재 도면");
    this.hitTestingEnabled = Boolean(hitTestingEnabled);
    this.hitOccurrences = [];
    this.reportedInlineFontKeys = new Set();
    this.configuredMaskOrder = maskOrder?.enabled ? maskOrder : null;
    this.maskOrder = this.configuredMaskOrder;
    this.blockIndexByHandle = new Map(
      blocks.map((block) => [block.handle, block.index]),
    );
    const discoveredLayerZero = layers.findIndex(
      (layer) =>
        layer.name?.normalize("NFC").toLocaleLowerCase("en-US") === "0",
    );
    this.layerZeroIndex =
      instanceGraph.layerZeroIndex !== undefined &&
      instanceGraph.layerZeroIndex !== 0xffffffff
        ? instanceGraph.layerZeroIndex
        : discoveredLayerZero;
    this.displayRecord = {
      insertionPoint: [0, 0, 0],
      normal: [0, 0, 1],
    };
    this.lastMetrics = Object.freeze({
      sourceTexts: textEntities.length,
      visitedSourceTexts: 0,
      visibleOccurrences: 0,
      vectorGlyphs: 0,
      fallbackGlyphs: 0,
      segments: 0,
      backgroundFills: 0,
      maskOccurrences: 0,
      clippedTextOccurrences: 0,
      maskClipOperations: 0,
      maskClipDisabled: false,
      xclipOccurrences: 0,
      xclipOperations: 0,
      truncated: false,
    });
  }

  setMaskVisibility(visible) {
    this.maskOrder = visible ? this.configuredMaskOrder : null;
    return Boolean(this.maskOrder);
  }

  setPalette(palette) {
    if (!(palette instanceof Uint8Array) || palette.length !== 256 * 4) {
      throw new TypeError("text palette must contain 256 RGBA colors");
    }
    this.palette = new Uint8Array(palette);
  }

  setHitTestingEnabled(enabled) {
    this.hitTestingEnabled = Boolean(enabled);
    if (!this.hitTestingEnabled) {
      this.hitOccurrences = [];
    }
    return this.hitTestingEnabled;
  }

  findTextOccurrence(handle) {
    const normalized = String(handle ?? "")
      .trim()
      .replace(/^0x/iu, "");
    if (!/^[0-9a-f]{1,16}$/iu.test(normalized)) {
      return null;
    }
    const expected = BigInt(`0x${normalized}`);
    const sourceCount = Math.min(
      this.textEntities.length,
      this.maximumSourceTexts,
    );
    for (let textIndex = 0; textIndex < sourceCount; textIndex += 1) {
      const record =
        typeof this.textEntities.readDisplayRecord === "function"
          ? this.textEntities.readDisplayRecord(
              textIndex,
              this.displayRecord,
            )
          : this.textEntities.get(textIndex);
      if (record.handle !== expected) {
        continue;
      }
      const ownerBlockIndex = this.blockIndexByHandle.get(
        record.ownerHandle,
      );
      const instances = instancesForText(
        record,
        ownerBlockIndex,
        this.instanceGraph,
      );
      if (instances.count === 0) {
        return null;
      }
      const localMatrix = cadTextEntityMatrix(record, record.style);
      const instanceMatrix =
        instances.count === 1 && instances === IDENTITY_INSTANCES
          ? instances.data
          : instances.data.subarray(0, 16);
      const worldMatrix = multiplyMat4(instanceMatrix, localMatrix);
      const point = [
        worldMatrix[12],
        worldMatrix[13],
        worldMatrix[14],
      ];
      const worldHeight = Math.max(
        Math.hypot(worldMatrix[0], worldMatrix[1], worldMatrix[2]),
        Math.hypot(worldMatrix[4], worldMatrix[5], worldMatrix[6]),
      );
      if (
        !point.every(Number.isFinite) ||
        !Number.isFinite(worldHeight) ||
        worldHeight <= 0
      ) {
        return null;
      }
      return Object.freeze({
        point: Object.freeze(point),
        worldHeight,
        kind: record.kind,
      });
    }
    return null;
  }

  hitTest(
    x,
    y,
    {
      snapKinds = ["entity"],
      tolerancePixels = 6,
    } = {},
  ) {
    const enabled = new Set(snapKinds);
    if (
      (!enabled.has("entity") && !enabled.has("insertion")) ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      return null;
    }
    const scaleX =
      Math.max(this.canvas.width, 1) /
      Math.max(this.canvas.clientWidth, 1);
    const scaleY =
      Math.max(this.canvas.height, 1) /
      Math.max(this.canvas.clientHeight, 1);
    const point = [x * scaleX, y * scaleY];
    const tolerance =
      Math.max(scaleX, scaleY) * Math.max(tolerancePixels, 0);
    let best = null;
    for (
      let index = this.hitOccurrences.length - 1;
      index >= 0;
      index -= 1
    ) {
      const occurrence = this.hitOccurrences[index];
      const deviceDistance = screenPolygonDistance(
        point,
        occurrence.screenPolygon,
      );
      if (deviceDistance > tolerance) {
        continue;
      }
      const distancePixels =
        deviceDistance / Math.max(scaleX, scaleY);
      if (best && distancePixels >= best.distancePixels) {
        continue;
      }
      const fullRecord =
        typeof this.textEntities.get === "function"
          ? this.textEntities.get(occurrence.textIndex)
          : Object.freeze({
              ...occurrence.record,
              value:
                typeof this.textEntities.readValue === "function"
                  ? this.textEntities.readValue(occurrence.textIndex)
                  : "",
              tag: "",
              prompt: "",
            });
      const names = ["TEXT", "MTEXT", "ATTDEF", "ATTRIB"];
      best = Object.freeze({
        kind: enabled.has("entity") ? "entity" : "insertion",
        displayPoint: occurrence.displayPoint,
        measurementPoint: occurrence.measurementPoint,
        displayPolygon: occurrence.displayPolygon,
        measurementPolygon: occurrence.measurementPolygon,
        distancePixels,
        coordinateSpace: occurrence.coordinateSpace,
        handle: fullRecord.handle,
        layerIndex: occurrence.layerIndex,
        layerName: this.layers[occurrence.layerIndex]?.name ?? "",
        sourceKind: null,
        sourceKindName: names[fullRecord.kind] ?? "문자",
        entityType: "text",
        entityRecord: fullRecord,
        color: fullRecord.color,
        lineWeight: fullRecord.lineWeight,
        linetypeCode: fullRecord.linetypeCode,
        approximated: false,
        sourceId: this.sourceId,
        sourceLabel: this.sourceLabel,
      });
    }
    return best;
  }

  resize(size = null) {
    const ratio = Math.min(globalThis.devicePixelRatio ?? 1, 2);
    const width = size
      ? size.width
      : Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = size
      ? size.height
      : Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    return { width, height };
  }

  redraw(camera, layerVisibility, { clear = true, size = null } = {}) {
    const { width, height } = this.resize(size);
    const context = this.context;
    context.setTransform(1, 0, 0, 1, 0, 0);
    if (clear) {
      context.clearRect(0, 0, width, height);
    }
    context.lineWidth = 1;
    context.lineCap = "round";
    context.lineJoin = "round";
    const metrics = {
      sourceTexts: this.textEntities.length,
      visitedSourceTexts: 0,
      visibleOccurrences: 0,
      vectorGlyphs: 0,
      fallbackGlyphs: 0,
      segments: 0,
      backgroundFills: 0,
      maskOccurrences: 0,
      clippedTextOccurrences: 0,
      maskClipOperations: 0,
      maskClipDisabled: false,
      xclipOccurrences: 0,
      xclipOperations: 0,
      truncated: false,
    };
    this.hitOccurrences = [];
    const screenMasks = this.#screenMasks(
      camera,
      width,
      height,
      layerVisibility,
      metrics,
    );
    const sourceCount = Math.min(
      this.textEntities.length,
      this.maximumSourceTexts,
    );
    for (let textIndex = 0; textIndex < sourceCount; textIndex += 1) {
      if (
        metrics.visibleOccurrences >= this.maximumOccurrences ||
        metrics.segments >= this.maximumSegments ||
        metrics.fallbackGlyphs >= this.maximumFallbackGlyphs
      ) {
        metrics.truncated = true;
        break;
      }
      const record =
        typeof this.textEntities.readDisplayRecord === "function"
          ? this.textEntities.readDisplayRecord(
              textIndex,
              this.displayRecord,
            )
          : this.textEntities.get(textIndex);
      metrics.visitedSourceTexts += 1;
      if (
        (record.commonFlags & 1) !== 0 ||
        ((record.kind === TextEntityKind.AttributeDefinition ||
          record.kind === TextEntityKind.Attribute) &&
          (record.sourceFlags & 1) !== 0)
      ) {
        continue;
      }
      if (!record.insertionPoint.every(Number.isFinite)) {
        continue;
      }
      const localMatrix = cadTextEntityMatrix(record, record.style);
      const ownerBlockIndex = this.blockIndexByHandle.get(record.ownerHandle);
      const instances = instancesForText(
        record,
        ownerBlockIndex,
        this.instanceGraph,
      );
      for (let instanceIndex = 0; instanceIndex < instances.count; instanceIndex += 1) {
        const instanceLayerIndex =
          instances.layerIndices?.[instanceIndex] ?? 0xffffffff;
        const layerIndex =
          record.layerIndex === this.layerZeroIndex &&
          instanceLayerIndex !== 0xffffffff
            ? instanceLayerIndex
            : record.layerIndex;
        if (
          layerIndex !== 0xffffffff &&
          (layerVisibility[layerIndex] === false ||
            !visibleInInstanceViewport(
              this.instanceGraph,
              instances,
              instanceIndex,
              layerIndex,
            ))
        ) {
          continue;
        }
        const byBlockColor = decodeCadColor(
          instances.colors?.[instanceIndex] ?? ((2 << 30) | 7),
          { palette: this.palette },
        );
        const byBlockOpacity =
          instances.opacities?.[instanceIndex] ?? 1;
        const instanceOffset = instanceIndex * 16;
        const instanceMatrix =
          instances.count === 1 && instances === IDENTITY_INSTANCES
            ? instances.data
            : instances.data.subarray(instanceOffset, instanceOffset + 16);
        const worldMatrix = multiplyMat4(instanceMatrix, localMatrix);
        const screen = screenTransform(worldMatrix, camera, width, height);
        if (
          ![
            screen.a,
            screen.b,
            screen.c,
            screen.d,
            screen.e,
            screen.f,
            screen.pixelHeight,
            screen.pixelWidth,
          ].every(Number.isFinite)
        ) {
          continue;
        }
        const conservativeCharacters = Math.min(
          record.valueByteLength ?? record.value?.length ?? 0,
          MAXIMUM_CODE_POINTS_PER_ENTITY * 4,
        );
        const conservativeRadius =
          conservativeCharacters *
          Math.max(screen.pixelWidth, screen.pixelHeight) *
          2;
        if (
          screen.pixelHeight < this.minimumPixelHeight ||
          screen.e + conservativeRadius < 0 ||
          screen.e - conservativeRadius > width ||
          screen.f + conservativeRadius < 0 ||
          screen.f - conservativeRadius > height
        ) {
          continue;
        }
        const value =
          typeof this.textEntities.readValue === "function"
            ? this.textEntities.readValue(textIndex)
            : record.value;
        const isMText = isMTextRecord(record);
        const richLines = isMText
          ? parseCadMTextRuns(value, {
              baseHeight: baseTextHeight(record),
              maximumCodePoints: MAXIMUM_CODE_POINTS_PER_ENTITY,
            })
          : unformattedRichLines(plainCadTextLines(value, false));
        if (isMText) {
          this.#reportInlineFonts(richLines);
        }
        const lines = plainLinesFromRich(richLines);
        if (lines.every((line) => line.length === 0)) {
          continue;
        }
        const maximumLineLength = Math.max(...lines.map((line) => [...line].length));
        const radius =
          maximumLineLength * Math.max(screen.pixelWidth, screen.pixelHeight) +
          lines.length * screen.pixelHeight * 1.7;
        if (
          screen.e + radius < 0 ||
          screen.e - radius > width ||
          screen.f + radius < 0 ||
          screen.f - radius > height
        ) {
          continue;
        }
        metrics.visibleOccurrences += 1;
        const absoluteBucket =
          (instances.maskBases?.[instanceIndex] ?? 0) +
          maskBucketFor(
            this.maskOrder,
            record.ownerHandle,
            record.handle,
          );
        const xclipped = this.#beginXClip(
          instances.clipIds?.[instanceIndex] ?? 0,
          camera,
          width,
          height,
          metrics,
        );
        const maskClipped = this.#beginMaskClip(
          absoluteBucket,
          screenMasks,
          width,
          height,
          metrics,
        );
        const localBounds = this.#drawOccurrence(
          record,
          richLines,
          worldMatrix,
          screen,
          camera,
          width,
          height,
          metrics,
          layerIndex,
          byBlockColor,
          byBlockOpacity,
        );
        if (this.hitTestingEnabled && localBounds) {
          const localPolygon = [
            [localBounds.left, localBounds.top, 0],
            [localBounds.right, localBounds.top, 0],
            [localBounds.right, localBounds.bottom, 0],
            [localBounds.left, localBounds.bottom, 0],
          ];
          const displayPolygon = localPolygon.map((point) =>
            transformPoint(worldMatrix, point),
          );
          const measurementData =
            instances.measurementData ?? instances.data;
          const measurementInstanceMatrix =
            instances.count === 1 && instances === IDENTITY_INSTANCES
              ? measurementData
              : measurementData.subarray(
                  instanceOffset,
                  instanceOffset + 16,
                );
          const measurementMatrix = multiplyMat4(
            measurementInstanceMatrix,
            localMatrix,
          );
          const measurementPolygon = localPolygon.map((point) =>
            transformPoint(measurementMatrix, point),
          );
          const screenPolygon = displayPolygon.map((point) =>
            worldPointToScreen(point, camera, width, height),
          );
          if (
            screenPolygon.flat().every(Number.isFinite) &&
            displayPolygon.flat().every(Number.isFinite) &&
            measurementPolygon.flat().every(Number.isFinite)
          ) {
            this.hitOccurrences.push(
              Object.freeze({
                textIndex,
                layerIndex,
                record: Object.freeze({
                  handle: record.handle,
                  ownerHandle: record.ownerHandle,
                  kind: record.kind,
                  color: record.color,
                  lineWeight: record.lineWeight,
                  linetypeCode: record.linetypeCode,
                  height: record.height,
                  rotation: record.rotation,
                  style: record.style,
                }),
                displayPoint: Object.freeze([
                  worldMatrix[12],
                  worldMatrix[13],
                  worldMatrix[14],
                ]),
                measurementPoint: Object.freeze([
                  measurementMatrix[12],
                  measurementMatrix[13],
                  measurementMatrix[14],
                ]),
                displayPolygon: Object.freeze(
                  displayPolygon.map((point) =>
                    Object.freeze(point),
                  ),
                ),
                measurementPolygon: Object.freeze(
                  measurementPolygon.map((point) =>
                    Object.freeze(point),
                  ),
                ),
                screenPolygon: Object.freeze(
                  screenPolygon.map((point) =>
                    Object.freeze(point),
                  ),
                ),
                coordinateSpace:
                  instances.coordinateSpaceIds?.[instanceIndex] ?? 1,
              }),
            );
          }
        }
        if (maskClipped) {
          context.restore();
        }
        if (xclipped) {
          context.restore();
        }
        if (
          metrics.visibleOccurrences >= this.maximumOccurrences ||
          metrics.segments >= this.maximumSegments ||
          metrics.fallbackGlyphs >= this.maximumFallbackGlyphs
        ) {
          metrics.truncated = true;
          break;
        }
      }
    }
    if (sourceCount < this.textEntities.length) {
      metrics.truncated = true;
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    this.lastMetrics = Object.freeze(metrics);
    return this.lastMetrics;
  }

  #reportInlineFonts(lines) {
    if (!this.onInlineFonts) {
      return;
    }
    const names = [];
    for (const line of lines) {
      for (const run of line) {
        const name = run.format.fontFile;
        const key =
          typeof name === "string"
            ? name
                .trim()
                .normalize("NFC")
                .toLocaleLowerCase("en-US")
            : "";
        if (!key || this.reportedInlineFontKeys.has(key)) {
          continue;
        }
        this.reportedInlineFontKeys.add(key);
        names.push(name.trim());
      }
    }
    if (names.length === 0) {
      return;
    }
    try {
      this.onInlineFonts(Object.freeze(names));
    } catch {
      // Font discovery is optional; text keeps its bounded fallback path.
    }
  }

  #screenMasks(camera, width, height, layerVisibility, metrics) {
    if (!this.maskOrder) {
      return [];
    }
    const screenMasks = [];
    for (const mask of this.maskOrder.masks) {
      if (
        mask.layerIndex !== 0xffffffff &&
        layerVisibility[mask.layerIndex] === false
      ) {
        continue;
      }
      const ownerBlockIndex = this.blockIndexByHandle.get(mask.ownerHandle);
      const instances =
        ownerBlockIndex === undefined ||
        this.instanceGraph.modelBlockIndices?.has(ownerBlockIndex)
          ? this.instanceGraph.rootInstances ?? IDENTITY_INSTANCES
          : this.instanceGraph.instancesByBlock.get(ownerBlockIndex);
      if (!instances) {
        continue;
      }
      for (
        let instanceIndex = 0;
        instanceIndex < instances.count;
        instanceIndex += 1
      ) {
        const instanceLayerIndex =
          instances.layerIndices?.[instanceIndex] ?? 0xffffffff;
        const layerIndex =
          mask.layerIndex === this.layerZeroIndex &&
          instanceLayerIndex !== 0xffffffff
            ? instanceLayerIndex
            : mask.layerIndex;
        if (
          layerIndex !== 0xffffffff &&
          (layerVisibility[layerIndex] === false ||
            !visibleInInstanceViewport(
              this.instanceGraph,
              instances,
              instanceIndex,
              layerIndex,
            ))
        ) {
          continue;
        }
        if (screenMasks.length >= this.maximumMaskOccurrences) {
          metrics.maskClipDisabled = true;
          return [];
        }
        const offset = instanceIndex * 16;
        const matrix =
          instances === IDENTITY_INSTANCES
            ? instances.data
            : instances.data.subarray(offset, offset + 16);
        const points = mask.points.map((point) =>
          worldPointToScreen(
            transformPoint(matrix, point),
            camera,
            width,
            height,
          ),
        );
        const minX = Math.min(...points.map(([x]) => x));
        const maxX = Math.max(...points.map(([x]) => x));
        const minY = Math.min(...points.map(([, y]) => y));
        const maxY = Math.max(...points.map(([, y]) => y));
        if (maxX < 0 || minX > width || maxY < 0 || minY > height) {
          continue;
        }
        screenMasks.push({
          bucket:
            (instances.maskBases?.[instanceIndex] ?? 0) +
            mask.localBucket,
          points,
        });
      }
    }
    screenMasks.sort((left, right) => left.bucket - right.bucket);
    metrics.maskOccurrences = screenMasks.length;
    return screenMasks;
  }

  #beginMaskClip(bucket, screenMasks, width, height, metrics) {
    let saved = false;
    for (const mask of screenMasks) {
      if (mask.bucket <= bucket) {
        continue;
      }
      if (!saved) {
        this.context.save();
        saved = true;
        metrics.clippedTextOccurrences += 1;
      }
      this.context.beginPath();
      this.context.rect(0, 0, width, height);
      this.context.moveTo(mask.points[0][0], mask.points[0][1]);
      for (let index = 1; index < mask.points.length; index += 1) {
        this.context.lineTo(mask.points[index][0], mask.points[index][1]);
      }
      this.context.closePath();
      this.context.clip("evenodd");
      metrics.maskClipOperations += 1;
    }
    return saved;
  }

  #beginXClip(clipId, camera, width, height, metrics) {
    if (!clipId) {
      return false;
    }
    const chain = [];
    let current = clipId;
    let depth = 0;
    while (current > 0 && depth < 64) {
      const node = this.instanceGraph.clipNodes?.[current - 1];
      if (!node || node.id !== current) {
        return false;
      }
      chain.push(node);
      current = node.parentId;
      depth += 1;
    }
    if (current > 0 || chain.length === 0) {
      return false;
    }
    this.context.save();
    metrics.xclipOccurrences += 1;
    for (const node of chain.reverse()) {
      const points = node.points.map((point) =>
        worldPointToScreen(point, camera, width, height),
      );
      this.context.beginPath();
      if (node.inverted) {
        this.context.rect(0, 0, width, height);
      }
      this.context.moveTo(points[0][0], points[0][1]);
      for (let index = 1; index < points.length; index += 1) {
        this.context.lineTo(points[index][0], points[index][1]);
      }
      this.context.closePath();
      this.context.clip(node.inverted ? "evenodd" : "nonzero");
      metrics.xclipOperations += 1;
    }
    return true;
  }

  #currentDrawingBackground() {
    try {
      const target = this.canvas.parentElement ?? this.canvas;
      const color = globalThis.getComputedStyle?.(target)?.backgroundColor;
      if (
        typeof color === "string" &&
        color.length > 0 &&
        color.length <= 128 &&
        color !== "transparent" &&
        !/^rgba\([^)]*,\s*0(?:\.0+)?\)$/u.test(color)
      ) {
        return color;
      }
    } catch {
      // Use the bounded constructor fallback outside a browser DOM.
    }
    return this.drawingBackground;
  }

  #drawMTextBackground(
    record,
    matrix,
    camera,
    width,
    height,
    metrics,
    layerIndex,
    byBlockColor,
    left,
    right,
    top,
    bottom,
  ) {
    const flags = Number.isInteger(record.backgroundFlags)
      ? record.backgroundFlags
      : 0;
    if (
      (flags & 3) === 0 ||
      ![left, right, top, bottom].every(Number.isFinite) ||
      right <= left ||
      top <= bottom
    ) {
      return;
    }
    const scale =
      Number.isFinite(record.backgroundScale) &&
      record.backgroundScale >= 1
        ? Math.min(record.backgroundScale, 10)
        : 1;
    const padding = (scale - 1) * 0.5;
    const points = [
      pointToScreen(
        matrix,
        left - padding,
        top + padding,
        camera,
        width,
        height,
      ),
      pointToScreen(
        matrix,
        right + padding,
        top + padding,
        camera,
        width,
        height,
      ),
      pointToScreen(
        matrix,
        right + padding,
        bottom - padding,
        camera,
        width,
        height,
      ),
      pointToScreen(
        matrix,
        left - padding,
        bottom - padding,
        camera,
        width,
        height,
      ),
    ];
    if (!points.flat().every(Number.isFinite)) {
      return;
    }
    let color = this.#currentDrawingBackground();
    if ((flags & 2) === 0) {
      const [red, green, blue] = decodeColor(
        record.backgroundColor,
        this.layers[layerIndex],
        byBlockColor,
        this.palette,
      );
      color = `rgba(${red}, ${green}, ${blue}, 1)`;
    }
    const context = this.context;
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(points[0][0], points[0][1]);
    for (let index = 1; index < points.length; index += 1) {
      context.lineTo(points[index][0], points[index][1]);
    }
    context.closePath();
    context.fill();
    metrics.backgroundFills += 1;
  }

  #drawOccurrence(
    record,
    parsedLines,
    matrix,
    screen,
    camera,
    width,
    height,
    metrics,
    layerIndex,
    byBlockColor,
    byBlockOpacity,
  ) {
    const context = this.context;
    const opacity = decodeCadOpacity(record.color, {
      layer: decodeCadOpacity(this.layers[layerIndex]?.color ?? 0),
      byBlock: byBlockOpacity,
    });
    const colorCache = new Map();
    const colorForFormat = (format) => {
      const encoded =
        Number.isInteger(format.color) ? format.color : record.color;
      if (colorCache.has(encoded)) {
        return colorCache.get(encoded);
      }
      const [red, green, blue] = decodeColor(
        encoded,
        this.layers[layerIndex],
        byBlockColor,
        this.palette,
      );
      const color = `rgba(${red}, ${green}, ${blue}, ${opacity})`;
      colorCache.set(encoded, color);
      return color;
    };
    const lineStep = Math.max(
      Number.isFinite(record.lineSpacingFactor) && record.lineSpacingFactor > 0
        ? record.lineSpacingFactor * 1.667
        : 1.667,
      0.5,
    );
    const isMText = isMTextRecord(record);
    const verticalFlow = cadMTextFlowsVertically(record);
    const attachment = isMText ? record.attachment : 0;
    const verticalGroup =
      attachment >= 1 ? Math.floor((attachment - 1) / 3) : 0;
    const horizontalScale = textHorizontalScale(record, record.style);
    const verticalScale = baseTextHeight(record);
    const storedWrapWidth = isMText
      ? normalizedStoredExtent(
          record.rectangleWidth,
          horizontalScale,
        )
      : 0;
    const storedBlockWidth =
      storedWrapWidth ||
      (isMText
        ? normalizedStoredExtent(record.extentsWidth, horizontalScale)
        : 0);
    const storedBlockHeight = isMText
      ? normalizedStoredExtent(
          record.rectangleHeight > 0
            ? record.rectangleHeight
            : record.extentsHeight,
          verticalScale,
        )
      : 0;
    const formatRecords = new Map();
    const formatRecord = (format) => {
      if (formatRecords.has(format)) {
        return formatRecords.get(format);
      }
      const style = styleForMTextFormat(record.style, format);
      const baselineOffset =
        format.verticalAlignment === 2
          ? 1 - format.heightScale
          : format.verticalAlignment === 1
            ? (1 - format.heightScale) * 0.5
            : 0;
      const recordForFormat = Object.freeze({
        style,
        font: systemFallbackFont(style),
        heightScale: format.heightScale,
        widthScale: format.heightScale * format.widthScale,
        tracking: format.tracking,
        shear: Math.tan(format.obliqueAngle),
        baselineOffset,
        color: colorForFormat(format),
        underline: format.underline,
        overline: format.overline,
        strikeThrough: format.strikeThrough,
      });
      formatRecords.set(format, recordForFormat);
      return recordForFormat;
    };
    const characterCache = new Map();
    const formattedCharacter = (character, format) => {
      let perFormat = characterCache.get(format);
      if (!perFormat) {
        perFormat = new Map();
        characterCache.set(format, perFormat);
      }
      if (perFormat.has(character)) {
        return perFormat.get(character);
      }
      const formatted = formatRecord(format);
      context.font = formatted.font;
      const whitespace = character === " " || character === "\t";
      const glyph = whitespace
        ? null
        : this.glyphCache.getGlyph(
            formatted.style,
            character.codePointAt(0),
          );
      const baseAdvance =
        character === "\t"
          ? measuredFallbackAdvance(context, " ") * 4
          : glyph?.advance > 0
            ? glyph.advance
            : measuredFallbackAdvance(context, character);
      const entry = Object.freeze({
        glyph,
        formatted,
        whitespace,
        advance:
          baseAdvance * formatted.widthScale * formatted.tracking,
      });
      perFormat.set(character, entry);
      return entry;
    };
    const stackCache = new WeakMap();
    const stackLayout = (stack, format) => {
      let layout = stackCache.get(stack);
      if (layout) {
        return layout;
      }
      const stackFormat = Object.freeze({
        ...format,
        heightScale: format.heightScale * STACK_TEXT_SCALE,
        underline: false,
        overline: false,
        strikeThrough: false,
        verticalAlignment: 1,
      });
      const sequence = (value) => {
        const entries = [];
        let advance = 0;
        for (const character of value) {
          const formatted = formattedCharacter(
            character,
            stackFormat,
          );
          entries.push({
            character,
            ...formatted,
            x: advance,
          });
          advance += formatted.advance;
        }
        return { entries, advance };
      };
      const upper = sequence(stack.upper);
      const lower = sequence(stack.lower);
      const height = Math.max(format.heightScale, 0.01);
      const unit = Math.max(
        format.heightScale * format.widthScale,
        0.01,
      );
      const glyphs = [];
      let advance;
      let rule = null;
      if (stack.separator === "diagonal") {
        const lowerX =
          Math.max(upper.advance * 0.65, unit * 0.35) +
          unit * 0.15;
        advance =
          Math.max(upper.advance, lowerX + lower.advance) +
          unit * 0.05;
        for (const entry of upper.entries) {
          glyphs.push({
            ...entry,
            yOffset: height * 0.32,
          });
        }
        for (const entry of lower.entries) {
          glyphs.push({
            ...entry,
            x: entry.x + lowerX,
            yOffset: -height * 0.18,
          });
        }
        rule = Object.freeze({
          x1: Math.max(upper.advance * 0.72, unit * 0.25),
          y1: height * 0.3,
          x2: lowerX + unit * 0.05,
          y2: -height * 0.08,
        });
      } else {
        advance =
          Math.max(upper.advance, lower.advance) + unit * 0.12;
        const upperX = (advance - upper.advance) * 0.5;
        const lowerX = (advance - lower.advance) * 0.5;
        for (const entry of upper.entries) {
          glyphs.push({
            ...entry,
            x: entry.x + upperX,
            yOffset: height * 0.43,
          });
        }
        for (const entry of lower.entries) {
          glyphs.push({
            ...entry,
            x: entry.x + lowerX,
            yOffset: -height * 0.27,
          });
        }
        if (stack.separator === "horizontal") {
          rule = Object.freeze({
            x1: 0,
            y1: height * 0.34,
            x2: advance,
            y2: height * 0.34,
          });
        }
      }
      layout = Object.freeze({
        advance: Math.max(advance, unit * 0.35),
        glyphs: Object.freeze(glyphs),
        rule,
        color: formatRecord(format).color,
      });
      stackCache.set(stack, layout);
      return layout;
    };
    const characterAdvance = (
      character,
      format,
      stack,
      position = 0,
      paragraph = DEFAULT_MTEXT_PARAGRAPH,
      paragraphLine = 0,
    ) =>
      stack
        ? stackLayout(stack, format).advance
        : character === "\t"
          ? nextCadMTextTabAdvance(
              position,
              paragraph,
              paragraphLine,
            )
          : formattedCharacter(character, format).advance;
    const requestedColumnCount =
      isMText &&
      !verticalFlow &&
      Number.isInteger(record.columnType) &&
      record.columnType > 0
        ? Math.max(
            Number.isInteger(record.columnCount)
              ? record.columnCount
              : 0,
            Number.isInteger(record.columnHeightCount)
              ? record.columnHeightCount
              : record.columnHeights?.length ?? 0,
            1,
          )
        : 1;
    const columnCount = Math.min(
      requestedColumnCount,
      MAXIMUM_MTEXT_COLUMNS,
    );
    const storedColumnWidth =
      columnCount > 1
        ? normalizedStoredExtent(record.columnWidth, horizontalScale)
        : 0;
    const storedColumnGutter =
      columnCount > 1
        ? normalizedStoredExtent(record.columnGutter, horizontalScale)
        : 0;
    const columnWidth =
      storedColumnWidth ||
      (columnCount > 1 && storedBlockWidth > 0
        ? Math.max(
            (storedBlockWidth -
              storedColumnGutter * (columnCount - 1)) /
              columnCount,
            0,
          )
        : 0);
    const wrapWidth = columnWidth || storedWrapWidth;
    const lines =
      isMText && !verticalFlow && wrapWidth > 0
        ? wrapCadMTextRuns(
            parsedLines,
            wrapWidth,
            characterAdvance,
          )
        : parsedLines;
    const columnHeights = normalizedColumnHeights(
      record,
      verticalScale,
    );
    const columns = layoutCadTextColumns(lines, {
      count: columnCount,
      width: columnWidth,
      gutter: storedColumnGutter,
      heights: columnHeights,
      lineStep,
      flowReversed: (record.columnFlags & (1 << 1)) !== 0,
    });
    const maximumMeasuredLineWidth = Math.max(
      ...lines.map((line) =>
        cadMTextParagraphStart(
          line.paragraph,
          line.paragraphLine,
        ) +
        measureCadMTextLine(line, characterAdvance) +
        (Number.isFinite(line.paragraph?.right)
          ? line.paragraph.right
          : 0),
      ),
      0,
    );
    const maximumVerticalLineAdvance = verticalFlow
      ? Math.max(
          ...lines.map((line) =>
            line.reduce((total, run) => {
              if (run.stack) {
                return (
                  total +
                  Math.max(run.format.heightScale, 0.1)
                );
              }
              return (
                total +
                [...run.text].reduce(
                  (advance, character) =>
                    advance +
                    (character === "\t"
                      ? nextCadMTextTabAdvance(
                          advance,
                          line.paragraph,
                          line.paragraphLine,
                        )
                      : Math.max(run.format.heightScale, 0.1)),
                  0,
                )
              );
            }, 0),
          ),
          0,
        )
      : 0;
    const measuredBlockWidth =
      verticalFlow
        ? Math.max(lines.length, 1) * lineStep
        : columnCount > 1
        ? (columnWidth || maximumMeasuredLineWidth) * columnCount +
          storedColumnGutter * (columnCount - 1)
        : maximumMeasuredLineWidth;
    const blockWidth =
      columnCount > 1
        ? measuredBlockWidth || storedBlockWidth
        : storedBlockWidth || measuredBlockWidth;
    const blockHeight =
      storedBlockHeight ||
      (verticalFlow
        ? Math.max(maximumVerticalLineAdvance, 1)
        : Math.max(...columns.map((column) => column.height), lineStep));
    const verticalOffset =
      !isMText
        ? 0
        : verticalGroup === 0
          ? -1
          : verticalGroup === 1
          ? blockHeight * 0.5 - 1
          : blockHeight - 1;
    const textAlignmentWidth = cadTextAlignmentWidth(record);
    const horizontalGroup =
      isMText && attachment >= 1
        ? (attachment - 1) % 3
        : 0;
    const blockLeft =
      horizontalGroup === 1
        ? -blockWidth * 0.5
        : horizontalGroup === 2
          ? -blockWidth
          : 0;
    if (isMText) {
      this.#drawMTextBackground(
        record,
        matrix,
        camera,
        width,
        height,
        metrics,
        layerIndex,
        byBlockColor,
        blockLeft,
        blockLeft + blockWidth,
        verticalOffset + 1,
        verticalOffset + 1 - blockHeight,
      );
    }

    for (const column of columns) {
      for (
        let lineIndex = 0;
        lineIndex < column.lines.length;
        lineIndex += 1
      ) {
        const line = column.lines[lineIndex];
        const paragraph =
          line.paragraph ?? DEFAULT_MTEXT_PARAGRAPH;
        const paragraphLine = Number.isInteger(line.paragraphLine)
          ? line.paragraphLine
          : 0;
        const glyphs = [];
        const stackRules = [];
        let lineAdvance = 0;
        const lineAtoms = [];
        for (const run of line) {
          if (run.stack) {
            lineAtoms.push({
              format: run.format,
              stack: run.stack,
            });
            continue;
          }
          for (const character of run.text) {
            lineAtoms.push({ character, format: run.format });
          }
        }
        const alignedTabAdvance = (position, upcomingAdvance) => {
          const absolute =
            cadMTextParagraphStart(paragraph, paragraphLine) +
            position;
          const stop = paragraph.tabStops?.find(
            (candidate) =>
              Number.isFinite(candidate?.position) &&
              candidate.position > absolute + 1e-9,
          );
          const defaultAdvance = nextCadMTextTabAdvance(
            position,
            paragraph,
            paragraphLine,
          );
          if (!stop || stop.alignment === "left") {
            return defaultAdvance;
          }
          const adjustment =
            stop.alignment === "right"
              ? upcomingAdvance
              : upcomingAdvance * 0.5;
          return Math.max(defaultAdvance - adjustment, 0.01);
        };
        for (
          let atomIndex = 0;
          atomIndex < lineAtoms.length;
          atomIndex += 1
        ) {
          const atom = lineAtoms[atomIndex];
          if (atom.stack) {
            const stack = stackLayout(atom.stack, atom.format);
            const stackX = verticalFlow
              ? -stack.advance * 0.5
              : lineAdvance;
            const stackY = verticalFlow ? -lineAdvance : 0;
            for (const entry of stack.glyphs) {
              glyphs.push({
                ...entry,
                x: stackX + entry.x,
                yOffset: stackY + (entry.yOffset ?? 0),
              });
            }
            if (stack.rule) {
              stackRules.push({
                ...stack.rule,
                x1: stackX + stack.rule.x1,
                x2: stackX + stack.rule.x2,
                y1: stackY + stack.rule.y1,
                y2: stackY + stack.rule.y2,
                color: stack.color,
              });
            }
            lineAdvance += verticalFlow
              ? Math.max(atom.format.heightScale, 0.1)
              : stack.advance;
            continue;
          }
          const formatted = formattedCharacter(
            atom.character,
            atom.format,
          );
          let advance;
          if (verticalFlow) {
            advance =
              atom.character === "\t"
                ? nextCadMTextTabAdvance(
                    lineAdvance,
                    paragraph,
                    paragraphLine,
                  )
                : Math.max(
                    atom.format.heightScale,
                    0.1,
                  );
          } else if (atom.character === "\t") {
            let upcomingAdvance = 0;
            for (
              let nextIndex = atomIndex + 1;
              nextIndex < lineAtoms.length;
              nextIndex += 1
            ) {
              const next = lineAtoms[nextIndex];
              if (next.character === "\t") {
                break;
              }
              upcomingAdvance += next.stack
                ? stackLayout(next.stack, next.format).advance
                : formattedCharacter(
                    next.character,
                    next.format,
                  ).advance;
            }
            advance = alignedTabAdvance(
              lineAdvance,
              upcomingAdvance,
            );
          } else {
            advance = characterAdvance(
              atom.character,
              atom.format,
              undefined,
              lineAdvance,
              paragraph,
              paragraphLine,
            );
          }
          glyphs.push({
            character: atom.character,
            ...formatted,
            advance,
            x: verticalFlow
              ? -formatted.formatted.widthScale * 0.5
              : lineAdvance,
            ...(verticalFlow
              ? { yOffset: -lineAdvance }
              : {}),
          });
          lineAdvance += advance;
        }
        const storedLineWidth =
          !verticalFlow &&
          isMText &&
          columnCount === 1 &&
          lines.length === 1
            ? normalizedStoredExtent(
                record.extentsWidth,
                horizontalScale,
              )
            : textAlignmentWidth;
        const lineScale =
          storedLineWidth > 0 && lineAdvance > 0
            ? storedLineWidth / lineAdvance
            : 1;
        const scaledLineAdvance = lineAdvance * lineScale;
        const paragraphStart = cadMTextParagraphStart(
          paragraph,
          paragraphLine,
        );
        const paragraphRight = Number.isFinite(paragraph.right)
          ? paragraph.right
          : 0;
        const paragraphBoxWidth =
          columnWidth || storedBlockWidth;
        const remainingParagraphWidth =
          paragraphBoxWidth > 0
            ? Math.max(
                paragraphBoxWidth -
                  paragraphStart -
                  paragraphRight -
                  scaledLineAdvance,
                0,
              )
            : 0;
        const paragraphAlignmentOffset =
          paragraph.alignment === "right"
            ? remainingParagraphWidth
            : paragraph.alignment === "center"
              ? remainingParagraphWidth * 0.5
              : 0;
        const horizontalOffset =
          verticalFlow
            ? blockLeft +
              blockWidth -
              (lineIndex + 0.5) * lineStep
            : isMText
            ? blockLeft +
              column.x +
              paragraphStart +
              paragraphAlignmentOffset
            : horizontalGroup === 1
              ? -scaledLineAdvance * 0.5
              : horizontalGroup === 2
                ? -scaledLineAdvance
                : 0;
        const baseline = verticalFlow
          ? verticalOffset
          : verticalOffset - lineIndex * lineStep;
        context.beginPath();
        let hasVectorPath = false;
        let activeVectorColor = "";
        const flushVectorPath = () => {
          if (hasVectorPath) {
            context.stroke();
            context.beginPath();
            hasVectorPath = false;
          }
        };
        for (const entry of glyphs) {
          if (entry.whitespace) {
            continue;
          }
          const x = entry.x * lineScale + horizontalOffset;
          const glyphXScale = entry.formatted.widthScale * lineScale;
          const glyphYScale = entry.formatted.heightScale;
          const entryBaseline =
            baseline +
            entry.formatted.baselineOffset +
            (entry.yOffset ?? 0);
          if (activeVectorColor !== entry.formatted.color) {
            flushVectorPath();
            activeVectorColor = entry.formatted.color;
            context.strokeStyle = activeVectorColor;
            context.fillStyle = activeVectorColor;
          }
          if (entry.glyph) {
            const remaining = this.maximumSegments - metrics.segments;
            const count = Math.min(
              entry.glyph.segmentCount,
              remaining,
            );
            for (let segment = 0; segment < count; segment += 1) {
              const offset = segment * 4;
              const start = pointToScreen(
                matrix,
                entry.glyph.vertices[offset] * glyphXScale +
                  entry.glyph.vertices[offset + 1] *
                    glyphYScale *
                    entry.formatted.shear +
                  x,
                entry.glyph.vertices[offset + 1] * glyphYScale +
                  entryBaseline,
                camera,
                width,
                height,
              );
              const end = pointToScreen(
                matrix,
                entry.glyph.vertices[offset + 2] * glyphXScale +
                  entry.glyph.vertices[offset + 3] *
                    glyphYScale *
                    entry.formatted.shear +
                  x,
                entry.glyph.vertices[offset + 3] * glyphYScale +
                  entryBaseline,
                camera,
                width,
                height,
              );
              context.moveTo(start[0], start[1]);
              context.lineTo(end[0], end[1]);
            }
            metrics.segments += count;
            metrics.vectorGlyphs += 1;
            hasVectorPath ||= count > 0;
          } else if (
            metrics.fallbackGlyphs < this.maximumFallbackGlyphs
          ) {
            flushVectorPath();
            context.setTransform(
              screen.a * glyphXScale,
              screen.b * glyphXScale,
              -(
                screen.c * glyphYScale +
                screen.a * entry.formatted.shear * glyphYScale
              ),
              -(
                screen.d * glyphYScale +
                screen.b * entry.formatted.shear * glyphYScale
              ),
              screen.e -
                screen.a * entry.formatted.shear * entryBaseline,
              screen.f -
                screen.b * entry.formatted.shear * entryBaseline,
            );
            context.font = entry.formatted.font;
            context.textBaseline = "alphabetic";
            context.fillText(
              entry.character,
              x / glyphXScale,
              -entryBaseline / glyphYScale,
            );
            context.setTransform(1, 0, 0, 1, 0, 0);
            metrics.fallbackGlyphs += 1;
          }
        }
        flushVectorPath();
        for (const rule of stackRules) {
          if (metrics.segments >= this.maximumSegments) {
            break;
          }
          const start = pointToScreen(
            matrix,
            rule.x1 * lineScale + horizontalOffset,
            baseline + rule.y1,
            camera,
            width,
            height,
          );
          const end = pointToScreen(
            matrix,
            rule.x2 * lineScale + horizontalOffset,
            baseline + rule.y2,
            camera,
            width,
            height,
          );
          context.strokeStyle = rule.color;
          context.beginPath();
          context.moveTo(start[0], start[1]);
          context.lineTo(end[0], end[1]);
          context.stroke();
          metrics.segments += 1;
        }
        if (!verticalFlow) {
          for (let first = 0; first < glyphs.length; ) {
            let end = first + 1;
            while (
              end < glyphs.length &&
              glyphs[end].formatted === glyphs[first].formatted
            ) {
              end += 1;
            }
            const formatted = glyphs[first].formatted;
            const startX =
              glyphs[first].x * lineScale + horizontalOffset;
            const endX =
              (glyphs[end - 1].x + glyphs[end - 1].advance) *
                lineScale +
              horizontalOffset;
            for (const [enabled, offset] of [
              [formatted.underline, -0.12],
              [formatted.strikeThrough, 0.45],
              [formatted.overline, 1.05],
            ]) {
              if (
                !enabled ||
                metrics.segments >= this.maximumSegments ||
                !(endX > startX)
              ) {
                continue;
              }
              const y =
                baseline +
                formatted.baselineOffset +
                offset * formatted.heightScale;
              const start = pointToScreen(
                matrix,
                startX,
                y,
                camera,
                width,
                height,
              );
              const finish = pointToScreen(
                matrix,
                endX,
                y,
                camera,
                width,
                height,
              );
              context.strokeStyle = formatted.color;
              context.beginPath();
              context.moveTo(start[0], start[1]);
              context.lineTo(finish[0], finish[1]);
              context.stroke();
              metrics.segments += 1;
            }
            first = end;
          }
        }
      }
    }
    const selectionWidth = Math.max(
      blockWidth,
      textAlignmentWidth,
      0.35,
    );
    const selectionHeight = Math.max(blockHeight, 1);
    return Object.freeze({
      left: blockLeft,
      right: blockLeft + selectionWidth,
      top: verticalOffset + 1.15,
      bottom: verticalOffset + 1 - selectionHeight,
    });
  }

  dispose() {
    const { width, height } = this.resize();
    this.context.setTransform(1, 0, 0, 1, 0, 0);
    this.context.clearRect(0, 0, width, height);
  }
}

export class CompositeTextOverlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.overlays = [];
    this.maskVisibility = true;
    this.hitTestingEnabled = false;
    this.palette = new Uint8Array(DEFAULT_ACI_PALETTE);
  }

  add(overlay, { first = false } = {}) {
    if (!overlay || typeof overlay.redraw !== "function") {
      throw new TypeError("composite text overlay requires a drawable overlay");
    }
    overlay.setMaskVisibility?.(this.maskVisibility);
    overlay.setPalette?.(this.palette);
    overlay.setHitTestingEnabled?.(this.hitTestingEnabled);
    if (first) {
      this.overlays.unshift(overlay);
    } else {
      this.overlays.push(overlay);
    }
    return overlay;
  }

  setMaskVisibility(visible) {
    this.maskVisibility = Boolean(visible);
    for (const overlay of this.overlays) {
      overlay.setMaskVisibility?.(this.maskVisibility);
    }
    return this.maskVisibility;
  }

  setPalette(palette) {
    if (!(palette instanceof Uint8Array) || palette.length !== 256 * 4) {
      throw new TypeError("text palette must contain 256 RGBA colors");
    }
    this.palette = new Uint8Array(palette);
    for (const overlay of this.overlays) {
      overlay.setPalette?.(this.palette);
    }
  }

  setHitTestingEnabled(enabled) {
    this.hitTestingEnabled = Boolean(enabled);
    for (const overlay of this.overlays) {
      overlay.setHitTestingEnabled?.(this.hitTestingEnabled);
    }
    return this.hitTestingEnabled;
  }

  findTextOccurrence(handle) {
    for (const overlay of this.overlays) {
      const occurrence = overlay.findTextOccurrence?.(handle);
      if (occurrence) {
        return occurrence;
      }
    }
    return null;
  }

  hitTest(x, y, options) {
    let best = null;
    for (let index = this.overlays.length - 1; index >= 0; index -= 1) {
      const candidate = this.overlays[index].hitTest?.(x, y, options);
      if (
        candidate &&
        (!best || candidate.distancePixels < best.distancePixels)
      ) {
        best = candidate;
      }
    }
    return best;
  }

  redraw(camera, layerVisibility, { size = null } = {}) {
    const metrics = {
      sourceTexts: 0,
      visitedSourceTexts: 0,
      visibleOccurrences: 0,
      vectorGlyphs: 0,
      fallbackGlyphs: 0,
      segments: 0,
      backgroundFills: 0,
      maskOccurrences: 0,
      clippedTextOccurrences: 0,
      maskClipOperations: 0,
      maskClipDisabled: false,
      xclipOccurrences: 0,
      xclipOperations: 0,
      truncated: false,
    };
    if (this.overlays.length === 0) {
      if (size) {
        this.canvas.width = size.width;
        this.canvas.height = size.height;
      }
      const context = this.canvas.getContext("2d", { alpha: true });
      context?.clearRect(0, 0, this.canvas.width, this.canvas.height);
      return Object.freeze(metrics);
    }
    this.overlays.forEach((overlay, index) => {
      const current = overlay.redraw(camera, layerVisibility, {
        clear: index === 0,
        size,
      });
      for (const name of [
        "sourceTexts",
        "visitedSourceTexts",
        "visibleOccurrences",
        "vectorGlyphs",
        "fallbackGlyphs",
        "segments",
        "backgroundFills",
        "maskOccurrences",
        "clippedTextOccurrences",
        "maskClipOperations",
        "xclipOccurrences",
        "xclipOperations",
      ]) {
        metrics[name] += current[name] ?? 0;
      }
      metrics.maskClipDisabled ||= Boolean(current.maskClipDisabled);
      metrics.truncated ||= Boolean(current.truncated);
    });
    return Object.freeze(metrics);
  }

  dispose() {
    for (const overlay of this.overlays) {
      overlay.dispose();
    }
    this.overlays.length = 0;
  }
}

export {
  DEFAULT_MAXIMUM_FALLBACK_GLYPHS,
  DEFAULT_MAXIMUM_OCCURRENCES,
  DEFAULT_MAXIMUM_SEGMENTS,
  DEFAULT_MAXIMUM_SOURCE_TEXTS,
  DEFAULT_MAXIMUM_MASK_OCCURRENCES,
  DEFAULT_MINIMUM_PIXEL_HEIGHT,
};

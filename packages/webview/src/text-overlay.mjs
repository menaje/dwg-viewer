import {
  TextEntityKind,
} from "./scene-cache.mjs";
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

const DEFAULT_MAXIMUM_SOURCE_TEXTS = 50_000;
const DEFAULT_MAXIMUM_OCCURRENCES = 10_000;
const DEFAULT_MAXIMUM_SEGMENTS = 250_000;
const DEFAULT_MAXIMUM_FALLBACK_GLYPHS = 50_000;
const DEFAULT_MINIMUM_PIXEL_HEIGHT = 0.5;
const DEFAULT_MAXIMUM_MASK_OCCURRENCES = 10_000;
const MAXIMUM_CODE_POINTS_PER_ENTITY = 4_096;
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
  if (localFamily) {
    return `1px "${localFamily}", "Noto Sans KR", "Apple SD Gothic Neo", sans-serif`;
  }
  const bold =
    /(?:bold|black|heavy|semibold|demi)/.test(name) ||
    /bd(?:\.[^.]+)?$/.test(name);
  const weight = bold ? "700 " : "";
  if (/^(?:arial|helvetica)/.test(name)) {
    return `${weight}1px "Arial", "Helvetica Neue", Helvetica, sans-serif`;
  }
  if (/^(?:batang|gungsuh|궁서|바탕)/.test(name)) {
    return `${weight}1px "Batang", "AppleMyungjo", "Noto Serif KR", serif`;
  }
  if (/^(?:malgun|dotum|gulim|돋움|굴림|맑은)/.test(name)) {
    return `${weight}1px "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`;
  }
  return `${weight}1px "Noto Sans KR", "Apple SD Gothic Neo", sans-serif`;
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
  const output = [""];
  let codePoints = 0;
  const append = (text) => {
    if (codePoints >= MAXIMUM_CODE_POINTS_PER_ENTITY) {
      return;
    }
    const limited = [...text].slice(
      0,
      MAXIMUM_CODE_POINTS_PER_ENTITY - codePoints,
    );
    output[output.length - 1] += limited.join("");
    codePoints += limited.length;
  };
  for (let index = 0; index < value.length && codePoints < MAXIMUM_CODE_POINTS_PER_ENTITY; ) {
    const character = value[index];
    if (character === "{" || character === "}") {
      index += 1;
      continue;
    }
    if (character !== "\\") {
      append(character);
      index += 1;
      continue;
    }
    const command = value[index + 1] ?? "";
    if (command === "P" || command === "p") {
      output.push("");
      index += 2;
      continue;
    }
    if (command === "~") {
      append(" ");
      index += 2;
      continue;
    }
    if (command === "\\" || command === "{" || command === "}") {
      append(command);
      index += 2;
      continue;
    }
    if (
      (command === "U" || command === "u") &&
      value[index + 2] === "+" &&
      /^[0-9a-f]{4}$/i.test(value.slice(index + 3, index + 7))
    ) {
      append(String.fromCodePoint(Number.parseInt(value.slice(index + 3, index + 7), 16)));
      index += 7;
      continue;
    }
    if ("LlOoKk".includes(command)) {
      index += 2;
      continue;
    }
    const semicolon = value.indexOf(";", index + 2);
    if (semicolon !== -1) {
      if (command === "S" || command === "s") {
        append(
          value
            .slice(index + 2, semicolon)
            .replaceAll("^", "/")
            .replaceAll("#", "/"),
        );
      }
      index = semicolon + 1;
      continue;
    }
    append(command || "\\");
    index += command ? 2 : 1;
  }
  return Object.freeze(output.map(replacePercentCodes));
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

function shearXMat4(angle) {
  const matrix = identityMat4();
  const shear = Math.tan(angle);
  matrix[4] = Number.isFinite(shear) ? shear : 0;
  return matrix;
}

function effectiveTextMatrix(record, style) {
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
  return [
    arbitraryAxisMat4(normal),
    translationMat4(...record.insertionPoint),
    rotationZMat4(Number.isFinite(record.rotation) ? record.rotation : 0),
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

function normalizedTextAlignmentWidth(record) {
  if (
    isMTextRecord(record) ||
    ![1, 2, 3, 4, 5].includes(record.horizontalAlignment) ||
    !record.alignmentPoint?.every(Number.isFinite) ||
    !record.insertionPoint?.every(Number.isFinite)
  ) {
    return 0;
  }
  const deltaX = record.alignmentPoint[0] - record.insertionPoint[0];
  const deltaY = record.alignmentPoint[1] - record.insertionPoint[1];
  const rotation = Number.isFinite(record.rotation) ? record.rotation : 0;
  const projected = Math.abs(
    deltaX * Math.cos(rotation) + deltaY * Math.sin(rotation),
  );
  const worldWidth =
    record.horizontalAlignment === 1 || record.horizontalAlignment === 4
      ? projected * 2
      : record.horizontalAlignment === 3 ||
          record.horizontalAlignment === 5
        ? Math.hypot(deltaX, deltaY)
        : projected;
  return normalizedStoredExtent(
    worldWidth,
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

  resize() {
    const ratio = Math.min(globalThis.devicePixelRatio ?? 1, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    return { width, height };
  }

  redraw(camera, layerVisibility, { clear = true } = {}) {
    const { width, height } = this.resize();
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
      maskOccurrences: 0,
      clippedTextOccurrences: 0,
      maskClipOperations: 0,
      maskClipDisabled: false,
      xclipOccurrences: 0,
      xclipOperations: 0,
      truncated: false,
    };
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
        record.kind === TextEntityKind.AttributeDefinition ||
        (record.commonFlags & 1) !== 0 ||
        (record.kind === TextEntityKind.Attribute &&
          (record.sourceFlags & 1) !== 0)
      ) {
        continue;
      }
      if (!record.insertionPoint.every(Number.isFinite)) {
        continue;
      }
      const localMatrix = effectiveTextMatrix(record, record.style);
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
        const isMText =
          record.kind === TextEntityKind.MText || record.mtextType !== 0;
        const lines = plainCadTextLines(value, isMText);
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
          layerIndex,
          byBlockColor,
          byBlockOpacity,
        );
        this.#drawOccurrence(
          record,
          lines,
          worldMatrix,
          screen,
          camera,
          width,
          height,
          metrics,
        );
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
    const [red, green, blue] = decodeColor(
      record.color,
      this.layers[layerIndex],
      byBlockColor,
      this.palette,
    );
    const opacity = decodeCadOpacity(record.color, {
      layer: decodeCadOpacity(this.layers[layerIndex]?.color ?? 0),
      byBlock: byBlockOpacity,
    });
    const color = `rgba(${red}, ${green}, ${blue}, ${opacity})`;
    const lineStep = Math.max(
      Number.isFinite(record.lineSpacingFactor) && record.lineSpacingFactor > 0
        ? record.lineSpacingFactor * 1.667
        : 1.667,
      0.5,
    );
    const isMText = isMTextRecord(record);
    const attachment = isMText ? record.attachment : 0;
    const verticalGroup =
      attachment >= 1 ? Math.floor((attachment - 1) / 3) : 0;
    const horizontalScale = textHorizontalScale(record, record.style);
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
          Number.isFinite(record.height) && record.height > 0
            ? record.height
            : record.style?.height > 0
              ? record.style.height
              : record.style?.lastHeight > 0
                ? record.style.lastHeight
                : 1,
        )
      : 0;
    const fallbackFont = systemFallbackFont(record.style);
    context.font = fallbackFont;
    const advanceCache = new Map();
    const characterAdvance = (character) => {
      const cached = advanceCache.get(character);
      if (cached !== undefined) {
        return cached;
      }
      const glyph =
        character === " " || character === "\t"
          ? null
          : this.glyphCache.getGlyph(
              record.style,
              character.codePointAt(0),
            );
      const advance =
        character === "\t"
          ? measuredFallbackAdvance(context, " ") * 4
          : glyph?.advance > 0
            ? glyph.advance
            : measuredFallbackAdvance(context, character);
      advanceCache.set(character, advance);
      return advance;
    };
    const lines =
      isMText && storedWrapWidth > 0
        ? wrapCadTextLines(
            parsedLines,
            storedWrapWidth,
            characterAdvance,
          )
        : parsedLines;
    const blockHeight =
      storedBlockHeight || Math.max(lines.length, 1) * lineStep;
    const verticalOffset =
      !isMText
        ? 0
        : verticalGroup === 0
          ? -1
          : verticalGroup === 1
          ? blockHeight * 0.5 - 1
          : blockHeight - 1;
    const textAlignmentWidth = normalizedTextAlignmentWidth(record);

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const glyphs = [];
      let lineAdvance = 0;
      for (const character of lines[lineIndex]) {
        if (character === " " || character === "\t") {
          glyphs.push({ character, glyph: null, x: lineAdvance, whitespace: true });
          const spaceAdvance = measuredFallbackAdvance(context, " ");
          lineAdvance += character === "\t" ? spaceAdvance * 4 : spaceAdvance;
          continue;
        }
        const glyph = this.glyphCache.getGlyph(
          record.style,
          character.codePointAt(0),
        );
        glyphs.push({ character, glyph, x: lineAdvance, whitespace: false });
        lineAdvance +=
          glyph?.advance > 0
            ? glyph.advance
            : measuredFallbackAdvance(context, character);
      }
      const storedLineWidth =
        isMText && lines.length === 1
          ? normalizedStoredExtent(record.extentsWidth, horizontalScale)
          : textAlignmentWidth;
      const lineScale =
        storedLineWidth > 0 && lineAdvance > 0
          ? storedLineWidth / lineAdvance
          : 1;
      const scaledLineAdvance = lineAdvance * lineScale;
      const horizontalGroup =
        isMText && attachment >= 1
          ? (attachment - 1) % 3
          : 0;
      const alignmentWidth =
        storedBlockWidth > 0 ? storedBlockWidth : scaledLineAdvance;
      const horizontalOffset =
        horizontalGroup === 1
          ? -alignmentWidth * 0.5
          : horizontalGroup === 2
            ? -alignmentWidth
            : 0;
      const baseline = verticalOffset - lineIndex * lineStep;
      context.strokeStyle = color;
      context.fillStyle = color;
      context.beginPath();
      let hasVectorPath = false;
      for (const entry of glyphs) {
        if (entry.whitespace) {
          continue;
        }
        const x = entry.x * lineScale + horizontalOffset;
        if (entry.glyph) {
          const remaining = this.maximumSegments - metrics.segments;
          const count = Math.min(entry.glyph.segmentCount, remaining);
          for (let segment = 0; segment < count; segment += 1) {
            const offset = segment * 4;
            const start = pointToScreen(
              matrix,
              entry.glyph.vertices[offset] * lineScale + x,
              entry.glyph.vertices[offset + 1] + baseline,
              camera,
              width,
              height,
            );
            const end = pointToScreen(
              matrix,
              entry.glyph.vertices[offset + 2] * lineScale + x,
              entry.glyph.vertices[offset + 3] + baseline,
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
        } else if (metrics.fallbackGlyphs < this.maximumFallbackGlyphs) {
          if (hasVectorPath) {
            context.stroke();
            context.beginPath();
            hasVectorPath = false;
          }
          context.setTransform(
            screen.a * lineScale,
            screen.b * lineScale,
            -screen.c,
            -screen.d,
            screen.e,
            screen.f,
          );
          context.font = fallbackFont;
          context.textBaseline = "alphabetic";
          context.fillText(
            entry.character,
            entry.x + horizontalOffset / lineScale,
            -baseline,
          );
          context.setTransform(1, 0, 0, 1, 0, 0);
          metrics.fallbackGlyphs += 1;
        }
      }
      if (hasVectorPath) {
        context.stroke();
      }
    }
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
    this.palette = new Uint8Array(DEFAULT_ACI_PALETTE);
  }

  add(overlay, { first = false } = {}) {
    if (!overlay || typeof overlay.redraw !== "function") {
      throw new TypeError("composite text overlay requires a drawable overlay");
    }
    overlay.setMaskVisibility?.(this.maskVisibility);
    overlay.setPalette?.(this.palette);
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

  redraw(camera, layerVisibility) {
    const metrics = {
      sourceTexts: 0,
      visitedSourceTexts: 0,
      visibleOccurrences: 0,
      vectorGlyphs: 0,
      fallbackGlyphs: 0,
      segments: 0,
      maskOccurrences: 0,
      clippedTextOccurrences: 0,
      maskClipOperations: 0,
      maskClipDisabled: false,
      xclipOccurrences: 0,
      xclipOperations: 0,
      truncated: false,
    };
    if (this.overlays.length === 0) {
      const context = this.canvas.getContext("2d", { alpha: true });
      context?.clearRect(0, 0, this.canvas.width, this.canvas.height);
      return Object.freeze(metrics);
    }
    this.overlays.forEach((overlay, index) => {
      const current = overlay.redraw(camera, layerVisibility, {
        clear: index === 0,
      });
      for (const name of [
        "sourceTexts",
        "visitedSourceTexts",
        "visibleOccurrences",
        "vectorGlyphs",
        "fallbackGlyphs",
        "segments",
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

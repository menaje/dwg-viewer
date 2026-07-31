import {
  TextEntityKind,
} from "./scene-cache.mjs";
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
const DEFAULT_MINIMUM_PIXEL_HEIGHT = 2;
const DEFAULT_MAXIMUM_MASK_OCCURRENCES = 10_000;
const MAXIMUM_CODE_POINTS_PER_ENTITY = 4_096;
const IDENTITY_INSTANCES = Object.freeze({
  data: identityMat4(),
  maskBases: new Uint32Array([0]),
  count: 1,
});

function replacePercentCodes(value) {
  return value
    .replace(/%%d/gi, "°")
    .replace(/%%p/gi, "±")
    .replace(/%%c/gi, "⌀");
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
  return [
    arbitraryAxisMat4(normal),
    translationMat4(...record.insertionPoint),
    rotationZMat4(Number.isFinite(record.rotation) ? record.rotation : 0),
    shearXMat4(oblique),
    scalingMat4(height * entityWidth * styleWidth, height, height),
  ].reduce(multiplyMat4);
}

function decodeColor(encoded, layer) {
  const kind = encoded >>> 30;
  if (kind === 0 && layer) {
    return decodeColor(layer.color, null);
  }
  if (kind === 2) {
    const index = encoded & 255;
    const colors = {
      1: [255, 46, 46],
      2: [255, 255, 51],
      3: [51, 255, 89],
      4: [51, 242, 255],
      5: [89, 140, 255],
      6: [255, 64, 255],
      7: [235, 235, 235],
    };
    return colors[index] ?? [190, 198, 210];
  }
  if (kind === 3) {
    return [(encoded >>> 16) & 255, (encoded >>> 8) & 255, encoded & 255];
  }
  return [235, 235, 235];
}

function instancesForText(record, ownerBlockIndex, instanceGraph) {
  if (
    ownerBlockIndex === undefined ||
    instanceGraph.modelBlockIndices.has(ownerBlockIndex) ||
    record.kind === TextEntityKind.Attribute
  ) {
    return IDENTITY_INSTANCES;
  }
  return (
    instanceGraph.instancesByBlock.get(ownerBlockIndex) ??
    Object.freeze({ data: new Float64Array(0), count: 0 })
  );
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
    this.maskOrder = maskOrder?.enabled ? maskOrder : null;
    this.blockIndexByHandle = new Map(
      blocks.map((block) => [block.handle, block.index]),
    );
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
      truncated: false,
    });
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

  redraw(camera, layerVisibility) {
    const { width, height } = this.resize();
    const context = this.context;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, width, height);
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
          (record.sourceFlags & 1) !== 0) ||
        (record.layerIndex !== 0xffffffff &&
          layerVisibility[record.layerIndex] === false)
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
        const clipped = this.#beginMaskClip(
          absoluteBucket,
          screenMasks,
          width,
          height,
          metrics,
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
        if (clipped) {
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
        this.instanceGraph.modelBlockIndices.has(ownerBlockIndex)
          ? IDENTITY_INSTANCES
          : this.instanceGraph.instancesByBlock.get(ownerBlockIndex);
      if (!instances) {
        continue;
      }
      for (
        let instanceIndex = 0;
        instanceIndex < instances.count;
        instanceIndex += 1
      ) {
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

  #drawOccurrence(
    record,
    lines,
    matrix,
    screen,
    camera,
    width,
    height,
    metrics,
  ) {
    const context = this.context;
    const [red, green, blue] = decodeColor(
      record.color,
      this.layers[record.layerIndex],
    );
    const color = `rgb(${red} ${green} ${blue})`;
    const lineStep = Math.max(
      Number.isFinite(record.lineSpacingFactor) && record.lineSpacingFactor > 0
        ? record.lineSpacingFactor * 1.667
        : 1.667,
      0.5,
    );
    const attachment = record.kind === TextEntityKind.MText ? record.attachment : 0;
    const verticalGroup =
      attachment >= 1 ? Math.floor((attachment - 1) / 3) : 0;
    const blockHeight = Math.max(lines.length, 1) * lineStep;
    const verticalOffset =
      verticalGroup === 0
        ? -1
        : verticalGroup === 1
          ? blockHeight * 0.5 - 1
          : blockHeight - 1;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const glyphs = [];
      let lineAdvance = 0;
      for (const character of lines[lineIndex]) {
        if (character === " " || character === "\t") {
          glyphs.push({ character, glyph: null, x: lineAdvance, whitespace: true });
          lineAdvance += character === "\t" ? 2.4 : 0.6;
          continue;
        }
        const glyph = this.glyphCache.getGlyph(
          record.style,
          character.codePointAt(0),
        );
        glyphs.push({ character, glyph, x: lineAdvance, whitespace: false });
        lineAdvance += glyph?.advance > 0 ? glyph.advance : 1;
      }
      const horizontalGroup =
        attachment >= 1
          ? (attachment - 1) % 3
          : record.horizontalAlignment === 1 ||
              record.horizontalAlignment === 4
            ? 1
            : record.horizontalAlignment === 2
              ? 2
              : 0;
      const horizontalOffset =
        horizontalGroup === 1
          ? -lineAdvance * 0.5
          : horizontalGroup === 2
            ? -lineAdvance
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
        const x = entry.x + horizontalOffset;
        if (entry.glyph) {
          const remaining = this.maximumSegments - metrics.segments;
          const count = Math.min(entry.glyph.segmentCount, remaining);
          for (let segment = 0; segment < count; segment += 1) {
            const offset = segment * 4;
            const start = pointToScreen(
              matrix,
              entry.glyph.vertices[offset] + x,
              entry.glyph.vertices[offset + 1] + baseline,
              camera,
              width,
              height,
            );
            const end = pointToScreen(
              matrix,
              entry.glyph.vertices[offset + 2] + x,
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
            screen.a,
            screen.b,
            -screen.c,
            -screen.d,
            screen.e,
            screen.f,
          );
          context.font =
            '1px "Noto Sans KR", "Apple SD Gothic Neo", sans-serif';
          context.textBaseline = "alphabetic";
          context.fillText(entry.character, x, -baseline);
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

export {
  DEFAULT_MAXIMUM_FALLBACK_GLYPHS,
  DEFAULT_MAXIMUM_OCCURRENCES,
  DEFAULT_MAXIMUM_SEGMENTS,
  DEFAULT_MAXIMUM_SOURCE_TEXTS,
  DEFAULT_MAXIMUM_MASK_OCCURRENCES,
  DEFAULT_MINIMUM_PIXEL_HEIGHT,
};

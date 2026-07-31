import earcut, { deviation } from "../node_modules/earcut/src/earcut.js";

import {
  GpuLineBatchKind,
  HatchFlags,
  HatchStyle,
} from "./scene-cache.mjs";
import {
  encodeMaskBucket,
  maskBucketFor,
} from "./mask-order.mjs";

export const HATCH_FILL_VERTEX_STRIDE = 32;
export const MAX_HATCH_FILL_GPU_BYTES = 32 * 1024 * 1024;
export const MAX_HATCH_FILL_TRIANGLES_PER_ENTITY = 65_536;
export const MAX_HATCH_FILL_LOOPS_PER_ENTITY = 2_048;

const MAX_BATCH_VERTICES = 24_576;
const INITIAL_BATCH_BYTES = 4 * 1024;
const MAX_POSITION_ERROR = 1e-3;
const MAX_TRIANGULATION_DEVIATION = 1e-6;
const PATH_FLAG_SELF_INTERSECTING = 64;
const PATH_FLAG_DUPLICATE = 256;
const GPU_STYLE_INVISIBLE = 1 << 16;

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function dominantProjection(normal) {
  const absolute = normal.map(Math.abs);
  if (absolute[0] >= absolute[1] && absolute[0] >= absolute[2]) {
    return [1, 2];
  }
  if (absolute[1] >= absolute[2]) {
    return [0, 2];
  }
  return [0, 1];
}

function projectedArea(coordinates) {
  const originX = coordinates[0];
  const originY = coordinates[1];
  let twiceArea = 0;
  for (let index = 0; index < coordinates.length; index += 2) {
    const next = (index + 2) % coordinates.length;
    const leftX = coordinates[index] - originX;
    const leftY = coordinates[index + 1] - originY;
    const rightX = coordinates[next] - originX;
    const rightY = coordinates[next + 1] - originY;
    twiceArea += leftX * rightY - rightX * leftY;
  }
  return twiceArea * 0.5;
}

function pointOnSegment(x, y, startX, startY, endX, endY) {
  const cross =
    (x - startX) * (endY - startY) -
    (y - startY) * (endX - startX);
  const scale = Math.max(
    1,
    Math.abs(x),
    Math.abs(y),
    Math.abs(startX),
    Math.abs(startY),
    Math.abs(endX),
    Math.abs(endY),
  );
  if (Math.abs(cross) > scale * scale * Number.EPSILON * 64) {
    return false;
  }
  return (
    x >= Math.min(startX, endX) - Number.EPSILON * scale * 64 &&
    x <= Math.max(startX, endX) + Number.EPSILON * scale * 64 &&
    y >= Math.min(startY, endY) - Number.EPSILON * scale * 64 &&
    y <= Math.max(startY, endY) + Number.EPSILON * scale * 64
  );
}

function pointInRing(x, y, coordinates) {
  let inside = false;
  for (
    let index = 0, previous = coordinates.length - 2;
    index < coordinates.length;
    previous = index, index += 2
  ) {
    const startX = coordinates[previous];
    const startY = coordinates[previous + 1];
    const endX = coordinates[index];
    const endY = coordinates[index + 1];
    if (pointOnSegment(x, y, startX, startY, endX, endY)) {
      return true;
    }
    const crosses =
      startY > y !== endY > y &&
      x < ((endX - startX) * (y - startY)) / (endY - startY) + startX;
    if (crosses) {
      inside = !inside;
    }
  }
  return inside;
}

function readRing(source, loopIndex, axes, loopTarget, vertexTarget) {
  const loop = source.readLoop(loopIndex, loopTarget);
  if (
    loop.pathFlags & (PATH_FLAG_SELF_INTERSECTING | PATH_FLAG_DUPLICATE)
  ) {
    return null;
  }
  const coordinates = new Float64Array(loop.vertexCount * 2);
  const sourceIndices = new Uint32Array(loop.vertexCount);
  const bounds = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };
  for (let index = 0; index < loop.vertexCount; index += 1) {
    const sourceIndex = loop.firstVertex + index;
    source.readVertex(sourceIndex, vertexTarget);
    const x = vertexTarget[axes[0]];
    const y = vertexTarget[axes[1]];
    coordinates[index * 2] = x;
    coordinates[index * 2 + 1] = y;
    sourceIndices[index] = sourceIndex;
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
  }
  const area = projectedArea(coordinates);
  const extent = Math.max(
    bounds.maxX - bounds.minX,
    bounds.maxY - bounds.minY,
  );
  if (
    !Number.isFinite(area) ||
    Math.abs(area) <= Math.max(extent * extent * 1e-14, 1e-18)
  ) {
    return null;
  }
  return {
    loopIndex,
    pathFlags: loop.pathFlags,
    coordinates,
    sourceIndices,
    bounds,
    area,
    absoluteArea: Math.abs(area),
    parent: null,
    depth: 0,
  };
}

function boundsContain(outer, inner) {
  return (
    outer.minX <= inner.minX &&
    outer.minY <= inner.minY &&
    outer.maxX >= inner.maxX &&
    outer.maxY >= inner.maxY
  );
}

function classifyRingNesting(rings) {
  for (const ring of rings) {
    let parent = null;
    const x = ring.coordinates[0];
    const y = ring.coordinates[1];
    for (const candidate of rings) {
      if (
        candidate === ring ||
        candidate.absoluteArea <= ring.absoluteArea ||
        !boundsContain(candidate.bounds, ring.bounds) ||
        !pointInRing(x, y, candidate.coordinates)
      ) {
        continue;
      }
      if (!parent || candidate.absoluteArea < parent.absoluteArea) {
        parent = candidate;
      }
    }
    ring.parent = parent;
  }
  for (const ring of rings) {
    let current = ring.parent;
    let depth = 0;
    while (current && depth <= rings.length) {
      depth += 1;
      current = current.parent;
    }
    if (depth > rings.length) {
      ring.parent = null;
      ring.depth = 0;
    } else {
      ring.depth = depth;
    }
  }
}

function fillGroups(rings, style) {
  const groups = [];
  for (const outer of rings) {
    const includeOuter =
      style === HatchStyle.Ignore
        ? outer.depth === 0
        : style === HatchStyle.Outer
          ? outer.depth === 0
          : outer.depth % 2 === 0;
    if (!includeOuter) {
      continue;
    }
    const holes =
      style === HatchStyle.Ignore
        ? []
        : rings.filter(
            (ring) =>
              ring.parent === outer && ring.depth === outer.depth + 1,
          );
    groups.push({ outer, holes });
  }
  return groups;
}

function flattenGroup(group) {
  const rings = [group.outer, ...group.holes];
  const originX = group.outer.coordinates[0];
  const originY = group.outer.coordinates[1];
  const coordinates = [];
  const sourceIndices = [];
  const holes = [];
  let vertexCount = 0;
  for (const [ringIndex, ring] of rings.entries()) {
    if (ringIndex > 0) {
      holes.push(vertexCount);
    }
    for (let index = 0; index < ring.sourceIndices.length; index += 1) {
      coordinates.push(
        ring.coordinates[index * 2] - originX,
        ring.coordinates[index * 2 + 1] - originY,
      );
      sourceIndices.push(ring.sourceIndices[index]);
      vertexCount += 1;
    }
  }
  return { coordinates, sourceIndices, holes };
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

function decodeEncodedColor(encoded) {
  const unsigned = encoded >>> 0;
  const kind = unsigned >>> 30;
  if (kind === 2) {
    return aciRgb(unsigned & 255);
  }
  if (kind === 3) {
    return [
      (unsigned >>> 16) & 255,
      (unsigned >>> 8) & 255,
      unsigned & 255,
    ];
  }
  return [235, 235, 235];
}

function encodeRgb([red, green, blue]) {
  return (
    ((3 << 30) |
      (Math.round(red) << 16) |
      (Math.round(green) << 8) |
      Math.round(blue)) >>>
    0
  );
}

function tintedColor(encoded, tint) {
  const [red, green, blue] = decodeEncodedColor(encoded);
  const amount = clamp01(tint);
  return encodeRgb([
    red + (255 - red) * amount,
    green + (255 - green) * amount,
    blue + (255 - blue) * amount,
  ]);
}

function hatchColors(source, entity, colorTarget) {
  if (!(entity.flags & HatchFlags.Gradient)) {
    return {
      first: entity.color,
      last: entity.color,
      gradient: false,
    };
  }
  let firstValue = Number.POSITIVE_INFINITY;
  let lastValue = Number.NEGATIVE_INFINITY;
  let firstColor = entity.color;
  let lastColor = entity.color;
  for (let index = 0; index < entity.gradientColorCount; index += 1) {
    source.readGradientColor(entity.firstGradientColor + index, colorTarget);
    if (colorTarget.value < firstValue) {
      firstValue = colorTarget.value;
      firstColor = colorTarget.color;
    }
    if (colorTarget.value > lastValue) {
      lastValue = colorTarget.value;
      lastColor = colorTarget.color;
    }
  }
  if (entity.gradientColorCount === 0) {
    return { first: entity.color, last: entity.color, gradient: true };
  }
  if (entity.gradientColorCount === 1) {
    return {
      first: firstColor,
      last:
        entity.flags & HatchFlags.SingleColorGradient
          ? tintedColor(firstColor, entity.gradientTint)
          : firstColor,
      gradient: true,
    };
  }
  return {
    first: firstColor,
    last: lastColor,
    gradient: true,
  };
}

function classifyOwner(entity, blocks, instanceGraph, blockIndexByHandle) {
  const blockIndex = blockIndexByHandle.get(entity.ownerHandle);
  if (blockIndex === undefined) {
    return entity.ownerHandle === 0n
      ? { key: "model", kind: GpuLineBatchKind.ModelDetail, blockIndex: null }
      : null;
  }
  const block = blocks[blockIndex];
  if (instanceGraph.modelBlockIndices.has(blockIndex)) {
    return { key: "model", kind: GpuLineBatchKind.ModelDetail, blockIndex: null };
  }
  if (block?.name.toUpperCase().startsWith("*PAPER_SPACE")) {
    return null;
  }
  return {
    key: `block:${blockIndex}`,
    kind: GpuLineBatchKind.BlockDefinition,
    blockIndex,
  };
}

class PackedBatchBuilder {
  constructor(owner, firstPoint) {
    this.owner = owner;
    this.origin = [...firstPoint];
    this.buffer = new ArrayBuffer(INITIAL_BATCH_BYTES);
    this.view = new DataView(this.buffer);
    this.byteLength = 0;
    this.vertexCount = 0;
    this.maximumPositionError = 0;
    this.bounds = {
      min: [...firstPoint],
      max: [...firstPoint],
    };
  }

  canAccept(points) {
    if (this.vertexCount + points.length > MAX_BATCH_VERTICES) {
      return false;
    }
    if (this.vertexCount === 0) {
      return true;
    }
    return points.every((point) =>
      point.every((coordinate, axis) => {
        const local = coordinate - this.origin[axis];
        return Math.abs(Math.fround(local) - local) <= MAX_POSITION_ERROR;
      }),
    );
  }

  writeTriangle(points, attributes) {
    this.#ensure(points.length * HATCH_FILL_VERTEX_STRIDE);
    for (let index = 0; index < points.length; index += 1) {
      this.#writeVertex(points[index], attributes, attributes.mixes[index]);
    }
  }

  #writeVertex(
    point,
    { layerIndex, firstColor, lastColor, style },
    mix,
  ) {
    const offset = this.byteLength;
    for (let axis = 0; axis < 3; axis += 1) {
      const local = point[axis] - this.origin[axis];
      const stored = Math.fround(local);
      this.view.setFloat32(offset + axis * 4, stored, true);
      this.maximumPositionError = Math.max(
        this.maximumPositionError,
        Math.abs(stored - local),
      );
      this.bounds.min[axis] = Math.min(this.bounds.min[axis], point[axis]);
      this.bounds.max[axis] = Math.max(this.bounds.max[axis], point[axis]);
    }
    this.view.setUint32(offset + 12, layerIndex, true);
    this.view.setUint32(offset + 16, firstColor >>> 0, true);
    this.view.setUint32(offset + 20, lastColor >>> 0, true);
    this.view.setFloat32(offset + 24, clamp01(mix), true);
    this.view.setUint32(offset + 28, style >>> 0, true);
    this.byteLength += HATCH_FILL_VERTEX_STRIDE;
    this.vertexCount += 1;
  }

  #ensure(additionalBytes) {
    const required = this.byteLength + additionalBytes;
    if (required <= this.buffer.byteLength) {
      return;
    }
    let capacity = this.buffer.byteLength;
    const maximum = MAX_BATCH_VERTICES * HATCH_FILL_VERTEX_STRIDE;
    while (capacity < required) {
      capacity = Math.min(maximum, capacity * 2);
    }
    const next = new ArrayBuffer(capacity);
    new Uint8Array(next).set(new Uint8Array(this.buffer, 0, this.byteLength));
    this.buffer = next;
    this.view = new DataView(next);
  }
}

class FillMeshBuilder {
  constructor(maximumBytes) {
    this.maximumBytes = maximumBytes;
    this.groups = new Map();
    this.byteLength = 0;
    this.vertexCount = 0;
    this.maximumPositionError = 0;
  }

  canWriteTriangle() {
    return (
      this.byteLength + 3 * HATCH_FILL_VERTEX_STRIDE <= this.maximumBytes
    );
  }

  writeTriangle(owner, points, attributes) {
    let group = this.groups.get(owner.key);
    if (!group) {
      group = { owner, batches: [], active: null };
      this.groups.set(owner.key, group);
    }
    if (!group.active || !group.active.canAccept(points)) {
      group.active = new PackedBatchBuilder(owner, points[0]);
      group.batches.push(group.active);
    }
    group.active.writeTriangle(points, attributes);
    this.byteLength += 3 * HATCH_FILL_VERTEX_STRIDE;
    this.vertexCount += 3;
  }

  finish() {
    const buffer = new ArrayBuffer(this.byteLength);
    const destination = new Uint8Array(buffer);
    const batches = [];
    let byteOffset = 0;
    let firstVertex = 0;
    for (const group of this.groups.values()) {
      for (const builder of group.batches) {
        destination.set(
          new Uint8Array(builder.buffer, 0, builder.byteLength),
          byteOffset,
        );
        batches.push(
          Object.freeze({
            id: batches.length,
            kind: builder.owner.kind,
            lodLevel: 1,
            flags: 0,
            blockIndex: builder.owner.blockIndex,
            firstVertex,
            vertexCount: builder.vertexCount,
            origin: Object.freeze([...builder.origin]),
            bounds: Object.freeze({
              min: Object.freeze([...builder.bounds.min]),
              max: Object.freeze([...builder.bounds.max]),
            }),
            maximumPositionError: builder.maximumPositionError,
          }),
        );
        this.maximumPositionError = Math.max(
          this.maximumPositionError,
          builder.maximumPositionError,
        );
        byteOffset += builder.byteLength;
        firstVertex += builder.vertexCount;
        builder.buffer = null;
        builder.view = null;
      }
    }
    return Object.freeze({
      batches: Object.freeze(batches),
      vertices: Object.freeze({
        buffer,
        byteLength: buffer.byteLength,
        vertexCount: this.vertexCount,
      }),
      maximumPositionError: this.maximumPositionError,
    });
  }
}

function gradientRange(rings, angle) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const ring of rings) {
    for (let index = 0; index < ring.coordinates.length; index += 2) {
      const value =
        ring.coordinates[index] * cosine +
        ring.coordinates[index + 1] * sine;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  }
  return { cosine, sine, minimum, maximum };
}

function gradientMix(point, axes, range, gradient) {
  if (!gradient || range.maximum - range.minimum <= Number.EPSILON) {
    return 0;
  }
  const projected =
    point[axes[0]] * range.cosine + point[axes[1]] * range.sine;
  return clamp01(
    (projected - range.minimum) / (range.maximum - range.minimum),
  );
}

export function buildHatchFillMesh(
  source,
  blocks,
  instanceGraph,
  {
    maximumGpuBytes = MAX_HATCH_FILL_GPU_BYTES,
    maximumTrianglesPerEntity = MAX_HATCH_FILL_TRIANGLES_PER_ENTITY,
    maskOrder = null,
  } = {},
) {
  if (!source || typeof source.readEntity !== "function") {
    throw new TypeError("HATCH fill builder requires a HATCH source table");
  }
  if (
    !Number.isSafeInteger(maximumGpuBytes) ||
    maximumGpuBytes < HATCH_FILL_VERTEX_STRIDE * 3
  ) {
    throw new RangeError("HATCH GPU byte limit is too small");
  }
  const blockIndexByHandle = new Map(
    blocks.map((block) => [block.handle, block.index]),
  );
  const mesh = new FillMeshBuilder(maximumGpuBytes);
  const entity = { normal: [0, 0, 1] };
  const loopTarget = {};
  const vertexTarget = [0, 0, 0];
  const colorTarget = {};
  const pointTargets = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const metrics = {
    sourceHatches: source.length,
    solidHatches: 0,
    gradientHatches: 0,
    patternHatches: 0,
    renderedHatches: 0,
    sourceTruncatedHatches: 0,
    truncatedHatches: 0,
    skippedOwners: 0,
    skippedInvalidLoops: 0,
    skippedTriangulations: 0,
    loops: 0,
    triangles: 0,
    vertices: 0,
    gpuBytes: 0,
    batches: 0,
    maximumDeviation: 0,
    maximumPositionError: 0,
    gpuLimitReached: false,
  };

  for (let entityIndex = 0; entityIndex < source.length; entityIndex += 1) {
    source.readEntity(entityIndex, entity);
    if (entity.flags & HatchFlags.Truncated) {
      metrics.sourceTruncatedHatches += 1;
    }
    const isGradient = Boolean(entity.flags & HatchFlags.Gradient);
    const isSolid = Boolean(entity.flags & HatchFlags.Solid);
    if (isGradient) {
      metrics.gradientHatches += 1;
    } else if (isSolid) {
      metrics.solidHatches += 1;
    } else {
      metrics.patternHatches += 1;
      continue;
    }
    const owner = classifyOwner(
      entity,
      blocks,
      instanceGraph,
      blockIndexByHandle,
    );
    if (!owner) {
      metrics.skippedOwners += 1;
      continue;
    }

    const axes = dominantProjection(entity.normal);
    const rings = [];
    const loopCount = Math.min(
      entity.loopCount,
      MAX_HATCH_FILL_LOOPS_PER_ENTITY,
    );
    const loopLimitReached = loopCount < entity.loopCount;
    for (let index = 0; index < loopCount; index += 1) {
      const ring = readRing(
        source,
        entity.firstLoop + index,
        axes,
        loopTarget,
        vertexTarget,
      );
      if (ring) {
        rings.push(ring);
      } else {
        metrics.skippedInvalidLoops += 1;
      }
    }
    if (rings.length === 0) {
      if (loopLimitReached) {
        metrics.truncatedHatches += 1;
      }
      continue;
    }
    classifyRingNesting(rings);
    const groups = fillGroups(rings, entity.style);
    const colors = hatchColors(source, entity, colorTarget);
    const range = gradientRange(rings, entity.gradientAngle);
    const style = encodeMaskBucket(
      entity.commonFlags & 1 ? GPU_STYLE_INVISIBLE : 0,
      maskBucketFor(maskOrder, entity.ownerHandle, entity.handle),
    );
    let entityTriangles = 0;
    let rendered = false;
    let entityTruncated = loopLimitReached;

    for (const group of groups) {
      const flattened = flattenGroup(group);
      const triangleIndices = earcut(
        flattened.coordinates,
        flattened.holes,
        2,
      );
      const measuredDeviation = deviation(
        flattened.coordinates,
        flattened.holes,
        2,
        triangleIndices,
      );
      metrics.maximumDeviation = Math.max(
        metrics.maximumDeviation,
        measuredDeviation,
      );
      if (
        triangleIndices.length === 0 ||
        triangleIndices.length % 3 !== 0 ||
        !Number.isFinite(measuredDeviation) ||
        measuredDeviation > MAX_TRIANGULATION_DEVIATION
      ) {
        metrics.skippedTriangulations += 1;
        continue;
      }
      for (let triangle = 0; triangle < triangleIndices.length; triangle += 3) {
        if (
          entityTriangles >= maximumTrianglesPerEntity ||
          !mesh.canWriteTriangle()
        ) {
          entityTruncated = true;
          metrics.gpuLimitReached ||= !mesh.canWriteTriangle();
          break;
        }
        const mixes = [0, 0, 0];
        for (let corner = 0; corner < 3; corner += 1) {
          const flatIndex = triangleIndices[triangle + corner];
          const sourceIndex = flattened.sourceIndices[flatIndex];
          source.readVertex(sourceIndex, pointTargets[corner]);
          mixes[corner] = gradientMix(
            pointTargets[corner],
            axes,
            range,
            colors.gradient,
          );
        }
        mesh.writeTriangle(owner, pointTargets, {
          layerIndex: entity.layerIndex,
          firstColor: colors.first,
          lastColor: colors.last,
          mixes,
          style,
        });
        entityTriangles += 1;
        metrics.triangles += 1;
        rendered = true;
      }
      if (entityTruncated) {
        break;
      }
    }
    if (rendered) {
      metrics.renderedHatches += 1;
      metrics.loops += rings.length;
    }
    if (entityTruncated) {
      metrics.truncatedHatches += 1;
    }
    if (metrics.gpuLimitReached) {
      break;
    }
  }

  const result = mesh.finish();
  metrics.vertices = result.vertices.vertexCount;
  metrics.gpuBytes = result.vertices.byteLength;
  metrics.batches = result.batches.length;
  metrics.maximumPositionError = result.maximumPositionError;
  return Object.freeze({
    ...result,
    metrics: Object.freeze(metrics),
  });
}

const DWG_RENDER_DELTA_TRANSFORM_BYTES = 272;
const MATRIX_VALUES = 16;
const NORMALIZED_TRANSFORM_RECORDS = new WeakSet();
const NORMALIZED_TRANSFORM_RECORD_BYTES = new WeakMap();

function normalizeHandle(value, label) {
  let handle;
  try {
    handle =
      typeof value === "bigint"
        ? value
        : BigInt(
            typeof value === "string"
              ? `0x${value.replace(/^0x/iu, "")}`
              : value,
          );
  } catch {
    throw new TypeError(`${label} is invalid`);
  }
  if (handle < 0n || handle > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`${label} exceeds u64`);
  }
  return handle;
}

function affineMatrix(view, byteOffset, label) {
  const matrix = new Array(MATRIX_VALUES);
  for (let index = 0; index < MATRIX_VALUES; index += 1) {
    matrix[index] = view.getFloat64(
      byteOffset + index * Float64Array.BYTES_PER_ELEMENT,
      true,
    );
  }
  if (
    !matrix.every(Number.isFinite) ||
    Math.abs(matrix[3]) > 1e-12 ||
    Math.abs(matrix[7]) > 1e-12 ||
    Math.abs(matrix[11]) > 1e-12 ||
    Math.abs(matrix[15] - 1) > 1e-12
  ) {
    throw new TypeError(`${label} must be a finite affine matrix`);
  }
  const determinant =
    matrix[0] *
      (matrix[5] * matrix[10] - matrix[9] * matrix[6]) -
    matrix[4] *
      (matrix[1] * matrix[10] - matrix[9] * matrix[2]) +
    matrix[8] *
      (matrix[1] * matrix[6] - matrix[5] * matrix[2]);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-18) {
    throw new TypeError(`${label} must be invertible`);
  }
  return Object.freeze(matrix);
}

export function decodeDwgRenderDeltaTransform(
  buffer,
  { expectedHandle = null } = {},
) {
  if (
    !(buffer instanceof ArrayBuffer) ||
    buffer.byteLength !== DWG_RENDER_DELTA_TRANSFORM_BYTES
  ) {
    throw new TypeError("DWG render delta transform buffer is invalid");
  }
  const view = new DataView(buffer);
  const blockIndex = view.getUint32(0, true);
  const instanceIndex = view.getUint32(4, true);
  const handleLow = view.getUint32(8, true);
  const handleHigh = view.getUint32(12, true);
  const handle =
    BigInt(handleLow) | (BigInt(handleHigh) << 32n);
  if (
    expectedHandle !== null &&
    handle !==
      normalizeHandle(
        expectedHandle,
        "expected DWG transform handle",
      )
  ) {
    throw new TypeError(
      "DWG render delta transform belongs to another Render ID",
    );
  }
  const record = Object.freeze({
    blockIndex,
    instanceIndex,
    handle,
    handleLow,
    handleHigh,
    matrix: affineMatrix(
      view,
      16,
      "DWG render delta display transform",
    ),
    measurementMatrix: affineMatrix(
      view,
      16 + MATRIX_VALUES * Float64Array.BYTES_PER_ELEMENT,
      "DWG render delta measurement transform",
    ),
  });
  NORMALIZED_TRANSFORM_RECORDS.add(record);
  NORMALIZED_TRANSFORM_RECORD_BYTES.set(
    record,
    buffer.byteLength,
  );
  return record;
}

export function isNormalizedDwgRenderDeltaTransformRecord(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    NORMALIZED_TRANSFORM_RECORDS.has(value)
  );
}

export function dwgRenderDeltaTransformByteLength(value) {
  return NORMALIZED_TRANSFORM_RECORD_BYTES.get(value) ?? null;
}

export function indexDwgRenderDeltaTransforms(
  entries,
  {
    sourceId,
    instanceGraph,
    rejectClipped = true,
    requireComplete = true,
  } = {},
) {
  if (
    !Array.isArray(entries) ||
    typeof sourceId !== "string" ||
    sourceId.length === 0 ||
    !(instanceGraph?.instancesByBlock instanceof Map)
  ) {
    throw new TypeError(
      "DWG render delta transform index input is invalid",
    );
  }
  const selected = [];
  const byInstances = new Map();
  for (const entry of entries) {
    if (entry?.sceneId !== sourceId) {
      continue;
    }
    if (
      entry.resourceKind !== "transform" ||
      !isNormalizedDwgRenderDeltaTransformRecord(entry.record) ||
      entry.byteLength !==
        dwgRenderDeltaTransformByteLength(entry.record)
    ) {
      throw new TypeError(
        "DWG render delta transform entry is invalid",
      );
    }
    const { record } = entry;
    if (
      !(instanceGraph.insertsByOwner instanceof Map) ||
      (instanceGraph.insertsByOwner.get(record.blockIndex)?.length ??
        0) > 0
    ) {
      throw new TypeError(
        "DWG render delta transform requires dependency invalidation",
      );
    }
    const instances = instanceGraph.instancesByBlock.get(
      record.blockIndex,
    );
    if (
      !instances ||
      !Number.isSafeInteger(instances.count) ||
      record.instanceIndex >= instances.count ||
      instances.handles?.[record.instanceIndex] !== record.handle
    ) {
      throw new TypeError(
        "DWG render delta transform target is invalid",
      );
    }
    if (
      rejectClipped &&
      (instances.clipIds?.[record.instanceIndex] ?? 0) !== 0
    ) {
      throw new TypeError(
        "DWG render delta transform cannot move a clipped occurrence",
      );
    }
    let byIndex = byInstances.get(instances);
    if (!byIndex) {
      byIndex = new Map();
      byInstances.set(instances, byIndex);
    }
    if (byIndex.has(record.instanceIndex)) {
      throw new TypeError(
        "DWG render delta transform target is duplicated",
      );
    }
    byIndex.set(record.instanceIndex, record);
    selected.push(entry);
  }
  if (requireComplete) {
    for (const [instances, byIndex] of byInstances) {
      const transformedHandles = new Set(
        [...byIndex.values()].map((record) => record.handle),
      );
      for (
        let instanceIndex = 0;
        instanceIndex < instances.count;
        instanceIndex += 1
      ) {
        if (
          transformedHandles.has(instances.handles[instanceIndex]) &&
          !byIndex.has(instanceIndex)
        ) {
          throw new TypeError(
            "DWG render delta transform occurrence coverage is incomplete",
          );
        }
      }
    }
  }
  return Object.freeze({
    entries: Object.freeze(selected),
    byInstances,
  });
}

export function renderDeltaInstanceMatrix(
  index,
  instances,
  instanceIndex,
  { measurement = false } = {},
) {
  const replacement = renderDeltaInstanceTransform(
    index,
    instances,
    instanceIndex,
  );
  if (replacement) {
    return measurement
      ? replacement.measurementMatrix
      : replacement.matrix;
  }
  const data =
    measurement && instances.measurementData
      ? instances.measurementData
      : instances.data;
  const first = instanceIndex * MATRIX_VALUES;
  return data.subarray(first, first + MATRIX_VALUES);
}

export function renderDeltaInstanceTransform(
  index,
  instances,
  instanceIndex,
) {
  return (
    index?.byInstances?.get(instances)?.get(instanceIndex) ?? null
  );
}

export {
  DWG_RENDER_DELTA_TRANSFORM_BYTES,
  MATRIX_VALUES as DWG_RENDER_DELTA_TRANSFORM_MATRIX_VALUES,
};

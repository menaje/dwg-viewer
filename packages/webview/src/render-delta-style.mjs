const DWG_RENDER_DELTA_STYLE_BYTES = 40;

const DwgRenderDeltaStyleFlag = Object.freeze({
  COLOR: 1 << 0,
  LAYER: 1 << 1,
  OPACITY: 1 << 2,
  LINE_WEIGHT: 1 << 3,
  LINETYPE: 1 << 4,
  VISIBILITY: 1 << 5,
});
const ALL_STYLE_FLAGS = Object.values(
  DwgRenderDeltaStyleFlag,
).reduce((combined, flag) => combined | flag, 0);
const NO_LAYER = 0xffff_ffff;
const NORMALIZED_STYLE_RECORDS = new WeakSet();
const NORMALIZED_STYLE_RECORD_BYTES = new WeakMap();

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

function active(flags, flag) {
  return (flags & flag) !== 0;
}

export function decodeDwgRenderDeltaStyle(
  buffer,
  { expectedHandle = null } = {},
) {
  if (
    !(buffer instanceof ArrayBuffer) ||
    buffer.byteLength !== DWG_RENDER_DELTA_STYLE_BYTES
  ) {
    throw new TypeError("DWG render delta style buffer is invalid");
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
      normalizeHandle(expectedHandle, "expected DWG style handle")
  ) {
    throw new TypeError(
      "DWG render delta style belongs to another Render ID",
    );
  }
  const flags = view.getUint32(16, true);
  const color = view.getUint32(20, true);
  const layerIndex = view.getUint32(24, true);
  const opacity = view.getFloat32(28, true);
  const lineWeight = view.getInt16(32, true);
  const linetypeCode = view.getUint16(34, true);
  const visible = view.getUint8(36);
  if (
    flags === 0 ||
    (flags & ~ALL_STYLE_FLAGS) !== 0 ||
    (!active(flags, DwgRenderDeltaStyleFlag.COLOR) && color !== 0) ||
    (!active(flags, DwgRenderDeltaStyleFlag.LAYER) &&
      layerIndex !== 0) ||
    (!active(flags, DwgRenderDeltaStyleFlag.OPACITY) &&
      view.getUint32(28, true) !== 0) ||
    (!active(flags, DwgRenderDeltaStyleFlag.LINE_WEIGHT) &&
      lineWeight !== 0) ||
    (!active(flags, DwgRenderDeltaStyleFlag.LINETYPE) &&
      linetypeCode !== 0) ||
    (!active(flags, DwgRenderDeltaStyleFlag.VISIBILITY) &&
      visible !== 0) ||
    view.getUint8(37) !== 0 ||
    view.getUint8(38) !== 0 ||
    view.getUint8(39) !== 0
  ) {
    throw new TypeError(
      "DWG render delta style flags or reserved fields are invalid",
    );
  }
  if (
    (active(flags, DwgRenderDeltaStyleFlag.COLOR) &&
      (color >>> 30) < 2) ||
    (active(flags, DwgRenderDeltaStyleFlag.OPACITY) &&
      (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)) ||
    (active(flags, DwgRenderDeltaStyleFlag.LINE_WEIGHT) &&
      (lineWeight < -3 ||
        lineWeight > 211 ||
        lineWeight === -2 ||
        lineWeight === -1)) ||
    (active(flags, DwgRenderDeltaStyleFlag.LINETYPE) &&
      (linetypeCode < 2 || linetypeCode > 2047)) ||
    (active(flags, DwgRenderDeltaStyleFlag.VISIBILITY) &&
      visible > 1)
  ) {
    throw new RangeError(
      "DWG render delta style value is outside its supported range",
    );
  }
  const record = Object.freeze({
    blockIndex,
    instanceIndex,
    handle,
    handleLow,
    handleHigh,
    color: active(flags, DwgRenderDeltaStyleFlag.COLOR)
      ? color
      : null,
    layerIndex: active(flags, DwgRenderDeltaStyleFlag.LAYER)
      ? layerIndex
      : null,
    opacity: active(flags, DwgRenderDeltaStyleFlag.OPACITY)
      ? opacity
      : null,
    lineWeight: active(
      flags,
      DwgRenderDeltaStyleFlag.LINE_WEIGHT,
    )
      ? lineWeight
      : null,
    linetypeCode: active(flags, DwgRenderDeltaStyleFlag.LINETYPE)
      ? linetypeCode
      : null,
    visible: active(flags, DwgRenderDeltaStyleFlag.VISIBILITY)
      ? visible === 1
      : null,
  });
  NORMALIZED_STYLE_RECORDS.add(record);
  NORMALIZED_STYLE_RECORD_BYTES.set(record, buffer.byteLength);
  return record;
}

export function isNormalizedDwgRenderDeltaStyleRecord(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    NORMALIZED_STYLE_RECORDS.has(value)
  );
}

export function dwgRenderDeltaStyleByteLength(value) {
  return NORMALIZED_STYLE_RECORD_BYTES.get(value) ?? null;
}

export function indexDwgRenderDeltaStyles(
  entries,
  {
    sourceId,
    instanceGraph,
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
      "DWG render delta style index input is invalid",
    );
  }
  const selected = [];
  const byInstances = new Map();
  const hiddenInstances = new Set();
  for (const entry of entries) {
    if (entry?.sceneId !== sourceId) {
      continue;
    }
    if (
      entry.resourceKind !== "style" ||
      !isNormalizedDwgRenderDeltaStyleRecord(entry.record) ||
      entry.byteLength !== dwgRenderDeltaStyleByteLength(entry.record)
    ) {
      throw new TypeError("DWG render delta style entry is invalid");
    }
    const { record } = entry;
    if (
      !(instanceGraph.insertsByOwner instanceof Map) ||
      (instanceGraph.insertsByOwner.get(record.blockIndex)?.length ??
        0) > 0
    ) {
      throw new TypeError(
        "DWG render delta style requires dependency invalidation",
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
      throw new TypeError("DWG render delta style target is invalid");
    }
    let byIndex = byInstances.get(instances);
    if (!byIndex) {
      byIndex = new Map();
      byInstances.set(instances, byIndex);
    }
    if (byIndex.has(record.instanceIndex)) {
      throw new TypeError(
        "DWG render delta style target is duplicated",
      );
    }
    byIndex.set(record.instanceIndex, record);
    if (record.visible === false) {
      hiddenInstances.add(instances);
    }
    selected.push(entry);
  }
  if (requireComplete) {
    for (const [instances, byIndex] of byInstances) {
      const styledHandles = new Set(
        [...byIndex.values()].map((record) => record.handle),
      );
      for (
        let instanceIndex = 0;
        instanceIndex < instances.count;
        instanceIndex += 1
      ) {
        if (
          styledHandles.has(instances.handles[instanceIndex]) &&
          !byIndex.has(instanceIndex)
        ) {
          throw new TypeError(
            "DWG render delta style occurrence coverage is incomplete",
          );
        }
      }
    }
  }
  return Object.freeze({
    entries: Object.freeze(selected),
    byInstances,
    hiddenInstances,
  });
}

export function renderDeltaInstanceStyle(
  index,
  instances,
  instanceIndex,
) {
  return (
    index?.byInstances?.get(instances)?.get(instanceIndex) ?? null
  );
}

export {
  DwgRenderDeltaStyleFlag,
  DWG_RENDER_DELTA_STYLE_BYTES,
  NO_LAYER as DWG_RENDER_DELTA_NO_LAYER,
};

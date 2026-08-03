const MAX_DWG_RENDER_DELTA_TEXT_BYTES = 256 * 1024;
const MAX_DWG_RENDER_DELTA_TEXT_CODE_POINTS = 4_096;
const MAX_DWG_RENDER_DELTA_TEXT_COLUMNS = 64;
const NORMALIZED_TEXT_RECORDS = new WeakSet();
const NORMALIZED_TEXT_RECORD_BYTES = new WeakMap();

const RECORD_KEYS = Object.freeze([
  "handle",
  "ownerHandle",
  "layerIndex",
  "color",
  "lineWeight",
  "commonFlags",
  "linetypeCode",
  "kind",
  "flags",
  "style",
  "value",
  "tag",
  "prompt",
  "linkedHandle",
  "insertionPoint",
  "alignmentPoint",
  "normal",
  "xAxisDirection",
  "height",
  "widthFactor",
  "rotation",
  "obliqueAngle",
  "thickness",
  "rectangleWidth",
  "rectangleHeight",
  "extentsWidth",
  "extentsHeight",
  "lineSpacingFactor",
  "backgroundScale",
  "backgroundColor",
  "backgroundTransparency",
  "backgroundFlags",
  "sourceFlags",
  "horizontalAlignment",
  "verticalAlignment",
  "attachment",
  "flowDirection",
  "lineSpacingStyle",
  "generationFlags",
  "fieldLength",
  "mtextType",
  "lineCount",
  "columnType",
  "columnCount",
  "columnFlags",
  "columnWidth",
  "columnGutter",
  "columnHeights",
]);

const STYLE_KEYS = Object.freeze([
  "handle",
  "name",
  "fontFile",
  "bigFontFile",
  "trueTypeFont",
  "flags",
  "height",
  "widthFactor",
  "obliqueAngle",
  "lastHeight",
]);

function plainRecord(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    keys.length !== wanted.length ||
    keys.some((key, index) => key !== wanted[index])
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
}

function normalizeHandle(value, label) {
  let handle;
  try {
    handle =
      typeof value === "bigint"
        ? value
        : BigInt(`0x${String(value).replace(/^0x/iu, "")}`);
  } catch {
    throw new TypeError(`${label} is invalid`);
  }
  if (handle < 0n || handle > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`${label} exceeds u64`);
  }
  return handle;
}

function integer(value, minimum, maximum, label) {
  if (
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function finite(value, label) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function vector3(value, label) {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every(Number.isFinite)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return Object.freeze([...value]);
}

function boundedString(value, maximumCodePoints, label) {
  if (
    typeof value !== "string" ||
    [...value].length > maximumCodePoints
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function normalizeStyle(value) {
  if (value === null) {
    return null;
  }
  const style = plainRecord(value, "DWG render delta text style");
  exactKeys(style, STYLE_KEYS, "DWG render delta text style");
  return Object.freeze({
    handle: normalizeHandle(
      style.handle,
      "DWG render delta text style handle",
    ),
    name: boundedString(
      style.name,
      1_024,
      "DWG render delta text style name",
    ),
    fontFile: boundedString(
      style.fontFile,
      1_024,
      "DWG render delta text font",
    ),
    bigFontFile: boundedString(
      style.bigFontFile,
      1_024,
      "DWG render delta text BigFont",
    ),
    trueTypeFont: boundedString(
      style.trueTypeFont,
      1_024,
      "DWG render delta text TrueType font",
    ),
    flags: integer(
      style.flags,
      0,
      0xffff_ffff,
      "DWG render delta text style flags",
    ),
    height: finite(
      style.height,
      "DWG render delta text style height",
    ),
    widthFactor: finite(
      style.widthFactor,
      "DWG render delta text style width",
    ),
    obliqueAngle: finite(
      style.obliqueAngle,
      "DWG render delta text style oblique angle",
    ),
    lastHeight: finite(
      style.lastHeight,
      "DWG render delta text style last height",
    ),
  });
}

export function normalizeDwgRenderDeltaTextRecord(
  value,
  {
    expectedHandle = null,
    encodedByteLength = null,
  } = {},
) {
  if (
    encodedByteLength !== null &&
    (!Number.isSafeInteger(encodedByteLength) ||
      encodedByteLength <= 0 ||
      encodedByteLength > MAX_DWG_RENDER_DELTA_TEXT_BYTES)
  ) {
    throw new TypeError(
      "DWG render delta text encoded byte length is invalid",
    );
  }
  const record = plainRecord(value, "DWG render delta text record");
  exactKeys(record, RECORD_KEYS, "DWG render delta text record");
  const handle = normalizeHandle(
    record.handle,
    "DWG render delta text handle",
  );
  if (
    expectedHandle !== null &&
    handle !== normalizeHandle(expectedHandle, "expected DWG text handle")
  ) {
    throw new TypeError(
      "DWG render delta text belongs to another Render ID",
    );
  }
  const normal = vector3(
    record.normal,
    "DWG render delta text normal",
  );
  if (Math.hypot(...normal) < 1e-12) {
    throw new TypeError("DWG render delta text normal is invalid");
  }
  if (
    !Array.isArray(record.columnHeights) ||
    record.columnHeights.length > MAX_DWG_RENDER_DELTA_TEXT_COLUMNS ||
    !record.columnHeights.every(
      (height) => Number.isFinite(height) && height >= 0,
    )
  ) {
    throw new TypeError(
      "DWG render delta text column heights are invalid",
    );
  }
  const valueText = boundedString(
    record.value,
    MAX_DWG_RENDER_DELTA_TEXT_CODE_POINTS,
    "DWG render delta text value",
  );
  const style = normalizeStyle(record.style);
  const columnHeights = Object.freeze([...record.columnHeights]);
  const normalized = Object.freeze({
    index: -1,
    handle,
    ownerHandle: normalizeHandle(
      record.ownerHandle,
      "DWG render delta text owner handle",
    ),
    layerIndex: integer(
      record.layerIndex,
      0,
      0xffff_ffff,
      "DWG render delta text layer",
    ),
    color: integer(
      record.color,
      0,
      0xffff_ffff,
      "DWG render delta text color",
    ),
    lineWeight: integer(
      record.lineWeight,
      -0x8000,
      0x7fff,
      "DWG render delta text line weight",
    ),
    commonFlags: integer(
      record.commonFlags,
      0,
      0xffff,
      "DWG render delta text common flags",
    ),
    linetypeCode: integer(
      record.linetypeCode,
      0,
      0xffff_ffff,
      "DWG render delta text linetype",
    ),
    kind: integer(
      record.kind,
      0,
      3,
      "DWG render delta text kind",
    ),
    flags: integer(
      record.flags,
      0,
      0xffff,
      "DWG render delta text flags",
    ),
    styleIndex: null,
    style,
    value: valueText,
    valueByteLength: new TextEncoder().encode(valueText).byteLength,
    tag: boundedString(
      record.tag,
      4_096,
      "DWG render delta text tag",
    ),
    prompt: boundedString(
      record.prompt,
      4_096,
      "DWG render delta text prompt",
    ),
    linkedHandle: normalizeHandle(
      record.linkedHandle,
      "DWG render delta text linked handle",
    ),
    insertionPoint: vector3(
      record.insertionPoint,
      "DWG render delta text insertion point",
    ),
    alignmentPoint: vector3(
      record.alignmentPoint,
      "DWG render delta text alignment point",
    ),
    normal,
    xAxisDirection: vector3(
      record.xAxisDirection,
      "DWG render delta text X axis",
    ),
    height: finite(record.height, "DWG render delta text height"),
    widthFactor: finite(
      record.widthFactor,
      "DWG render delta text width factor",
    ),
    rotation: finite(
      record.rotation,
      "DWG render delta text rotation",
    ),
    obliqueAngle: finite(
      record.obliqueAngle,
      "DWG render delta text oblique angle",
    ),
    thickness: finite(
      record.thickness,
      "DWG render delta text thickness",
    ),
    rectangleWidth: finite(
      record.rectangleWidth,
      "DWG render delta text rectangle width",
    ),
    rectangleHeight: finite(
      record.rectangleHeight,
      "DWG render delta text rectangle height",
    ),
    extentsWidth: finite(
      record.extentsWidth,
      "DWG render delta text extents width",
    ),
    extentsHeight: finite(
      record.extentsHeight,
      "DWG render delta text extents height",
    ),
    lineSpacingFactor: finite(
      record.lineSpacingFactor,
      "DWG render delta text line spacing",
    ),
    backgroundScale: finite(
      record.backgroundScale,
      "DWG render delta text background scale",
    ),
    backgroundColor: integer(
      record.backgroundColor,
      0,
      0xffff_ffff,
      "DWG render delta text background color",
    ),
    backgroundTransparency: integer(
      record.backgroundTransparency,
      -0x8000_0000,
      0x7fff_ffff,
      "DWG render delta text background transparency",
    ),
    backgroundFlags: integer(
      record.backgroundFlags,
      -0x8000_0000,
      0x7fff_ffff,
      "DWG render delta text background flags",
    ),
    sourceFlags: integer(
      record.sourceFlags,
      -0x8000_0000,
      0x7fff_ffff,
      "DWG render delta text source flags",
    ),
    horizontalAlignment: integer(
      record.horizontalAlignment,
      -0x8000,
      0x7fff,
      "DWG render delta text horizontal alignment",
    ),
    verticalAlignment: integer(
      record.verticalAlignment,
      -0x8000,
      0x7fff,
      "DWG render delta text vertical alignment",
    ),
    attachment: integer(
      record.attachment,
      -0x8000,
      0x7fff,
      "DWG render delta text attachment",
    ),
    flowDirection: integer(
      record.flowDirection,
      -0x8000,
      0x7fff,
      "DWG render delta text flow direction",
    ),
    lineSpacingStyle: integer(
      record.lineSpacingStyle,
      -0x8000,
      0x7fff,
      "DWG render delta text line spacing style",
    ),
    generationFlags: integer(
      record.generationFlags,
      -0x8000,
      0x7fff,
      "DWG render delta text generation flags",
    ),
    fieldLength: integer(
      record.fieldLength,
      -0x8000,
      0x7fff,
      "DWG render delta text field length",
    ),
    mtextType: integer(
      record.mtextType,
      -0x8000,
      0x7fff,
      "DWG render delta text MText type",
    ),
    lineCount: integer(
      record.lineCount,
      -0x8000_0000,
      0x7fff_ffff,
      "DWG render delta text line count",
    ),
    columnType: integer(
      record.columnType,
      -0x8000_0000,
      0x7fff_ffff,
      "DWG render delta text column type",
    ),
    columnCount: integer(
      record.columnCount,
      0,
      MAX_DWG_RENDER_DELTA_TEXT_COLUMNS,
      "DWG render delta text column count",
    ),
    columnFlags: integer(
      record.columnFlags,
      0,
      0xffff_ffff,
      "DWG render delta text column flags",
    ),
    columnWidth: finite(
      record.columnWidth,
      "DWG render delta text column width",
    ),
    columnGutter: finite(
      record.columnGutter,
      "DWG render delta text column gutter",
    ),
    columnHeights,
    firstColumnHeight: 0,
    columnHeightCount: columnHeights.length,
    columnHeightPool: columnHeights,
  });
  NORMALIZED_TEXT_RECORDS.add(normalized);
  if (encodedByteLength !== null) {
    NORMALIZED_TEXT_RECORD_BYTES.set(
      normalized,
      encodedByteLength,
    );
  }
  return normalized;
}

export function decodeDwgRenderDeltaText(
  buffer,
  { expectedHandle = null } = {},
) {
  if (
    !(buffer instanceof ArrayBuffer) ||
    buffer.byteLength === 0 ||
    buffer.byteLength > MAX_DWG_RENDER_DELTA_TEXT_BYTES
  ) {
    throw new TypeError("DWG render delta text buffer is invalid");
  }
  let value;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(buffer),
    );
    value = JSON.parse(source);
  } catch {
    throw new TypeError("DWG render delta text JSON is invalid");
  }
  return normalizeDwgRenderDeltaTextRecord(value, {
    expectedHandle,
    encodedByteLength: buffer.byteLength,
  });
}

export function isNormalizedDwgRenderDeltaTextRecord(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    NORMALIZED_TEXT_RECORDS.has(value)
  );
}

export function dwgRenderDeltaTextByteLength(value) {
  return NORMALIZED_TEXT_RECORD_BYTES.get(value) ?? null;
}

export {
  MAX_DWG_RENDER_DELTA_TEXT_BYTES,
  MAX_DWG_RENDER_DELTA_TEXT_CODE_POINTS,
  MAX_DWG_RENDER_DELTA_TEXT_COLUMNS,
};

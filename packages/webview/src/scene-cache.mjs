export const CACHE_MAGIC = new Uint8Array([68, 87, 71, 83, 67, 78, 49, 0]);
export const CACHE_VERSION_MAJOR = 1;
export const MAX_CACHE_VERSION_MINOR = 6;
export const HEADER_SIZE = 64;
export const DIRECTORY_ENTRY_SIZE = 40;
export const GPU_LINE_BATCH_RECORD_SIZE = 128;
export const GPU_LINE_VERTEX_RECORD_SIZE = 32;
export const TEXT_STYLE_RECORD_SIZE = 96;
export const TEXT_ENTITY_RECORD_SIZE = 336;
export const TEXT_COLUMN_HEIGHT_RECORD_SIZE = 8;
export const HATCH_ENTITY_RECORD_SIZE = 192;
export const HATCH_LOOP_RECORD_SIZE = 48;
export const HATCH_VERTEX_RECORD_SIZE = 24;
export const HATCH_GRADIENT_COLOR_RECORD_SIZE = 16;
export const HATCH_SEED_POINT_RECORD_SIZE = 16;

export const SectionKind = Object.freeze({
  Drawing: 1,
  Layers: 2,
  Blocks: 3,
  TextStyles: 4,
  Lines: 10,
  Arcs: 11,
  Circles: 12,
  Inserts: 13,
  PolylineHeaders: 14,
  PolylineVertices: 15,
  Ellipses: 16,
  SplineHeaders: 17,
  SplineKnots: 18,
  SplineWeights: 19,
  SplineControlPoints: 20,
  SplineFitPoints: 21,
  TextEntities: 22,
  TextColumnHeights: 23,
  GpuLineBatches: 30,
  GpuLineVertices: 31,
  HatchEntities: 32,
  HatchLoops: 33,
  HatchVertices: 34,
  HatchGradientColors: 35,
  HatchSeedPoints: 36,
});

export const GpuLineBatchKind = Object.freeze({
  ModelOverview: 0,
  ModelDetail: 1,
  BlockDefinition: 2,
});

const FIXED_RECORD_SIZES = new Map([
  [SectionKind.Drawing, 80],
  [SectionKind.Inserts, 136],
  [SectionKind.TextColumnHeights, TEXT_COLUMN_HEIGHT_RECORD_SIZE],
  [SectionKind.GpuLineBatches, GPU_LINE_BATCH_RECORD_SIZE],
  [SectionKind.GpuLineVertices, GPU_LINE_VERTEX_RECORD_SIZE],
  [SectionKind.HatchLoops, HATCH_LOOP_RECORD_SIZE],
  [SectionKind.HatchVertices, HATCH_VERTEX_RECORD_SIZE],
  [SectionKind.HatchGradientColors, HATCH_GRADIENT_COLOR_RECORD_SIZE],
  [SectionKind.HatchSeedPoints, HATCH_SEED_POINT_RECORD_SIZE],
]);
const MAX_METADATA_SECTION_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_STRING_BYTES = 1024 * 1024;
const MAX_OVERVIEW_BYTES = 8 * 1024 * 1024;
const MAX_DETAIL_BATCH_BYTES = 512 * 1024;
const MAX_HATCH_SOURCE_RECORDS = 1_048_576;
const STRING_TABLE_HEADER_SIZE = 16;
const STRING_TABLE_FLAG = 1;

export const TextEntityKind = Object.freeze({
  Text: 0,
  MText: 1,
  AttributeDefinition: 2,
  Attribute: 3,
});

export const HatchFlags = Object.freeze({
  Solid: 1,
  Associative: 1 << 1,
  Double: 1 << 2,
  Gradient: 1 << 3,
  SingleColorGradient: 1 << 4,
  Truncated: 1 << 5,
});

export const HatchStyle = Object.freeze({
  Normal: 0,
  Outer: 1,
  Ignore: 2,
});

function requireArrayBuffer(buffer, expectedLength, label) {
  if (!(buffer instanceof ArrayBuffer)) {
    throw new TypeError(`${label} reader did not return an ArrayBuffer`);
  }
  if (buffer.byteLength !== expectedLength) {
    throw new Error(
      `${label} is truncated: expected ${expectedLength} bytes, received ${buffer.byteLength}`,
    );
  }
  return buffer;
}

function readSafeU64(view, offset, label) {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} exceeds JavaScript's safe integer limit`);
  }
  return Number(value);
}

function checkedMultiply(left, right, label) {
  const value = left * right;
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} exceeds JavaScript's safe integer limit`);
  }
  return value;
}

function checkedAdd(left, right, label) {
  const value = left + right;
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} exceeds JavaScript's safe integer limit`);
  }
  return value;
}

function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function readVec3F64(view, offset) {
  return [
    view.getFloat64(offset, true),
    view.getFloat64(offset + 8, true),
    view.getFloat64(offset + 16, true),
  ];
}

function ensureFiniteVector(vector, label) {
  if (!vector.every(Number.isFinite)) {
    throw new Error(`${label} contains a non-finite coordinate`);
  }
  return vector;
}

function validateRecordSection(entry, expectedRecordSize) {
  if (entry.recordSize !== expectedRecordSize) {
    throw new Error(
      `section ${entry.kind} record size is ${entry.recordSize}, expected ${expectedRecordSize}`,
    );
  }
  const expectedBytes = checkedMultiply(
    entry.recordCount,
    entry.recordSize,
    `section ${entry.kind} byte length`,
  );
  if (entry.byteLength !== expectedBytes) {
    throw new Error(`section ${entry.kind} byte length does not match its records`);
  }
  if (entry.flags !== 0) {
    throw new Error(`section ${entry.kind} has unsupported flags`);
  }
}

function validateStringTableDirectoryEntry(entry, expectedRecordSize) {
  if (
    entry.recordSize !== expectedRecordSize ||
    entry.flags !== STRING_TABLE_FLAG ||
    entry.byteLength < STRING_TABLE_HEADER_SIZE
  ) {
    throw new Error(`section ${entry.kind} has invalid string-table metadata`);
  }
  const minimumBytes = checkedAdd(
    STRING_TABLE_HEADER_SIZE,
    checkedMultiply(
      entry.recordCount,
      entry.recordSize,
      `section ${entry.kind} record bytes`,
    ),
    `section ${entry.kind} minimum bytes`,
  );
  if (entry.byteLength < minimumBytes) {
    throw new Error(`section ${entry.kind} is shorter than its records`);
  }
}

export class TextEntityTable {
  constructor(buffer, stringOffset, recordCount, styles, columnHeights) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.stringOffset = stringOffset;
    this.recordCount = recordCount;
    this.styles = styles;
    this.columnHeights = columnHeights;
    this.decoder = new TextDecoder("utf-8", { fatal: true });
  }

  get length() {
    return this.recordCount;
  }

  #recordOffset(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.recordCount) {
      throw new RangeError(`text entity index is out of range: ${index}`);
    }
    return STRING_TABLE_HEADER_SIZE + index * TEXT_ENTITY_RECORD_SIZE;
  }

  readValue(index) {
    return this.#readString(this.#recordOffset(index) + 40);
  }

  readDisplayRecord(index, target) {
    if (!target || typeof target !== "object") {
      throw new TypeError("text display record target must be an object");
    }
    const offset = this.#recordOffset(index);
    const styleIndex = this.view.getUint32(offset + 36, true);
    target.index = index;
    target.ownerHandle = this.view.getBigUint64(offset + 8, true);
    target.layerIndex = this.view.getUint32(offset + 16, true);
    target.color = this.view.getUint32(offset + 20, true);
    target.commonFlags = this.view.getUint16(offset + 26, true);
    target.kind = this.view.getUint16(offset + 32, true);
    target.styleIndex = styleIndex === 0xffffffff ? null : styleIndex;
    target.style =
      styleIndex === 0xffffffff ? null : this.styles[styleIndex];
    target.valueByteLength = this.view.getUint32(offset + 44, true);
    target.insertionPoint ??= [0, 0, 0];
    target.normal ??= [0, 0, 1];
    for (let axis = 0; axis < 3; axis += 1) {
      target.insertionPoint[axis] = this.view.getFloat64(
        offset + 72 + axis * 8,
        true,
      );
      target.normal[axis] = this.view.getFloat64(
        offset + 120 + axis * 8,
        true,
      );
    }
    target.height = this.view.getFloat64(offset + 168, true);
    target.widthFactor = this.view.getFloat64(offset + 176, true);
    target.rotation = this.view.getFloat64(offset + 184, true);
    target.obliqueAngle = this.view.getFloat64(offset + 192, true);
    target.lineSpacingFactor = this.view.getFloat64(offset + 240, true);
    target.sourceFlags = this.view.getInt32(offset + 268, true);
    target.horizontalAlignment = this.view.getInt16(offset + 272, true);
    target.attachment = this.view.getInt16(offset + 276, true);
    target.mtextType = this.view.getInt16(offset + 286, true);
    return target;
  }

  get(index) {
    const offset = this.#recordOffset(index);
    const styleIndex = this.view.getUint32(offset + 36, true);
    const firstColumnHeight = readSafeU64(
      this.view,
      offset + 320,
      "text column-height offset",
    );
    const columnHeightCount = readSafeU64(
      this.view,
      offset + 328,
      "text column-height count",
    );
    return Object.freeze({
      index,
      handle: this.view.getBigUint64(offset, true),
      ownerHandle: this.view.getBigUint64(offset + 8, true),
      layerIndex: this.view.getUint32(offset + 16, true),
      color: this.view.getUint32(offset + 20, true),
      lineWeight: this.view.getInt16(offset + 24, true),
      commonFlags: this.view.getUint16(offset + 26, true),
      kind: this.view.getUint16(offset + 32, true),
      flags: this.view.getUint16(offset + 34, true),
      styleIndex: styleIndex === 0xffffffff ? null : styleIndex,
      style: styleIndex === 0xffffffff ? null : this.styles[styleIndex],
      value: this.#readString(offset + 40),
      tag: this.#readString(offset + 48),
      prompt: this.#readString(offset + 56),
      linkedHandle: this.view.getBigUint64(offset + 64, true),
      insertionPoint: readVec3F64(this.view, offset + 72),
      alignmentPoint: readVec3F64(this.view, offset + 96),
      normal: readVec3F64(this.view, offset + 120),
      xAxisDirection: readVec3F64(this.view, offset + 144),
      height: this.view.getFloat64(offset + 168, true),
      widthFactor: this.view.getFloat64(offset + 176, true),
      rotation: this.view.getFloat64(offset + 184, true),
      obliqueAngle: this.view.getFloat64(offset + 192, true),
      thickness: this.view.getFloat64(offset + 200, true),
      rectangleWidth: this.view.getFloat64(offset + 208, true),
      rectangleHeight: this.view.getFloat64(offset + 216, true),
      extentsWidth: this.view.getFloat64(offset + 224, true),
      extentsHeight: this.view.getFloat64(offset + 232, true),
      lineSpacingFactor: this.view.getFloat64(offset + 240, true),
      backgroundScale: this.view.getFloat64(offset + 248, true),
      backgroundColor: this.view.getUint32(offset + 256, true),
      backgroundTransparency: this.view.getInt32(offset + 260, true),
      backgroundFlags: this.view.getInt32(offset + 264, true),
      sourceFlags: this.view.getInt32(offset + 268, true),
      horizontalAlignment: this.view.getInt16(offset + 272, true),
      verticalAlignment: this.view.getInt16(offset + 274, true),
      attachment: this.view.getInt16(offset + 276, true),
      flowDirection: this.view.getInt16(offset + 278, true),
      lineSpacingStyle: this.view.getInt16(offset + 280, true),
      generationFlags: this.view.getInt16(offset + 282, true),
      fieldLength: this.view.getInt16(offset + 284, true),
      mtextType: this.view.getInt16(offset + 286, true),
      lineCount: this.view.getInt32(offset + 288, true),
      columnType: this.view.getInt32(offset + 292, true),
      columnCount: this.view.getInt32(offset + 296, true),
      columnFlags: this.view.getUint32(offset + 300, true),
      columnWidth: this.view.getFloat64(offset + 304, true),
      columnGutter: this.view.getFloat64(offset + 312, true),
      columnHeights: this.columnHeights.subarray(
        firstColumnHeight,
        firstColumnHeight + columnHeightCount,
      ),
    });
  }

  #readString(referenceOffset) {
    const relativeOffset = this.view.getUint32(referenceOffset, true);
    const byteLength = this.view.getUint32(referenceOffset + 4, true);
    return this.decoder.decode(
      new Uint8Array(
        this.buffer,
        this.stringOffset + relativeOffset,
        byteLength,
      ),
    );
  }
}

export class HatchSourceTable {
  constructor({
    entityBuffer,
    stringOffset,
    entityCount,
    loopBuffer,
    loopCount,
    vertexBuffer,
    vertexCount,
    gradientColorBuffer,
    gradientColorCount,
    seedPointBuffer,
    seedPointCount,
  }) {
    this.entityBuffer = entityBuffer;
    this.entityView = new DataView(entityBuffer);
    this.stringOffset = stringOffset;
    this.entityCount = entityCount;
    this.loopBuffer = loopBuffer;
    this.loopView = new DataView(loopBuffer);
    this.loopCount = loopCount;
    this.vertexBuffer = vertexBuffer;
    this.vertexView = new DataView(vertexBuffer);
    this.vertexCount = vertexCount;
    this.gradientColorBuffer = gradientColorBuffer;
    this.gradientColorView = new DataView(gradientColorBuffer);
    this.gradientColorCount = gradientColorCount;
    this.seedPointBuffer = seedPointBuffer;
    this.seedPointView = new DataView(seedPointBuffer);
    this.seedPointCount = seedPointCount;
    this.decoder = new TextDecoder("utf-8", { fatal: true });
  }

  get length() {
    return this.entityCount;
  }

  #entityOffset(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.entityCount) {
      throw new RangeError(`HATCH entity index is out of range: ${index}`);
    }
    return STRING_TABLE_HEADER_SIZE + index * HATCH_ENTITY_RECORD_SIZE;
  }

  readEntity(index, target) {
    if (!target || typeof target !== "object") {
      throw new TypeError("HATCH entity target must be an object");
    }
    const offset = this.#entityOffset(index);
    target.index = index;
    target.handle = this.entityView.getBigUint64(offset, true);
    target.ownerHandle = this.entityView.getBigUint64(offset + 8, true);
    target.layerIndex = this.entityView.getUint32(offset + 16, true);
    target.color = this.entityView.getUint32(offset + 20, true);
    target.lineWeight = this.entityView.getInt16(offset + 24, true);
    target.commonFlags = this.entityView.getUint16(offset + 26, true);
    target.flags = this.entityView.getUint32(offset + 48, true);
    target.style = this.entityView.getUint16(offset + 52, true);
    target.patternType = this.entityView.getUint16(offset + 54, true);
    target.firstLoop = readSafeU64(
      this.entityView,
      offset + 56,
      "HATCH loop offset",
    );
    target.loopCount = readSafeU64(
      this.entityView,
      offset + 64,
      "HATCH loop count",
    );
    target.firstGradientColor = readSafeU64(
      this.entityView,
      offset + 72,
      "HATCH gradient-color offset",
    );
    target.gradientColorCount = readSafeU64(
      this.entityView,
      offset + 80,
      "HATCH gradient-color count",
    );
    target.elevation = this.entityView.getFloat64(offset + 88, true);
    target.normal ??= [0, 0, 1];
    for (let axis = 0; axis < 3; axis += 1) {
      target.normal[axis] = this.entityView.getFloat64(
        offset + 96 + axis * 8,
        true,
      );
    }
    target.patternAngle = this.entityView.getFloat64(offset + 120, true);
    target.patternScale = this.entityView.getFloat64(offset + 128, true);
    target.pixelSize = this.entityView.getFloat64(offset + 136, true);
    target.gradientAngle = this.entityView.getFloat64(offset + 144, true);
    target.gradientShift = this.entityView.getFloat64(offset + 152, true);
    target.gradientTint = this.entityView.getFloat64(offset + 160, true);
    target.firstSeedPoint = readSafeU64(
      this.entityView,
      offset + 168,
      "HATCH seed-point offset",
    );
    target.seedPointCount = readSafeU64(
      this.entityView,
      offset + 176,
      "HATCH seed-point count",
    );
    target.gradientReserved = this.entityView.getInt32(offset + 184, true);
    target.definitionLineCount = this.entityView.getUint32(
      offset + 188,
      true,
    );
    return target;
  }

  readPatternName(index) {
    return this.#readString(this.#entityOffset(index) + 32);
  }

  readGradientName(index) {
    return this.#readString(this.#entityOffset(index) + 40);
  }

  readLoop(index, target) {
    if (!Number.isInteger(index) || index < 0 || index >= this.loopCount) {
      throw new RangeError(`HATCH loop index is out of range: ${index}`);
    }
    if (!target || typeof target !== "object") {
      throw new TypeError("HATCH loop target must be an object");
    }
    const offset = index * HATCH_LOOP_RECORD_SIZE;
    target.index = index;
    target.hatchIndex = readSafeU64(
      this.loopView,
      offset,
      "HATCH loop source index",
    );
    target.pathFlags = this.loopView.getUint32(offset + 8, true);
    target.sourcePathIndex = this.loopView.getUint32(offset + 12, true);
    target.firstVertex = readSafeU64(
      this.loopView,
      offset + 16,
      "HATCH vertex offset",
    );
    target.vertexCount = readSafeU64(
      this.loopView,
      offset + 24,
      "HATCH vertex count",
    );
    target.sourceEdgeCount = this.loopView.getUint32(offset + 32, true);
    target.flags = this.loopView.getUint32(offset + 36, true);
    target.signedArea = this.loopView.getFloat64(offset + 40, true);
    return target;
  }

  readVertex(index, target) {
    if (!Number.isInteger(index) || index < 0 || index >= this.vertexCount) {
      throw new RangeError(`HATCH vertex index is out of range: ${index}`);
    }
    if (!target || target.length < 3) {
      throw new TypeError("HATCH vertex target must contain three values");
    }
    const offset = index * HATCH_VERTEX_RECORD_SIZE;
    for (let axis = 0; axis < 3; axis += 1) {
      target[axis] = this.vertexView.getFloat64(offset + axis * 8, true);
    }
    return target;
  }

  readGradientColor(index, target) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.gradientColorCount
    ) {
      throw new RangeError(`HATCH gradient-color index is out of range: ${index}`);
    }
    if (!target || typeof target !== "object") {
      throw new TypeError("HATCH gradient-color target must be an object");
    }
    const offset = index * HATCH_GRADIENT_COLOR_RECORD_SIZE;
    target.value = this.gradientColorView.getFloat64(offset, true);
    target.color = this.gradientColorView.getUint32(offset + 8, true);
    return target;
  }

  readSeedPoint(index, target) {
    if (!Number.isInteger(index) || index < 0 || index >= this.seedPointCount) {
      throw new RangeError(`HATCH seed-point index is out of range: ${index}`);
    }
    if (!target || target.length < 2) {
      throw new TypeError("HATCH seed-point target must contain two values");
    }
    const offset = index * HATCH_SEED_POINT_RECORD_SIZE;
    target[0] = this.seedPointView.getFloat64(offset, true);
    target[1] = this.seedPointView.getFloat64(offset + 8, true);
    return target;
  }

  get(index) {
    const record = this.readEntity(index, { normal: [0, 0, 1] });
    return Object.freeze({
      ...record,
      normal: Object.freeze([...record.normal]),
      patternName: this.readPatternName(index),
      gradientName: this.readGradientName(index),
    });
  }

  #readString(referenceOffset) {
    const relativeOffset = this.entityView.getUint32(referenceOffset, true);
    const byteLength = this.entityView.getUint32(referenceOffset + 4, true);
    return this.decoder.decode(
      new Uint8Array(
        this.entityBuffer,
        this.stringOffset + relativeOffset,
        byteLength,
      ),
    );
  }
}

export class SceneCacheReader {
  constructor(source, header, sections) {
    this.source = source;
    this.header = header;
    this.sections = sections;
    this.cache = new Map();
  }

  static async open(source) {
    if (!source || typeof source.read !== "function") {
      throw new TypeError("SceneCacheReader requires a range source");
    }
    const headerBuffer = requireArrayBuffer(
      await source.read(0, HEADER_SIZE),
      HEADER_SIZE,
      "scene-cache header",
    );
    const headerView = new DataView(headerBuffer);
    for (let index = 0; index < CACHE_MAGIC.length; index += 1) {
      if (headerView.getUint8(index) !== CACHE_MAGIC[index]) {
        throw new Error("invalid scene-cache magic");
      }
    }

    const major = headerView.getUint16(8, true);
    const minor = headerView.getUint16(10, true);
    if (major !== CACHE_VERSION_MAJOR || minor > MAX_CACHE_VERSION_MINOR) {
      throw new Error(`unsupported scene-cache version ${major}.${minor}`);
    }
    if (headerView.getUint32(12, true) !== HEADER_SIZE) {
      throw new Error("unexpected scene-cache header size");
    }
    const sectionCount = headerView.getUint32(16, true);
    if (sectionCount === 0 || sectionCount > 1024) {
      throw new Error(`invalid scene-cache section count: ${sectionCount}`);
    }
    if (headerView.getUint32(20, true) !== DIRECTORY_ENTRY_SIZE) {
      throw new Error("unexpected scene-cache directory-entry size");
    }

    const directoryOffset = readSafeU64(
      headerView,
      32,
      "scene-cache directory offset",
    );
    const fileSize = readSafeU64(headerView, 40, "scene-cache file size");
    const sourceSize = readSafeU64(headerView, 48, "source DWG size");
    if (source.size !== undefined && source.size !== null && source.size !== fileSize) {
      throw new Error(
        `scene-cache size mismatch: header=${fileSize}, source=${source.size}`,
      );
    }

    const directoryLength = checkedMultiply(
      sectionCount,
      DIRECTORY_ENTRY_SIZE,
      "scene-cache directory length",
    );
    const directoryEnd = checkedAdd(
      directoryOffset,
      directoryLength,
      "scene-cache directory end",
    );
    if (directoryOffset < HEADER_SIZE || directoryEnd > fileSize) {
      throw new Error("scene-cache directory is outside the file");
    }
    const directoryBuffer = requireArrayBuffer(
      await source.read(directoryOffset, directoryLength),
      directoryLength,
      "scene-cache directory",
    );
    const directoryView = new DataView(directoryBuffer);
    const sections = new Map();
    const ranges = [];
    const bodyStart = alignUp(directoryEnd, 8);

    for (let index = 0; index < sectionCount; index += 1) {
      const offset = index * DIRECTORY_ENTRY_SIZE;
      const entry = {
        kind: directoryView.getUint32(offset, true),
        recordSize: directoryView.getUint32(offset + 4, true),
        offset: readSafeU64(directoryView, offset + 8, "section offset"),
        byteLength: readSafeU64(directoryView, offset + 16, "section byte length"),
        recordCount: readSafeU64(directoryView, offset + 24, "section record count"),
        flags: directoryView.getUint32(offset + 32, true),
      };
      if (sections.has(entry.kind)) {
        throw new Error(`duplicate scene-cache section ${entry.kind}`);
      }
      const end = checkedAdd(
        entry.offset,
        entry.byteLength,
        `section ${entry.kind} end`,
      );
      if (entry.offset < bodyStart || entry.offset % 8 !== 0 || end > fileSize) {
        throw new Error(`section ${entry.kind} has an invalid range`);
      }
      const expectedRecordSize = FIXED_RECORD_SIZES.get(entry.kind);
      if (expectedRecordSize !== undefined) {
        validateRecordSection(entry, expectedRecordSize);
      }
      sections.set(entry.kind, Object.freeze(entry));
      ranges.push({ start: entry.offset, end, kind: entry.kind });
    }

    ranges.sort((left, right) => left.start - right.start);
    for (let index = 1; index < ranges.length; index += 1) {
      if (ranges[index - 1].end > ranges[index].start) {
        throw new Error(
          `scene-cache sections ${ranges[index - 1].kind} and ${ranges[index].kind} overlap`,
        );
      }
    }

    if (minor >= 4) {
      const textStyles = sections.get(SectionKind.TextStyles);
      const textEntities = sections.get(SectionKind.TextEntities);
      const columnHeights = sections.get(SectionKind.TextColumnHeights);
      if (!textStyles || !textEntities || !columnHeights) {
        throw new Error("Scene Cache v1.4 is missing required text sections");
      }
      validateStringTableDirectoryEntry(textStyles, TEXT_STYLE_RECORD_SIZE);
      validateStringTableDirectoryEntry(textEntities, TEXT_ENTITY_RECORD_SIZE);
      validateRecordSection(columnHeights, TEXT_COLUMN_HEIGHT_RECORD_SIZE);
    }
    if (minor >= 6) {
      const hatchEntities = sections.get(SectionKind.HatchEntities);
      const hatchLoops = sections.get(SectionKind.HatchLoops);
      const hatchVertices = sections.get(SectionKind.HatchVertices);
      const hatchGradientColors = sections.get(
        SectionKind.HatchGradientColors,
      );
      const hatchSeedPoints = sections.get(SectionKind.HatchSeedPoints);
      if (
        !hatchEntities ||
        !hatchLoops ||
        !hatchVertices ||
        !hatchGradientColors ||
        !hatchSeedPoints
      ) {
        throw new Error("Scene Cache v1.6 is missing required HATCH sections");
      }
      validateStringTableDirectoryEntry(
        hatchEntities,
        HATCH_ENTITY_RECORD_SIZE,
      );
      validateRecordSection(hatchLoops, HATCH_LOOP_RECORD_SIZE);
      validateRecordSection(hatchVertices, HATCH_VERTEX_RECORD_SIZE);
      validateRecordSection(
        hatchGradientColors,
        HATCH_GRADIENT_COLOR_RECORD_SIZE,
      );
      validateRecordSection(
        hatchSeedPoints,
        HATCH_SEED_POINT_RECORD_SIZE,
      );
    }

    return new SceneCacheReader(
      source,
      Object.freeze({
        major,
        minor,
        sectionCount,
        directoryOffset,
        fileSize,
        sourceSize,
        sourceVersion: headerView.getUint32(56, true),
        maintenanceVersion: headerView.getUint32(60, true),
      }),
      sections,
    );
  }

  getSection(kind) {
    const section = this.sections.get(kind);
    if (!section) {
      throw new Error(`scene-cache section ${kind} is missing`);
    }
    return section;
  }

  async readDrawing() {
    return this.memoize("drawing", async () => {
      const section = this.getSection(SectionKind.Drawing);
      if (section.recordCount !== 1) {
        throw new Error("drawing section must contain one record");
      }
      const buffer = await this.readWholeMetadataSection(section);
      const view = new DataView(buffer);
      const bounds = {
        min: ensureFiniteVector(readVec3F64(view, 32), "drawing minimum bounds"),
        max: ensureFiniteVector(readVec3F64(view, 56), "drawing maximum bounds"),
      };
      return Object.freeze({
        version: view.getUint32(0, true),
        maintenanceVersion: view.getUint32(4, true),
        insertionUnits: view.getInt32(8, true),
        totalEntities: readSafeU64(view, 16, "drawing entity count"),
        serializedEntities: readSafeU64(view, 24, "serialized entity count"),
        bounds,
      });
    });
  }

  async readLayers() {
    return this.memoize("layers", async () => {
      const section = this.getSection(SectionKind.Layers);
      return this.readStringTable(section, 40, (view, offset, readString) =>
        Object.freeze({
          handle: view.getBigUint64(offset, true),
          name: readString(
            view.getUint32(offset + 8, true),
            view.getUint32(offset + 12, true),
          ),
          linetype: readString(
            view.getUint32(offset + 16, true),
            view.getUint32(offset + 20, true),
          ),
          color: view.getUint32(offset + 24, true),
          flags: view.getUint32(offset + 28, true),
          lineWeight: view.getInt32(offset + 32, true),
        }),
      );
    });
  }

  async readBlocks() {
    return this.memoize("blocks", async () => {
      const section = this.getSection(SectionKind.Blocks);
      return this.readStringTable(section, 64, (view, offset, readString, index) =>
        Object.freeze({
          index,
          handle: view.getBigUint64(offset, true),
          name: readString(
            view.getUint32(offset + 8, true),
            view.getUint32(offset + 12, true),
          ),
          entityCount: view.getUint32(offset + 16, true),
          referenceCount: view.getUint32(offset + 20, true),
          flags: view.getUint32(offset + 24, true),
          units: view.getInt32(offset + 28, true),
          basePoint: ensureFiniteVector(
            readVec3F64(view, offset + 32),
            "block base point",
          ),
        }),
      );
    });
  }

  async readTextStyles() {
    return this.memoize("text-styles", async () => {
      const section = this.getSection(SectionKind.TextStyles);
      return this.readStringTable(
        section,
        TEXT_STYLE_RECORD_SIZE,
        (view, offset, readString, index) =>
          Object.freeze({
            index,
            handle: view.getBigUint64(offset, true),
            name: readString(
              view.getUint32(offset + 8, true),
              view.getUint32(offset + 12, true),
            ),
            fontFile: readString(
              view.getUint32(offset + 16, true),
              view.getUint32(offset + 20, true),
            ),
            bigFontFile: readString(
              view.getUint32(offset + 24, true),
              view.getUint32(offset + 28, true),
            ),
            trueTypeFont: readString(
              view.getUint32(offset + 32, true),
              view.getUint32(offset + 36, true),
            ),
            flags: view.getUint32(offset + 40, true),
            height: view.getFloat64(offset + 48, true),
            widthFactor: view.getFloat64(offset + 56, true),
            obliqueAngle: view.getFloat64(offset + 64, true),
            lastHeight: view.getFloat64(offset + 72, true),
          }),
      );
    });
  }

  async readTextColumnHeights() {
    return this.memoize("text-column-heights", async () => {
      const section = this.getSection(SectionKind.TextColumnHeights);
      const buffer = await this.readWholeMetadataSection(section);
      const view = new DataView(buffer);
      const values = new Float64Array(section.recordCount);
      for (let index = 0; index < values.length; index += 1) {
        values[index] = view.getFloat64(
          index * TEXT_COLUMN_HEIGHT_RECORD_SIZE,
          true,
        );
      }
      return values;
    });
  }

  async readTextEntities() {
    return this.memoize("text-entities", async () => {
      const section = this.getSection(SectionKind.TextEntities);
      validateStringTableDirectoryEntry(section, TEXT_ENTITY_RECORD_SIZE);
      const [styles, columnHeights, buffer] = await Promise.all([
        this.readTextStyles(),
        this.readTextColumnHeights(),
        this.readWholeMetadataSection(section),
      ]);
      const view = new DataView(buffer);
      const recordCount = view.getUint32(0, true);
      const recordSize = view.getUint32(4, true);
      const stringOffset = readSafeU64(view, 8, "text UTF-8 blob offset");
      const minimumStringOffset = checkedAdd(
        STRING_TABLE_HEADER_SIZE,
        checkedMultiply(
          section.recordCount,
          section.recordSize,
          "text record bytes",
        ),
        "text UTF-8 minimum offset",
      );
      if (
        recordCount !== section.recordCount ||
        recordSize !== section.recordSize ||
        stringOffset < minimumStringOffset ||
        stringOffset > section.byteLength
      ) {
        throw new Error("text-entity string-table header is inconsistent");
      }

      const decoder = new TextDecoder("utf-8", { fatal: true });
      for (let index = 0; index < section.recordCount; index += 1) {
        const offset = STRING_TABLE_HEADER_SIZE + index * section.recordSize;
        const kind = view.getUint16(offset + 32, true);
        const styleIndex = view.getUint32(offset + 36, true);
        if (kind > TextEntityKind.Attribute) {
          throw new Error(`text entity ${index} has an unsupported kind`);
        }
        if (styleIndex !== 0xffffffff && styleIndex >= styles.length) {
          throw new Error(`text entity ${index} has an invalid style reference`);
        }
        for (const referenceOffset of [40, 48, 56]) {
          const relativeOffset = view.getUint32(offset + referenceOffset, true);
          const byteLength = view.getUint32(offset + referenceOffset + 4, true);
          if (byteLength > MAX_CACHE_STRING_BYTES) {
            throw new Error(`text entity ${index} contains an oversized string`);
          }
          const start = checkedAdd(
            stringOffset,
            relativeOffset,
            "text UTF-8 offset",
          );
          const end = checkedAdd(start, byteLength, "text UTF-8 end");
          if (start < stringOffset || end > section.byteLength) {
            throw new Error(`text entity ${index} points outside its UTF-8 blob`);
          }
          decoder.decode(new Uint8Array(buffer, start, byteLength));
        }
        const firstColumnHeight = readSafeU64(
          view,
          offset + 320,
          "text column-height offset",
        );
        const columnHeightCount = readSafeU64(
          view,
          offset + 328,
          "text column-height count",
        );
        if (
          checkedAdd(
            firstColumnHeight,
            columnHeightCount,
            "text column-height range",
          ) > columnHeights.length
        ) {
          throw new Error(`text entity ${index} has an invalid column-height range`);
        }
      }
      return new TextEntityTable(
        buffer,
        stringOffset,
        section.recordCount,
        styles,
        columnHeights,
      );
    });
  }

  async readHatchSource() {
    return this.memoize("hatch-source", async () => {
      const entities = this.getSection(SectionKind.HatchEntities);
      const loops = this.getSection(SectionKind.HatchLoops);
      const vertices = this.getSection(SectionKind.HatchVertices);
      const gradientColors = this.getSection(SectionKind.HatchGradientColors);
      const seedPoints = this.getSection(SectionKind.HatchSeedPoints);
      validateStringTableDirectoryEntry(entities, HATCH_ENTITY_RECORD_SIZE);
      validateRecordSection(loops, HATCH_LOOP_RECORD_SIZE);
      validateRecordSection(vertices, HATCH_VERTEX_RECORD_SIZE);
      validateRecordSection(
        gradientColors,
        HATCH_GRADIENT_COLOR_RECORD_SIZE,
      );
      validateRecordSection(seedPoints, HATCH_SEED_POINT_RECORD_SIZE);
      for (const section of [
        entities,
        loops,
        vertices,
        gradientColors,
        seedPoints,
      ]) {
        if (section.recordCount > MAX_HATCH_SOURCE_RECORDS) {
          throw new Error(
            `HATCH section ${section.kind} exceeds the ${MAX_HATCH_SOURCE_RECORDS}-record limit`,
          );
        }
      }

      const [
        entityBuffer,
        loopBuffer,
        vertexBuffer,
        gradientColorBuffer,
        seedPointBuffer,
      ] = await Promise.all([
        this.readWholeMetadataSection(entities),
        this.readWholeMetadataSection(loops),
        this.readWholeMetadataSection(vertices),
        this.readWholeMetadataSection(gradientColors),
        this.readWholeMetadataSection(seedPoints),
      ]);
      const entityView = new DataView(entityBuffer);
      const loopView = new DataView(loopBuffer);
      const vertexView = new DataView(vertexBuffer);
      const gradientColorView = new DataView(gradientColorBuffer);
      const seedPointView = new DataView(seedPointBuffer);
      const recordCount = entityView.getUint32(0, true);
      const recordSize = entityView.getUint32(4, true);
      const stringOffset = readSafeU64(
        entityView,
        8,
        "HATCH UTF-8 blob offset",
      );
      const minimumStringOffset = checkedAdd(
        STRING_TABLE_HEADER_SIZE,
        checkedMultiply(
          entities.recordCount,
          entities.recordSize,
          "HATCH entity bytes",
        ),
        "HATCH UTF-8 minimum offset",
      );
      if (
        recordCount !== entities.recordCount ||
        recordSize !== entities.recordSize ||
        stringOffset < minimumStringOffset ||
        stringOffset > entities.byteLength
      ) {
        throw new Error("HATCH string-table header is inconsistent");
      }

      const decoder = new TextDecoder("utf-8", { fatal: true });
      const validateString = (entityIndex, referenceOffset) => {
        const relativeOffset = entityView.getUint32(referenceOffset, true);
        const byteLength = entityView.getUint32(referenceOffset + 4, true);
        if (byteLength > MAX_CACHE_STRING_BYTES) {
          throw new Error(
            `HATCH entity ${entityIndex} contains an oversized string`,
          );
        }
        const start = checkedAdd(
          stringOffset,
          relativeOffset,
          "HATCH UTF-8 offset",
        );
        const end = checkedAdd(start, byteLength, "HATCH UTF-8 end");
        if (start < stringOffset || end > entities.byteLength) {
          throw new Error(
            `HATCH entity ${entityIndex} points outside its UTF-8 blob`,
          );
        }
        decoder.decode(new Uint8Array(entityBuffer, start, byteLength));
      };
      let expectedFirstLoop = 0;
      let expectedFirstGradientColor = 0;
      let expectedFirstSeedPoint = 0;
      for (let index = 0; index < entities.recordCount; index += 1) {
        const offset =
          STRING_TABLE_HEADER_SIZE + index * HATCH_ENTITY_RECORD_SIZE;
        validateString(index, offset + 32);
        validateString(index, offset + 40);
        const flags = entityView.getUint32(offset + 48, true);
        const style = entityView.getUint16(offset + 52, true);
        const patternType = entityView.getUint16(offset + 54, true);
        if (flags & ~0x3f || style > HatchStyle.Ignore || patternType > 2) {
          throw new Error(
            `HATCH entity ${index} has unsupported flags or enum values`,
          );
        }
        const firstLoop = readSafeU64(
          entityView,
          offset + 56,
          "HATCH loop offset",
        );
        const loopCount = readSafeU64(
          entityView,
          offset + 64,
          "HATCH loop count",
        );
        const firstGradientColor = readSafeU64(
          entityView,
          offset + 72,
          "HATCH gradient-color offset",
        );
        const gradientColorCount = readSafeU64(
          entityView,
          offset + 80,
          "HATCH gradient-color count",
        );
        const firstSeedPoint = readSafeU64(
          entityView,
          offset + 168,
          "HATCH seed-point offset",
        );
        const seedPointCount = readSafeU64(
          entityView,
          offset + 176,
          "HATCH seed-point count",
        );
        if (
          firstLoop !== expectedFirstLoop ||
          firstGradientColor !== expectedFirstGradientColor ||
          firstSeedPoint !== expectedFirstSeedPoint ||
          checkedAdd(firstLoop, loopCount, "HATCH loop range") >
            loops.recordCount ||
          checkedAdd(
            firstGradientColor,
            gradientColorCount,
            "HATCH gradient-color range",
          ) > gradientColors.recordCount ||
          checkedAdd(
            firstSeedPoint,
            seedPointCount,
            "HATCH seed-point range",
          ) > seedPoints.recordCount
        ) {
          throw new Error(`HATCH entity ${index} has an invalid pool range`);
        }
        expectedFirstLoop += loopCount;
        expectedFirstGradientColor += gradientColorCount;
        expectedFirstSeedPoint += seedPointCount;
        const finiteOffsets = [
          88, 96, 104, 112, 120, 128, 136, 144, 152, 160,
        ];
        if (
          finiteOffsets.some(
            (relativeOffset) =>
              !Number.isFinite(
                entityView.getFloat64(offset + relativeOffset, true),
              ),
          )
        ) {
          throw new Error(`HATCH entity ${index} has a non-finite scalar`);
        }
        const normalLengthSquared =
          entityView.getFloat64(offset + 96, true) ** 2 +
          entityView.getFloat64(offset + 104, true) ** 2 +
          entityView.getFloat64(offset + 112, true) ** 2;
        if (
          !Number.isFinite(normalLengthSquared) ||
          normalLengthSquared <= Number.EPSILON
        ) {
          throw new Error(`HATCH entity ${index} has an invalid normal`);
        }
      }
      if (
        expectedFirstLoop !== loops.recordCount ||
        expectedFirstGradientColor !== gradientColors.recordCount ||
        expectedFirstSeedPoint !== seedPoints.recordCount
      ) {
        throw new Error("HATCH source pools are not fully covered");
      }

      let expectedFirstVertex = 0;
      for (let index = 0; index < loops.recordCount; index += 1) {
        const offset = index * HATCH_LOOP_RECORD_SIZE;
        const hatchIndex = readSafeU64(
          loopView,
          offset,
          "HATCH loop source index",
        );
        const pathFlags = loopView.getUint32(offset + 8, true);
        const firstVertex = readSafeU64(
          loopView,
          offset + 16,
          "HATCH vertex offset",
        );
        const vertexCount = readSafeU64(
          loopView,
          offset + 24,
          "HATCH vertex count",
        );
        const flags = loopView.getUint32(offset + 36, true);
        const signedArea = loopView.getFloat64(offset + 40, true);
        if (
          hatchIndex >= entities.recordCount ||
          pathFlags & 32 ||
          firstVertex !== expectedFirstVertex ||
          vertexCount < 3 ||
          flags & ~1 ||
          !Number.isFinite(signedArea) ||
          Math.abs(signedArea) <= 1e-18 ||
          checkedAdd(firstVertex, vertexCount, "HATCH vertex range") >
            vertices.recordCount
        ) {
          throw new Error(`HATCH loop ${index} has invalid metadata`);
        }
        expectedFirstVertex += vertexCount;
      }
      if (expectedFirstVertex !== vertices.recordCount) {
        throw new Error("HATCH vertex pool is not fully covered");
      }

      for (let index = 0; index < vertices.recordCount; index += 1) {
        const offset = index * HATCH_VERTEX_RECORD_SIZE;
        if (
          [0, 8, 16].some(
            (relativeOffset) =>
              !Number.isFinite(
                vertexView.getFloat64(offset + relativeOffset, true),
              ),
          )
        ) {
          throw new Error(`HATCH vertex ${index} contains a non-finite value`);
        }
      }
      for (let index = 0; index < gradientColors.recordCount; index += 1) {
        if (
          !Number.isFinite(
            gradientColorView.getFloat64(
              index * HATCH_GRADIENT_COLOR_RECORD_SIZE,
              true,
            ),
          )
        ) {
          throw new Error(
            `HATCH gradient color ${index} contains a non-finite value`,
          );
        }
      }
      for (let index = 0; index < seedPoints.recordCount; index += 1) {
        const offset = index * HATCH_SEED_POINT_RECORD_SIZE;
        if (
          !Number.isFinite(seedPointView.getFloat64(offset, true)) ||
          !Number.isFinite(seedPointView.getFloat64(offset + 8, true))
        ) {
          throw new Error(
            `HATCH seed point ${index} contains a non-finite value`,
          );
        }
      }

      return new HatchSourceTable({
        entityBuffer,
        stringOffset,
        entityCount: entities.recordCount,
        loopBuffer,
        loopCount: loops.recordCount,
        vertexBuffer,
        vertexCount: vertices.recordCount,
        gradientColorBuffer,
        gradientColorCount: gradientColors.recordCount,
        seedPointBuffer,
        seedPointCount: seedPoints.recordCount,
      });
    });
  }

  async readInserts() {
    return this.memoize("inserts", async () => {
      const section = this.getSection(SectionKind.Inserts);
      const buffer = await this.readWholeMetadataSection(section);
      const view = new DataView(buffer);
      const inserts = new Array(section.recordCount);
      for (let index = 0; index < section.recordCount; index += 1) {
        const offset = index * section.recordSize;
        inserts[index] = Object.freeze({
          index,
          handle: view.getBigUint64(offset, true),
          ownerHandle: view.getBigUint64(offset + 8, true),
          layerIndex: view.getUint32(offset + 16, true),
          color: view.getUint32(offset + 20, true),
          lineWeight: view.getInt16(offset + 24, true),
          flags: view.getUint16(offset + 26, true),
          blockIndex: view.getUint32(offset + 32, true),
          columnCount: view.getUint16(offset + 36, true),
          rowCount: view.getUint16(offset + 38, true),
          insertPoint: ensureFiniteVector(
            readVec3F64(view, offset + 40),
            "INSERT point",
          ),
          scale: ensureFiniteVector(readVec3F64(view, offset + 64), "INSERT scale"),
          rotation: view.getFloat64(offset + 88, true),
          normal: ensureFiniteVector(
            readVec3F64(view, offset + 96),
            "INSERT normal",
          ),
          columnSpacing: view.getFloat64(offset + 120, true),
          rowSpacing: view.getFloat64(offset + 128, true),
        });
      }
      return Object.freeze(inserts);
    });
  }

  async readGpuLineBatches() {
    return this.memoize("gpu-line-batches", async () => {
      const section = this.getSection(SectionKind.GpuLineBatches);
      const vertices = this.getSection(SectionKind.GpuLineVertices);
      const blocks = this.getSection(SectionKind.Blocks);
      const buffer = await this.readWholeMetadataSection(section);
      const view = new DataView(buffer);
      const batches = new Array(section.recordCount);
      let expectedFirstVertex = 0;
      let detailStarted = false;
      let overviewVertexCount = 0;

      for (let index = 0; index < section.recordCount; index += 1) {
        const offset = index * section.recordSize;
        const id = view.getUint32(offset, true);
        const kind = view.getUint16(offset + 4, true);
        const lodLevel = view.getUint16(offset + 6, true);
        const flags = view.getUint32(offset + 8, true);
        const encodedBlockIndex = view.getUint32(offset + 12, true);
        const firstVertex = readSafeU64(view, offset + 16, "GPU first vertex");
        const vertexCount = readSafeU64(view, offset + 24, "GPU vertex count");
        const segmentCount = view.getUint32(offset + 32, true);
        const origin = ensureFiniteVector(
          readVec3F64(view, offset + 40),
          "GPU batch origin",
        );
        const bounds = {
          min: ensureFiniteVector(
            readVec3F64(view, offset + 64),
            "GPU batch minimum bounds",
          ),
          max: ensureFiniteVector(
            readVec3F64(view, offset + 88),
            "GPU batch maximum bounds",
          ),
        };
        const maximumPositionError = view.getFloat32(offset + 112, true);

        if (id !== index) {
          throw new Error("GPU batch IDs are not sequential");
        }
        if (kind > GpuLineBatchKind.BlockDefinition || lodLevel > 1) {
          throw new Error(`GPU batch ${id} has unsupported metadata`);
        }
        if (detailStarted && lodLevel === 0) {
          throw new Error("GPU overview batches are not a contiguous prefix");
        }
        detailStarted ||= lodLevel === 1;
        if (firstVertex !== expectedFirstVertex) {
          throw new Error("GPU vertex ranges are not contiguous");
        }
        if (vertexCount !== segmentCount * 2) {
          throw new Error(`GPU batch ${id} vertex count does not match segments`);
        }
        expectedFirstVertex = checkedAdd(
          firstVertex,
          vertexCount,
          "GPU vertex range end",
        );
        if (lodLevel === 0) {
          overviewVertexCount = expectedFirstVertex;
        }
        const isBlock = kind === GpuLineBatchKind.BlockDefinition;
        if (
          (isBlock && encodedBlockIndex >= blocks.recordCount) ||
          (!isBlock && encodedBlockIndex !== 0xffffffff)
        ) {
          throw new Error(`GPU batch ${id} has an invalid block reference`);
        }
        if (
          !Number.isFinite(maximumPositionError) ||
          maximumPositionError < 0 ||
          bounds.min.some((value, axis) => value > bounds.max[axis])
        ) {
          throw new Error(`GPU batch ${id} has invalid bounds or precision`);
        }

        batches[index] = Object.freeze({
          id,
          kind,
          lodLevel,
          flags,
          blockIndex: isBlock ? encodedBlockIndex : null,
          firstVertex,
          vertexCount,
          segmentCount,
          origin,
          bounds,
          maximumPositionError,
        });
      }
      if (expectedFirstVertex !== vertices.recordCount) {
        throw new Error("GPU batches do not cover the complete vertex pool");
      }
      Object.defineProperty(batches, "overviewVertexCount", {
        value: overviewVertexCount,
        enumerable: false,
      });
      return Object.freeze(batches);
    });
  }

  async readRenderMetadata() {
    const [drawing, layers, blocks, inserts, batches] = await Promise.all([
      this.readDrawing(),
      this.readLayers(),
      this.readBlocks(),
      this.readInserts(),
      this.readGpuLineBatches(),
    ]);
    return Object.freeze({ drawing, layers, blocks, inserts, batches });
  }

  async readOverviewVertices({ maximumBytes = MAX_OVERVIEW_BYTES } = {}) {
    const batches = await this.readGpuLineBatches();
    const section = this.getSection(SectionKind.GpuLineVertices);
    const vertexCount = batches.overviewVertexCount;
    const byteLength = checkedMultiply(
      vertexCount,
      GPU_LINE_VERTEX_RECORD_SIZE,
      "overview vertex bytes",
    );
    if (byteLength > maximumBytes) {
      throw new Error(
        `overview vertex prefix is ${byteLength} bytes, above the ${maximumBytes}-byte limit`,
      );
    }
    const buffer = requireArrayBuffer(
      await this.source.read(section.offset, byteLength),
      byteLength,
      "overview GPU vertices",
    );
    return Object.freeze({ buffer, firstVertex: 0, vertexCount, byteLength });
  }

  async readBatchVertices(
    batch,
    { maximumBytes = MAX_DETAIL_BATCH_BYTES } = {},
  ) {
    const section = this.getSection(SectionKind.GpuLineVertices);
    const byteLength = checkedMultiply(
      batch.vertexCount,
      GPU_LINE_VERTEX_RECORD_SIZE,
      "GPU batch vertex bytes",
    );
    if (byteLength > maximumBytes) {
      throw new Error(
        `GPU batch ${batch.id} is ${byteLength} bytes, above the ${maximumBytes}-byte limit`,
      );
    }
    const relativeOffset = checkedMultiply(
      batch.firstVertex,
      GPU_LINE_VERTEX_RECORD_SIZE,
      "GPU batch vertex offset",
    );
    const offset = checkedAdd(
      section.offset,
      relativeOffset,
      "GPU batch file offset",
    );
    const buffer = requireArrayBuffer(
      await this.source.read(offset, byteLength),
      byteLength,
      `GPU batch ${batch.id} vertices`,
    );
    return Object.freeze({
      buffer,
      firstVertex: batch.firstVertex,
      vertexCount: batch.vertexCount,
      byteLength,
    });
  }

  async readStringTable(section, expectedRecordSize, parseRecord) {
    if (
      section.recordSize !== expectedRecordSize ||
      section.flags !== STRING_TABLE_FLAG ||
      section.byteLength < STRING_TABLE_HEADER_SIZE
    ) {
      throw new Error(`section ${section.kind} has invalid string-table metadata`);
    }
    const buffer = await this.readWholeMetadataSection(section);
    const view = new DataView(buffer);
    const recordCount = view.getUint32(0, true);
    const recordSize = view.getUint32(4, true);
    const stringOffset = readSafeU64(view, 8, "string-table blob offset");
    const minimumStringOffset =
      STRING_TABLE_HEADER_SIZE + section.recordCount * section.recordSize;
    if (
      recordCount !== section.recordCount ||
      recordSize !== section.recordSize ||
      stringOffset < minimumStringOffset ||
      stringOffset > section.byteLength
    ) {
      throw new Error(`section ${section.kind} string-table header is inconsistent`);
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const readString = (relativeOffset, byteLength) => {
      if (byteLength > MAX_CACHE_STRING_BYTES) {
        throw new Error(`section ${section.kind} contains an oversized string`);
      }
      const start = checkedAdd(
        stringOffset,
        relativeOffset,
        "string-table string offset",
      );
      const end = checkedAdd(start, byteLength, "string-table string end");
      if (start < stringOffset || end > section.byteLength) {
        throw new Error(`section ${section.kind} string points outside its blob`);
      }
      return decoder.decode(new Uint8Array(buffer, start, byteLength));
    };
    const rows = new Array(section.recordCount);
    for (let index = 0; index < section.recordCount; index += 1) {
      const offset = STRING_TABLE_HEADER_SIZE + index * section.recordSize;
      rows[index] = parseRecord(view, offset, readString, index);
    }
    return Object.freeze(rows);
  }

  async readWholeMetadataSection(section) {
    if (section.byteLength > MAX_METADATA_SECTION_BYTES) {
      throw new Error(
        `metadata section ${section.kind} exceeds the ${MAX_METADATA_SECTION_BYTES}-byte limit`,
      );
    }
    return requireArrayBuffer(
      await this.source.read(section.offset, section.byteLength),
      section.byteLength,
      `section ${section.kind}`,
    );
  }

  memoize(key, loader) {
    if (!this.cache.has(key)) {
      this.cache.set(
        key,
        Promise.resolve()
          .then(loader)
          .catch((error) => {
            this.cache.delete(key);
            throw error;
          }),
      );
    }
    return this.cache.get(key);
  }
}

export {
  MAX_DETAIL_BATCH_BYTES,
  MAX_METADATA_SECTION_BYTES,
  MAX_OVERVIEW_BYTES,
  checkedAdd,
  checkedMultiply,
  readSafeU64,
};

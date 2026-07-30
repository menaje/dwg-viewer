import {
  DIRECTORY_ENTRY_SIZE,
  GPU_LINE_BATCH_RECORD_SIZE,
  GPU_LINE_VERTEX_RECORD_SIZE,
  HEADER_SIZE,
  SectionKind,
} from "../src/scene-cache.mjs";

const encoder = new TextEncoder();

function alignUp(value, alignment = 8) {
  return Math.ceil(value / alignment) * alignment;
}

function writeU64(view, offset, value) {
  view.setBigUint64(offset, BigInt(value), true);
}

function writeVec3(view, offset, values) {
  values.forEach((value, axis) => view.setFloat64(offset + axis * 8, value, true));
}

function makeDrawingSection() {
  const buffer = new ArrayBuffer(80);
  const view = new DataView(buffer);
  view.setUint32(0, 1032, true);
  writeU64(view, 16, 5);
  writeU64(view, 24, 5);
  writeVec3(view, 32, [0, 0, 0]);
  writeVec3(view, 56, [200, 200, 0]);
  return { kind: SectionKind.Drawing, recordSize: 80, recordCount: 1, flags: 0, buffer };
}

function makeStringTable(kind, recordSize, rows, writeRow) {
  const strings = [];
  let stringBytes = 0;
  const references = rows.map((row) => {
    const encoded = encoder.encode(row.name);
    const reference = { offset: stringBytes, length: encoded.byteLength, encoded };
    strings.push(encoded);
    stringBytes += encoded.byteLength;
    return reference;
  });
  const stringOffset = 16 + rows.length * recordSize;
  const buffer = new ArrayBuffer(stringOffset + stringBytes);
  const view = new DataView(buffer);
  view.setUint32(0, rows.length, true);
  view.setUint32(4, recordSize, true);
  writeU64(view, 8, stringOffset);
  rows.forEach((row, index) => {
    writeRow(view, 16 + index * recordSize, row, references[index]);
  });
  let destination = stringOffset;
  for (const string of strings) {
    new Uint8Array(buffer, destination, string.byteLength).set(string);
    destination += string.byteLength;
  }
  return {
    kind,
    recordSize,
    recordCount: rows.length,
    flags: 1,
    buffer,
  };
}

function makeLayerSection() {
  const continuous = encoder.encode("Continuous");
  const name = encoder.encode("0");
  const stringOffset = 16 + 40;
  const buffer = new ArrayBuffer(stringOffset + name.length + continuous.length);
  const view = new DataView(buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, 40, true);
  writeU64(view, 8, stringOffset);
  writeU64(view, 16, 11);
  view.setUint32(24, 0, true);
  view.setUint32(28, name.length, true);
  view.setUint32(32, name.length, true);
  view.setUint32(36, continuous.length, true);
  view.setUint32(40, (2 << 30) | 7, true);
  new Uint8Array(buffer, stringOffset, name.length).set(name);
  new Uint8Array(buffer, stringOffset + name.length, continuous.length).set(
    continuous,
  );
  return {
    kind: SectionKind.Layers,
    recordSize: 40,
    recordCount: 1,
    flags: 1,
    buffer,
  };
}

function makeBlockSection() {
  const rows = [
    { handle: 100, name: "*Model_Space", basePoint: [0, 0, 0] },
    { handle: 101, name: "BLOCK_A", basePoint: [10, 0, 0] },
    { handle: 102, name: "BLOCK_B", basePoint: [0, 0, 0] },
  ];
  return makeStringTable(
    SectionKind.Blocks,
    64,
    rows,
    (view, offset, row, name) => {
      writeU64(view, offset, row.handle);
      view.setUint32(offset + 8, name.offset, true);
      view.setUint32(offset + 12, name.length, true);
      view.setUint32(offset + 16, 1, true);
      view.setUint32(offset + 20, row.handle === 100 ? 0 : 1, true);
      writeVec3(view, offset + 32, row.basePoint);
    },
  );
}

function writeInsert(view, offset, values) {
  writeU64(view, offset, values.handle);
  writeU64(view, offset + 8, values.ownerHandle);
  view.setUint32(offset + 16, 0, true);
  view.setUint32(offset + 20, 0, true);
  view.setInt16(offset + 24, -1, true);
  view.setUint32(offset + 32, values.blockIndex, true);
  view.setUint16(offset + 36, values.columns ?? 1, true);
  view.setUint16(offset + 38, values.rows ?? 1, true);
  writeVec3(view, offset + 40, values.insertPoint);
  writeVec3(view, offset + 64, values.scale ?? [1, 1, 1]);
  view.setFloat64(offset + 88, values.rotation ?? 0, true);
  writeVec3(view, offset + 96, [0, 0, 1]);
  view.setFloat64(offset + 120, values.columnSpacing ?? 0, true);
  view.setFloat64(offset + 128, values.rowSpacing ?? 0, true);
}

function makeInsertSection() {
  const buffer = new ArrayBuffer(136 * 2);
  const view = new DataView(buffer);
  writeInsert(view, 0, {
    handle: 201,
    ownerHandle: 100,
    blockIndex: 1,
    insertPoint: [100, 200, 0],
    scale: [2, 2, 1],
  });
  writeInsert(view, 136, {
    handle: 202,
    ownerHandle: 101,
    blockIndex: 2,
    insertPoint: [5, 0, 0],
  });
  return {
    kind: SectionKind.Inserts,
    recordSize: 136,
    recordCount: 2,
    flags: 0,
    buffer,
  };
}

function writeBatch(view, offset, values) {
  view.setUint32(offset, values.id, true);
  view.setUint16(offset + 4, 2, true);
  view.setUint16(offset + 6, values.lod, true);
  view.setUint32(offset + 12, values.blockIndex, true);
  writeU64(view, offset + 16, values.firstVertex);
  writeU64(view, offset + 24, 2);
  view.setUint32(offset + 32, 1, true);
  writeVec3(view, offset + 40, values.origin);
  writeVec3(view, offset + 64, values.bounds.min);
  writeVec3(view, offset + 88, values.bounds.max);
  view.setFloat32(offset + 112, 0, true);
}

function makeBatchSection() {
  const buffer = new ArrayBuffer(GPU_LINE_BATCH_RECORD_SIZE * 3);
  const view = new DataView(buffer);
  writeBatch(view, 0, {
    id: 0,
    lod: 0,
    blockIndex: 1,
    firstVertex: 0,
    origin: [10, 0, 0],
    bounds: { min: [10, 0, 0], max: [11, 0, 0] },
  });
  writeBatch(view, GPU_LINE_BATCH_RECORD_SIZE, {
    id: 1,
    lod: 0,
    blockIndex: 2,
    firstVertex: 2,
    origin: [0, 0, 0],
    bounds: { min: [0, 0, 0], max: [0, 1, 0] },
  });
  writeBatch(view, GPU_LINE_BATCH_RECORD_SIZE * 2, {
    id: 2,
    lod: 1,
    blockIndex: 1,
    firstVertex: 4,
    origin: [10, 0, 0],
    bounds: { min: [10, 0, 0], max: [12, 0, 0] },
  });
  return {
    kind: SectionKind.GpuLineBatches,
    recordSize: GPU_LINE_BATCH_RECORD_SIZE,
    recordCount: 3,
    flags: 0,
    buffer,
  };
}

function writeVertex(view, offset, position, handle) {
  position.forEach((value, axis) =>
    view.setFloat32(offset + axis * 4, value, true),
  );
  view.setUint32(offset + 12, 0, true);
  view.setUint32(offset + 16, 0, true);
  view.setUint32(offset + 20, handle, true);
}

function makeVertexSection() {
  const buffer = new ArrayBuffer(GPU_LINE_VERTEX_RECORD_SIZE * 6);
  const view = new DataView(buffer);
  writeVertex(view, 0, [0, 0, 0], 301);
  writeVertex(view, 32, [1, 0, 0], 301);
  writeVertex(view, 64, [0, 0, 0], 302);
  writeVertex(view, 96, [0, 1, 0], 302);
  writeVertex(view, 128, [0, 0, 0], 303);
  writeVertex(view, 160, [2, 0, 0], 303);
  return {
    kind: SectionKind.GpuLineVertices,
    recordSize: GPU_LINE_VERTEX_RECORD_SIZE,
    recordCount: 6,
    flags: 0,
    buffer,
  };
}

export function makeFixtureCache() {
  const sections = [
    makeDrawingSection(),
    makeLayerSection(),
    makeBlockSection(),
    makeInsertSection(),
    makeBatchSection(),
    makeVertexSection(),
  ];
  const directoryOffset = HEADER_SIZE;
  const directoryLength = sections.length * DIRECTORY_ENTRY_SIZE;
  let cursor = alignUp(directoryOffset + directoryLength);
  for (const section of sections) {
    section.offset = cursor;
    cursor = alignUp(cursor + section.buffer.byteLength);
  }
  const fileSize = cursor;
  const buffer = new ArrayBuffer(fileSize);
  const view = new DataView(buffer);
  new Uint8Array(buffer, 0, 8).set([68, 87, 71, 83, 67, 78, 49, 0]);
  view.setUint16(8, 1, true);
  view.setUint16(10, 2, true);
  view.setUint32(12, HEADER_SIZE, true);
  view.setUint32(16, sections.length, true);
  view.setUint32(20, DIRECTORY_ENTRY_SIZE, true);
  writeU64(view, 32, directoryOffset);
  writeU64(view, 40, fileSize);
  writeU64(view, 48, 1024);
  view.setUint32(56, 1032, true);

  sections.forEach((section, index) => {
    const offset = directoryOffset + index * DIRECTORY_ENTRY_SIZE;
    view.setUint32(offset, section.kind, true);
    view.setUint32(offset + 4, section.recordSize, true);
    writeU64(view, offset + 8, section.offset);
    writeU64(view, offset + 16, section.buffer.byteLength);
    writeU64(view, offset + 24, section.recordCount);
    view.setUint32(offset + 32, section.flags, true);
    new Uint8Array(buffer, section.offset, section.buffer.byteLength).set(
      new Uint8Array(section.buffer),
    );
  });

  return buffer;
}

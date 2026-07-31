import {
  DIRECTORY_ENTRY_SIZE,
  DRAW_ORDER_ENTRY_RECORD_SIZE,
  DRAW_ORDER_TABLE_RECORD_SIZE,
  FACE_ENTITY_RECORD_SIZE,
  GPU_LINE_BATCH_RECORD_SIZE,
  GPU_LINE_VERTEX_RECORD_SIZE,
  HATCH_ENTITY_RECORD_SIZE,
  HATCH_GRADIENT_COLOR_RECORD_SIZE,
  HATCH_LOOP_RECORD_SIZE,
  HATCH_PATTERN_DASH_RECORD_SIZE,
  HATCH_PATTERN_LINE_RECORD_SIZE,
  HATCH_SEED_POINT_RECORD_SIZE,
  HATCH_VERTEX_RECORD_SIZE,
  HEADER_SIZE,
  POINT_ENTITY_RECORD_SIZE,
  SectionKind,
  SOLID_ENTITY_RECORD_SIZE,
  TEXT_COLUMN_HEIGHT_RECORD_SIZE,
  TEXT_ENTITY_RECORD_SIZE,
  TEXT_STYLE_RECORD_SIZE,
  WIPEOUT_CLIP_VERTEX_RECORD_SIZE,
  WIPEOUT_ENTITY_RECORD_SIZE,
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

function makeDrawingSection(rawWipeoutFrame = 0) {
  const buffer = new ArrayBuffer(80);
  const view = new DataView(buffer);
  view.setUint32(0, 1032, true);
  view.setUint32(12, rawWipeoutFrame >>> 0, true);
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

function makeTextStyleSection() {
  const values = ["KOREAN", "txt.shx", "hztxt.shx", ""];
  const encoded = values.map((value) => encoder.encode(value));
  const stringOffset = 16 + TEXT_STYLE_RECORD_SIZE;
  const stringBytes = encoded.reduce((total, value) => total + value.byteLength, 0);
  const buffer = new ArrayBuffer(stringOffset + stringBytes);
  const view = new DataView(buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, TEXT_STYLE_RECORD_SIZE, true);
  writeU64(view, 8, stringOffset);
  writeU64(view, 16, 150);
  let relativeOffset = 0;
  encoded.forEach((value, index) => {
    view.setUint32(24 + index * 8, relativeOffset, true);
    view.setUint32(28 + index * 8, value.byteLength, true);
    new Uint8Array(buffer, stringOffset + relativeOffset, value.byteLength).set(
      value,
    );
    relativeOffset += value.byteLength;
  });
  view.setFloat64(64, 1, true);
  view.setFloat64(72, 1, true);
  view.setFloat64(80, 0, true);
  view.setFloat64(88, 2.5, true);
  return {
    kind: SectionKind.TextStyles,
    recordSize: TEXT_STYLE_RECORD_SIZE,
    recordCount: 1,
    flags: 1,
    buffer,
  };
}

function makeTextEntitySection() {
  const rows = [
    { kind: 0, value: "한글", tag: "", prompt: "", columns: [] },
    {
      kind: 1,
      value: "{\\H1.2x;배관}\\P점검",
      tag: "",
      prompt: "",
      columns: [10, 11],
    },
  ];
  const references = [];
  const strings = [];
  let stringBytes = 0;
  for (const row of rows) {
    const rowReferences = [];
    for (const value of [row.value, row.tag, row.prompt]) {
      const encoded = encoder.encode(value);
      rowReferences.push({ offset: stringBytes, length: encoded.byteLength });
      strings.push(encoded);
      stringBytes += encoded.byteLength;
    }
    references.push(rowReferences);
  }
  const stringOffset = 16 + rows.length * TEXT_ENTITY_RECORD_SIZE;
  const buffer = new ArrayBuffer(stringOffset + stringBytes);
  const view = new DataView(buffer);
  view.setUint32(0, rows.length, true);
  view.setUint32(4, TEXT_ENTITY_RECORD_SIZE, true);
  writeU64(view, 8, stringOffset);
  rows.forEach((row, index) => {
    const offset = 16 + index * TEXT_ENTITY_RECORD_SIZE;
    writeU64(view, offset, 300 + index);
    writeU64(view, offset + 8, 100);
    view.setUint32(offset + 16, 0, true);
    view.setInt16(offset + 24, -1, true);
    view.setUint16(offset + 32, row.kind, true);
    view.setUint32(offset + 36, 0, true);
    references[index].forEach((reference, referenceIndex) => {
      view.setUint32(offset + 40 + referenceIndex * 8, reference.offset, true);
      view.setUint32(
        offset + 44 + referenceIndex * 8,
        reference.length,
        true,
      );
    });
    writeVec3(view, offset + 72, [101 + index * 2, 201, 0]);
    writeVec3(view, offset + 120, [0, 0, 1]);
    writeVec3(view, offset + 144, [1, 0, 0]);
    view.setFloat64(offset + 168, 0.5, true);
    view.setFloat64(offset + 176, 1, true);
    if (row.kind === 1) {
      view.setUint16(offset + 276, 1, true);
      view.setUint16(offset + 278, 1, true);
      view.setUint16(offset + 280, 1, true);
      view.setFloat64(offset + 240, 1, true);
      view.setInt32(offset + 292, 2, true);
      view.setInt32(offset + 296, 2, true);
      view.setFloat64(offset + 304, 20, true);
      view.setFloat64(offset + 312, 2, true);
      writeU64(view, offset + 320, 0);
      writeU64(view, offset + 328, row.columns.length);
    }
  });
  let destination = stringOffset;
  for (const string of strings) {
    new Uint8Array(buffer, destination, string.byteLength).set(string);
    destination += string.byteLength;
  }
  return {
    kind: SectionKind.TextEntities,
    recordSize: TEXT_ENTITY_RECORD_SIZE,
    recordCount: rows.length,
    flags: 1,
    buffer,
  };
}

function makeTextColumnHeightSection() {
  const buffer = new ArrayBuffer(TEXT_COLUMN_HEIGHT_RECORD_SIZE * 2);
  const view = new DataView(buffer);
  view.setFloat64(0, 10, true);
  view.setFloat64(8, 11, true);
  return {
    kind: SectionKind.TextColumnHeights,
    recordSize: TEXT_COLUMN_HEIGHT_RECORD_SIZE,
    recordCount: 2,
    flags: 0,
    buffer,
  };
}

function makeHatchEntitySection() {
  const pattern = encoder.encode("SOLID");
  const gradient = encoder.encode("LINEAR");
  const stringOffset = 16 + HATCH_ENTITY_RECORD_SIZE;
  const buffer = new ArrayBuffer(
    stringOffset + pattern.byteLength + gradient.byteLength,
  );
  const view = new DataView(buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, HATCH_ENTITY_RECORD_SIZE, true);
  writeU64(view, 8, stringOffset);
  const offset = 16;
  writeU64(view, offset, 401);
  writeU64(view, offset + 8, 100);
  view.setUint32(offset + 16, 0, true);
  view.setUint32(offset + 20, 0, true);
  view.setInt16(offset + 24, -1, true);
  view.setUint32(offset + 32, 0, true);
  view.setUint32(offset + 36, pattern.byteLength, true);
  view.setUint32(offset + 40, pattern.byteLength, true);
  view.setUint32(offset + 44, gradient.byteLength, true);
  view.setUint32(offset + 48, (1 << 0) | (1 << 3), true);
  view.setUint16(offset + 52, 0, true);
  view.setUint16(offset + 54, 1, true);
  writeU64(view, offset + 56, 0);
  writeU64(view, offset + 64, 2);
  writeU64(view, offset + 72, 0);
  writeU64(view, offset + 80, 2);
  view.setFloat64(offset + 88, 0, true);
  writeVec3(view, offset + 96, [0, 0, 1]);
  view.setFloat64(offset + 120, 0, true);
  view.setFloat64(offset + 128, 1, true);
  view.setFloat64(offset + 136, 0, true);
  view.setFloat64(offset + 144, Math.PI / 4, true);
  view.setFloat64(offset + 152, 0, true);
  view.setFloat64(offset + 160, 0, true);
  writeU64(view, offset + 168, 0);
  writeU64(view, offset + 176, 1);
  view.setUint32(offset + 188, 2, true);
  new Uint8Array(buffer, stringOffset, pattern.byteLength).set(pattern);
  new Uint8Array(
    buffer,
    stringOffset + pattern.byteLength,
    gradient.byteLength,
  ).set(gradient);
  return {
    kind: SectionKind.HatchEntities,
    recordSize: HATCH_ENTITY_RECORD_SIZE,
    recordCount: 1,
    flags: 1,
    buffer,
  };
}

function makeHatchLoopSection() {
  const buffer = new ArrayBuffer(HATCH_LOOP_RECORD_SIZE * 2);
  const view = new DataView(buffer);
  const writeLoop = (offset, pathFlags, firstVertex, signedArea) => {
    writeU64(view, offset, 0);
    view.setUint32(offset + 8, pathFlags, true);
    writeU64(view, offset + 16, firstVertex);
    writeU64(view, offset + 24, 4);
    view.setUint32(offset + 32, 4, true);
    view.setFloat64(offset + 40, signedArea, true);
  };
  writeLoop(0, 1, 0, 100);
  writeLoop(HATCH_LOOP_RECORD_SIZE, 0, 4, -16);
  return {
    kind: SectionKind.HatchLoops,
    recordSize: HATCH_LOOP_RECORD_SIZE,
    recordCount: 2,
    flags: 0,
    buffer,
  };
}

function makeHatchVertexSection() {
  const points = [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
    [0, 10, 0],
    [3, 3, 0],
    [3, 7, 0],
    [7, 7, 0],
    [7, 3, 0],
  ];
  const buffer = new ArrayBuffer(HATCH_VERTEX_RECORD_SIZE * points.length);
  const view = new DataView(buffer);
  points.forEach((point, index) =>
    writeVec3(view, index * HATCH_VERTEX_RECORD_SIZE, point),
  );
  return {
    kind: SectionKind.HatchVertices,
    recordSize: HATCH_VERTEX_RECORD_SIZE,
    recordCount: points.length,
    flags: 0,
    buffer,
  };
}

function makeHatchGradientColorSection() {
  const buffer = new ArrayBuffer(HATCH_GRADIENT_COLOR_RECORD_SIZE * 2);
  const view = new DataView(buffer);
  view.setFloat64(0, 0, true);
  view.setUint32(8, (3 << 30) | (255 << 16), true);
  view.setFloat64(HATCH_GRADIENT_COLOR_RECORD_SIZE, 1, true);
  view.setUint32(
    HATCH_GRADIENT_COLOR_RECORD_SIZE + 8,
    (3 << 30) | 255,
    true,
  );
  return {
    kind: SectionKind.HatchGradientColors,
    recordSize: HATCH_GRADIENT_COLOR_RECORD_SIZE,
    recordCount: 2,
    flags: 0,
    buffer,
  };
}

function makeHatchSeedPointSection() {
  const buffer = new ArrayBuffer(HATCH_SEED_POINT_RECORD_SIZE);
  const view = new DataView(buffer);
  view.setFloat64(0, 1, true);
  view.setFloat64(8, 1, true);
  return {
    kind: SectionKind.HatchSeedPoints,
    recordSize: HATCH_SEED_POINT_RECORD_SIZE,
    recordCount: 1,
    flags: 0,
    buffer,
  };
}

function makeHatchPatternLineSection() {
  const rows = [
    {
      sourceLineIndex: 0,
      angle: 0,
      basePoint: [0, 0],
      offset: [0, 2],
      firstDash: 0,
      dashCount: 2,
    },
    {
      sourceLineIndex: 1,
      angle: Math.PI / 2,
      basePoint: [0, 0],
      offset: [2, 0],
      firstDash: 2,
      dashCount: 0,
    },
  ];
  const buffer = new ArrayBuffer(HATCH_PATTERN_LINE_RECORD_SIZE * rows.length);
  const view = new DataView(buffer);
  rows.forEach((row, index) => {
    const offset = index * HATCH_PATTERN_LINE_RECORD_SIZE;
    writeU64(view, offset, 0);
    view.setUint32(offset + 8, row.sourceLineIndex, true);
    view.setFloat64(offset + 16, row.angle, true);
    view.setFloat64(offset + 24, row.basePoint[0], true);
    view.setFloat64(offset + 32, row.basePoint[1], true);
    view.setFloat64(offset + 40, row.offset[0], true);
    view.setFloat64(offset + 48, row.offset[1], true);
    writeU64(view, offset + 56, row.firstDash);
    view.setUint32(offset + 64, row.dashCount, true);
  });
  return {
    kind: SectionKind.HatchPatternLines,
    recordSize: HATCH_PATTERN_LINE_RECORD_SIZE,
    recordCount: rows.length,
    flags: 0,
    buffer,
  };
}

function makeHatchPatternDashSection() {
  const dashes = [3, -1];
  const buffer = new ArrayBuffer(HATCH_PATTERN_DASH_RECORD_SIZE * dashes.length);
  const view = new DataView(buffer);
  dashes.forEach((dash, index) =>
    view.setFloat64(index * HATCH_PATTERN_DASH_RECORD_SIZE, dash, true),
  );
  return {
    kind: SectionKind.HatchPatternDashes,
    recordSize: HATCH_PATTERN_DASH_RECORD_SIZE,
    recordCount: dashes.length,
    flags: 0,
    buffer,
  };
}

function writePrimitiveCommon(
  view,
  offset,
  { handle, ownerHandle, color = 0, invisible = false },
) {
  writeU64(view, offset, handle);
  writeU64(view, offset + 8, ownerHandle);
  view.setUint32(offset + 16, 0, true);
  view.setUint32(offset + 20, color >>> 0, true);
  view.setInt16(offset + 24, -1, true);
  view.setUint16(offset + 26, invisible ? 1 : 0, true);
}

function makePointEntitySection() {
  const buffer = new ArrayBuffer(POINT_ENTITY_RECORD_SIZE);
  const view = new DataView(buffer);
  writePrimitiveCommon(view, 0, {
    handle: 501,
    ownerHandle: 101,
    color: (2 << 30) | 3,
  });
  writeVec3(view, 32, [11, 2, 0]);
  writeVec3(view, 56, [0, 0, 1]);
  view.setFloat64(80, 0, true);
  view.setFloat64(88, Math.PI / 6, true);
  view.setFloat64(96, -3, true);
  view.setInt16(104, 66, true);
  return {
    kind: SectionKind.PointEntities,
    recordSize: POINT_ENTITY_RECORD_SIZE,
    recordCount: 1,
    flags: 0,
    buffer,
  };
}

function makeSolidEntitySection() {
  const rows = [
    {
      handle: 601,
      ownerHandle: 100,
      fillMode: true,
      corners: [
        [0, 0, 0],
        [4, 0, 0],
        [4, 3, 0],
        [0, 3, 0],
      ],
    },
    {
      handle: 602,
      ownerHandle: 101,
      fillMode: false,
      corners: [
        [10, 0, 0],
        [12, 0, 0],
        [11, 2, 0],
        [11, 2, 0],
      ],
    },
  ];
  const buffer = new ArrayBuffer(SOLID_ENTITY_RECORD_SIZE * rows.length);
  const view = new DataView(buffer);
  rows.forEach((row, index) => {
    const offset = index * SOLID_ENTITY_RECORD_SIZE;
    writePrimitiveCommon(view, offset, row);
    view.setUint32(offset + 32, row.fillMode ? 1 : 0, true);
    row.corners.forEach((corner, cornerIndex) =>
      writeVec3(view, offset + 40 + cornerIndex * 24, corner),
    );
    writeVec3(view, offset + 136, [0, 0, 1]);
    view.setFloat64(offset + 160, 0, true);
  });
  return {
    kind: SectionKind.SolidEntities,
    recordSize: SOLID_ENTITY_RECORD_SIZE,
    recordCount: rows.length,
    flags: 0,
    buffer,
  };
}

function makeFaceEntitySection(recordCount = 5) {
  const rows = [
    {
      handle: 701,
      ownerHandle: 100,
      invisibleEdges: 1,
      corners: [
        [20, 0, 0],
        [24, 0, 0],
        [24, 3, 0],
        [20, 3, 0],
      ],
    },
    {
      handle: 702,
      ownerHandle: 100,
      invisibleEdges: 2,
      corners: [
        [25, 0, 0],
        [29, 0, 0],
        [29, 3, 0],
        [25, 3, 0],
      ],
    },
    {
      handle: 703,
      ownerHandle: 101,
      invisibleEdges: 4,
      corners: [
        [30, 0, 0],
        [34, 0, 0],
        [34, 3, 0],
        [30, 3, 0],
      ],
    },
    {
      handle: 704,
      ownerHandle: 101,
      invisibleEdges: 8,
      corners: [
        [35, 0, 0],
        [39, 0, 0],
        [39, 3, 0],
        [35, 3, 0],
      ],
    },
    {
      handle: 705,
      ownerHandle: 100,
      invisibleEdges: 0,
      corners: [
        [40, 0, 0],
        [44, 0, 0],
        [42, 3, 0],
        [42, 3, 0],
      ],
    },
  ];
  const buffer = new ArrayBuffer(FACE_ENTITY_RECORD_SIZE * recordCount);
  const view = new DataView(buffer);
  rows.slice(0, recordCount).forEach((row, index) => {
    const offset = index * FACE_ENTITY_RECORD_SIZE;
    writePrimitiveCommon(view, offset, row);
    view.setUint32(offset + 32, row.invisibleEdges, true);
    row.corners.forEach((corner, cornerIndex) =>
      writeVec3(view, offset + 40 + cornerIndex * 24, corner),
    );
  });
  return {
    kind: SectionKind.FaceEntities,
    recordSize: FACE_ENTITY_RECORD_SIZE,
    recordCount,
    flags: 0,
    buffer,
  };
}

const WIPEOUT_ROWS = Object.freeze([
  Object.freeze({
    handle: 801,
    ownerHandle: 100,
    classVersion: 1,
    displayProperties: 5,
    clipType: 2,
    clippingEnabled: true,
    brightness: 50,
    contrast: 50,
    fade: 0,
    clipMode: 0,
    insertionPoint: [50, 0, 0],
    uVector: [2, 0, 0],
    vVector: [0, 3, 0],
    size: [10, 10],
    clipVertices: [
      [0, 0],
      [2, 0],
      [2, 1],
      [0, 1],
    ],
  }),
  Object.freeze({
    handle: 802,
    ownerHandle: 101,
    classVersion: 2,
    displayProperties: 5,
    clipType: 1,
    clippingEnabled: true,
    brightness: 40,
    contrast: 60,
    fade: 10,
    clipMode: 0,
    insertionPoint: [60, 0, 0],
    uVector: [1, 0, 0],
    vVector: [0, 1, 0],
    size: [8, 6],
    clipVertices: [
      [-0.5, -0.5],
      [7.5, 5.5],
    ],
  }),
  Object.freeze({
    handle: 803,
    ownerHandle: 100,
    classVersion: 3,
    displayProperties: 1,
    clipType: 2,
    clippingEnabled: false,
    brightness: 50,
    contrast: 50,
    fade: 0,
    clipMode: 1,
    insertionPoint: [70, 0, 0],
    uVector: [1, 0, 0],
    vVector: [0, 1, 0],
    size: [4, 3],
    clipVertices: [
      [0, 0],
      [1, 0],
      [0, 1],
    ],
  }),
]);

function makeWipeoutEntitySection(recordCount = WIPEOUT_ROWS.length) {
  const buffer = new ArrayBuffer(WIPEOUT_ENTITY_RECORD_SIZE * recordCount);
  const view = new DataView(buffer);
  let firstClipVertex = 0;
  WIPEOUT_ROWS.slice(0, recordCount).forEach((row, index) => {
    const offset = index * WIPEOUT_ENTITY_RECORD_SIZE;
    writePrimitiveCommon(view, offset, row);
    view.setInt32(offset + 32, row.classVersion, true);
    view.setUint16(offset + 36, row.displayProperties, true);
    view.setUint8(offset + 38, row.clipType);
    view.setUint8(offset + 39, Number(row.clippingEnabled));
    view.setUint8(offset + 40, row.brightness);
    view.setUint8(offset + 41, row.contrast);
    view.setUint8(offset + 42, row.fade);
    view.setUint8(offset + 43, row.clipMode);
    writeU64(view, offset + 48, firstClipVertex);
    view.setUint32(offset + 56, row.clipVertices.length, true);
    writeU64(view, offset + 64, 900 + index * 2);
    writeU64(view, offset + 72, 901 + index * 2);
    writeVec3(view, offset + 80, row.insertionPoint);
    writeVec3(view, offset + 104, row.uVector);
    writeVec3(view, offset + 128, row.vVector);
    view.setFloat64(offset + 152, row.size[0], true);
    view.setFloat64(offset + 160, row.size[1], true);
    firstClipVertex += row.clipVertices.length;
  });
  return {
    kind: SectionKind.WipeoutEntities,
    recordSize: WIPEOUT_ENTITY_RECORD_SIZE,
    recordCount,
    flags: 0,
    buffer,
  };
}

function makeWipeoutClipVertexSection() {
  const vertices = WIPEOUT_ROWS.flatMap((row) => row.clipVertices);
  const buffer = new ArrayBuffer(
    WIPEOUT_CLIP_VERTEX_RECORD_SIZE * vertices.length,
  );
  const view = new DataView(buffer);
  vertices.forEach((point, index) => {
    const offset = index * WIPEOUT_CLIP_VERTEX_RECORD_SIZE;
    view.setFloat64(offset, point[0], true);
    view.setFloat64(offset + 8, point[1], true);
  });
  return {
    kind: SectionKind.WipeoutClipVertices,
    recordSize: WIPEOUT_CLIP_VERTEX_RECORD_SIZE,
    recordCount: vertices.length,
    flags: 0,
    buffer,
  };
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

function makeDrawOrderTableSection() {
  const buffer = new ArrayBuffer(DRAW_ORDER_TABLE_RECORD_SIZE * 2);
  const view = new DataView(buffer);
  writeU64(view, 0, 0x900);
  writeU64(view, 8, 100);
  writeU64(view, 16, 0);
  writeU64(view, 24, 2);
  const second = DRAW_ORDER_TABLE_RECORD_SIZE;
  writeU64(view, second, 0x901);
  writeU64(view, second + 8, 101);
  writeU64(view, second + 16, 2);
  writeU64(view, second + 24, 1);
  return {
    kind: SectionKind.DrawOrderTables,
    recordSize: DRAW_ORDER_TABLE_RECORD_SIZE,
    recordCount: 2,
    flags: 0,
    buffer,
  };
}

function makeDrawOrderEntrySection() {
  const rows = [
    [0x301, 0x102],
    [0x302, 0x101],
    [0x401, 0x401],
  ];
  const buffer = new ArrayBuffer(DRAW_ORDER_ENTRY_RECORD_SIZE * rows.length);
  const view = new DataView(buffer);
  rows.forEach(([entityHandle, sortHandle], index) => {
    const offset = index * DRAW_ORDER_ENTRY_RECORD_SIZE;
    writeU64(view, offset, entityHandle);
    writeU64(view, offset + 8, sortHandle);
  });
  return {
    kind: SectionKind.DrawOrderEntries,
    recordSize: DRAW_ORDER_ENTRY_RECORD_SIZE,
    recordCount: rows.length,
    flags: 0,
    buffer,
  };
}

export function makeFixtureCache({
  minorVersion = 2,
  includeText = minorVersion >= 4,
  includeHatch = minorVersion >= 6,
  faceRecordCount = 5,
  wipeoutFrame = 1,
  wipeoutRecordCount = WIPEOUT_ROWS.length,
} = {}) {
  const sections = [
    makeDrawingSection(minorVersion >= 10 ? wipeoutFrame : 0),
    makeLayerSection(),
    makeBlockSection(),
    ...(includeText ? [makeTextStyleSection()] : []),
    makeInsertSection(),
    ...(includeText
      ? [makeTextEntitySection(), makeTextColumnHeightSection()]
      : []),
    makeBatchSection(),
    makeVertexSection(),
    ...(includeHatch
      ? [
          makeHatchEntitySection(),
          makeHatchLoopSection(),
          makeHatchVertexSection(),
          makeHatchGradientColorSection(),
          makeHatchSeedPointSection(),
          ...(minorVersion >= 7
            ? [
                makeHatchPatternLineSection(),
                makeHatchPatternDashSection(),
              ]
            : []),
        ]
      : []),
    ...(minorVersion >= 8
      ? [makePointEntitySection(), makeSolidEntitySection()]
      : []),
    ...(minorVersion >= 9
      ? [makeFaceEntitySection(faceRecordCount)]
      : []),
    ...(minorVersion >= 10
      ? [
          makeWipeoutEntitySection(wipeoutRecordCount),
          makeWipeoutClipVertexSection(),
        ]
      : []),
    ...(minorVersion >= 11
      ? [makeDrawOrderTableSection(), makeDrawOrderEntrySection()]
      : []),
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
  view.setUint16(10, minorVersion, true);
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

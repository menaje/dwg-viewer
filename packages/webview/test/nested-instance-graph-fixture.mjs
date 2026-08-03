import { buildInstanceGraph } from "../src/instance-graph.mjs";

export const NESTED_INSTANCE_HANDLES = Object.freeze({
  outer: 0x2an,
  child: 0x2bn,
  grandchild: 0x2cn,
});

export const NESTED_INSTANCE_BLOCKS = Object.freeze([
  Object.freeze({
    index: 0,
    handle: 0x100n,
    name: "*Model_Space",
    basePoint: Object.freeze([0, 0, 0]),
  }),
  Object.freeze({
    index: 1,
    handle: 0x101n,
    name: "A",
    basePoint: Object.freeze([0, 0, 0]),
  }),
  Object.freeze({
    index: 2,
    handle: 0x102n,
    name: "B",
    basePoint: Object.freeze([0, 0, 0]),
  }),
  Object.freeze({
    index: 3,
    handle: 0x103n,
    name: "C",
    basePoint: Object.freeze([0, 0, 0]),
  }),
]);

export const NESTED_INSTANCE_LAYERS = Object.freeze([
  Object.freeze({
    name: "0",
    color: ((2 << 30) | 7) >>> 0,
    lineWeight: -3,
  }),
  Object.freeze({
    name: "A-WALL",
    color: ((2 << 30) | 3) >>> 0,
    lineWeight: 25,
  }),
  Object.freeze({
    name: "A-DETAIL",
    color: ((2 << 30) | 5) >>> 0,
    lineWeight: 40,
  }),
]);

function insert({
  handle,
  ownerHandle,
  blockIndex,
  insertPoint,
  layerIndex,
  color,
  lineWeight,
  linetypeCode,
  columnCount = 1,
  columnSpacing = 0,
}) {
  return Object.freeze({
    handle,
    ownerHandle,
    blockIndex,
    insertPoint,
    layerIndex,
    color,
    lineWeight,
    linetypeCode,
    columnCount,
    rowCount: 1,
    scale: Object.freeze([1, 1, 1]),
    rotation: 0,
    normal: Object.freeze([0, 0, 1]),
    columnSpacing,
    rowSpacing: 0,
  });
}

export function nestedInstanceGraph({
  clippedHandle = null,
  outerColumns = 1,
} = {}) {
  const blocks = NESTED_INSTANCE_BLOCKS;
  const layers = NESTED_INSTANCE_LAYERS;
  const byBlock =
    ((2 << 24) | (1 << 30)) >>> 0;
  const inserts = Object.freeze([
    insert({
      handle: NESTED_INSTANCE_HANDLES.outer,
      ownerHandle: blocks[0].handle,
      blockIndex: 1,
      insertPoint: Object.freeze([10, 20, 0]),
      layerIndex: 1,
      color: ((33 << 24) | (2 << 30) | 3) >>> 0,
      lineWeight: 35,
      linetypeCode: 3,
      columnCount: outerColumns,
      columnSpacing: 100,
    }),
    insert({
      handle: NESTED_INSTANCE_HANDLES.child,
      ownerHandle: blocks[1].handle,
      blockIndex: 2,
      insertPoint: Object.freeze([2, 3, 0]),
      layerIndex: 0,
      color: byBlock,
      lineWeight: -2,
      linetypeCode: 1,
    }),
    insert({
      handle: NESTED_INSTANCE_HANDLES.grandchild,
      ownerHandle: blocks[2].handle,
      blockIndex: 3,
      insertPoint: Object.freeze([4, 5, 0]),
      layerIndex: 0,
      color: byBlock,
      lineWeight: -2,
      linetypeCode: 1,
    }),
  ]);
  const insertClips =
    clippedHandle === null
      ? Object.freeze([])
      : Object.freeze([
          Object.freeze({
            insertHandle: clippedHandle,
            rectangular: true,
            inverted: false,
            vertices: Object.freeze([
              Object.freeze([0, 0, 0]),
              Object.freeze([1, 1, 0]),
            ]),
          }),
        ]);
  return buildInstanceGraph(blocks, inserts, {
    layers,
    layerLinetypeCodes: new Uint16Array([2, 7, 9]),
    insertClips,
  });
}

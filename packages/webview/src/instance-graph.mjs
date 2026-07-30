import {
  identityMat4,
  insertCellMatrix,
  multiplyMat4,
} from "./math.mjs";

const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_INSTANCES = 1_000_000;
const MATRIX_VALUES = 16;
const MATRICES_PER_CHUNK = 256;

class MatrixCollectionBuilder {
  constructor() {
    this.chunks = [];
    this.count = 0;
  }

  add(matrix) {
    const chunkIndex = Math.floor(this.count / MATRICES_PER_CHUNK);
    const indexInChunk = this.count % MATRICES_PER_CHUNK;
    if (!this.chunks[chunkIndex]) {
      this.chunks[chunkIndex] = new Float64Array(
        MATRICES_PER_CHUNK * MATRIX_VALUES,
      );
    }
    this.chunks[chunkIndex].set(matrix, indexInChunk * MATRIX_VALUES);
    this.count += 1;
  }

  finish() {
    const data = new Float64Array(this.count * MATRIX_VALUES);
    let destination = 0;
    for (const chunk of this.chunks) {
      const remaining = data.length - destination;
      const length = Math.min(chunk.length, remaining);
      data.set(chunk.subarray(0, length), destination);
      destination += length;
    }
    return Object.freeze({ data, count: this.count, length: this.count });
  }
}

export function buildInstanceGraph(
  blocks,
  inserts,
  {
    maximumDepth = DEFAULT_MAX_DEPTH,
    maximumInstances = DEFAULT_MAX_INSTANCES,
  } = {},
) {
  const blockIndexByHandle = new Map(
    blocks.map((block) => [block.handle, block.index]),
  );
  const modelBlockIndices = new Set(
    blocks
      .filter((block) => block.name.toUpperCase() === "*MODEL_SPACE")
      .map((block) => block.index),
  );
  const insertsByOwner = new Map();
  const diagnostics = {
    invalidOwner: 0,
    invalidTarget: 0,
    cycles: 0,
    depthLimit: 0,
    instanceLimit: 0,
  };

  for (const insert of inserts) {
    const ownerIndex = blockIndexByHandle.get(insert.ownerHandle);
    if (ownerIndex === undefined) {
      diagnostics.invalidOwner += 1;
      continue;
    }
    let owned = insertsByOwner.get(ownerIndex);
    if (!owned) {
      owned = [];
      insertsByOwner.set(ownerIndex, owned);
    }
    owned.push(insert);
  }

  const instanceBuilders = new Map();
  let instanceCount = 0;
  let stopped = false;

  const addInstance = (blockIndex, matrix) => {
    let builder = instanceBuilders.get(blockIndex);
    if (!builder) {
      builder = new MatrixCollectionBuilder();
      instanceBuilders.set(blockIndex, builder);
    }
    builder.add(matrix);
    instanceCount += 1;
    if (instanceCount >= maximumInstances) {
      diagnostics.instanceLimit += 1;
      stopped = true;
    }
  };

  const visitInsert = (insert, parentMatrix, path, depth) => {
    if (stopped) {
      return;
    }
    if (depth > maximumDepth) {
      diagnostics.depthLimit += 1;
      return;
    }
    const target = blocks[insert.blockIndex];
    if (!target) {
      diagnostics.invalidTarget += 1;
      return;
    }
    if (path.has(target.index)) {
      diagnostics.cycles += 1;
      return;
    }

    const columns = Math.max(insert.columnCount, 1);
    const rows = Math.max(insert.rowCount, 1);
    for (let row = 0; row < rows && !stopped; row += 1) {
      for (let column = 0; column < columns && !stopped; column += 1) {
        const local = insertCellMatrix(insert, target.basePoint, column, row);
        const world = multiplyMat4(parentMatrix, local);
        addInstance(target.index, world);

        const nested = insertsByOwner.get(target.index);
        if (!nested || stopped) {
          continue;
        }
        const nestedPath = new Set(path);
        nestedPath.add(target.index);
        for (const child of nested) {
          visitInsert(child, world, nestedPath, depth + 1);
          if (stopped) {
            break;
          }
        }
      }
    }
  };

  const identity = identityMat4();
  for (const modelIndex of modelBlockIndices) {
    const roots = insertsByOwner.get(modelIndex) ?? [];
    for (const insert of roots) {
      visitInsert(insert, identity, new Set([modelIndex]), 1);
      if (stopped) {
        break;
      }
    }
    if (stopped) {
      break;
    }
  }

  const instancesByBlock = new Map(
    [...instanceBuilders].map(([blockIndex, builder]) => [
      blockIndex,
      builder.finish(),
    ]),
  );

  return Object.freeze({
    instancesByBlock,
    insertsByOwner,
    modelBlockIndices,
    instanceCount,
    diagnostics: Object.freeze(diagnostics),
    truncated: stopped,
  });
}

export { DEFAULT_MAX_DEPTH, DEFAULT_MAX_INSTANCES };

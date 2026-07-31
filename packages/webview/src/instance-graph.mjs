import {
  identityMat4,
  insertCellMatrix,
  multiplyMat4,
} from "./math.mjs";
import {
  MAX_GLOBAL_MASK_BUCKET,
  maskBucketBefore,
  maskSpanForBlock,
} from "./mask-order.mjs";

const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_INSTANCES = 1_000_000;
const MATRIX_VALUES = 16;
const MATRICES_PER_CHUNK = 256;

class MatrixCollectionBuilder {
  constructor(includeMaskBases) {
    this.includeMaskBases = includeMaskBases;
    this.chunks = [];
    this.maskBaseChunks = [];
    this.count = 0;
  }

  add(matrix, maskBase) {
    const chunkIndex = Math.floor(this.count / MATRICES_PER_CHUNK);
    const indexInChunk = this.count % MATRICES_PER_CHUNK;
    if (!this.chunks[chunkIndex]) {
      this.chunks[chunkIndex] = new Float64Array(
        MATRICES_PER_CHUNK * MATRIX_VALUES,
      );
      if (this.includeMaskBases) {
        this.maskBaseChunks[chunkIndex] = new Uint32Array(
          MATRICES_PER_CHUNK,
        );
      }
    }
    this.chunks[chunkIndex].set(matrix, indexInChunk * MATRIX_VALUES);
    if (this.includeMaskBases) {
      this.maskBaseChunks[chunkIndex][indexInChunk] = maskBase;
    }
    this.count += 1;
  }

  finish() {
    const data = new Float64Array(this.count * MATRIX_VALUES);
    const maskBases = this.includeMaskBases
      ? new Uint32Array(this.count)
      : null;
    let destination = 0;
    let maskDestination = 0;
    for (let index = 0; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index];
      const remaining = data.length - destination;
      const length = Math.min(chunk.length, remaining);
      data.set(chunk.subarray(0, length), destination);
      destination += length;
      if (this.includeMaskBases) {
        const maskChunk = this.maskBaseChunks[index];
        const maskLength = Math.min(
          maskChunk.length,
          maskBases.length - maskDestination,
        );
        maskBases.set(maskChunk.subarray(0, maskLength), maskDestination);
        maskDestination += maskLength;
      }
    }
    const result = {
      data,
      count: this.count,
      length: this.count,
    };
    if (maskBases) {
      result.maskBases = maskBases;
    }
    return Object.freeze(result);
  }
}

export function buildInstanceGraph(
  blocks,
  inserts,
  {
    maximumDepth = DEFAULT_MAX_DEPTH,
    maximumInstances = DEFAULT_MAX_INSTANCES,
    maskOrder = null,
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

  const addInstance = (blockIndex, matrix, maskBase) => {
    let builder = instanceBuilders.get(blockIndex);
    if (!builder) {
      builder = new MatrixCollectionBuilder(Boolean(maskOrder?.enabled));
      instanceBuilders.set(blockIndex, builder);
    }
    builder.add(matrix, maskBase);
    instanceCount += 1;
    if (instanceCount >= maximumInstances) {
      diagnostics.instanceLimit += 1;
      stopped = true;
    }
  };

  const visitInsert = (
    insert,
    parentMatrix,
    parentMaskBase,
    path,
    depth,
  ) => {
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
    const ownerBlockIndex = blockIndexByHandle.get(insert.ownerHandle);
    const ownerHandle =
      ownerBlockIndex === undefined
        ? insert.ownerHandle
        : blocks[ownerBlockIndex].handle;
    const prefix = maskBucketBefore(
      maskOrder,
      ownerHandle,
      insert.handle,
    );
    const targetSpan = maskSpanForBlock(maskOrder, target.index);
    for (let row = 0; row < rows && !stopped; row += 1) {
      for (let column = 0; column < columns && !stopped; column += 1) {
        const local = insertCellMatrix(insert, target.basePoint, column, row);
        const world = multiplyMat4(parentMatrix, local);
        const cellIndex = row * columns + column;
        const maskBase =
          parentMaskBase + prefix + cellIndex * targetSpan;
        if (
          !Number.isSafeInteger(maskBase) ||
          maskBase < 0 ||
          maskBase > MAX_GLOBAL_MASK_BUCKET
        ) {
          diagnostics.instanceLimit += 1;
          stopped = true;
          break;
        }
        addInstance(target.index, world, maskBase);

        const nested = insertsByOwner.get(target.index);
        if (!nested || stopped) {
          continue;
        }
        const nestedPath = new Set(path);
        nestedPath.add(target.index);
        for (const child of nested) {
          visitInsert(
            child,
            world,
            maskBase,
            nestedPath,
            depth + 1,
          );
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
      visitInsert(
        insert,
        identity,
        0,
        new Set([modelIndex]),
        1,
      );
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
    maskOrderEnabled:
      Boolean(maskOrder?.enabled) &&
      !stopped &&
      diagnostics.invalidOwner === 0 &&
      diagnostics.invalidTarget === 0 &&
      diagnostics.cycles === 0 &&
      diagnostics.depthLimit === 0,
  });
}

export function applyMaskOrderToInstanceGraph(
  instanceGraph,
  blocks,
  maskOrder,
  { maximumDepth = DEFAULT_MAX_DEPTH } = {},
) {
  if (!maskOrder?.enabled) {
    return instanceGraph;
  }
  if (
    instanceGraph.truncated ||
    Object.values(instanceGraph.diagnostics).some((value) => value !== 0)
  ) {
    return Object.freeze({
      ...instanceGraph,
      maskOrderEnabled: false,
    });
  }
  const blockIndexByHandle = new Map(
    blocks.map((block) => [block.handle, block.index]),
  );
  const cursors = new Uint32Array(blocks.length);
  const maskBasesByBlock = new Map(
    [...instanceGraph.instancesByBlock].map(([blockIndex, instances]) => [
      blockIndex,
      new Uint32Array(instances.count),
    ]),
  );
  let valid = true;

  const visitInsert = (insert, parentMaskBase, path, depth) => {
    if (!valid) {
      return;
    }
    if (depth > maximumDepth) {
      valid = false;
      return;
    }
    const target = blocks[insert.blockIndex];
    if (!target || path.has(target.index)) {
      valid = false;
      return;
    }
    const ownerBlockIndex = blockIndexByHandle.get(insert.ownerHandle);
    const ownerHandle =
      ownerBlockIndex === undefined
        ? insert.ownerHandle
        : blocks[ownerBlockIndex].handle;
    const prefix = maskBucketBefore(
      maskOrder,
      ownerHandle,
      insert.handle,
    );
    const targetSpan = maskSpanForBlock(maskOrder, target.index);
    const columns = Math.max(insert.columnCount, 1);
    const rows = Math.max(insert.rowCount, 1);
    for (let row = 0; row < rows && valid; row += 1) {
      for (let column = 0; column < columns && valid; column += 1) {
        const cellIndex = row * columns + column;
        const maskBase =
          parentMaskBase + prefix + cellIndex * targetSpan;
        const destination = maskBasesByBlock.get(target.index);
        const cursor = cursors[target.index];
        if (
          !destination ||
          cursor >= destination.length ||
          !Number.isSafeInteger(maskBase) ||
          maskBase < 0 ||
          maskBase > MAX_GLOBAL_MASK_BUCKET
        ) {
          valid = false;
          break;
        }
        destination[cursor] = maskBase;
        cursors[target.index] = cursor + 1;

        const nested = instanceGraph.insertsByOwner.get(target.index);
        if (!nested) {
          continue;
        }
        const nestedPath = new Set(path);
        nestedPath.add(target.index);
        for (const child of nested) {
          visitInsert(child, maskBase, nestedPath, depth + 1);
          if (!valid) {
            break;
          }
        }
      }
    }
  };

  for (const modelIndex of instanceGraph.modelBlockIndices) {
    for (const insert of instanceGraph.insertsByOwner.get(modelIndex) ?? []) {
      visitInsert(insert, 0, new Set([modelIndex]), 1);
      if (!valid) {
        break;
      }
    }
  }
  for (const [blockIndex, instances] of instanceGraph.instancesByBlock) {
    if (cursors[blockIndex] !== instances.count) {
      valid = false;
      break;
    }
  }
  if (!valid) {
    return Object.freeze({
      ...instanceGraph,
      maskOrderEnabled: false,
    });
  }
  const instancesByBlock = new Map(
    [...instanceGraph.instancesByBlock].map(([blockIndex, instances]) => [
      blockIndex,
      Object.freeze({
        ...instances,
        maskBases: maskBasesByBlock.get(blockIndex),
      }),
    ]),
  );
  return Object.freeze({
    ...instanceGraph,
    instancesByBlock,
    maskOrderEnabled: true,
  });
}

export { DEFAULT_MAX_DEPTH, DEFAULT_MAX_INSTANCES };

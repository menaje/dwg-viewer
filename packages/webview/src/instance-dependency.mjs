function validInstanceGraph(instanceGraph) {
  return (
    instanceGraph &&
    instanceGraph.truncated !== true &&
    !(instanceGraph.diagnostics &&
      Object.values(instanceGraph.diagnostics).some(
        (value) => value !== 0,
      )) &&
    instanceGraph.instancesByBlock instanceof Map &&
    instanceGraph.insertsByOwner instanceof Map &&
    Array.isArray(instanceGraph.traversalRoots)
  );
}

export function walkInstanceDependencyOccurrences(
  instanceGraph,
  visitor,
) {
  if (!validInstanceGraph(instanceGraph) || typeof visitor !== "function") {
    throw new TypeError(
      "DWG instance dependency graph is unavailable",
    );
  }
  const dependencyBlockIndices =
    instanceGraph.dependencyBlockIndices instanceof Set
      ? instanceGraph.dependencyBlockIndices
      : new Set(instanceGraph.instancesByBlock.keys());
  const cursors = new Map(
    [...dependencyBlockIndices].map((blockIndex) => [
      blockIndex,
      0,
    ]),
  );
  const maximumDepth =
    Number.isSafeInteger(instanceGraph.maximumDepth) &&
    instanceGraph.maximumDepth > 0
      ? instanceGraph.maximumDepth
      : 64;

  const nextInstance = (blockIndex, expectedHandle) => {
    const instances =
      instanceGraph.instancesByBlock.get(blockIndex);
    const instanceIndex = cursors.get(blockIndex) ?? 0;
    if (
      !instances ||
      !Number.isSafeInteger(instances.count) ||
      instanceIndex >= instances.count ||
      (expectedHandle !== null &&
        instances.handles?.[instanceIndex] !== expectedHandle)
    ) {
      throw new TypeError(
        "DWG instance dependency topology is inconsistent",
      );
    }
    cursors.set(blockIndex, instanceIndex + 1);
    return [instances, instanceIndex];
  };

  const visitInsert = (
    insert,
    parentInstances,
    parentInstanceIndex,
    parentState,
    path,
    depth,
  ) => {
    if (
      depth > maximumDepth ||
      !Number.isSafeInteger(insert?.blockIndex) ||
      path.has(insert.blockIndex)
    ) {
      throw new TypeError(
        "DWG instance dependency topology is inconsistent",
      );
    }
    const rows = Math.max(insert.rowCount ?? 1, 1);
    const columns = Math.max(insert.columnCount ?? 1, 1);
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const [instances, instanceIndex] = nextInstance(
          insert.blockIndex,
          insert.handle,
        );
        const state = visitor(
          instances,
          instanceIndex,
          parentInstances,
          parentInstanceIndex,
          parentState,
          insert,
        );
        const nested =
          instanceGraph.insertsByOwner.get(insert.blockIndex);
        if (!nested || nested.length === 0) {
          continue;
        }
        const nestedPath = new Set(path);
        nestedPath.add(insert.blockIndex);
        for (const child of nested) {
          visitInsert(
            child,
            instances,
            instanceIndex,
            state,
            nestedPath,
            depth + 1,
          );
        }
      }
    }
  };

  for (const root of instanceGraph.traversalRoots) {
    if (
      !Number.isSafeInteger(root?.blockIndex) ||
      root.blockIndex < 0
    ) {
      throw new TypeError(
        "DWG instance dependency topology is inconsistent",
      );
    }
    let rootInstances = null;
    let rootInstanceIndex = null;
    let rootState = null;
    if (
      Number.isSafeInteger(root.rootInstanceBlockIndex) &&
      Number.isSafeInteger(root.rootInstanceIndex)
    ) {
      if (root.includeRootBatch) {
        const [instances, instanceIndex] = nextInstance(
          root.rootInstanceBlockIndex,
          null,
        );
        if (instanceIndex !== root.rootInstanceIndex) {
          throw new TypeError(
            "DWG instance dependency topology is inconsistent",
          );
        }
        rootInstances = instances;
        rootInstanceIndex = instanceIndex;
      } else {
        rootInstances = instanceGraph.instancesByBlock.get(
          root.rootInstanceBlockIndex,
        );
        rootInstanceIndex = root.rootInstanceIndex;
        if (
          !rootInstances ||
          rootInstanceIndex >= rootInstances.count
        ) {
          throw new TypeError(
            "DWG instance dependency topology is inconsistent",
          );
        }
      }
      rootState = visitor(
        rootInstances,
        rootInstanceIndex,
        null,
        null,
        null,
        null,
      );
    }
    for (
      const insert of
      instanceGraph.insertsByOwner.get(root.blockIndex) ?? []
    ) {
      visitInsert(
        insert,
        rootInstances,
        rootInstanceIndex,
        rootState,
        new Set([root.blockIndex]),
        1,
      );
    }
  }
  for (const blockIndex of dependencyBlockIndices) {
    const instances =
      instanceGraph.instancesByBlock.get(blockIndex);
    if ((cursors.get(blockIndex) ?? 0) !== instances?.count) {
      throw new TypeError(
        "DWG instance dependency topology is inconsistent",
      );
    }
  }
}

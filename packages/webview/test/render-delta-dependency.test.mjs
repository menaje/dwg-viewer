import assert from "node:assert/strict";
import test from "node:test";

import {
  DwgRenderDependencyKind,
  dwgBlockRenderDependencyId,
  dwgTypeRenderDependencyId,
  indexDwgRenderDeltaDependencies,
  isDwgRenderDeltaBatchInvalidated,
  isDwgRenderDeltaBlockInvalidated,
  isDwgRenderDeltaOwnerInvalidated,
  isDwgRenderDeltaSceneInvalidated,
  parseDwgRenderDependencyId,
} from "../src/render-delta-dependency.mjs";
import { GpuLineBatchKind } from "../src/scene-cache.mjs";

function graph(modelBlockIndex = 0) {
  return {
    instancesByBlock: new Map(),
    modelBlockIndices: new Set([modelBlockIndex]),
  };
}

function scenes() {
  return new Map([
    [
      "root",
      {
        blocks: [
          { index: 0, handle: 0x100n },
          { index: 1, handle: 0x101n },
        ],
        instanceGraph: graph(),
      },
    ],
    [
      "cache:0:xref",
      {
        blocks: [
          { index: 0, handle: 0x100n },
          { index: 1, handle: 0x101n },
        ],
        instanceGraph: graph(),
      },
    ],
  ]);
}

test("round-trips scene-scoped DWG block and type dependencies", () => {
  const blockId = dwgBlockRenderDependencyId(
    "cache:0:xref",
    0x101n,
  );
  const typeId = dwgTypeRenderDependencyId(
    "root",
    "text-style",
    0x201n,
  );

  assert.deepEqual(parseDwgRenderDependencyId(blockId), {
    dependencyId: blockId,
    kind: DwgRenderDependencyKind.BLOCK,
    sceneId: "cache:0:xref",
    blockHandle: 0x101n,
  });
  assert.deepEqual(parseDwgRenderDependencyId(typeId), {
    dependencyId: typeId,
    kind: DwgRenderDependencyKind.TYPE,
    sceneId: "root",
    typeKind: "text-style",
    typeHandle: 0x201n,
  });
  assert.equal(parseDwgRenderDependencyId("service:type:wall"), null);
  assert.throws(
    () =>
      parseDwgRenderDependencyId(
        "dwg-dependency:block:root:0101",
      ),
    /not canonical/u,
  );
});

test("indexes exact root and XREF dependency scopes without duplication", () => {
  const rootBlock = dwgBlockRenderDependencyId("root", 0x101n);
  const xrefBlock = dwgBlockRenderDependencyId(
    "cache:0:xref",
    0x101n,
  );
  const rootType = dwgTypeRenderDependencyId(
    "root",
    "linetype",
    0x301n,
  );
  const index = indexDwgRenderDeltaDependencies(
    [
      xrefBlock,
      "service:type:wall",
      rootBlock,
      rootBlock,
    ],
    { scenes: scenes() },
  );

  assert.deepEqual(index.ids, [
    rootBlock,
    xrefBlock,
    "service:type:wall",
  ].sort());
  assert.equal(index.recognizedCount, 2);
  assert.equal(
    isDwgRenderDeltaBlockInvalidated(index, "root", 1),
    true,
  );
  assert.equal(
    isDwgRenderDeltaBlockInvalidated(
      index,
      "cache:0:xref",
      1,
    ),
    true,
  );
  assert.equal(
    isDwgRenderDeltaBlockInvalidated(index, "root", 0),
    false,
  );
  assert.equal(
    isDwgRenderDeltaSceneInvalidated(index, "root"),
    false,
  );

  const typed = indexDwgRenderDeltaDependencies([rootType], {
    scenes: scenes(),
  });
  assert.equal(
    isDwgRenderDeltaSceneInvalidated(typed, "root"),
    true,
  );
  assert.equal(
    isDwgRenderDeltaSceneInvalidated(
      typed,
      "cache:0:xref",
    ),
    false,
  );
});

test("invalidates matching base batches and owner blocks only", () => {
  const index = indexDwgRenderDeltaDependencies(
    [dwgBlockRenderDependencyId("root", 0x101n)],
    { scenes: scenes() },
  );
  const instanceGraph = graph();
  const blockBatch = {
    kind: GpuLineBatchKind.BlockDefinition,
    blockIndex: 1,
  };
  const modelBatch = {
    kind: GpuLineBatchKind.ModelOverview,
    blockIndex: null,
  };

  assert.equal(
    isDwgRenderDeltaBatchInvalidated(
      index,
      "root",
      blockBatch,
      instanceGraph,
    ),
    true,
  );
  assert.equal(
    isDwgRenderDeltaBatchInvalidated(
      index,
      "cache:0:xref",
      blockBatch,
      instanceGraph,
    ),
    false,
  );
  assert.equal(
    isDwgRenderDeltaBatchInvalidated(
      index,
      "root",
      modelBatch,
      instanceGraph,
    ),
    false,
  );
  assert.equal(
    isDwgRenderDeltaOwnerInvalidated(
      index,
      "root",
      0x101n,
      {
        blockIndexByHandle: new Map([[0x101n, 1]]),
        modelBlockIndices: new Set([0]),
      },
    ),
    true,
  );
  assert.equal(
    isDwgRenderDeltaOwnerInvalidated(
      index,
      "root",
      0x100n,
      {
        blockIndexByHandle: new Map([[0x100n, 0]]),
        modelBlockIndices: new Set([0]),
      },
    ),
    false,
  );
});

test("rejects stale canonical targets and can ignore other overlay scenes", () => {
  const missingScene = dwgBlockRenderDependencyId(
    "missing",
    0x101n,
  );
  const missingBlock = dwgBlockRenderDependencyId(
    "root",
    0xffffn,
  );

  assert.throws(
    () =>
      indexDwgRenderDeltaDependencies([missingScene], {
        scenes: scenes(),
      }),
    /scene missing is unavailable/u,
  );
  assert.throws(
    () =>
      indexDwgRenderDeltaDependencies([missingBlock], {
        scenes: scenes(),
      }),
    /block ffff is unavailable/u,
  );
  assert.deepEqual(
    indexDwgRenderDeltaDependencies([missingScene], {
      scenes: new Map([
        [
          "root",
          {
            blocks: [],
            instanceGraph: graph(),
          },
        ],
      ]),
      ignoreUnavailableScenes: true,
    }).ids,
    [missingScene],
  );
});

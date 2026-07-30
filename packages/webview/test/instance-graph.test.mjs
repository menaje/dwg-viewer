import assert from "node:assert/strict";
import test from "node:test";

import { buildInstanceGraph } from "../src/instance-graph.mjs";
import {
  batchRelativeInstanceMatrix,
  transformPoint,
} from "../src/math.mjs";
import { MemoryRangeSource } from "../src/range-source.mjs";
import { SceneCacheReader } from "../src/scene-cache.mjs";
import { makeFixtureCache } from "./cache-fixture.mjs";

test("resolves nested block instances without copying block geometry", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache()),
  );
  const [blocks, inserts] = await Promise.all([
    reader.readBlocks(),
    reader.readInserts(),
  ]);
  const graph = buildInstanceGraph(blocks, inserts);

  assert.equal(graph.instanceCount, 2);
  assert.equal(graph.instancesByBlock.get(1).length, 1);
  assert.equal(graph.instancesByBlock.get(2).length, 1);
  assert.deepEqual(graph.diagnostics, {
    invalidOwner: 0,
    invalidTarget: 0,
    cycles: 0,
    depthLimit: 0,
    instanceLimit: 0,
  });

  const blockAOrigin = transformPoint(
    graph.instancesByBlock.get(1).data,
    blocks[1].basePoint,
  );
  assert.deepEqual(blockAOrigin, [100, 200, 0]);

  const nestedOrigin = transformPoint(
    graph.instancesByBlock.get(2).data,
    blocks[2].basePoint,
  );
  assert.deepEqual(nestedOrigin, [90, 200, 0]);
});

test("camera rebasing keeps a small batch offset at a large world coordinate", () => {
  const world = new Float64Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    1_000_000_000.25, 1_000_000_000.5, 0, 1,
  ]);
  const relative = batchRelativeInstanceMatrix(
    world,
    [0.125, 0.25, 0],
    [1_000_000_000, 1_000_000_000, 0],
  );

  assert.equal(relative[12], 0.375);
  assert.equal(relative[13], 0.75);
});

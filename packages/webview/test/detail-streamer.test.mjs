import assert from "node:assert/strict";
import test from "node:test";

import {
  DetailStreamer,
  selectVisibleDetailBatches,
} from "../src/detail-streamer.mjs";
import { identityMat4 } from "../src/math.mjs";
import {
  GPU_LINE_VERTEX_RECORD_SIZE,
  GpuLineBatchKind,
} from "../src/scene-cache.mjs";

function detailBatch({
  id,
  kind = GpuLineBatchKind.ModelDetail,
  blockIndex = null,
  min = [0, 0, 0],
  max = [1, 1, 0],
  vertexCount = 2,
}) {
  return {
    id,
    kind,
    blockIndex,
    lodLevel: 1,
    bounds: { min, max },
    vertexCount,
  };
}

test("selects intersecting model and block detail without expanding geometry", () => {
  const matrices = new Float64Array(32);
  matrices.set(identityMat4(), 0);
  matrices.set(identityMat4(), 16);
  matrices[12] = 5;
  matrices[13] = 5;
  matrices[28] = 100;
  matrices[29] = 100;
  const instanceGraph = {
    instancesByBlock: new Map([
      [1, { data: matrices, count: 2, length: 2 }],
    ]),
  };
  const batches = [
    detailBatch({ id: 1, min: [-2, -2, 0], max: [2, 2, 0] }),
    detailBatch({
      id: 2,
      kind: GpuLineBatchKind.BlockDefinition,
      blockIndex: 1,
    }),
    detailBatch({ id: 3, min: [50, 50, 0], max: [60, 60, 0] }),
  ];
  const selected = selectVisibleDetailBatches(
    batches,
    instanceGraph,
    {
      origin: [0, 0, 0],
      worldWidth: 20,
      worldHeight: 20,
    },
  );

  assert.deepEqual(
    selected.map((candidate) => candidate.batch.id),
    [1, 2],
  );
  assert.deepEqual([...selected[1].instanceIndices], [0]);
  assert.equal(selected.byteLength, 4 * GPU_LINE_VERTEX_RECORD_SIZE);
});

test("streams selected batches into a byte-budgeted renderer cache", async () => {
  const added = [];
  const deleted = [];
  const selections = [];
  const renderer = {
    addDetailBatch(batch, vertices) {
      added.push(batch.id);
      return { id: batch.id, bytes: vertices.byteLength };
    },
    deleteDetailBatch(batchId) {
      deleted.push(batchId);
    },
    setDetailSelections(value) {
      selections.push(value.map((candidate) => candidate.batch.id));
    },
    redraw(camera) {
      return { camera, detailBatches: added.length };
    },
  };
  const reader = {
    async readBatchVertices(batch) {
      return {
        buffer: new ArrayBuffer(
          batch.vertexCount * GPU_LINE_VERTEX_RECORD_SIZE,
        ),
        byteLength: batch.vertexCount * GPU_LINE_VERTEX_RECORD_SIZE,
        vertexCount: batch.vertexCount,
      };
    },
  };
  const batch = detailBatch({ id: 7 });
  const streamer = new DetailStreamer(
    reader,
    renderer,
    [batch],
    { instancesByBlock: new Map() },
  );

  streamer.update({
    origin: [0, 0, 0],
    worldWidth: 10,
    worldHeight: 10,
  });
  const snapshot = await streamer.whenIdle();

  assert.deepEqual(added, [7]);
  assert.deepEqual(selections, [[7]]);
  assert.equal(snapshot.cache.entries, 1);
  assert.equal(snapshot.loading, 0);

  streamer.dispose();
  assert.deepEqual(deleted, [7]);
});

test("does not upload a detail batch after the streamer is disposed", async () => {
  let finishRead;
  const added = [];
  const renderer = {
    addDetailBatch(batch) {
      added.push(batch.id);
      return { id: batch.id };
    },
    deleteDetailBatch() {},
    setDetailSelections() {},
    redraw(camera) {
      return { camera };
    },
  };
  const reader = {
    readBatchVertices(batch) {
      return new Promise((resolve) => {
        finishRead = () =>
          resolve({
            buffer: new ArrayBuffer(
              batch.vertexCount * GPU_LINE_VERTEX_RECORD_SIZE,
            ),
            byteLength:
              batch.vertexCount * GPU_LINE_VERTEX_RECORD_SIZE,
            vertexCount: batch.vertexCount,
          });
      });
    },
  };
  const streamer = new DetailStreamer(
    reader,
    renderer,
    [detailBatch({ id: 8 })],
    { instancesByBlock: new Map() },
  );

  streamer.update({
    origin: [0, 0, 0],
    worldWidth: 10,
    worldHeight: 10,
  });
  await Promise.resolve();
  await Promise.resolve();
  streamer.dispose();
  finishRead();
  await streamer.whenIdle();

  assert.deepEqual(added, []);
});

test("can defer the initial redraw while a viewport coordinates sources", () => {
  let redraws = 0;
  let updates = 0;
  const renderer = {
    addDetailBatch() {},
    deleteDetailBatch() {},
    setDetailSelections() {},
    redraw(camera) {
      redraws += 1;
      return { camera };
    },
  };
  const streamer = new DetailStreamer(
    { readBatchVertices() {} },
    renderer,
    [],
    { instancesByBlock: new Map() },
    {
      onUpdate() {
        updates += 1;
      },
    },
  );

  const snapshot = streamer.update(
    {
      origin: [0, 0, 0],
      worldWidth: 10,
      worldHeight: 10,
    },
    { redraw: false, emit: false },
  );

  assert.equal(redraws, 0);
  assert.equal(updates, 0);
  assert.equal(snapshot.render, null);
  streamer.dispose();
});

test("redraws a completed detail batch with the latest interaction camera", async () => {
  let finishRead;
  const redraws = [];
  const renderer = {
    addDetailBatch(batch) {
      return { id: batch.id };
    },
    deleteDetailBatch() {},
    setDetailSelections() {},
    redraw(camera, options) {
      redraws.push({ camera, options });
      return { camera };
    },
  };
  const reader = {
    readBatchVertices(batch) {
      return new Promise((resolve) => {
        finishRead = () =>
          resolve({
            buffer: new ArrayBuffer(
              batch.vertexCount * GPU_LINE_VERTEX_RECORD_SIZE,
            ),
            byteLength:
              batch.vertexCount * GPU_LINE_VERTEX_RECORD_SIZE,
            vertexCount: batch.vertexCount,
          });
      });
    },
  };
  const streamer = new DetailStreamer(
    reader,
    renderer,
    [detailBatch({ id: 9 })],
    { instancesByBlock: new Map() },
  );
  const initialCamera = {
    origin: [0, 0, 0],
    worldWidth: 10,
    worldHeight: 10,
  };
  const latestCamera = {
    origin: [20, 10, 0],
    worldWidth: 40,
    worldHeight: 20,
  };

  streamer.update(initialCamera);
  await Promise.resolve();
  await Promise.resolve();
  streamer.setRenderCamera(latestCamera, { interactive: true });
  finishRead();
  await streamer.whenIdle();

  assert.equal(redraws.at(-1).camera, latestCamera);
  assert.deepEqual(redraws.at(-1).options, { interactive: true });
  streamer.dispose();
});

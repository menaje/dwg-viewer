import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeDwgRenderDeltaTransform,
  dwgRenderDeltaTransformByteLength,
  indexDwgRenderDeltaTransforms,
  isNormalizedDwgRenderDeltaTransformRecord,
  renderDeltaInstanceMatrix,
} from "../src/render-delta-transform.mjs";
import {
  dwgRenderDeltaTransformBuffer,
  translatedTransformMatrix,
} from "./render-delta-transform-fixture.mjs";

function instanceGraph({
  handle = 0x2an,
  clipId = 0,
} = {}) {
  const instances = Object.freeze({
    data: new Float64Array(
      translatedTransformMatrix(1, 2, 0),
    ),
    measurementData: new Float64Array(
      translatedTransformMatrix(3, 4, 0),
    ),
    handles: new BigUint64Array([handle]),
    clipIds: new Uint32Array([clipId]),
    count: 1,
  });
  return {
    instances,
    graph: Object.freeze({
      instancesByBlock: new Map([[1, instances]]),
      insertsByOwner: new Map(),
    }),
  };
}

test("decodes one identity-bound display and measurement transform", () => {
  const buffer = dwgRenderDeltaTransformBuffer({
    handle: 0x1_0000_002an,
    matrix: translatedTransformMatrix(10, 20, 30),
    measurementMatrix: translatedTransformMatrix(40, 50, 60),
  });
  const record = decodeDwgRenderDeltaTransform(buffer, {
    expectedHandle: 0x1_0000_002an,
  });

  assert.equal(record.blockIndex, 1);
  assert.equal(record.instanceIndex, 0);
  assert.equal(record.handle, 0x1_0000_002an);
  assert.deepEqual(record.matrix.slice(12), [10, 20, 30, 1]);
  assert.deepEqual(
    record.measurementMatrix.slice(12),
    [40, 50, 60, 1],
  );
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.matrix), true);
  assert.equal(isNormalizedDwgRenderDeltaTransformRecord(record), true);
  assert.equal(
    dwgRenderDeltaTransformByteLength(record),
    buffer.byteLength,
  );
  assert.equal(
    isNormalizedDwgRenderDeltaTransformRecord({
      ...record,
    }),
    false,
  );
});

test("rejects malformed, singular, and cross-identity transforms", () => {
  assert.throws(
    () => decodeDwgRenderDeltaTransform(new ArrayBuffer(16)),
    /buffer is invalid/u,
  );
  assert.throws(
    () =>
      decodeDwgRenderDeltaTransform(
        dwgRenderDeltaTransformBuffer(),
        { expectedHandle: 0x2bn },
      ),
    /another Render ID/u,
  );
  assert.throws(
    () =>
      decodeDwgRenderDeltaTransform(
        dwgRenderDeltaTransformBuffer({
          matrix: Object.freeze(new Array(16).fill(0)),
        }),
      ),
    /affine matrix|invertible/u,
  );
});

test("indexes only the matching unclipped base occurrence", () => {
  const { graph, instances } = instanceGraph();
  const buffer = dwgRenderDeltaTransformBuffer();
  const record = decodeDwgRenderDeltaTransform(buffer);
  const entry = Object.freeze({
    resourceKind: "transform",
    sceneId: "root",
    record,
    byteLength: buffer.byteLength,
  });
  const index = indexDwgRenderDeltaTransforms([entry], {
    sourceId: "root",
    instanceGraph: graph,
  });

  assert.equal(index.entries.length, 1);
  assert.deepEqual(
    [...renderDeltaInstanceMatrix(index, instances, 0)],
    translatedTransformMatrix(10, 20, 0),
  );
  assert.deepEqual(
    [
      ...renderDeltaInstanceMatrix(index, instances, 0, {
        measurement: true,
      }),
    ],
    translatedTransformMatrix(10, 20, 0),
  );
  assert.throws(
    () =>
      indexDwgRenderDeltaTransforms([entry, entry], {
        sourceId: "root",
        instanceGraph: graph,
      }),
    /duplicated/u,
  );
  assert.throws(
    () =>
      indexDwgRenderDeltaTransforms([entry], {
        sourceId: "root",
        instanceGraph: instanceGraph({ clipId: 1 }).graph,
      }),
    /clipped occurrence/u,
  );
  assert.throws(
    () =>
      indexDwgRenderDeltaTransforms([entry], {
        sourceId: "root",
        instanceGraph: instanceGraph({ handle: 0x2bn }).graph,
      }),
    /target is invalid/u,
  );
});

test("requires complete array coverage and no nested dependency", () => {
  const data = new Float64Array(32);
  data.set(translatedTransformMatrix(), 0);
  data.set(translatedTransformMatrix(2, 0, 0), 16);
  const instances = Object.freeze({
    data,
    measurementData: data,
    handles: new BigUint64Array([0x2an, 0x2an]),
    clipIds: new Uint32Array([0, 0]),
    count: 2,
  });
  const graph = {
    instancesByBlock: new Map([[1, instances]]),
    insertsByOwner: new Map(),
  };
  const entries = [0, 1].map((instanceIndex) => {
    const buffer = dwgRenderDeltaTransformBuffer({
      instanceIndex,
      matrix: translatedTransformMatrix(10 + instanceIndex, 0, 0),
    });
    return Object.freeze({
      resourceKind: "transform",
      sceneId: "root",
      record: decodeDwgRenderDeltaTransform(buffer),
      byteLength: buffer.byteLength,
    });
  });

  assert.throws(
    () =>
      indexDwgRenderDeltaTransforms(entries.slice(0, 1), {
        sourceId: "root",
        instanceGraph: graph,
      }),
    /coverage is incomplete/u,
  );
  assert.equal(
    indexDwgRenderDeltaTransforms(entries, {
      sourceId: "root",
      instanceGraph: graph,
    }).entries.length,
    2,
  );
  assert.throws(
    () =>
      indexDwgRenderDeltaTransforms(entries, {
        sourceId: "root",
        instanceGraph: {
          ...graph,
          insertsByOwner: new Map([[1, [{}]]]),
        },
      }),
    /requires dependency invalidation/u,
  );
});

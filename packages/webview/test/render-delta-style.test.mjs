import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeDwgRenderDeltaStyle,
  dwgRenderDeltaStyleByteLength,
  indexDwgRenderDeltaStyles,
  isNormalizedDwgRenderDeltaStyleRecord,
  renderDeltaInstanceStyle,
} from "../src/render-delta-style.mjs";
import {
  dwgRenderDeltaStyleBuffer,
} from "./render-delta-style-fixture.mjs";

function instanceGraph({
  handles = [0x2an],
  clipIds = handles.map(() => 0),
} = {}) {
  const instances = Object.freeze({
    handles: BigUint64Array.from(handles),
    clipIds: Uint32Array.from(clipIds),
    count: handles.length,
  });
  return {
    instances,
    graph: Object.freeze({
      instancesByBlock: new Map([[1, instances]]),
      insertsByOwner: new Map(),
    }),
  };
}

function entry(buffer, sceneId = "root") {
  return Object.freeze({
    resourceKind: "style",
    sceneId,
    record: decodeDwgRenderDeltaStyle(buffer),
    byteLength: buffer.byteLength,
  });
}

test("decodes one bounded partial instance style", () => {
  const buffer = dwgRenderDeltaStyleBuffer({
    handle: 0x1_0000_002an,
    color: 0x8000_0005,
    layerIndex: 3,
    opacity: 0.25,
    lineWeight: 35,
    linetypeCode: 7,
    visible: false,
  });
  const record = decodeDwgRenderDeltaStyle(buffer, {
    expectedHandle: 0x1_0000_002an,
  });

  assert.deepEqual(
    {
      blockIndex: record.blockIndex,
      instanceIndex: record.instanceIndex,
      handle: record.handle,
      color: record.color,
      layerIndex: record.layerIndex,
      opacity: record.opacity,
      lineWeight: record.lineWeight,
      linetypeCode: record.linetypeCode,
      visible: record.visible,
    },
    {
      blockIndex: 1,
      instanceIndex: 0,
      handle: 0x1_0000_002an,
      color: 0x8000_0005,
      layerIndex: 3,
      opacity: 0.25,
      lineWeight: 35,
      linetypeCode: 7,
      visible: false,
    },
  );
  assert.equal(Object.isFrozen(record), true);
  assert.equal(isNormalizedDwgRenderDeltaStyleRecord(record), true);
  assert.equal(
    dwgRenderDeltaStyleByteLength(record),
    buffer.byteLength,
  );
  assert.equal(
    isNormalizedDwgRenderDeltaStyleRecord({ ...record }),
    false,
  );
});

test("rejects malformed, noncanonical, and cross-identity styles", () => {
  assert.throws(
    () => decodeDwgRenderDeltaStyle(new ArrayBuffer(16)),
    /buffer is invalid/u,
  );
  assert.throws(
    () =>
      decodeDwgRenderDeltaStyle(
        dwgRenderDeltaStyleBuffer({ visible: false }),
        { expectedHandle: 0x2bn },
      ),
    /another Render ID/u,
  );
  assert.throws(
    () => decodeDwgRenderDeltaStyle(dwgRenderDeltaStyleBuffer()),
    /flags or reserved/u,
  );
  const noncanonical = dwgRenderDeltaStyleBuffer({ visible: true });
  new DataView(noncanonical).setUint32(20, 1, true);
  assert.throws(
    () => decodeDwgRenderDeltaStyle(noncanonical),
    /flags or reserved/u,
  );
  assert.throws(
    () =>
      decodeDwgRenderDeltaStyle(
        dwgRenderDeltaStyleBuffer({ opacity: 1.5 }),
      ),
    /supported range/u,
  );
  assert.throws(
    () =>
      decodeDwgRenderDeltaStyle(
        dwgRenderDeltaStyleBuffer({ linetypeCode: 1 }),
      ),
    /supported range/u,
  );
  assert.throws(
    () =>
      decodeDwgRenderDeltaStyle(
        dwgRenderDeltaStyleBuffer({ color: 0 }),
      ),
    /supported range/u,
  );
  assert.throws(
    () =>
      decodeDwgRenderDeltaStyle(
        dwgRenderDeltaStyleBuffer({ lineWeight: -1 }),
      ),
    /supported range/u,
  );
});

test("indexes only the matching direct base occurrence", () => {
  const { graph, instances } = instanceGraph();
  const buffer = dwgRenderDeltaStyleBuffer({
    opacity: 0.5,
    visible: true,
  });
  const styleEntry = entry(buffer);
  const index = indexDwgRenderDeltaStyles([styleEntry], {
    sourceId: "root",
    instanceGraph: graph,
  });

  assert.equal(index.entries.length, 1);
  assert.equal(
    renderDeltaInstanceStyle(index, instances, 0).opacity,
    0.5,
  );
  assert.equal(
    indexDwgRenderDeltaStyles([styleEntry], {
      sourceId: "root",
      instanceGraph: instanceGraph({ clipIds: [1] }).graph,
    }).entries.length,
    1,
  );
  assert.throws(
    () =>
      indexDwgRenderDeltaStyles([styleEntry, styleEntry], {
        sourceId: "root",
        instanceGraph: graph,
      }),
    /duplicated/u,
  );
  assert.throws(
    () =>
      indexDwgRenderDeltaStyles([styleEntry], {
        sourceId: "root",
        instanceGraph: instanceGraph({ handles: [0x2bn] }).graph,
      }),
    /target is invalid/u,
  );
});

test("requires complete repeated coverage and no nested dependency", () => {
  const { graph } = instanceGraph({ handles: [0x2an, 0x2an] });
  const entries = [0, 1].map((instanceIndex) =>
    entry(
      dwgRenderDeltaStyleBuffer({
        instanceIndex,
        visible: false,
      }),
    ),
  );

  assert.throws(
    () =>
      indexDwgRenderDeltaStyles(entries.slice(0, 1), {
        sourceId: "root",
        instanceGraph: graph,
      }),
    /coverage is incomplete/u,
  );
  assert.equal(
    indexDwgRenderDeltaStyles(entries, {
      sourceId: "root",
      instanceGraph: graph,
    }).entries.length,
    2,
  );
  assert.throws(
    () =>
      indexDwgRenderDeltaStyles(entries, {
        sourceId: "root",
        instanceGraph: {
          ...graph,
          insertsByOwner: new Map([[1, [{}]]]),
        },
      }),
    /requires dependency invalidation/u,
  );
});

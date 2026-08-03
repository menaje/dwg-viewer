import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExternalFilledObjectReviewData,
  buildFilledObjectReviewData,
  CompositeFilledObjectSelectionIndex,
  FilledObjectSelectionIndex,
} from "../src/filled-object-review.mjs";
import {
  buildInstanceGraph,
  createClipNode,
} from "../src/instance-graph.mjs";
import {
  identityMat4,
  translationMat4,
} from "../src/math.mjs";
import { MemoryRangeSource } from "../src/range-source.mjs";
import { SceneCacheReader } from "../src/scene-cache.mjs";
import { makeFixtureCache } from "./cache-fixture.mjs";

async function reviewFixture() {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache()),
  );
  const [hatches, solids, faces, metadata] = await Promise.all([
    reader.readHatchSource(),
    reader.readSolidEntities(),
    reader.readFaceEntities(),
    reader.readRenderMetadata(),
  ]);
  const instanceGraph = buildInstanceGraph(
    metadata.blocks,
    metadata.inserts,
    { layers: metadata.layers },
  );
  const data = buildFilledObjectReviewData(
    { hatches, solids, faces },
    metadata.blocks,
    instanceGraph,
  );
  return { data, metadata };
}

function onlyKind(data, kind) {
  return {
    ...data,
    records: data.records.filter((record) => record.kind === kind),
  };
}

function camera(origin, worldWidth = 20, worldHeight = 20) {
  return {
    origin,
    worldWidth,
    worldHeight,
    width: 1_000,
    height: 1_000,
  };
}

function indexFor(data, metadata, visibility = null) {
  return new FilledObjectSelectionIndex(data, {
    layers: metadata.layers,
    getLayerVisibility: () =>
      visibility ?? metadata.layers.map(() => true),
  });
}

function collection(matrix, {
  layerIndex = 0xffffffff,
  clipId = 0,
} = {}) {
  return Object.freeze({
    data: new Float64Array(matrix),
    measurementData: new Float64Array(matrix),
    coordinateSpaceIds: new Uint8Array([1]),
    clipIds: new Uint32Array([clipId]),
    layerIndices: new Uint32Array([layerIndex]),
    visibilityRows: new Uint32Array([0]),
    count: 1,
    length: 1,
  });
}

function oneSolidSource({
  layerIndex = 1,
  linetypeCode = 3,
} = {}) {
  return {
    hatches: null,
    faces: null,
    solids: {
      length: 1,
      readEntity(_index, target) {
        Object.assign(target, {
          handle: 900n,
          ownerHandle: 100n,
          layerIndex,
          color: 7,
          lineWeight: 25,
          linetypeCode,
          commonFlags: 0,
          corners: [
            [0, 0, 0],
            [10, 0, 0],
            [10, 10, 0],
            [0, 10, 0],
          ],
          normal: [0, 0, 1],
          fillMode: true,
          thickness: 0,
        });
      },
    },
  };
}

function externalSolidData({
  entityLayer = 1,
  outerLayer = 4,
  parentClip = true,
} = {}) {
  const parentInstances = collection(
    translationMat4(100, 20, 0),
    {
      layerIndex: outerLayer,
      clipId: parentClip ? 1 : 0,
    },
  );
  const childRoot = collection(identityMat4());
  const childInstanceGraph = {
    instancesByBlock: new Map([[0, childRoot]]),
    modelBlockIndices: new Set([0]),
    rootInstances: childRoot,
    clipNodes: Object.freeze([]),
    layerZeroIndex: 0,
  };
  return buildExternalFilledObjectReviewData(
    oneSolidSource({ layerIndex: entityLayer }),
    [{ index: 0, handle: 100n, name: "*Model_Space" }],
    childInstanceGraph,
    {
      parentBlockIndex: 7,
      parentInstances,
      parentClipNodes: parentClip
        ? [
            createClipNode(1, 0, [
              [100, 20, 0],
              [106, 20, 0],
              [106, 26, 0],
              [100, 26, 0],
            ]),
          ]
        : [],
      parentLayerVisibilityRows: [],
      layerMap: new Uint32Array([0, 7]),
      linetypeMap: new Uint16Array([0, 1, 2, 8]),
    },
  );
}

test("builds compact HATCH, SOLID, and 3DFACE review occurrences", async () => {
  const { data } = await reviewFixture();

  assert.deepEqual(data.metrics, {
    sourceHatches: 1,
    sourceSolids: 2,
    sourceFaces: 5,
    occurrences: 8,
    hatches: 1,
    solids: 2,
    faces: 5,
    rings: 9,
    vertices: 34,
    skippedInvisible: 0,
    skippedOwners: 0,
    skippedInvalid: 0,
    truncated: false,
  });
  const hatch = data.records.find((record) => record.kind === "hatch");
  assert.equal(hatch.handle, 401n);
  assert.equal(hatch.objectMeasurement.area, 84);
  assert.equal(hatch.objectMeasurement.length, 56);
});

test("selects a HATCH interior but leaves its nested hole empty", async () => {
  const { data, metadata } = await reviewFixture();
  const index = indexFor(onlyKind(data, "hatch"), metadata);
  const view = camera([5, 5, 0]);

  const selected = index.find([1, 5, 0], view);
  assert.equal(selected.entityType, "hatch");
  assert.equal(selected.sourceKindName, "해치");
  assert.equal(selected.objectMeasurement.area, 84);
  assert.equal(selected.displayPolygons.length, 2);
  assert.equal(index.find([5, 5, 0], view), null);
});

test("uses SOLID fill mode and 3DFACE outlines for hit testing", async () => {
  const { data, metadata } = await reviewFixture();
  const solids = indexFor(onlyKind(data, "solid"), metadata);

  assert.equal(
    solids.find([2, 2, 0], camera([2, 2, 0])).entityType,
    "solid",
  );
  assert.equal(
    solids.find([102, 202, 0], camera([102, 202, 0])),
    null,
  );
  assert.equal(
    solids.find([102, 200.05, 0], camera([102, 202, 0])).handle,
    602n,
  );

  const faces = indexFor(onlyKind(data, "face"), metadata);
  assert.equal(
    faces.find([22, 1.5, 0], camera([22, 1.5, 0])),
    null,
  );
  assert.equal(
    faces.find([22, 0.05, 0], camera([22, 1.5, 0])),
    null,
  );
  assert.equal(
    faces.find([20.05, 1.5, 0], camera([22, 1.5, 0])).entityType,
    "face",
  );
});

test("applies current layer visibility before returning a filled object", async () => {
  const { data, metadata } = await reviewFixture();
  const hatch = data.records.find((record) => record.kind === "hatch");
  const visibility = metadata.layers.map(() => true);
  visibility[hatch.layerIndex] = false;
  const index = indexFor(onlyKind(data, "hatch"), metadata, visibility);

  assert.equal(index.find([1, 5, 0], camera([5, 5, 0])), null);
});

test("transforms, remaps, and clips an external SOLID occurrence", () => {
  const data = externalSolidData();
  const layers = Array.from({ length: 8 }, (_value, index) => ({
    name: index === 7 ? "X-TITLE|FILL" : `Layer ${index}`,
  }));
  const index = new FilledObjectSelectionIndex(data, {
    sourceId: "xref-1",
    sourceLabel: "X-TITLE",
    layers,
    getLayerVisibility: () => layers.map(() => true),
  });

  assert.equal(data.records[0].layerIndex, 7);
  assert.equal(data.records[0].linetypeCode, 8);
  assert.deepEqual(data.records[0].bounds, [100, 20, 110, 30]);
  const selected = index.find(
    [102, 22, 0],
    camera([105, 25, 0]),
  );
  assert.equal(selected.handle, 900n);
  assert.equal(selected.sourceLabel, "X-TITLE");
  assert.equal(selected.layerName, "X-TITLE|FILL");
  assert.equal(
    index.find([108, 28, 0], camera([105, 25, 0])),
    null,
  );
  const hidden = new FilledObjectSelectionIndex(data, {
    layers,
    getLayerVisibility: () =>
      layers.map((_layer, layerIndex) => layerIndex !== 7),
  });
  assert.equal(
    hidden.find([102, 22, 0], camera([105, 25, 0])),
    null,
  );
});

test("filters filled objects through the revision-bound render pick map", () => {
  const data = externalSolidData({ parentClip: false });
  const layers = Array.from({ length: 8 }, (_value, index) => ({
    name: `Layer ${index}`,
  }));
  const contexts = [];
  const pickIdentity = Object.freeze({
    status: "base",
    revisionId: "revision:pick:2",
    renderId: "dwg:xref-1:384",
  });
  const accepted = new FilledObjectSelectionIndex(data, {
    sourceId: "xref-1",
    layers,
    getLayerVisibility: () => layers.map(() => true),
    resolveRenderPick(context) {
      contexts.push(context);
      return pickIdentity;
    },
  }).find([102, 22, 0], camera([105, 25, 0]));

  assert.equal(accepted.renderPick, pickIdentity);
  assert.deepEqual(contexts[0], {
    origin: "base",
    sceneId: "xref-1",
    handle: data.records[0].handle,
    ownerHandle: data.records[0].ownerHandle,
  });

  const rejected = new FilledObjectSelectionIndex(data, {
    sourceId: "xref-1",
    layers,
    getLayerVisibility: () => layers.map(() => true),
    resolveRenderPick: () => null,
  });
  assert.equal(
    rejected.find([102, 22, 0], camera([105, 25, 0])),
    null,
  );
});

test("inherits the parent XREF layer for an external Layer 0 fill", () => {
  const data = externalSolidData({
    entityLayer: 0,
    outerLayer: 4,
    parentClip: false,
  });

  assert.equal(data.records[0].layerIndex, 4);
});

test("combines root and external filled-object selection sources", () => {
  const external = externalSolidData({ parentClip: false });
  const root = buildFilledObjectReviewData(
    oneSolidSource({ layerIndex: 0 }),
    [{ index: 0, handle: 100n, name: "*Model_Space" }],
    {
      instancesByBlock: new Map([[0, collection(identityMat4())]]),
      modelBlockIndices: new Set([0]),
      rootInstances: collection(identityMat4()),
      clipNodes: Object.freeze([]),
      layerZeroIndex: 0,
    },
  );
  const layers = Array.from({ length: 8 }, (_value, index) => ({
    name: `Layer ${index}`,
  }));
  const composite = new CompositeFilledObjectSelectionIndex(
    [
      { id: "root", label: "현재 도면", layers, data: root },
      {
        id: "xref-1",
        label: "X-TITLE",
        layers,
        data: external,
      },
    ],
    { getLayerVisibility: () => layers.map(() => true) },
  );

  assert.equal(
    composite.find([2, 2, 0], camera([5, 5, 0])).sourceId,
    "root",
  );
  assert.equal(
    composite.find(
      [102, 22, 0],
      camera([105, 25, 0]),
    ).sourceId,
    "xref-1",
  );
  assert.deepEqual(composite.snapshot(), {
    sources: 2,
    failedSources: 0,
    records: 2,
    rings: 2,
    vertices: 8,
    truncated: false,
  });
});

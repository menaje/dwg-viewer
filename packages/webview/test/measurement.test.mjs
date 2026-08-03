import assert from "node:assert/strict";
import test from "node:test";

import { createClipNode } from "../src/instance-graph.mjs";
import {
  OverviewSnapIndex,
  pointInsideClipChain,
  screenToWorld,
  worldToScreen,
} from "../src/measurement.mjs";
import {
  identityMat4,
  scalingMat4,
  translationMat4,
} from "../src/math.mjs";
import {
  GPU_LINE_VERTEX_RECORD_SIZE,
  GpuLineBatchKind,
} from "../src/scene-cache.mjs";
import { formatNumber, unitLabel } from "../src/review-tools.mjs";

function vertices(segments) {
  const buffer = new ArrayBuffer(
    segments.length * 2 * GPU_LINE_VERTEX_RECORD_SIZE,
  );
  const view = new DataView(buffer);
  for (const [segmentIndex, segment] of segments.entries()) {
    for (const [pointIndex, point] of [segment.first, segment.last].entries()) {
      const offset =
        (segmentIndex * 2 + pointIndex) * GPU_LINE_VERTEX_RECORD_SIZE;
      view.setFloat32(offset, point[0], true);
      view.setFloat32(offset + 4, point[1], true);
      view.setFloat32(offset + 8, point[2] ?? 0, true);
      view.setUint32(offset + 12, segment.layerIndex ?? 0, true);
      view.setUint32(offset + 20, Number(segment.handle ?? 1n), true);
      view.setUint32(
        offset + 24,
        Number((segment.handle ?? 1n) >> 32n),
        true,
      );
      view.setUint32(
        offset + 28,
        (segment.sourceKind ?? 0) << 17,
        true,
      );
    }
  }
  return {
    buffer,
    byteLength: buffer.byteLength,
    vertexCount: segments.length * 2,
    recordSize: GPU_LINE_VERTEX_RECORD_SIZE,
  };
}

function collection(
  matrix = identityMat4(),
  measurementMatrix = matrix,
  {
    coordinateSpace = 1,
    clipId = 0,
    layerIndex = 0xffffffff,
    visibilityRow = 0,
  } = {},
) {
  return {
    data: matrix,
    measurementData: measurementMatrix,
    coordinateSpaceIds: new Uint8Array([coordinateSpace]),
    clipIds: new Uint32Array([clipId]),
    layerIndices: new Uint32Array([layerIndex]),
    visibilityRows: new Uint32Array([visibilityRow]),
    count: 1,
    length: 1,
  };
}

function source({
  segments,
  instances = collection(),
  instanceIndices,
  exactCurves,
  clipNodes = [],
  visibilityRows = [new Uint8Array([1, 1])],
}) {
  const points = segments.flatMap((segment) => [segment.first, segment.last]);
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return {
    id: "root",
    label: "현재 도면",
    layers: [{ name: "0" }, { name: "A-WALL" }],
    vertices: vertices(segments),
    batches: [
      {
        id: 0,
        kind: GpuLineBatchKind.ModelOverview,
        lodLevel: 0,
        blockIndex: null,
        firstVertex: 0,
        vertexCount: segments.length * 2,
        segmentCount: segments.length,
        origin: [0, 0, 0],
        bounds: {
          min: [Math.min(...xs), Math.min(...ys), 0],
          max: [Math.max(...xs), Math.max(...ys), 0],
        },
      },
    ],
    instanceGraph: {
      modelInstances: instances,
      instancesByBlock: new Map(),
      clipNodes,
      layerVisibilityRows: visibilityRows,
    },
    instanceIndices,
    exactCurves,
  };
}

const camera = {
  origin: [5, 5, 0],
  worldWidth: 10,
  worldHeight: 10,
  width: 1_000,
  height: 1_000,
};

test("converts between CSS screen and drawing coordinates", () => {
  assert.deepEqual(screenToWorld(camera, 500, 500, 1_000, 1_000), [5, 5, 0]);
  assert.deepEqual(worldToScreen(camera, [0, 10, 0], 1_000, 1_000), [0, 0]);
});

test("formats drawing units without exposing negative zero", () => {
  assert.equal(formatNumber(-0), "0");
  assert.equal(formatNumber(-1e-12), "0");
  assert.equal(unitLabel(4), "mm");
  assert.equal(unitLabel(0), "도면 단위");
});

test("snaps to endpoints, midpoints, and nearest points through a spatial index", () => {
  const index = new OverviewSnapIndex([
    source({
      segments: [{ first: [0, 0, 0], last: [10, 0, 0], handle: 42n }],
    }),
  ], {
    layerZeroIndex: 0,
    getLayerVisibility: () => [true, true],
  });

  const endpoint = index.find([0.03, 0.02, 0], camera);
  assert.equal(endpoint.kind, "endpoint");
  assert.deepEqual(endpoint.measurementPoint, [0, 0, 0]);
  assert.equal(endpoint.handle, 42n);

  const midpoint = index.find([5.02, 0.02, 0], camera);
  assert.equal(midpoint.kind, "midpoint");
  assert.deepEqual(midpoint.measurementPoint, [5, 0, 0]);

  const nearest = index.find([7, 0.04, 0], camera);
  assert.equal(nearest.kind, "nearest");
  assert.deepEqual(nearest.measurementPoint, [7, 0, 0]);
});

test("filters stale base geometry through the active render pick map", () => {
  const contexts = [];
  const pickIdentity = Object.freeze({
    status: "base",
    revisionId: "revision:pick:2",
    renderId: "dwg:root:2A",
  });
  const index = new OverviewSnapIndex(
    [
      source({
        segments: [
          { first: [0, 0, 0], last: [10, 0, 0], handle: 41n },
          { first: [0, 0, 0], last: [10, 0, 0], handle: 42n },
        ],
      }),
    ],
    {
      layerZeroIndex: 0,
      getLayerVisibility: () => [true, true],
      resolveRenderPick(context) {
        contexts.push(context);
        return context.handle === 41n ? null : pickIdentity;
      },
    },
  );

  const selected = index.find([5, 0.01, 0], camera, {
    snapKinds: ["nearest"],
  });

  assert.equal(selected.handle, 42n);
  assert.equal(selected.renderPick, pickIdentity);
  assert.ok(
    contexts.some(
      (context) =>
        context.origin === "base" &&
        context.sceneId === "root" &&
        context.handle === 41n &&
        context.batch?.id === 0 &&
        context.instanceIndex === 0,
    ),
  );
});

test("reports whole-object length and area for a closed polyline", () => {
  const index = new OverviewSnapIndex([
    source({
      segments: [
        {
          first: [0, 0, 0],
          last: [3, 0, 0],
          handle: 99n,
          sourceKind: 1,
        },
        {
          first: [3, 0, 0],
          last: [3, 4, 0],
          handle: 99n,
          sourceKind: 1,
        },
        {
          first: [3, 4, 0],
          last: [0, 4, 0],
          handle: 99n,
          sourceKind: 1,
        },
        {
          first: [0, 4, 0],
          last: [0, 0, 0],
          handle: 99n,
          sourceKind: 1,
        },
      ],
    }),
  ], {
    layerZeroIndex: 0,
    getLayerVisibility: () => [true, true],
  });

  const selected = index.find([1, 0.02, 0], camera, {
    snapKinds: ["nearest"],
  });

  assert.deepEqual(selected.objectMeasurement, {
    length: 14,
    area: 12,
    closed: true,
    segments: 4,
    approximated: false,
  });
});

test("uses an 18 CSS pixel snap aperture", () => {
  const index = new OverviewSnapIndex([
    source({
      segments: [{ first: [0, 0, 0], last: [10, 0, 0], handle: 42n }],
    }),
  ], {
    layerZeroIndex: 0,
    getLayerVisibility: () => [true, true],
  });
  const fartherNearest = index.find([7, 0.17, 0], camera);
  assert.equal(fartherNearest.kind, "nearest");
  assert.deepEqual(fartherNearest.measurementPoint, [7, 0, 0]);

  assert.equal(index.find([7, 0.19, 0], camera), null);
});

test("keeps display and actual model coordinates separate in a scaled viewport", () => {
  const display = scalingMat4(0.1, 0.1, 1);
  display[12] = 100;
  display[13] = 50;
  const index = new OverviewSnapIndex([
    source({
      segments: [{ first: [0, 0, 0], last: [10, 0, 0] }],
      instances: collection(display, identityMat4()),
    }),
  ], {
    layerZeroIndex: 0,
    getLayerVisibility: () => [true, true],
  });
  const paperCamera = {
    ...camera,
    origin: [100.5, 50, 0],
    worldWidth: 10,
    worldHeight: 10,
  };

  const hit = index.find([101, 50.01, 0], paperCamera);
  assert.deepEqual(hit.displayPoint, [101, 50, 0]);
  assert.deepEqual(hit.measurementPoint, [10, 0, 0]);
  assert.equal(hit.coordinateSpace, 1);
});

test("honours layer visibility, viewport freezing, and nested clip polygons", () => {
  const clipNodes = [
    createClipNode(1, 0, [
      [2, -1, 0],
      [8, -1, 0],
      [8, 1, 0],
      [2, 1, 0],
    ]),
  ];
  const visibleIndex = new OverviewSnapIndex([
    source({
      segments: [
        {
          first: [0, 0, 0],
          last: [10, 0, 0],
          layerIndex: 1,
        },
      ],
      instances: collection(identityMat4(), identityMat4(), {
        clipId: 1,
      }),
      clipNodes,
    }),
  ], {
    layerZeroIndex: 0,
    getLayerVisibility: () => [true, true],
  });
  assert.equal(visibleIndex.find([1, 0, 0], camera), null);
  assert.ok(visibleIndex.find([5, 0, 0], camera));

  const hiddenIndex = new OverviewSnapIndex(visibleIndex.sources, {
    layerZeroIndex: 0,
    getLayerVisibility: () => [true, false],
  });
  assert.equal(hiddenIndex.find([5, 0, 0], camera), null);

  const frozenSource = source({
    segments: [{ first: [0, 0, 0], last: [10, 0, 0], layerIndex: 1 }],
    instances: collection(translationMat4(0, 0, 0), identityMat4(), {
      visibilityRow: 1,
    }),
    visibilityRows: [new Uint8Array([1, 1]), new Uint8Array([1, 0])],
  });
  const frozenIndex = new OverviewSnapIndex([frozenSource], {
    layerZeroIndex: 0,
    getLayerVisibility: () => [true, true],
  });
  assert.equal(frozenIndex.find([5, 0, 0], camera), null);

  assert.equal(pointInsideClipChain({ clipNodes }, 1, [5, 0]), true);
  assert.equal(pointInsideClipChain({ clipNodes }, 1, [9, 0]), false);
});

test("does not expose tessellation vertices as arc endpoints", () => {
  const index = new OverviewSnapIndex([
    source({
      segments: [
        { first: [0, 0, 0], last: [5, 5, 0], handle: 9n, sourceKind: 4 },
        { first: [5, 5, 0], last: [10, 0, 0], handle: 9n, sourceKind: 4 },
      ],
    }),
  ], {
    layerZeroIndex: 0,
    getLayerVisibility: () => [true, true],
  });

  const middle = index.find([5, 5, 0], camera, {
    snapKinds: ["endpoint"],
  });
  assert.equal(middle, null);
  assert.equal(
    index.find([0, 0, 0], camera, { snapKinds: ["endpoint"] }).kind,
    "endpoint",
  );
});

test("indexes only the visible instance subset of a streamed detail batch", () => {
  const matrices = new Float64Array(32);
  matrices.set(identityMat4(), 0);
  matrices.set(translationMat4(100, 0, 0), 16);
  const instances = {
    data: matrices,
    measurementData: matrices,
    coordinateSpaceIds: new Uint8Array([1, 1]),
    clipIds: new Uint32Array([0, 0]),
    layerIndices: new Uint32Array([0xffffffff, 0xffffffff]),
    visibilityRows: new Uint32Array([0, 0]),
    count: 2,
    length: 2,
  };
  const indexedSource = source({
    segments: [{ first: [0, 0, 0], last: [10, 0, 0] }],
    instances,
    instanceIndices: new Uint32Array([1]),
  });
  const index = new OverviewSnapIndex([indexedSource], {
    layerZeroIndex: 0,
    getLayerVisibility: () => [true, true],
  });
  const detailCamera = {
    ...camera,
    origin: [105, 0, 0],
    worldWidth: 20,
    worldHeight: 20,
  };

  assert.equal(index.find([5, 0, 0], detailCamera), null);
  assert.ok(index.find([105, 0, 0], detailCamera));
  assert.equal(index.snapshot().occurrences, 1);
});

test("uses exact ARC geometry for midpoint and nearest snaps", () => {
  const exactCurves = new Map([
    [
      9n,
      {
        kind: "arc",
        center: [0, 0, 0],
        radius: 10,
        startParameter: 0,
        endParameter: Math.PI / 2,
        normal: [0, 0, 1],
      },
    ],
  ]);
  const index = new OverviewSnapIndex([
    source({
      segments: [
        {
          first: [10, 0, 0],
          last: [7, 7, 0],
          handle: 9n,
          sourceKind: 4,
        },
        {
          first: [7, 7, 0],
          last: [0, 10, 0],
          handle: 9n,
          sourceKind: 4,
        },
      ],
      exactCurves,
    }),
  ], {
    layerZeroIndex: 0,
    getLayerVisibility: () => [true, true],
  });
  const curveCamera = {
    ...camera,
    worldWidth: 20,
    worldHeight: 20,
  };
  const expected = Math.sqrt(50);

  const midpoint = index.find([expected, expected, 0], curveCamera, {
    snapKinds: ["midpoint"],
  });
  assert.equal(midpoint.kind, "midpoint");
  assert.ok(Math.abs(midpoint.measurementPoint[0] - expected) < 1e-9);
  assert.ok(Math.abs(midpoint.measurementPoint[1] - expected) < 1e-9);
  assert.equal(midpoint.approximated, false);
  assert.deepEqual(
    midpoint.curveMeasurement.measurementCenter,
    [0, 0, 0],
  );
  assert.equal(midpoint.curveMeasurement.majorRadius, 10);
  assert.equal(midpoint.curveMeasurement.minorRadius, 10);

  const nearest = index.find([7.2, 7.2, 0], curveCamera, {
    snapKinds: ["nearest"],
  });
  assert.ok(Math.abs(Math.hypot(...nearest.measurementPoint.slice(0, 2)) - 10) < 1e-7);
});

test("snaps to line intersections before nearby segments", () => {
  const index = new OverviewSnapIndex([
    source({
      segments: [
        {
          first: [0, 5, 0],
          last: [10, 5, 0],
          handle: 21n,
        },
        {
          first: [5, 0, 0],
          last: [5, 10, 0],
          handle: 22n,
        },
      ],
    }),
  ], {
    layerZeroIndex: 0,
    getLayerVisibility: () => [true, true],
  });

  const hit = index.find([5.03, 5.02, 0], camera, {
    snapKinds: ["intersection", "nearest"],
  });

  assert.equal(hit.kind, "intersection");
  assert.deepEqual(hit.displayPoint, [5, 5, 0]);
  assert.deepEqual(
    new Set([hit.handle, hit.relatedHandle]),
    new Set([21n, 22n]),
  );
});

test("snaps perpendicular from the previous measurement point", () => {
  const index = new OverviewSnapIndex([
    source({
      segments: [
        {
          first: [0, 0, 0],
          last: [10, 0, 0],
          handle: 31n,
        },
      ],
    }),
  ], {
    layerZeroIndex: 0,
    getLayerVisibility: () => [true, true],
  });

  const hit = index.find([4.02, 0.03, 0], camera, {
    snapKinds: ["perpendicular", "nearest"],
    referencePoint: [4, 5, 0],
  });

  assert.equal(hit.kind, "perpendicular");
  assert.deepEqual(hit.displayPoint, [4, 0, 0]);
  assert.deepEqual(hit.measurementPoint, [4, 0, 0]);
});

test("snaps to exact curve centers and reports full circle properties", () => {
  const exactCurves = new Map([
    [
      41n,
      {
        kind: "circle",
        handle: 41n,
        ownerHandle: 0n,
        layerIndex: 0,
        color: 0,
        lineWeight: -1,
        linetypeCode: 2,
        center: [5, 5, 0],
        radius: 2,
        startParameter: 0,
        endParameter: Math.PI * 2,
        normal: [0, 0, 1],
      },
    ],
  ]);
  const index = new OverviewSnapIndex([
    source({
      segments: [
        {
          first: [7, 5, 0],
          last: [5, 7, 0],
          handle: 41n,
          sourceKind: 5,
        },
        {
          first: [5, 7, 0],
          last: [3, 5, 0],
          handle: 41n,
          sourceKind: 5,
        },
      ],
      exactCurves,
    }),
  ], {
    layerZeroIndex: 0,
    getLayerVisibility: () => [true, true],
  });

  const hit = index.find([5.02, 5.01, 0], camera, {
    snapKinds: ["center"],
  });

  assert.equal(hit.kind, "center");
  assert.deepEqual(hit.measurementPoint, [5, 5, 0]);
  assert.equal(hit.curveMeasurement.closed, true);
  assert.ok(Math.abs(hit.curveMeasurement.length - Math.PI * 4) < 1e-9);
  assert.ok(Math.abs(hit.curveMeasurement.area - Math.PI * 4) < 1e-9);
});

test("snaps to block insertion points and keeps insert metadata", () => {
  const blockInstances = collection(
    translationMat4(5, 4, 0),
    translationMat4(5, 4, 0),
    { layerIndex: 1 },
  );
  blockInstances.handles = new BigUint64Array([51n]);
  blockInstances.colors = new Uint32Array([0]);
  blockInstances.lineWeights = new Int16Array([-1]);
  blockInstances.linetypeCodes = new Uint16Array([2]);
  const insertSource = source({
    segments: [{ first: [0, 0, 0], last: [1, 0, 0] }],
  });
  insertSource.blocks = [
    { index: 0, handle: 100n, name: "*Model_Space", basePoint: [0, 0, 0] },
    { index: 1, handle: 200n, name: "문틀", basePoint: [2, 3, 0] },
  ];
  insertSource.instanceGraph.instancesByBlock.set(1, blockInstances);
  const index = new OverviewSnapIndex([insertSource], {
    layerZeroIndex: 0,
    getLayerVisibility: () => [true, true],
  });

  const hit = index.find([7.02, 7.01, 0], camera, {
    snapKinds: ["insertion"],
  });

  assert.equal(hit.kind, "insertion");
  assert.equal(hit.entityType, "block");
  assert.equal(hit.blockName, "문틀");
  assert.equal(hit.handle, 51n);
  assert.deepEqual(hit.insertionPoint, [7, 7, 0]);
  assert.deepEqual(hit.transform.scale, [1, 1, 1]);
  assert.equal(hit.transform.rotation, 0);
});

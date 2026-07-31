import assert from "node:assert/strict";
import test from "node:test";

import { buildInstanceGraph } from "../src/instance-graph.mjs";
import { buildMaskOrderPlan, decodeMaskBucket } from "../src/mask-order.mjs";
import {
  buildPrimitiveMeshes,
  PRIMITIVE_VERTEX_STRIDE,
} from "../src/primitive-mesh.mjs";
import { MemoryRangeSource } from "../src/range-source.mjs";
import {
  GpuLineBatchKind,
  SceneCacheReader,
} from "../src/scene-cache.mjs";
import { makeFixtureCache } from "./cache-fixture.mjs";

async function primitiveFixture(minorVersion = 8) {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache({ minorVersion })),
  );
  const [source, metadata] = await Promise.all([
    reader.readPrimitiveSource(),
    reader.readRenderMetadata(),
  ]);
  const instanceGraph = buildInstanceGraph(
    metadata.blocks,
    metadata.inserts,
  );
  return { source, metadata, instanceGraph };
}

function verticesForHandle(scene, handle) {
  const view = new DataView(scene.vertices.buffer);
  const points = [];
  for (const batch of scene.batches) {
    for (
      let vertex = batch.firstVertex;
      vertex < batch.firstVertex + batch.vertexCount;
      vertex += 1
    ) {
      const offset = vertex * PRIMITIVE_VERTEX_STRIDE;
      const encodedHandle =
        BigInt(view.getUint32(offset + 20, true)) |
        (BigInt(view.getUint32(offset + 24, true)) << 32n);
      if (encodedHandle !== handle) {
        continue;
      }
      points.push({
        blockIndex: batch.blockIndex,
        point: batch.origin.map(
          (origin, axis) => origin + view.getFloat32(offset + axis * 4, true),
        ),
      });
    }
  }
  return points;
}

test("builds instanced POINT markers and FILLMODE-aware SOLID meshes", async () => {
  const { source, metadata, instanceGraph } = await primitiveFixture();
  const result = buildPrimitiveMeshes(
    source,
    metadata.blocks,
    instanceGraph,
  );

  assert.equal(result.metrics.sourcePoints, 1);
  assert.equal(result.metrics.renderedPoints, 1);
  assert.equal(result.metrics.sourceSolids, 2);
  assert.equal(result.metrics.renderedFilledSolids, 1);
  assert.equal(result.metrics.renderedOutlineSolids, 1);
  assert.equal(result.metrics.pointVertices, 1);
  assert.equal(result.metrics.solidFillVertices, 6);
  assert.equal(result.metrics.solidOutlineVertices, 6);
  assert.equal(result.metrics.gpuBytes, 13 * PRIMITIVE_VERTEX_STRIDE);

  assert.equal(
    result.points.batches[0].kind,
    GpuLineBatchKind.BlockDefinition,
  );
  assert.equal(result.points.batches[0].blockIndex, 1);
  assert.deepEqual(result.points.batches[0].origin, [11, 2, 0]);
  const pointView = new DataView(result.points.vertices.buffer);
  assert.equal(pointView.getUint32(28, true) & 0xffff, 66);
  assert.equal(pointView.getFloat32(24, true), -3);
  assert.ok(
    Math.abs(pointView.getFloat32(20, true) - Math.PI / 6) < 1e-6,
  );

  assert.equal(
    result.solidFills.batches[0].kind,
    GpuLineBatchKind.ModelDetail,
  );
  assert.equal(result.solidFills.batches[0].blockIndex, null);
  assert.equal(
    result.solidOutlines.batches[0].kind,
    GpuLineBatchKind.BlockDefinition,
  );
  assert.equal(result.solidOutlines.batches[0].blockIndex, 1);
});

test("renders visible 3DFACE edges in the shared surface buffer", async () => {
  const { source, metadata, instanceGraph } = await primitiveFixture(9);
  const result = buildPrimitiveMeshes(
    source,
    metadata.blocks,
    instanceGraph,
  );

  assert.equal(result.metrics.sourceFaces, 5);
  assert.equal(result.metrics.renderedFaces, 5);
  assert.equal(result.metrics.renderedFaceEdges, 15);
  assert.equal(result.metrics.hiddenFaceEdges, 4);
  assert.equal(result.metrics.skippedDegenerateFaceEdges, 1);
  assert.equal(result.metrics.faceOutlineVertices, 30);
  assert.equal(result.metrics.solidOutlineVertices, 6);
  assert.equal(result.metrics.surfaceOutlineVertices, 36);
  assert.equal(
    result.metrics.faceOutlineGpuBytes,
    30 * PRIMITIVE_VERTEX_STRIDE,
  );
  assert.equal(result.metrics.gpuBytes, 43 * PRIMITIVE_VERTEX_STRIDE);
  assert.equal(result.solidOutlines.vertices.vertexCount, 36);
  assert.ok(
    result.solidOutlines.batches.some(
      (batch) =>
        batch.kind === GpuLineBatchKind.BlockDefinition &&
        batch.blockIndex === 1,
    ),
  );
});

test("renders WIPEOUT polygon, rectangular and full-image frames without masks", async () => {
  const { source, metadata, instanceGraph } = await primitiveFixture(10);
  const result = buildPrimitiveMeshes(
    source,
    metadata.blocks,
    instanceGraph,
    { wipeoutFrame: metadata.drawing.wipeoutFrame },
  );

  assert.equal(result.metrics.sourceWipeouts, 3);
  assert.equal(result.metrics.deferredWipeoutMasks, 3);
  assert.equal(result.metrics.renderedWipeoutFrames, 3);
  assert.equal(result.metrics.renderedWipeoutFrameEdges, 12);
  assert.equal(result.metrics.skippedDegenerateWipeoutEdges, 0);
  assert.equal(result.metrics.wipeoutOutlineVertices, 24);
  assert.equal(
    result.metrics.wipeoutOutlineGpuBytes,
    24 * PRIMITIVE_VERTEX_STRIDE,
  );
  assert.equal(result.metrics.surfaceOutlineVertices, 60);
  assert.equal(result.metrics.gpuBytes, 67 * PRIMITIVE_VERTEX_STRIDE);

  const polygon = verticesForHandle(result.solidOutlines, 801n);
  assert.equal(polygon.length, 8);
  assert.deepEqual(
    [
      Math.min(...polygon.map(({ point }) => point[0])),
      Math.max(...polygon.map(({ point }) => point[0])),
      Math.min(...polygon.map(({ point }) => point[1])),
      Math.max(...polygon.map(({ point }) => point[1])),
    ],
    [50, 54, 0, 3],
  );

  const rectangle = verticesForHandle(result.solidOutlines, 802n);
  assert.equal(rectangle.length, 8);
  assert.ok(rectangle.every(({ blockIndex }) => blockIndex === 1));
  assert.deepEqual(
    [
      Math.min(...rectangle.map(({ point }) => point[0])),
      Math.max(...rectangle.map(({ point }) => point[0])),
      Math.min(...rectangle.map(({ point }) => point[1])),
      Math.max(...rectangle.map(({ point }) => point[1])),
    ],
    [59.5, 67.5, -0.5, 5.5],
  );

  const fullImage = verticesForHandle(result.solidOutlines, 803n);
  assert.equal(fullImage.length, 8);
  assert.deepEqual(
    [
      Math.min(...fullImage.map(({ point }) => point[0])),
      Math.max(...fullImage.map(({ point }) => point[0])),
      Math.min(...fullImage.map(({ point }) => point[1])),
      Math.max(...fullImage.map(({ point }) => point[1])),
    ],
    [69.5, 73.5, -0.5, 2.5],
  );
});

test("keeps WIPEOUT masks deferred and omits frames when the setting is off", async () => {
  const { source, metadata, instanceGraph } = await primitiveFixture(10);
  const result = buildPrimitiveMeshes(
    source,
    metadata.blocks,
    instanceGraph,
    { wipeoutFrame: 0 },
  );

  assert.equal(result.metrics.sourceWipeouts, 3);
  assert.equal(result.metrics.deferredWipeoutMasks, 3);
  assert.equal(result.metrics.renderedWipeoutFrames, 0);
  assert.equal(result.metrics.renderedWipeoutFrameEdges, 0);
  assert.equal(result.metrics.wipeoutOutlineVertices, 0);
  assert.equal(result.metrics.wipeoutOutlineGpuBytes, 0);
  assert.equal(result.metrics.surfaceOutlineVertices, 36);
  assert.equal(result.metrics.gpuBytes, 43 * PRIMITIVE_VERTEX_STRIDE);
});

test("triangulates WIPEOUT masks with compressed draw-order buckets", async () => {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache({ minorVersion: 11 })),
  );
  const [source, metadata, drawOrder] = await Promise.all([
    reader.readPrimitiveSource(),
    reader.readRenderMetadata(),
    reader.readDrawOrder(),
  ]);
  const maskOrder = buildMaskOrderPlan(
    drawOrder,
    source.wipeouts,
    metadata.blocks,
    metadata.inserts,
  );
  const instanceGraph = buildInstanceGraph(
    metadata.blocks,
    metadata.inserts,
    { maskOrder },
  );
  const result = buildPrimitiveMeshes(
    source,
    metadata.blocks,
    instanceGraph,
    { maskOrder, wipeoutFrame: 0 },
  );

  assert.equal(maskOrder.enabled, true);
  assert.equal(instanceGraph.maskOrderEnabled, true);
  assert.equal(result.metrics.maskOrderEnabled, true);
  assert.equal(result.metrics.renderedWipeoutMasks, 3);
  assert.equal(result.metrics.renderedWipeoutMaskTriangles, 6);
  assert.equal(result.metrics.wipeoutMaskVertices, 18);
  assert.equal(
    result.metrics.wipeoutMaskGpuBytes,
    18 * PRIMITIVE_VERTEX_STRIDE,
  );
  const view = new DataView(result.wipeoutMasks.vertices.buffer);
  assert.ok(decodeMaskBucket(view.getUint32(28, true)) > 0);
});

test("stops each deferred primitive stream at its GPU budget", async () => {
  const { source, metadata, instanceGraph } = await primitiveFixture();
  const result = buildPrimitiveMeshes(
    source,
    metadata.blocks,
    instanceGraph,
    {
      maximumPointGpuBytes: PRIMITIVE_VERTEX_STRIDE,
      maximumSolidFillGpuBytes: PRIMITIVE_VERTEX_STRIDE * 3,
      maximumSolidOutlineGpuBytes: PRIMITIVE_VERTEX_STRIDE * 2,
    },
  );

  assert.equal(result.metrics.pointGpuLimitReached, false);
  assert.equal(result.metrics.solidFillGpuLimitReached, true);
  assert.equal(result.metrics.solidOutlineGpuLimitReached, true);
  assert.equal(result.solidFills.vertices.vertexCount, 3);
  assert.equal(result.solidOutlines.vertices.vertexCount, 2);
  assert.equal(
    result.metrics.gpuBytes,
    PRIMITIVE_VERTEX_STRIDE * 6,
  );
});

test("stops 3DFACE edges at the shared surface GPU budget", async () => {
  const { source, metadata, instanceGraph } = await primitiveFixture(9);
  const result = buildPrimitiveMeshes(
    source,
    metadata.blocks,
    instanceGraph,
    {
      maximumSolidOutlineGpuBytes: PRIMITIVE_VERTEX_STRIDE * 8,
    },
  );

  assert.equal(result.metrics.solidOutlineGpuLimitReached, false);
  assert.equal(result.metrics.faceOutlineGpuLimitReached, true);
  assert.equal(result.metrics.solidOutlineVertices, 6);
  assert.equal(result.metrics.faceOutlineVertices, 2);
  assert.equal(result.solidOutlines.vertices.vertexCount, 8);
  assert.equal(
    result.metrics.surfaceOutlineGpuBytes,
    PRIMITIVE_VERTEX_STRIDE * 8,
  );
});

test("stops WIPEOUT frames at the shared surface GPU budget", async () => {
  const { source, metadata, instanceGraph } = await primitiveFixture(10);
  const result = buildPrimitiveMeshes(
    source,
    metadata.blocks,
    instanceGraph,
    {
      maximumSolidOutlineGpuBytes: PRIMITIVE_VERTEX_STRIDE * 44,
      wipeoutFrame: 1,
    },
  );

  assert.equal(result.metrics.wipeoutOutlineGpuLimitReached, true);
  assert.equal(result.metrics.deferredWipeoutMasks, 3);
  assert.equal(result.metrics.renderedWipeoutFrames, 1);
  assert.equal(result.metrics.renderedWipeoutFrameEdges, 4);
  assert.equal(result.metrics.wipeoutOutlineVertices, 8);
  assert.equal(result.solidOutlines.vertices.vertexCount, 44);
});

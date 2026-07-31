import assert from "node:assert/strict";
import test from "node:test";

import { buildInstanceGraph } from "../src/instance-graph.mjs";
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

async function primitiveFixture() {
  const reader = await SceneCacheReader.open(
    new MemoryRangeSource(makeFixtureCache({ minorVersion: 8 })),
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

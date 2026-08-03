import assert from "node:assert/strict";
import test from "node:test";

import {
  RenderCapability,
  RenderDeltaAspect,
  RenderDeltaOperationKind,
  RenderProtocolVersion,
  ViewerLayerKind,
  ViewerRepresentation,
  parseRenderSessionDescriptor,
  parseRenderSnapshotDescriptor,
} from "@dwg-viewer/render-protocol";
import {
  ViewerRenderDeltaController,
} from "@dwg-viewer/viewer-core";

import {
  DwgRenderDeltaAdapter,
  DWG_LINE_VERTEX_STRIDE,
  DWG_RENDER_DELTA_MEDIA_TYPE,
} from "../src/render-delta-adapter.mjs";
import { GpuLineBatchKind } from "../src/scene-cache.mjs";

const REVISION_ONE = "revision:dwg-delta:1";
const REVISION_TWO = "revision:dwg-delta:2";
const REVISION_THREE = "revision:dwg-delta:3";
const RENDER_ID = "dwg:root:2A";

function bounds(offset = 0) {
  return {
    min: [offset, offset, 0],
    max: [offset + 1, offset + 1, 0],
  };
}

function sessionDescriptor() {
  return parseRenderSessionDescriptor({
    protocolVersion: RenderProtocolVersion,
    sessionId: "session:dwg-delta",
    sourceId: "source:dwg-delta",
    currentRevisionId: REVISION_ONE,
    lastSuccessfulRevisionId: REVISION_ONE,
    capabilities: [
      RenderCapability.LAYER_MANIFEST,
      RenderCapability.RENDER_DELTA,
      RenderCapability.RENDER_SNAPSHOT,
    ],
    resourceBudgetBytes: 1024 * 1024,
  });
}

function baseSnapshot(descriptor) {
  return parseRenderSnapshotDescriptor(
    {
      protocolVersion: RenderProtocolVersion,
      sessionId: descriptor.sessionId,
      sourceId: descriptor.sourceId,
      revisionId: REVISION_ONE,
      snapshotId: "snapshot:dwg-delta:base",
      sequence: 0,
      layers: [
        {
          layerId: "layer:dwg-live",
          sourceId: "source:dwg-live",
          revisionId: REVISION_ONE,
          kind: ViewerLayerKind.LIVE,
          representation: ViewerRepresentation.TWO_DIMENSIONAL,
          order: 0,
          visible: true,
        },
      ],
    },
    { session: descriptor },
  );
}

function lineVertices(handle = 0x2an) {
  const buffer = new ArrayBuffer(DWG_LINE_VERTEX_STRIDE * 2);
  const view = new DataView(buffer);
  for (let vertex = 0; vertex < 2; vertex += 1) {
    const offset = vertex * DWG_LINE_VERTEX_STRIDE;
    view.setFloat32(offset, vertex, true);
    view.setUint32(offset + 16, 7, true);
    view.setUint32(
      offset + 20,
      Number(handle & 0xffff_ffffn),
      true,
    );
    view.setUint32(
      offset + 24,
      Number(handle >> 32n),
      true,
    );
  }
  return Object.freeze({
    buffer,
    byteLength: buffer.byteLength,
    vertexCount: 2,
    recordSize: DWG_LINE_VERTEX_STRIDE,
  });
}

function lineBatch(id = 1) {
  return Object.freeze({
    id,
    kind: GpuLineBatchKind.ModelDetail,
    lodLevel: 1,
    firstVertex: 0,
    vertexCount: 2,
    blockIndex: null,
    origin: [0, 0, 0],
    bounds: bounds(),
  });
}

function upsertDelta({
  deltaId = "delta:dwg:1",
  operationId = "operation:dwg:upsert",
  fromRevisionId = REVISION_ONE,
  toRevisionId = REVISION_TWO,
  sequence = 1,
  vertices = lineVertices(),
  extraLines = [],
} = {}) {
  const sha256 = "a".repeat(64);
  const lines = [
    {
      renderId: RENDER_ID,
      sceneId: "root",
      batch: lineBatch(1),
      vertices,
      instanceIndices: null,
    },
    ...extraLines,
  ];
  const byteLength = lines.reduce(
    (total, line) => total + line.vertices.byteLength,
    0,
  );
  const payload = {
    protocolVersion: RenderProtocolVersion,
    payloadId: `payload:${deltaId}`,
    sessionId: "session:dwg-delta",
    sourceId: "source:dwg-delta",
    fromRevisionId,
    toRevisionId,
    mediaType: DWG_RENDER_DELTA_MEDIA_TYPE,
    byteLength,
    sha256,
    expiresAt: null,
    disposeWithSession: true,
  };
  return {
    delta: {
      protocolVersion: RenderProtocolVersion,
      deltaId,
      sessionId: "session:dwg-delta",
      sourceId: "source:dwg-delta",
      baseSnapshotId: "snapshot:dwg-delta:base",
      fromRevisionId,
      toRevisionId,
      sequence,
      operations: [
        {
          operationId,
          kind: RenderDeltaOperationKind.UPSERT,
          aspect: RenderDeltaAspect.GEOMETRY,
          layerId: "layer:dwg-live",
          sourceId: "source:dwg-live",
          renderIds: [RENDER_ID],
          affectedWorldBounds: bounds(),
          dependencyIds: [],
          externalIdentityToken: "external:dwg:2A",
        },
      ],
      affectedWorldBounds: bounds(),
      payload,
    },
    packet: {
      payloadId: payload.payloadId,
      sha256,
      byteLength,
      operations: [
        {
          operationId,
          lines,
        },
      ],
    },
  };
}

function tombstoneDelta() {
  return {
    protocolVersion: RenderProtocolVersion,
    deltaId: "delta:dwg:2",
    sessionId: "session:dwg-delta",
    sourceId: "source:dwg-delta",
    baseSnapshotId: "snapshot:dwg-delta:base",
    fromRevisionId: REVISION_TWO,
    toRevisionId: REVISION_THREE,
    sequence: 2,
    operations: [
      {
        operationId: "operation:dwg:tombstone",
        kind: RenderDeltaOperationKind.TOMBSTONE,
        aspect: RenderDeltaAspect.ENTITY,
        layerId: "layer:dwg-live",
        sourceId: "source:dwg-live",
        renderIds: [RENDER_ID],
        affectedWorldBounds: bounds(),
        dependencyIds: [],
        externalIdentityToken: null,
      },
    ],
    affectedWorldBounds: bounds(),
    payload: null,
  };
}

function dependencyDelta() {
  return {
    protocolVersion: RenderProtocolVersion,
    deltaId: "delta:dwg:dependency",
    sessionId: "session:dwg-delta",
    sourceId: "source:dwg-delta",
    baseSnapshotId: "snapshot:dwg-delta:base",
    fromRevisionId: REVISION_TWO,
    toRevisionId: REVISION_THREE,
    sequence: 2,
    operations: [
      {
        operationId: "operation:dwg:dependency",
        kind: RenderDeltaOperationKind.UPSERT,
        aspect: RenderDeltaAspect.DEPENDENCY,
        layerId: "layer:dwg-live",
        sourceId: "source:dwg-live",
        renderIds: ["dwg:root:99"],
        affectedWorldBounds: bounds(),
        dependencyIds: ["block:door", "type:wall"],
        externalIdentityToken: "external:dwg:99",
      },
    ],
    affectedWorldBounds: bounds(),
    payload: null,
  };
}

class FakeDeltaRenderer {
  constructor() {
    this.active = Object.freeze({
      lines: Object.freeze([]),
      baseSuppressions: Object.freeze([]),
      affectedWorldBounds: null,
    });
    this.resources = new Set();
    this.released = [];
    this.stageCount = 0;
    this.failStageAt = null;
  }

  stageRenderDeltaLine(line) {
    this.stageCount += 1;
    if (this.stageCount === this.failStageAt) {
      throw new Error("GPU staging failed");
    }
    const entry = Object.freeze({
      ...line,
      token: this.stageCount,
    });
    this.resources.add(entry);
    return entry;
  }

  activateRenderDelta({
    lines = [],
    baseSuppressions = [],
    affectedWorldBounds = null,
  } = {}) {
    for (const line of lines) {
      if (!this.resources.has(line)) {
        throw new Error("unknown GPU line");
      }
    }
    this.active = Object.freeze({
      lines: Object.freeze([...lines]),
      baseSuppressions: Object.freeze([...baseSuppressions]),
      affectedWorldBounds,
    });
    return this.active;
  }

  releaseRenderDeltaLines(lines) {
    const active = new Set(this.active.lines);
    for (const line of lines) {
      if (!this.resources.has(line) || active.has(line)) {
        throw new Error("invalid GPU release");
      }
    }
    for (const line of lines) {
      this.resources.delete(line);
      this.released.push(line);
    }
    return lines.length;
  }
}

function makeController(renderer, packet) {
  const descriptor = sessionDescriptor();
  const packets = new Map([[packet.payloadId, packet]]);
  const adapter = new DwgRenderDeltaAdapter({
    renderer,
    resolvePacket(payload) {
      return packets.get(payload.payloadId);
    },
  });
  const controller = new ViewerRenderDeltaController({
    sourceSession: { descriptor },
    snapshot: baseSnapshot(descriptor),
    adapter,
  });
  return { adapter, controller, packets };
}

test("stages a DWG line overlay and restores it on preview rollback", () => {
  const renderer = new FakeDeltaRenderer();
  const { delta, packet } = upsertDelta();
  const { adapter, controller } = makeController(renderer, packet);

  const preview = controller.applyPreview(delta);
  assert.equal(preview.previewId, delta.deltaId);
  assert.equal(renderer.active.lines.length, 1);
  assert.equal(renderer.active.baseSuppressions.length, 1);
  assert.equal(renderer.resources.size, 1);
  assert.deepEqual(adapter.snapshot(), {
    revisionId: REVISION_TWO,
    sequence: 1,
    previewId: delta.deltaId,
    overlayEntities: 1,
    lineBatches: 1,
    baseSuppressions: 1,
    affectedWorldBounds: bounds(),
    invalidatedDependencyIds: [],
  });
  assert.deepEqual(
    {
      status: adapter.lookupIdentity("root", 0x2an).status,
      revisionId:
        adapter.lookupIdentity("root", 0x2an).revisionId,
    },
    { status: "upsert", revisionId: REVISION_TWO },
  );
  assert.equal(adapter.acceptsBasePick("root", 0x2an), false);

  controller.rollbackPreview(delta.deltaId);
  assert.equal(renderer.active.lines.length, 0);
  assert.equal(renderer.active.baseSuppressions.length, 0);
  assert.equal(renderer.resources.size, 0);
  assert.equal(adapter.acceptsBasePick("root", 0x2an), true);
  assert.equal(adapter.snapshot().revisionId, REVISION_ONE);
  assert.equal(
    adapter.lookupIdentity("root", 0x2an).revisionId,
    REVISION_ONE,
  );

  controller.applyPreview(delta);
  controller.promotePreview(delta.deltaId);
  assert.equal(renderer.resources.size, 1);
  assert.equal(adapter.snapshot().previewId, null);

  controller.applyCommitted(tombstoneDelta());
  assert.equal(renderer.active.lines.length, 0);
  assert.equal(renderer.active.baseSuppressions.length, 1);
  assert.equal(renderer.resources.size, 0);
  assert.deepEqual(
    {
      status: adapter.lookupIdentity("root", 0x2an).status,
      revisionId:
        adapter.lookupIdentity("root", 0x2an).revisionId,
    },
    { status: "tombstone", revisionId: REVISION_THREE },
  );

  assert.equal(controller.dispose(), true);
  assert.equal(renderer.active.baseSuppressions.length, 0);
});

test("cleans staged GPU resources when an atomic packet fails", () => {
  const renderer = new FakeDeltaRenderer();
  renderer.failStageAt = 2;
  const second = {
    renderId: RENDER_ID,
    sceneId: "root",
    batch: lineBatch(2),
    vertices: lineVertices(),
    instanceIndices: null,
  };
  const { delta, packet } = upsertDelta({
    extraLines: [second],
  });
  const { adapter, controller } = makeController(renderer, packet);
  const baseline = controller.snapshot();

  assert.throws(
    () => controller.applyCommitted(delta),
    /GPU staging failed/u,
  );
  assert.deepEqual(controller.snapshot(), baseline);
  assert.equal(renderer.resources.size, 0);
  assert.equal(renderer.active.lines.length, 0);
  assert.equal(adapter.snapshot().revisionId, null);

  controller.dispose();
});

test("rejects a packet whose vertex handle crosses Render ID scope", () => {
  const renderer = new FakeDeltaRenderer();
  const { delta, packet } = upsertDelta({
    vertices: lineVertices(0x2bn),
  });
  const { adapter, controller } = makeController(renderer, packet);

  assert.throws(
    () => controller.applyCommitted(delta),
    /another Render ID/u,
  );
  assert.equal(renderer.stageCount, 0);
  assert.equal(renderer.resources.size, 0);
  assert.equal(adapter.snapshot().revisionId, null);

  controller.dispose();
});

test("releases committed and preview resources together on disposal", () => {
  const renderer = new FakeDeltaRenderer();
  const first = upsertDelta();
  const { adapter, controller, packets } = makeController(
    renderer,
    first.packet,
  );
  controller.applyCommitted(first.delta);

  const second = upsertDelta({
    deltaId: "delta:dwg:preview-2",
    operationId: "operation:dwg:preview-2",
    fromRevisionId: REVISION_TWO,
    toRevisionId: REVISION_THREE,
    sequence: 2,
  });
  packets.set(second.packet.payloadId, second.packet);
  controller.applyPreview(second.delta);

  assert.equal(renderer.resources.size, 2);
  assert.equal(renderer.active.lines.length, 1);
  assert.equal(adapter.snapshot().previewId, second.delta.deltaId);

  controller.dispose();
  assert.equal(renderer.resources.size, 0);
  assert.equal(renderer.active.lines.length, 0);
  assert.equal(renderer.active.baseSuppressions.length, 0);
  assert.equal(renderer.released.length, 2);
});

test("keeps unchanged pick identities on the active renderer revision", () => {
  const renderer = new FakeDeltaRenderer();
  const first = upsertDelta();
  const { adapter, controller } = makeController(
    renderer,
    first.packet,
  );
  controller.applyCommitted(first.delta);
  controller.applyCommitted(dependencyDelta());

  const identity = adapter.lookupIdentity("root", 0x2an);
  assert.equal(identity.status, "upsert");
  assert.equal(identity.revisionId, REVISION_THREE);
  assert.deepEqual(adapter.snapshot().invalidatedDependencyIds, [
    "block:door",
    "type:wall",
  ]);
  assert.equal(renderer.resources.size, 1);
  assert.equal(renderer.active.lines.length, 1);

  controller.dispose();
});

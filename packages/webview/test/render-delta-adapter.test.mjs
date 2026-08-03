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
  DWG_FILL_VERTEX_STRIDE,
  DWG_LINE_VERTEX_STRIDE,
  DWG_POINT_VERTEX_STRIDE,
  DWG_RENDER_DELTA_MEDIA_TYPE,
  DWG_RENDER_DELTA_MEDIA_TYPE_V1,
  DWG_RENDER_DELTA_MEDIA_TYPE_V2,
  DWG_RENDER_DELTA_MEDIA_TYPE_V3,
  DWG_RENDER_DELTA_MEDIA_TYPE_V4,
  DWG_RENDER_DELTA_MEDIA_TYPE_V5,
} from "../src/render-delta-adapter.mjs";
import { GpuLineBatchKind } from "../src/scene-cache.mjs";
import {
  dwgRenderDeltaStyleBuffer,
} from "./render-delta-style-fixture.mjs";
import {
  dwgRenderDeltaTransformBuffer,
} from "./render-delta-transform-fixture.mjs";

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

function fillVertices() {
  const buffer = new ArrayBuffer(DWG_FILL_VERTEX_STRIDE * 3);
  const view = new DataView(buffer);
  for (let vertex = 0; vertex < 3; vertex += 1) {
    const offset = vertex * DWG_FILL_VERTEX_STRIDE;
    view.setFloat32(offset, vertex === 1 ? 1 : 0, true);
    view.setFloat32(offset + 4, vertex === 2 ? 1 : 0, true);
    view.setUint32(offset + 12, 0, true);
    view.setUint32(offset + 16, (2 << 30) | 3, true);
    view.setUint32(offset + 20, (2 << 30) | 3, true);
  }
  return Object.freeze({
    buffer,
    byteLength: buffer.byteLength,
    vertexCount: 3,
    recordSize: DWG_FILL_VERTEX_STRIDE,
  });
}

function fillBatch(id = 2) {
  return Object.freeze({
    ...lineBatch(id),
    vertexCount: 3,
  });
}

function fillEntry(vertices = fillVertices(), id = 2) {
  return {
    renderId: RENDER_ID,
    sceneId: "root",
    batch: fillBatch(id),
    vertices,
    instanceIndices: null,
  };
}

function pointVertices() {
  const buffer = new ArrayBuffer(DWG_POINT_VERTEX_STRIDE);
  const view = new DataView(buffer);
  view.setFloat32(0, 0.5, true);
  view.setFloat32(4, 0.5, true);
  view.setUint32(12, 0, true);
  view.setUint32(16, (2 << 30) | 2, true);
  view.setFloat32(20, 0, true);
  view.setFloat32(24, 4, true);
  view.setUint32(28, 0, true);
  return Object.freeze({
    buffer,
    byteLength: buffer.byteLength,
    vertexCount: 1,
    recordSize: DWG_POINT_VERTEX_STRIDE,
  });
}

function pointBatch(id = 3) {
  return Object.freeze({
    ...lineBatch(id),
    vertexCount: 1,
  });
}

function pointEntry(vertices = pointVertices(), id = 3) {
  return {
    renderId: RENDER_ID,
    sceneId: "root",
    batch: pointBatch(id),
    vertices,
    instanceIndices: null,
  };
}

function textRecord({
  handle = "2a",
  value = "변경된 문자",
} = {}) {
  return {
    handle,
    ownerHandle: "0",
    layerIndex: 0,
    color: ((2 << 30) | 2) >>> 0,
    lineWeight: -3,
    commonFlags: 0,
    linetypeCode: 2,
    kind: 0,
    flags: 0,
    style: null,
    value,
    tag: "",
    prompt: "",
    linkedHandle: "0",
    insertionPoint: [0.5, 0.5, 0],
    alignmentPoint: [0.5, 0.5, 0],
    normal: [0, 0, 1],
    xAxisDirection: [1, 0, 0],
    height: 1,
    widthFactor: 1,
    rotation: 0,
    obliqueAngle: 0,
    thickness: 0,
    rectangleWidth: 0,
    rectangleHeight: 0,
    extentsWidth: 0,
    extentsHeight: 0,
    lineSpacingFactor: 1,
    backgroundScale: 1.5,
    backgroundColor: 0,
    backgroundTransparency: 0,
    backgroundFlags: 0,
    sourceFlags: 0,
    horizontalAlignment: 0,
    verticalAlignment: 0,
    attachment: 0,
    flowDirection: 0,
    lineSpacingStyle: 0,
    generationFlags: 0,
    fieldLength: 0,
    mtextType: 0,
    lineCount: 1,
    columnType: 0,
    columnCount: 0,
    columnFlags: 0,
    columnWidth: 0,
    columnGutter: 0,
    columnHeights: [],
  };
}

function textBuffer(options) {
  return new TextEncoder().encode(
    JSON.stringify(textRecord(options)),
  ).buffer;
}

function textEntry(buffer = textBuffer()) {
  return {
    renderId: RENDER_ID,
    sceneId: "root",
    buffer,
  };
}

function transformEntry(
  buffer = dwgRenderDeltaTransformBuffer(),
) {
  return {
    renderId: RENDER_ID,
    sceneId: "root",
    buffer,
  };
}

function styleEntry(buffer = dwgRenderDeltaStyleBuffer({
  visible: false,
})) {
  return {
    renderId: RENDER_ID,
    sceneId: "root",
    buffer,
  };
}

function upsertDelta({
  deltaId = "delta:dwg:1",
  operationId = "operation:dwg:upsert",
  fromRevisionId = REVISION_ONE,
  toRevisionId = REVISION_TWO,
  sequence = 1,
  vertices = lineVertices(),
  extraLines = [],
  includeLine = true,
  fills = [],
  points = [],
  texts = [],
  transforms = [],
  styles = [],
  aspect = RenderDeltaAspect.GEOMETRY,
} = {}) {
  const sha256 = "a".repeat(64);
  const lines = [
    ...(includeLine
      ? [
          {
            renderId: RENDER_ID,
            sceneId: "root",
            batch: lineBatch(1),
            vertices,
            instanceIndices: null,
          },
        ]
      : []),
    ...extraLines,
  ];
  const byteLength =
    [...lines, ...fills, ...points].reduce(
      (total, entry) => total + entry.vertices.byteLength,
      0,
    ) +
    texts.reduce(
      (total, entry) => total + entry.buffer.byteLength,
      0,
    ) +
    transforms.reduce(
      (total, entry) => total + entry.buffer.byteLength,
      0,
    ) +
    styles.reduce(
      (total, entry) => total + entry.buffer.byteLength,
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
          aspect,
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
          fills,
          points,
          texts,
          transforms,
          styles,
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
      fills: Object.freeze([]),
      points: Object.freeze([]),
      texts: Object.freeze([]),
      transforms: Object.freeze([]),
      styles: Object.freeze([]),
      baseSuppressions: Object.freeze([]),
      invalidatedDependencyIds: Object.freeze([]),
      affectedWorldBounds: null,
    });
    this.resources = new Set();
    this.released = [];
    this.stageCount = 0;
    this.failStageAt = null;
  }

  stageRenderDeltaLine(line) {
    return this.stage("line", line);
  }

  stageRenderDeltaFill(fill) {
    return this.stage("fill", fill);
  }

  stageRenderDeltaPoint(point) {
    return this.stage("point", point);
  }

  stageRenderDeltaText(text) {
    return this.stage("text", text);
  }

  stageRenderDeltaTransform(transform) {
    return this.stage("transform", transform);
  }

  stageRenderDeltaStyle(style) {
    return this.stage("style", style);
  }

  stage(resourceKind, value) {
    this.stageCount += 1;
    if (this.stageCount === this.failStageAt) {
      throw new Error("GPU staging failed");
    }
    const entry = Object.freeze({
      ...value,
      resourceKind,
      token: this.stageCount,
    });
    this.resources.add(entry);
    return entry;
  }

  activateRenderDelta({
    lines = [],
    fills = [],
    points = [],
    texts = [],
    transforms = [],
    styles = [],
    baseSuppressions = [],
    invalidatedDependencyIds = [],
    affectedWorldBounds = null,
  } = {}) {
    for (const [resourceKind, entries] of [
      ["line", lines],
      ["fill", fills],
      ["point", points],
      ["text", texts],
      ["transform", transforms],
      ["style", styles],
    ]) {
      for (const entry of entries) {
        if (
          !this.resources.has(entry) ||
          entry.resourceKind !== resourceKind
        ) {
          throw new Error(`unknown GPU ${resourceKind}`);
        }
      }
    }
    this.active = Object.freeze({
      lines: Object.freeze([...lines]),
      fills: Object.freeze([...fills]),
      points: Object.freeze([...points]),
      texts: Object.freeze([...texts]),
      transforms: Object.freeze([...transforms]),
      styles: Object.freeze([...styles]),
      baseSuppressions: Object.freeze([...baseSuppressions]),
      invalidatedDependencyIds: Object.freeze([
        ...invalidatedDependencyIds,
      ]),
      affectedWorldBounds,
    });
    return this.active;
  }

  releaseRenderDeltaResources(resources) {
    const active = new Set([
      ...this.active.lines,
      ...this.active.fills,
      ...this.active.points,
      ...this.active.texts,
      ...this.active.transforms,
      ...this.active.styles,
    ]);
    for (const resource of resources) {
      if (
        !this.resources.has(resource) ||
        active.has(resource)
      ) {
        throw new Error("invalid GPU release");
      }
    }
    for (const resource of resources) {
      this.resources.delete(resource);
      this.released.push(resource);
    }
    return resources.length;
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
    fillBatches: 0,
    pointBatches: 0,
    textRecords: 0,
    textBytes: 0,
    transformRecords: 0,
    transformBytes: 0,
    styleRecords: 0,
    styleBytes: 0,
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
  assert.equal(renderer.active.fills.length, 0);
  assert.equal(renderer.active.points.length, 0);
  assert.equal(renderer.active.texts.length, 0);
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
  assert.equal(renderer.active.fills.length, 0);
  assert.equal(renderer.active.points.length, 0);
  assert.equal(renderer.active.texts.length, 0);
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
  renderer.failStageAt = 4;
  const { delta, packet } = upsertDelta({
    fills: [fillEntry()],
    points: [pointEntry()],
    texts: [textEntry()],
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
  assert.equal(renderer.active.fills.length, 0);
  assert.equal(renderer.active.points.length, 0);
  assert.equal(renderer.active.texts.length, 0);
  assert.equal(adapter.snapshot().revisionId, null);

  controller.dispose();
});

test("stages a fill-only upsert and restores it on preview rollback", () => {
  const renderer = new FakeDeltaRenderer();
  const { delta, packet } = upsertDelta({
    includeLine: false,
    fills: [fillEntry()],
  });
  const { adapter, controller } = makeController(renderer, packet);

  controller.applyPreview(delta);
  assert.equal(renderer.active.lines.length, 0);
  assert.equal(renderer.active.fills.length, 1);
  assert.equal(renderer.resources.size, 1);
  assert.equal(adapter.snapshot().lineBatches, 0);
  assert.equal(adapter.snapshot().fillBatches, 1);
  assert.equal(adapter.lookupIdentity("root", 0x2an).status, "upsert");

  controller.rollbackPreview(delta.deltaId);
  assert.equal(renderer.active.fills.length, 0);
  assert.equal(renderer.resources.size, 0);
  assert.equal(adapter.acceptsBasePick("root", 0x2an), true);

  controller.dispose();
});

test("stages a point-only upsert and restores it on preview rollback", () => {
  const renderer = new FakeDeltaRenderer();
  const { delta, packet } = upsertDelta({
    includeLine: false,
    points: [pointEntry()],
  });
  const { adapter, controller } = makeController(renderer, packet);

  controller.applyPreview(delta);
  assert.equal(renderer.active.lines.length, 0);
  assert.equal(renderer.active.fills.length, 0);
  assert.equal(renderer.active.points.length, 1);
  assert.equal(renderer.resources.size, 1);
  assert.equal(adapter.snapshot().lineBatches, 0);
  assert.equal(adapter.snapshot().fillBatches, 0);
  assert.equal(adapter.snapshot().pointBatches, 1);
  assert.equal(adapter.lookupIdentity("root", 0x2an).status, "upsert");

  controller.rollbackPreview(delta.deltaId);
  assert.equal(renderer.active.points.length, 0);
  assert.equal(renderer.resources.size, 0);
  assert.equal(adapter.acceptsBasePick("root", 0x2an), true);

  controller.dispose();
});

test("stages a text-only upsert and restores it on preview rollback", () => {
  const renderer = new FakeDeltaRenderer();
  const { delta, packet } = upsertDelta({
    includeLine: false,
    texts: [textEntry()],
  });
  const { adapter, controller } = makeController(renderer, packet);

  controller.applyPreview(delta);
  assert.equal(renderer.active.lines.length, 0);
  assert.equal(renderer.active.fills.length, 0);
  assert.equal(renderer.active.points.length, 0);
  assert.equal(renderer.active.texts.length, 1);
  assert.equal(renderer.resources.size, 1);
  assert.equal(adapter.snapshot().textRecords, 1);
  assert.equal(
    adapter.snapshot().textBytes,
    packet.operations[0].texts[0].buffer.byteLength,
  );
  assert.equal(adapter.lookupIdentity("root", 0x2an).status, "upsert");

  controller.rollbackPreview(delta.deltaId);
  assert.equal(renderer.active.texts.length, 0);
  assert.equal(renderer.resources.size, 0);
  assert.equal(adapter.acceptsBasePick("root", 0x2an), true);

  controller.dispose();
});

test("stages an instance-transform upsert and restores it on rollback", () => {
  const renderer = new FakeDeltaRenderer();
  const transform = transformEntry();
  const { delta, packet } = upsertDelta({
    includeLine: false,
    transforms: [transform],
    aspect: RenderDeltaAspect.TRANSFORM,
  });
  const { adapter, controller } = makeController(renderer, packet);

  controller.applyPreview(delta);
  assert.equal(renderer.active.lines.length, 0);
  assert.equal(renderer.active.transforms.length, 1);
  assert.equal(renderer.resources.size, 1);
  assert.equal(adapter.snapshot().transformRecords, 1);
  assert.equal(
    adapter.snapshot().transformBytes,
    transform.buffer.byteLength,
  );
  assert.equal(adapter.lookupIdentity("root", 0x2an).status, "upsert");

  controller.rollbackPreview(delta.deltaId);
  assert.equal(renderer.active.transforms.length, 0);
  assert.equal(renderer.resources.size, 0);
  assert.equal(adapter.acceptsBasePick("root", 0x2an), true);

  controller.dispose();
});

test("stages an instance-style upsert and restores it on rollback", () => {
  const renderer = new FakeDeltaRenderer();
  const style = styleEntry();
  const { delta, packet } = upsertDelta({
    includeLine: false,
    styles: [style],
    aspect: RenderDeltaAspect.STYLE,
  });
  const { adapter, controller } = makeController(renderer, packet);

  controller.applyPreview(delta);
  assert.equal(renderer.active.lines.length, 0);
  assert.equal(renderer.active.styles.length, 1);
  assert.equal(renderer.resources.size, 1);
  assert.equal(adapter.snapshot().styleRecords, 1);
  assert.equal(
    adapter.snapshot().styleBytes,
    style.buffer.byteLength,
  );

  controller.rollbackPreview(delta.deltaId);
  assert.equal(renderer.active.styles.length, 0);
  assert.equal(renderer.resources.size, 0);
  assert.equal(adapter.acceptsBasePick("root", 0x2an), true);

  controller.dispose();
});

test("keeps a committed transform while previewing and promoting style", () => {
  const renderer = new FakeDeltaRenderer();
  const first = upsertDelta({
    includeLine: false,
    transforms: [transformEntry()],
    aspect: RenderDeltaAspect.TRANSFORM,
  });
  const second = upsertDelta({
    deltaId: "delta:dwg:style-after-transform",
    operationId: "operation:dwg:style-after-transform",
    fromRevisionId: REVISION_TWO,
    toRevisionId: REVISION_THREE,
    sequence: 2,
    includeLine: false,
    styles: [styleEntry()],
    aspect: RenderDeltaAspect.STYLE,
  });
  const { adapter, controller, packets } = makeController(
    renderer,
    first.packet,
  );
  packets.set(second.packet.payloadId, second.packet);

  controller.applyCommitted(first.delta);
  controller.applyPreview(second.delta);
  assert.equal(renderer.active.transforms.length, 1);
  assert.equal(renderer.active.styles.length, 1);
  assert.equal(renderer.resources.size, 2);

  controller.rollbackPreview(second.delta.deltaId);
  assert.equal(renderer.active.transforms.length, 1);
  assert.equal(renderer.active.styles.length, 0);
  assert.equal(renderer.resources.size, 1);
  assert.equal(adapter.snapshot().revisionId, REVISION_TWO);

  controller.applyPreview(second.delta);
  controller.promotePreview(second.delta.deltaId);
  assert.equal(renderer.active.transforms.length, 1);
  assert.equal(renderer.active.styles.length, 1);
  assert.equal(renderer.resources.size, 2);

  controller.dispose();
  assert.equal(renderer.resources.size, 0);
});

test("accepts the line-only v1 private packet during the v6 transition", () => {
  const renderer = new FakeDeltaRenderer();
  const { delta, packet } = upsertDelta();
  delta.payload.mediaType = DWG_RENDER_DELTA_MEDIA_TYPE_V1;
  delete packet.operations[0].fills;
  delete packet.operations[0].points;
  delete packet.operations[0].texts;
  delete packet.operations[0].transforms;
  delete packet.operations[0].styles;
  const { adapter, controller } = makeController(renderer, packet);

  controller.applyCommitted(delta);

  assert.equal(renderer.active.lines.length, 1);
  assert.equal(renderer.active.fills.length, 0);
  assert.equal(renderer.active.points.length, 0);
  assert.equal(renderer.active.texts.length, 0);
  assert.equal(adapter.snapshot().fillBatches, 0);
  assert.equal(adapter.snapshot().pointBatches, 0);
  controller.dispose();
});

test("accepts the line/fill v2 private packet during the v6 transition", () => {
  const renderer = new FakeDeltaRenderer();
  const { delta, packet } = upsertDelta({
    fills: [fillEntry()],
  });
  delta.payload.mediaType = DWG_RENDER_DELTA_MEDIA_TYPE_V2;
  delete packet.operations[0].points;
  delete packet.operations[0].texts;
  delete packet.operations[0].transforms;
  delete packet.operations[0].styles;
  const { adapter, controller } = makeController(renderer, packet);

  controller.applyCommitted(delta);

  assert.equal(renderer.active.lines.length, 1);
  assert.equal(renderer.active.fills.length, 1);
  assert.equal(renderer.active.points.length, 0);
  assert.equal(renderer.active.texts.length, 0);
  assert.equal(adapter.snapshot().fillBatches, 1);
  assert.equal(adapter.snapshot().pointBatches, 0);
  controller.dispose();
});

test("accepts the line/fill/point v3 packet during the v6 transition", () => {
  const renderer = new FakeDeltaRenderer();
  const { delta, packet } = upsertDelta({
    fills: [fillEntry()],
    points: [pointEntry()],
  });
  delta.payload.mediaType = DWG_RENDER_DELTA_MEDIA_TYPE_V3;
  delete packet.operations[0].texts;
  delete packet.operations[0].transforms;
  delete packet.operations[0].styles;
  const { adapter, controller } = makeController(renderer, packet);

  controller.applyCommitted(delta);

  assert.equal(renderer.active.lines.length, 1);
  assert.equal(renderer.active.fills.length, 1);
  assert.equal(renderer.active.points.length, 1);
  assert.equal(renderer.active.texts.length, 0);
  assert.equal(adapter.snapshot().pointBatches, 1);
  assert.equal(adapter.snapshot().textRecords, 0);
  controller.dispose();
});

test("accepts the v4 text packet during the v6 transition", () => {
  const renderer = new FakeDeltaRenderer();
  const { delta, packet } = upsertDelta({
    includeLine: false,
    texts: [textEntry()],
  });
  delta.payload.mediaType = DWG_RENDER_DELTA_MEDIA_TYPE_V4;
  delete packet.operations[0].transforms;
  delete packet.operations[0].styles;
  const { adapter, controller } = makeController(renderer, packet);

  controller.applyCommitted(delta);

  assert.equal(renderer.active.lines.length, 0);
  assert.equal(renderer.active.texts.length, 1);
  assert.equal(renderer.active.transforms.length, 0);
  assert.equal(adapter.snapshot().textRecords, 1);
  assert.equal(adapter.snapshot().transformRecords, 0);
  controller.dispose();
});

test("accepts the v5 transform packet during the v6 transition", () => {
  const renderer = new FakeDeltaRenderer();
  const { delta, packet } = upsertDelta({
    includeLine: false,
    transforms: [transformEntry()],
    aspect: RenderDeltaAspect.TRANSFORM,
  });
  delta.payload.mediaType = DWG_RENDER_DELTA_MEDIA_TYPE_V5;
  delete packet.operations[0].styles;
  const { adapter, controller } = makeController(renderer, packet);

  controller.applyCommitted(delta);

  assert.equal(renderer.active.transforms.length, 1);
  assert.equal(renderer.active.styles.length, 0);
  assert.equal(adapter.snapshot().transformRecords, 1);
  assert.equal(adapter.snapshot().styleRecords, 0);
  controller.dispose();
});

test("rejects a fill packet outside its Render ID scene", () => {
  const renderer = new FakeDeltaRenderer();
  const fill = fillEntry();
  fill.sceneId = "external";
  const { delta, packet } = upsertDelta({
    includeLine: false,
    fills: [fill],
  });
  const { adapter, controller } = makeController(renderer, packet);

  assert.throws(
    () => controller.applyCommitted(delta),
    /invalid DWG fill payload/u,
  );
  assert.equal(renderer.stageCount, 0);
  assert.equal(renderer.resources.size, 0);
  assert.equal(adapter.snapshot().revisionId, null);
  controller.dispose();
});

test("rejects a point packet outside its Render ID scene", () => {
  const renderer = new FakeDeltaRenderer();
  const point = pointEntry();
  point.sceneId = "external";
  const { delta, packet } = upsertDelta({
    includeLine: false,
    points: [point],
  });
  const { adapter, controller } = makeController(renderer, packet);

  assert.throws(
    () => controller.applyCommitted(delta),
    /invalid DWG point payload/u,
  );
  assert.equal(renderer.stageCount, 0);
  assert.equal(renderer.resources.size, 0);
  assert.equal(adapter.snapshot().revisionId, null);
  controller.dispose();
});

test("rejects a text packet whose native handle crosses Render ID scope", () => {
  const renderer = new FakeDeltaRenderer();
  const { delta, packet } = upsertDelta({
    includeLine: false,
    texts: [textEntry(textBuffer({ handle: "2b" }))],
  });
  const { adapter, controller } = makeController(renderer, packet);

  assert.throws(
    () => controller.applyCommitted(delta),
    /invalid DWG text payload/u,
  );
  assert.equal(renderer.stageCount, 0);
  assert.equal(renderer.resources.size, 0);
  assert.equal(adapter.snapshot().revisionId, null);
  controller.dispose();
});

test("rejects a transform packet outside its Render ID scope", () => {
  const renderer = new FakeDeltaRenderer();
  const { delta, packet } = upsertDelta({
    includeLine: false,
    transforms: [
      transformEntry(
        dwgRenderDeltaTransformBuffer({ handle: 0x2bn }),
      ),
    ],
    aspect: RenderDeltaAspect.TRANSFORM,
  });
  const { adapter, controller } = makeController(renderer, packet);

  assert.throws(
    () => controller.applyCommitted(delta),
    /invalid DWG transform payload/u,
  );
  assert.equal(renderer.stageCount, 0);
  assert.equal(renderer.resources.size, 0);
  assert.equal(adapter.snapshot().revisionId, null);
  controller.dispose();
});

test("rejects a style packet outside its Render ID scope", () => {
  const renderer = new FakeDeltaRenderer();
  const { delta, packet } = upsertDelta({
    includeLine: false,
    styles: [
      styleEntry(
        dwgRenderDeltaStyleBuffer({
          handle: 0x2bn,
          visible: false,
        }),
      ),
    ],
    aspect: RenderDeltaAspect.STYLE,
  });
  const { adapter, controller } = makeController(renderer, packet);

  assert.throws(
    () => controller.applyCommitted(delta),
    /invalid DWG style payload/u,
  );
  assert.equal(renderer.stageCount, 0);
  assert.equal(renderer.resources.size, 0);
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
  const first = upsertDelta({
    fills: [fillEntry()],
    points: [pointEntry()],
    texts: [textEntry()],
  });
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
    fills: [fillEntry(fillVertices(), 3)],
    points: [pointEntry(pointVertices(), 4)],
    texts: [textEntry(textBuffer({ value: "미리보기 문자" }))],
  });
  packets.set(second.packet.payloadId, second.packet);
  controller.applyPreview(second.delta);

  assert.equal(renderer.resources.size, 8);
  assert.equal(renderer.active.lines.length, 1);
  assert.equal(renderer.active.fills.length, 1);
  assert.equal(renderer.active.points.length, 1);
  assert.equal(renderer.active.texts.length, 1);
  assert.equal(adapter.snapshot().previewId, second.delta.deltaId);

  controller.dispose();
  assert.equal(renderer.resources.size, 0);
  assert.equal(renderer.active.lines.length, 0);
  assert.equal(renderer.active.fills.length, 0);
  assert.equal(renderer.active.points.length, 0);
  assert.equal(renderer.active.texts.length, 0);
  assert.equal(renderer.active.baseSuppressions.length, 0);
  assert.equal(renderer.released.length, 8);
});

test("keeps unchanged pick identities on the active renderer revision", () => {
  const renderer = new FakeDeltaRenderer();
  const first = upsertDelta();
  const { adapter, controller } = makeController(
    renderer,
    first.packet,
  );
  controller.applyCommitted(first.delta);
  const dependency = dependencyDelta();
  controller.applyPreview(dependency);
  assert.deepEqual(renderer.active.invalidatedDependencyIds, [
    "block:door",
    "type:wall",
  ]);
  controller.rollbackPreview(dependency.deltaId);
  assert.deepEqual(renderer.active.invalidatedDependencyIds, []);

  controller.applyCommitted(dependency);

  const identity = adapter.lookupIdentity("root", 0x2an);
  assert.equal(identity.status, "upsert");
  assert.equal(identity.revisionId, REVISION_THREE);
  assert.deepEqual(adapter.snapshot().invalidatedDependencyIds, [
    "block:door",
    "type:wall",
  ]);
  assert.equal(renderer.resources.size, 1);
  assert.equal(renderer.active.lines.length, 1);
  assert.deepEqual(renderer.active.invalidatedDependencyIds, [
    "block:door",
    "type:wall",
  ]);

  controller.dispose();
});

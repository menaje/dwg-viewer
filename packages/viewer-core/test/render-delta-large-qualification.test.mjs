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
  ViewerDiffOverlayController,
} from "@dwg-viewer/viewer-core/diff-overlay";
import {
  ViewerRenderDeltaController,
} from "@dwg-viewer/viewer-core/render-delta";
import {
  ViewerRenderDiffController,
} from "@dwg-viewer/viewer-core/render-diff";
import {
  ViewerSplitViewDiffController,
} from "@dwg-viewer/viewer-core/split-view";

const BASE_RENDER_ID_COUNT = 378_400;
const DELTA_COUNT = 8;
const CHANGES_PER_DELTA = 96;
const PAYLOAD_BYTES = 1024 * 1024;
const RETAINED_MAPPING_HARD_LIMIT_BYTES = 8 * 1024 * 1024;

function revision(sequence) {
  return `revision:qualification:${sequence}`;
}

function descriptor() {
  return parseRenderSessionDescriptor({
    protocolVersion: RenderProtocolVersion,
    sessionId: "session:large-qualification",
    sourceId: "source:large-qualification",
    currentRevisionId: revision(0),
    lastSuccessfulRevisionId: revision(0),
    capabilities: [
      RenderCapability.LAYER_MANIFEST,
      RenderCapability.RENDER_DELTA,
      RenderCapability.RENDER_SNAPSHOT,
    ],
    resourceBudgetBytes: 512 * 1024 * 1024,
  });
}

function snapshot(session) {
  return parseRenderSnapshotDescriptor(
    {
      protocolVersion: RenderProtocolVersion,
      sessionId: session.sessionId,
      sourceId: session.sourceId,
      revisionId: revision(0),
      snapshotId: "snapshot:large-qualification",
      sequence: 0,
      layers: [
        {
          layerId: "layer:live",
          sourceId: "source:live",
          revisionId: revision(0),
          kind: ViewerLayerKind.LIVE,
          representation: ViewerRepresentation.TWO_DIMENSIONAL,
          order: 0,
          visible: true,
        },
      ],
    },
    { session },
  );
}

function bounds(sequence) {
  return {
    min: [sequence, sequence, 0],
    max: [sequence + 1, sequence + 1, 1],
  };
}

function operation({
  operationId,
  renderId,
  kind = RenderDeltaOperationKind.UPSERT,
  aspect = RenderDeltaAspect.GEOMETRY,
  dependencyIds = [],
}) {
  return {
    operationId,
    kind,
    aspect,
    layerId: "layer:live",
    sourceId: "source:live",
    renderIds: [renderId],
    affectedWorldBounds: bounds(0),
    dependencyIds,
    externalIdentityToken:
      kind === RenderDeltaOperationKind.TOMBSTONE
        ? null
        : `external:${renderId}`,
  };
}

function operations(sequence) {
  const result = [];
  const baseOffset = (sequence - 1) * 64;
  for (let index = 0; index < 32; index += 1) {
    const modified = baseOffset + index;
    const removed = baseOffset + 32 + index;
    const added = (sequence - 1) * 32 + index;
    result.push(
      operation({
        operationId: `operation:${sequence}:modify:${index}`,
        renderId: `render:base:${modified}`,
        aspect:
          index === 0
            ? RenderDeltaAspect.DEPENDENCY
            : index === 1
              ? RenderDeltaAspect.IDENTITY
              : RenderDeltaAspect.GEOMETRY,
        dependencyIds:
          index === 0
            ? [`block:qualification:${sequence}`]
            : [],
      }),
      operation({
        operationId: `operation:${sequence}:remove:${index}`,
        renderId: `render:base:${removed}`,
        kind: RenderDeltaOperationKind.TOMBSTONE,
        aspect: RenderDeltaAspect.ENTITY,
      }),
      operation({
        operationId: `operation:${sequence}:add:${index}`,
        renderId: `render:new:${added}`,
        aspect: RenderDeltaAspect.STYLE,
      }),
    );
  }
  return result;
}

function delta(sequence, inputOperations = operations(sequence)) {
  const hexadecimal = (sequence % 16).toString(16);
  return {
    protocolVersion: RenderProtocolVersion,
    deltaId: `delta:qualification:${sequence}`,
    sessionId: "session:large-qualification",
    sourceId: "source:large-qualification",
    baseSnapshotId: "snapshot:large-qualification",
    fromRevisionId: revision(sequence - 1),
    toRevisionId: revision(sequence),
    sequence,
    operations: inputOperations,
    affectedWorldBounds: {
      min: [0, 0, 0],
      max: [DELTA_COUNT + 2, DELTA_COUNT + 2, 1],
    },
    payload: {
      protocolVersion: RenderProtocolVersion,
      payloadId: `payload:qualification:${sequence}`,
      sessionId: "session:large-qualification",
      sourceId: "source:large-qualification",
      fromRevisionId: revision(sequence - 1),
      toRevisionId: revision(sequence),
      mediaType: "application/vnd.dwg-viewer.render-delta",
      byteLength: PAYLOAD_BYTES,
      sha256: hexadecimal.repeat(64),
      expiresAt: null,
      disposeWithSession: true,
    },
  };
}

function splitTarget() {
  const state = {
    presentation: null,
  };
  return {
    state,
    adapter: {
      applySplitDiff(presentation) {
        state.presentation = presentation;
      },
      clearSplitDiff() {
        state.presentation = null;
      },
    },
  };
}

function mappingKeys(entries) {
  return entries.map(
    ({ layerId, renderId, status }) =>
      `${layerId}\u0000${renderId}\u0000${status}`,
  );
}

test("qualifies bounded revision diff behavior against a 378k-entity base", () => {
  const session = descriptor();
  const baseSnapshot = snapshot(session);
  const adapterState = {
    reject: false,
    applied: [],
    rollbacks: [],
  };
  const deltaController = new ViewerRenderDeltaController({
    sourceSession: { descriptor: session },
    snapshot: baseSnapshot,
    checkpointDeltaCount: DELTA_COUNT,
    checkpointPayloadBytes: DELTA_COUNT * PAYLOAD_BYTES,
    checkpointOverlayEntries: DELTA_COUNT * CHANGES_PER_DELTA,
    checkpointDependencyIds: DELTA_COUNT,
    maximumDeltaCount: DELTA_COUNT * 2,
    maximumPayloadBytes: DELTA_COUNT * PAYLOAD_BYTES * 2,
    maximumOverlayEntries:
      DELTA_COUNT * CHANGES_PER_DELTA * 2,
    maximumDependencyIds: DELTA_COUNT * 2,
    adapter: {
      applyDelta(nextDelta, { preview }) {
        if (adapterState.reject) {
          throw new Error("qualification staging failed");
        }
        adapterState.applied.push([nextDelta.deltaId, preview]);
      },
      rollbackPreview(nextDelta) {
        adapterState.rollbacks.push(nextDelta.deltaId);
      },
      promotePreview() {},
      dispose() {},
    },
  });

  for (let sequence = 1; sequence <= DELTA_COUNT; sequence += 1) {
    deltaController.applyCommitted(delta(sequence));
  }
  const retained = deltaController.snapshot();
  assert.equal(retained.revisionId, revision(DELTA_COUNT));
  assert.equal(retained.deltaCount, DELTA_COUNT);
  assert.equal(
    retained.payloadBytes,
    DELTA_COUNT * PAYLOAD_BYTES,
  );
  assert.equal(
    retained.overlayEntries,
    DELTA_COUNT * CHANGES_PER_DELTA,
  );
  assert.equal(retained.invalidatedDependencyCount, DELTA_COUNT);
  assert.equal(retained.checkpointRecommended, true);

  let membershipCalls = 0;
  const diffController = new ViewerRenderDiffController({
    renderDeltaController: deltaController,
    baseRenderIdCount: BASE_RENDER_ID_COUNT,
    hasBaseRenderId(layerId, renderId) {
      membershipCalls += 1;
      if (layerId !== "layer:live") {
        return false;
      }
      const match = /^render:base:(\d+)$/u.exec(renderId);
      return (
        match !== null &&
        Number(match[1]) < BASE_RENDER_ID_COUNT
      );
    },
  });
  const diff = diffController.snapshot();
  assert.equal(
    diff.changedEntries.length,
    DELTA_COUNT * CHANGES_PER_DELTA,
  );
  assert.equal(membershipCalls, diff.changedEntries.length);
  assert.equal(diff.counts.modified, DELTA_COUNT * 32);
  assert.equal(diff.counts.removed, DELTA_COUNT * 32);
  assert.equal(diff.counts.added, DELTA_COUNT * 32);
  assert.equal(
    diff.counts.unchanged,
    BASE_RENDER_ID_COUNT - DELTA_COUNT * 64,
  );
  assert.equal(
    diff.changedEntries.some(
      ({ status }) => status === "unchanged",
    ),
    false,
  );
  assert(
    Buffer.byteLength(JSON.stringify(diff.changedEntries), "utf8") <
      RETAINED_MAPPING_HARD_LIMIT_BYTES,
  );

  let overlayPresentation;
  const overlay = new ViewerDiffOverlayController({
    renderDiffController: diffController,
    adapter: {
      applyDiffOverlay(presentation) {
        overlayPresentation = presentation;
      },
      clearDiffOverlay() {
        overlayPresentation = null;
      },
    },
  });
  overlay.synchronize();
  const before = splitTarget();
  const after = splitTarget();
  const split = new ViewerSplitViewDiffController({
    renderDiffController: diffController,
    before: before.adapter,
    after: after.adapter,
  });
  split.synchronize();

  assert.deepEqual(
    mappingKeys(overlayPresentation.changedEntries),
    mappingKeys(
      before.state.presentation.comparison.changedEntries,
    ),
  );
  assert.equal(
    before.state.presentation.comparison,
    after.state.presentation.comparison,
  );
  const highlighted =
    before.state.presentation.comparison.changedEntries[0];
  split.highlight(highlighted.layerId, highlighted.renderId);
  assert.equal(
    before.state.presentation.highlight,
    after.state.presentation.highlight,
  );

  const baseline = deltaController.snapshot();
  const preview = delta(DELTA_COUNT + 1, [
    operation({
      operationId: "operation:qualification:preview",
      renderId: "render:new:preview",
    }),
  ]);
  deltaController.applyPreview(preview);
  assert.equal(
    diffController.snapshot().previewId,
    preview.deltaId,
  );
  deltaController.rollbackPreview(preview.deltaId);
  assert.deepEqual(deltaController.snapshot(), baseline);
  assert.deepEqual(adapterState.rollbacks, [preview.deltaId]);

  adapterState.reject = true;
  assert.throws(
    () => deltaController.applyCommitted(preview),
    /qualification staging failed/u,
  );
  assert.deepEqual(deltaController.snapshot(), baseline);

  split.dispose();
  overlay.dispose();
  deltaController.dispose();
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  RenderCapability,
  RenderProtocolDiagnosticCode,
  RenderProtocolVersion,
  RenderRevisionEventStatus,
  ViewerDiagnosticSeverity,
  ViewerLayerKind,
  ViewerRepresentation,
} from "@menaje/viewer-render-protocol";

import {
  runServiceEventConformance,
  runServiceRenderSourceConformance,
} from "../src/conformance.mjs";
import {
  createMockServiceEventHarness,
  MockServicePickFixture,
  MockServiceRenderSource,
} from "../src/testing.mjs";
import { openRenderSource } from "../src/render-source-session.mjs";

const revisionId = "revision:service-test:1";

function snapshot(protocolVersion, sequence) {
  return {
    protocolVersion,
    sessionId: "session:service-test",
    sourceId: "source:service-test",
    revisionId,
    snapshotId: `snapshot:service-test:${sequence}`,
    sequence,
    layers: [
      {
        layerId: "layer:service-test",
        sourceId: "source:service-layer",
        revisionId,
        kind: ViewerLayerKind.LIVE,
        representation: ViewerRepresentation.TWO_DIMENSIONAL,
        order: 0,
        visible: true,
      },
    ],
  };
}

test("passes reusable Service RenderSource conformance", async () => {
  const report = await runServiceRenderSourceConformance(
    () => new MockServiceRenderSource(),
    MockServicePickFixture,
  );

  assert.equal(report.protocolVersion, RenderProtocolVersion);
  assert.equal(report.layers, 6);
  assert.deepEqual(report.layerKinds, [
    ViewerLayerKind.BASE,
    ViewerLayerKind.LIVE,
    ViewerLayerKind.ADDED,
    ViewerLayerKind.MODIFIED,
    ViewerLayerKind.REMOVED,
    ViewerLayerKind.DIAGNOSTIC,
  ]);
  assert.equal(report.hasExternalIdentity, true);
  assert.equal(report.contextId, "context:service:entity:42");
  assert.equal(report.revealId, "reveal:service:entity:42");
});

test("passes reusable Service revision and diagnostics conformance", async () => {
  const report = await runServiceEventConformance(
    () => createMockServiceEventHarness(),
  );

  assert.equal(report.revisionEvents, 1);
  assert.equal(report.diagnosticBatches, 1);
  assert.equal(report.diagnostics, 1);
  assert.equal(report.replayRejected, true);
});

test("validates ordered service revision and diagnostic streams", async () => {
  const source = new MockServiceRenderSource();
  const sourceSession = await openRenderSource(source);
  const snapshot = await sourceSession.getSnapshot();
  const revisions = [];
  const diagnostics = [];
  const errors = [];
  const revisionSubscription =
    await sourceSession.subscribeRevisionEvents(
      (event) => {
        revisions.push(event);
      },
      {
        onError(error) {
          errors.push(error);
        },
      },
    );
  const diagnosticSubscription =
    await sourceSession.subscribeDiagnostics(
      (batch) => {
        diagnostics.push(batch);
      },
      {
        onError(error) {
          errors.push(error);
        },
      },
    );
  const available = {
    protocolVersion: RenderProtocolVersion,
    eventId: "revision-event:service-test:1",
    sessionId: sourceSession.descriptor.sessionId,
    sourceId: sourceSession.descriptor.sourceId,
    revisionId: snapshot.revisionId,
    lastSuccessfulRevisionId: snapshot.revisionId,
    snapshotId: snapshot.snapshotId,
    sequence: 1,
    status: RenderRevisionEventStatus.AVAILABLE,
  };
  const batch = {
    protocolVersion: RenderProtocolVersion,
    batchId: "diagnostics:service-test:1",
    sessionId: sourceSession.descriptor.sessionId,
    sourceId: sourceSession.descriptor.sourceId,
    revisionId: snapshot.revisionId,
    lastSuccessfulRevisionId: snapshot.revisionId,
    snapshotId: snapshot.snapshotId,
    sequence: 1,
    diagnostics: [
      {
        diagnosticId: "diagnostic:service-test:1",
        severity: ViewerDiagnosticSeverity.WARNING,
        code: "PARTIAL_RENDER",
        message: "One service item was not rendered.",
        layerId: "layer:service-diagnostic",
        renderId: null,
        worldBounds: null,
      },
    ],
  };

  await source.emitRevisionEvent(available);
  await source.emitDiagnosticBatch(batch);
  await Promise.all([
    revisionSubscription.whenIdle(),
    diagnosticSubscription.whenIdle(),
  ]);

  assert.equal(revisions.length, 1);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].diagnostics[0].code, "PARTIAL_RENDER");
  assert.equal(sourceSession.revisionId, snapshot.revisionId);

  await source.emitRevisionEvent(available);
  await revisionSubscription.whenIdle();
  assert.equal(revisions.length, 1);
  assert.equal(
    errors.at(-1)?.code,
    RenderProtocolDiagnosticCode.OUT_OF_ORDER,
  );

  await source.emitRevisionEvent({
    ...available,
    eventId: "revision-event:service-test:2",
    revisionId: "revision:service-test:failed",
    snapshotId: null,
    sequence: 2,
    status: RenderRevisionEventStatus.FAILED,
  });
  await revisionSubscription.whenIdle();
  assert.equal(revisions.at(-1).status, RenderRevisionEventStatus.FAILED);
  assert.equal(sourceSession.revisionId, snapshot.revisionId);

  await revisionSubscription.dispose();
  await diagnosticSubscription.dispose();
  assert.equal(revisionSubscription.closed, true);
  assert.equal(diagnosticSubscription.closed, true);
  await sourceSession.dispose();
});

test("accepts a new snapshot only after an exact successful revision announcement", async () => {
  const nextRevisionId = "revision:service-test:2";
  let activeSnapshot;
  let revisionListener;
  const source = {
    supportedProtocolVersions: [RenderProtocolVersion],
    async open({ protocolVersion }) {
      activeSnapshot = snapshot(protocolVersion, 0);
      return {
        descriptor: {
          protocolVersion,
          sessionId: "session:service-test",
          sourceId: "source:service-test",
          currentRevisionId: revisionId,
          lastSuccessfulRevisionId: revisionId,
          capabilities: [
            RenderCapability.LAYER_MANIFEST,
            RenderCapability.RENDER_SNAPSHOT,
            RenderCapability.REVISION_EVENTS,
          ],
          resourceBudgetBytes: 1024,
        },
        async getSnapshot() {
          return activeSnapshot;
        },
        async subscribeRevisionEvents(listener) {
          revisionListener = listener;
          return () => {
            revisionListener = undefined;
          };
        },
        async dispose() {},
      };
    },
    async publish(event) {
      await revisionListener(event);
    },
    async dispose() {},
  };
  const sourceSession = await openRenderSource(source);
  const initial = await sourceSession.getSnapshot();
  const subscription =
    await sourceSession.subscribeRevisionEvents(() => {});
  const announcement = {
    protocolVersion: RenderProtocolVersion,
    eventId: "revision-event:service-test:next",
    sessionId: initial.sessionId,
    sourceId: initial.sourceId,
    revisionId: nextRevisionId,
    lastSuccessfulRevisionId: nextRevisionId,
    snapshotId: "snapshot:service-test:1",
    sequence: 1,
    status: RenderRevisionEventStatus.AVAILABLE,
  };

  await source.publish(announcement);
  await subscription.whenIdle();
  activeSnapshot = {
    ...snapshot(RenderProtocolVersion, 1),
    revisionId: nextRevisionId,
    snapshotId: "snapshot:service-test:wrong",
    layers: snapshot(RenderProtocolVersion, 1).layers.map((layer) => ({
      ...layer,
      revisionId: nextRevisionId,
    })),
  };
  await assert.rejects(
    sourceSession.getSnapshot(),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.SCOPE_MISMATCH,
  );
  assert.equal(sourceSession.revisionId, revisionId);

  activeSnapshot = {
    ...activeSnapshot,
    snapshotId: announcement.snapshotId,
  };
  const next = await sourceSession.getSnapshot();
  assert.equal(next.revisionId, nextRevisionId);
  assert.equal(sourceSession.revisionId, nextRevisionId);

  await subscription.dispose();
  await sourceSession.dispose();
});

test("rejects a pick response when the active snapshot changes in flight", async () => {
  let sequence = 0;
  let markStarted;
  let release;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const source = {
    supportedProtocolVersions: [RenderProtocolVersion],
    async open({ protocolVersion }) {
      return {
        descriptor: {
          protocolVersion,
          sessionId: "session:service-test",
          sourceId: "source:service-test",
          currentRevisionId: revisionId,
          lastSuccessfulRevisionId: revisionId,
          capabilities: [
            RenderCapability.LAYER_MANIFEST,
            RenderCapability.RENDER_SNAPSHOT,
            RenderCapability.PICK_RESOLVE,
          ],
          resourceBudgetBytes: 1024,
        },
        async getSnapshot() {
          const result = snapshot(protocolVersion, sequence);
          sequence += 1;
          return result;
        },
        async resolvePick(request) {
          markStarted();
          await gate;
          return {
            ...request,
            externalIdentityToken: "external:service-test:42",
          };
        },
        async dispose() {},
      };
    },
    async dispose() {},
  };
  const sourceSession = await openRenderSource(source);
  const firstSnapshot = await sourceSession.getSnapshot();
  const request = {
    protocolVersion: RenderProtocolVersion,
    sessionId: firstSnapshot.sessionId,
    sourceId: "source:service-layer",
    revisionId: firstSnapshot.revisionId,
    snapshotId: firstSnapshot.snapshotId,
    layerId: "layer:service-test",
    renderId: "render:service-test:42",
    pickId: "pick:service-test:42",
    worldPosition: [0, 0, 0],
    worldBounds: {
      min: [0, 0, 0],
      max: [1, 1, 0],
    },
  };

  const pendingPick = sourceSession.resolvePick(request);
  await started;
  await sourceSession.getSnapshot();
  release();

  await assert.rejects(
    pendingPick,
    (error) =>
      error.code === RenderProtocolDiagnosticCode.STALE_REVISION,
  );
  await sourceSession.dispose();
});

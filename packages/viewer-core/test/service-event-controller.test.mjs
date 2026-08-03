import assert from "node:assert/strict";
import test from "node:test";

import {
  RenderProtocolDiagnosticCode,
  RenderProtocolVersion,
  RenderRevisionEventStatus,
  ViewerDiagnosticSeverity,
  ViewerRepresentation,
} from "@menaje/viewer-render-protocol";

import {
  ViewerHostEventType,
  ViewerServiceEventController,
  openRenderSource,
} from "../src/index.mjs";
import {
  MockServiceRenderSource,
} from "../src/testing.mjs";

function revisionEvent(sourceSession, snapshot, overrides = {}) {
  return {
    protocolVersion: RenderProtocolVersion,
    eventId: "revision-event:controller:1",
    sessionId: sourceSession.descriptor.sessionId,
    sourceId: sourceSession.descriptor.sourceId,
    revisionId: snapshot.revisionId,
    lastSuccessfulRevisionId: snapshot.revisionId,
    snapshotId: snapshot.snapshotId,
    sequence: 1,
    status: RenderRevisionEventStatus.AVAILABLE,
    ...overrides,
  };
}

function diagnosticBatch(sourceSession, snapshot) {
  return {
    protocolVersion: RenderProtocolVersion,
    batchId: "diagnostics:controller:1",
    sessionId: sourceSession.descriptor.sessionId,
    sourceId: sourceSession.descriptor.sourceId,
    revisionId: snapshot.revisionId,
    lastSuccessfulRevisionId: snapshot.revisionId,
    snapshotId: snapshot.snapshotId,
    sequence: 1,
    diagnostics: [
      {
        diagnosticId: "diagnostic:controller:1",
        severity: ViewerDiagnosticSeverity.INFO,
        code: "SERVICE_READY",
        message: "The service render source is ready.",
        layerId: null,
        renderId: null,
        worldBounds: null,
      },
    ],
  };
}

test("forwards revision, diagnostic, viewport, and intent-only host events", async () => {
  const source = new MockServiceRenderSource();
  const sourceSession = await openRenderSource(source);
  const snapshot = await sourceSession.getSnapshot();
  const events = [];
  const errors = [];
  let hostDisposals = 0;
  const controller = new ViewerServiceEventController({
    host: {
      async handleEvent(event) {
        await Promise.resolve();
        events.push(event);
      },
      dispose() {
        hostDisposals += 1;
      },
    },
    sourceSession,
    snapshot,
  });

  await controller.start({
    onError(error, stream) {
      errors.push({ error, stream });
    },
  });
  await source.emitRevisionEvent(
    revisionEvent(sourceSession, snapshot),
  );
  await source.emitDiagnosticBatch(
    diagnosticBatch(sourceSession, snapshot),
  );
  const viewport = await controller.publishViewport({
    representation: ViewerRepresentation.THREE_DIMENSIONAL,
    worldBounds: {
      min: [-1, -2, -3],
      max: [4, 5, 6],
    },
  });
  const intent = await controller.requestHumanAction({
    intentId: "intent:accept-candidate:42",
    action: "accept-candidate",
    label: "Accept candidate",
    externalIdentityToken: "external:service:entity:42",
  });

  assert.deepEqual(
    events.map(({ type }) => type),
    [
      ViewerHostEventType.REVISION_CHANGED,
      ViewerHostEventType.DIAGNOSTICS_CHANGED,
      ViewerHostEventType.VIEWPORT_CHANGED,
      ViewerHostEventType.HUMAN_ACTION_REQUEST,
    ],
  );
  assert.equal(viewport.sequence, 1);
  assert.equal(viewport.revisionId, sourceSession.revisionId);
  assert.equal(intent.sequence, 1);
  assert.equal(intent.action, "accept-candidate");
  assert.equal(
    Object.hasOwn(intent, "capability"),
    false,
  );
  assert.equal(Object.isFrozen(events[0]), true);
  assert.equal(Object.isFrozen(events[0].detail), true);

  await source.emitRevisionEvent(
    revisionEvent(sourceSession, snapshot),
  );
  assert.equal(
    errors.at(-1)?.error.code,
    RenderProtocolDiagnosticCode.OUT_OF_ORDER,
  );

  await controller.dispose();
  await controller.dispose();
  assert.equal(controller.disposed, true);
  assert.equal(hostDisposals, 0);
  assert.equal((await sourceSession.getSnapshot()).snapshotId, snapshot.snapshotId);
  await assert.rejects(
    controller.publishViewport({
      representation: ViewerRepresentation.TWO_DIMENSIONAL,
      worldBounds: {
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
    }),
    /disposed/u,
  );
  await sourceSession.dispose();
});

test("does not start duplicate service subscriptions", async () => {
  const source = new MockServiceRenderSource();
  const sourceSession = await openRenderSource(source);
  const snapshot = await sourceSession.getSnapshot();
  const controller = new ViewerServiceEventController({
    host: {
      handleEvent() {},
      dispose() {},
    },
    sourceSession,
    snapshot,
  });

  await controller.start();
  await assert.rejects(controller.start(), /already started/u);
  await controller.dispose();
  await sourceSession.dispose();
});

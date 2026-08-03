import assert from "node:assert/strict";
import test from "node:test";

import {
  RenderCapability,
  RenderProtocolDiagnosticCode,
  RenderProtocolVersion,
  ViewerLayerKind,
  ViewerRepresentation,
} from "@dwg-viewer/render-protocol";

import {
  runServiceRenderSourceConformance,
} from "../src/conformance.mjs";
import {
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
  assert.equal(report.layers, 2);
  assert.deepEqual(report.layerKinds, [
    ViewerLayerKind.BASE,
    ViewerLayerKind.LIVE,
  ]);
  assert.equal(report.hasExternalIdentity, true);
  assert.equal(report.contextId, "context:service:entity:42");
  assert.equal(report.revealId, "reveal:service:entity:42");
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

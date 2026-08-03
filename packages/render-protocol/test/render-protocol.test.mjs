import assert from "node:assert/strict";
import test from "node:test";

import {
  RenderCapability,
  RenderProtocolDiagnosticCode,
  RenderProtocolError,
  RenderProtocolVersion,
  ViewerLayerKind,
  ViewerRepresentation,
  negotiateRenderProtocolVersion,
  parseRangeHandleDescriptor,
  parseRenderSessionDescriptor,
  parseRenderSnapshotDescriptor,
} from "../src/index.mjs";

const revisionOne =
  "revision:sha256:1111111111111111111111111111111111111111111111111111111111111111";
const revisionTwo =
  "revision:sha256:2222222222222222222222222222222222222222222222222222222222222222";

function sessionInput(overrides = {}) {
  return {
    protocolVersion: RenderProtocolVersion,
    sessionId: "session:test",
    sourceId: "source:test",
    currentRevisionId: revisionOne,
    lastSuccessfulRevisionId: revisionOne,
    capabilities: [
      RenderCapability.RENDER_SNAPSHOT,
      RenderCapability.LAYER_MANIFEST,
      RenderCapability.RANGE_READ,
    ],
    resourceBudgetBytes: 1024,
    ...overrides,
  };
}

function rangeHandle(overrides = {}) {
  return {
    protocolVersion: RenderProtocolVersion,
    handleId: "range:base",
    sessionId: "session:test",
    sourceId: "source:base",
    revisionId: revisionOne,
    layerId: "layer:base",
    mediaType: "application/vnd.dwg-viewer.scene-cache",
    byteLength: 8,
    maximumRequestBytes: 4,
    remainingReadBytes: 8,
    sha256: "a".repeat(64),
    expiresAt: null,
    disposeWithSession: true,
    ...overrides,
  };
}

function snapshotInput(overrides = {}) {
  return {
    protocolVersion: RenderProtocolVersion,
    sessionId: "session:test",
    sourceId: "source:test",
    revisionId: revisionOne,
    snapshotId: "snapshot:test",
    sequence: 0,
    layers: [
      {
        layerId: "layer:base",
        sourceId: "source:base",
        revisionId: revisionOne,
        kind: ViewerLayerKind.BASE,
        representation: ViewerRepresentation.TWO_DIMENSIONAL,
        order: 0,
        visible: true,
        rangeHandle: rangeHandle(),
      },
    ],
    ...overrides,
  };
}

test("negotiates the highest exact common semantic version", () => {
  assert.equal(
    negotiateRenderProtocolVersion(
      ["0.1.0", "0.2.0"],
      ["0.3.0", "0.2.0", "0.1.0"],
    ),
    "0.2.0",
  );
});

test("fails closed when no render protocol version overlaps", () => {
  assert.throws(
    () =>
      negotiateRenderProtocolVersion(
        ["0.1.0"],
        ["1.0.0"],
      ),
    (error) =>
      error instanceof RenderProtocolError &&
      error.code ===
        RenderProtocolDiagnosticCode.VERSION_INCOMPATIBLE,
  );
});

test("normalizes a bounded render session and requires base capabilities", () => {
  const session = parseRenderSessionDescriptor(sessionInput());
  assert.deepEqual(session.capabilities, [
    RenderCapability.LAYER_MANIFEST,
    RenderCapability.RANGE_READ,
    RenderCapability.RENDER_SNAPSHOT,
  ]);
  assert(Object.isFrozen(session));
  assert(Object.isFrozen(session.capabilities));

  assert.throws(
    () =>
      parseRenderSessionDescriptor(
        sessionInput({
          capabilities: [
            RenderCapability.RENDER_SNAPSHOT,
            RenderCapability.DIAGNOSTICS,
          ],
        }),
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.CAPABILITY_MISSING,
  );
});

test("rejects private Host fields and path-shaped public identity", () => {
  assert.throws(
    () =>
      parseRenderSessionDescriptor({
        ...sessionInput(),
        cacheId: "private-host-cache",
      }),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.MESSAGE_INVALID,
  );
  assert.throws(
    () =>
      parseRenderSessionDescriptor(
        sessionInput({ sourceId: "file:///tmp/drawing.dwg" }),
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.MESSAGE_INVALID,
  );
});

test("binds snapshot layers and range handles to one session revision", () => {
  const session = parseRenderSessionDescriptor(sessionInput());
  const snapshot = parseRenderSnapshotDescriptor(snapshotInput(), {
    session,
  });
  assert.equal(snapshot.layers[0].rangeHandle.layerId, "layer:base");
  assert.equal(snapshot.layers[0].rangeHandle.revisionId, revisionOne);

  assert.throws(
    () =>
      parseRenderSnapshotDescriptor(
        snapshotInput({ revisionId: revisionTwo }),
        { session },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.STALE_REVISION,
  );
  assert.throws(
    () =>
      parseRenderSnapshotDescriptor(
        snapshotInput({
          layers: [
            {
              ...snapshotInput().layers[0],
              rangeHandle: rangeHandle({
                revisionId: revisionTwo,
              }),
            },
          ],
        }),
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.STALE_REVISION,
  );
});

test("requires range expiration or session disposal and bounded budgets", () => {
  const session = parseRenderSessionDescriptor(sessionInput());
  assert.throws(
    () =>
      parseRangeHandleDescriptor(
        rangeHandle({
          expiresAt: null,
          disposeWithSession: false,
        }),
        { session },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.MESSAGE_INVALID,
  );
  assert.throws(
    () =>
      parseRangeHandleDescriptor(
        rangeHandle({ maximumRequestBytes: 2048 }),
        { session },
      ),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.MESSAGE_INVALID,
  );
});

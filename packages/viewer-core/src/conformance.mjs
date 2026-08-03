import {
  RenderCapability,
  RenderDeltaOperationKind,
  RenderProtocolDiagnosticCode,
} from "@dwg-viewer/render-protocol";

import { openRenderSource } from "./render-source-session.mjs";
import {
  ViewerRenderDeltaController,
} from "./render-delta-controller.mjs";

async function expectProtocolError(promise, code, label) {
  try {
    await promise;
  } catch (error) {
    if (error?.code === code) {
      return;
    }
    throw new Error(
      `${label} returned ${error?.code ?? error?.name ?? "unknown error"}`,
      { cause: error },
    );
  }
  throw new Error(`${label} did not fail closed`);
}

export async function runRenderSourceConformance(createSource) {
  if (typeof createSource !== "function") {
    throw new TypeError(
      "render source conformance requires a source factory",
    );
  }

  const incompatibleSource = await createSource();
  await expectProtocolError(
    openRenderSource(incompatibleSource, {
      supportedProtocolVersions: ["9999.0.0"],
    }),
    RenderProtocolDiagnosticCode.VERSION_INCOMPATIBLE,
    "incompatible version negotiation",
  );
  await incompatibleSource.dispose();

  const source = await createSource();
  let session;
  try {
    session = await openRenderSource(source);
    const snapshot = await session.getSnapshot();
    let rangeBytes = 0;
    if (
      session.descriptor.capabilities.includes(
        RenderCapability.RANGE_READ,
      )
    ) {
      const layer = snapshot.layers.find(
        (candidate) => candidate.rangeHandle,
      );
      if (!layer) {
        throw new Error(
          "range-read capability has no range handle in the snapshot",
        );
      }
      const length = Math.min(
        4,
        layer.rangeHandle.byteLength,
        layer.rangeHandle.maximumRequestBytes,
        layer.rangeHandle.remainingReadBytes,
      );
      const bytes = await session.readRange(
        layer.rangeHandle,
        0,
        length,
      );
      if (
        !(bytes instanceof ArrayBuffer) ||
        bytes.byteLength !== length
      ) {
        throw new Error("conformance range read returned invalid bytes");
      }
      rangeBytes = bytes.byteLength;
    }
    await session.dispose();
    await session.dispose();
    await source.dispose();
    await expectProtocolError(
      session.getSnapshot(),
      RenderProtocolDiagnosticCode.SOURCE_DISPOSED,
      "disposed session snapshot",
    );

    return Object.freeze({
      protocolVersion: session.descriptor.protocolVersion,
      sessionId: session.descriptor.sessionId,
      sourceId: session.descriptor.sourceId,
      revisionId: snapshot.revisionId,
      snapshotId: snapshot.snapshotId,
      layers: snapshot.layers.length,
      rangeBytes,
      disposed: session.disposed,
    });
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => session?.dispose()),
      Promise.resolve().then(() => source.dispose()),
    ]);
  }
}

export async function runServiceRenderSourceConformance(
  createSource,
  fixture,
) {
  if (typeof createSource !== "function") {
    throw new TypeError(
      "service RenderSource conformance requires a source factory",
    );
  }
  if (
    fixture === null ||
    typeof fixture !== "object" ||
    Array.isArray(fixture)
  ) {
    throw new TypeError(
      "service RenderSource conformance requires a pick fixture",
    );
  }

  const lifecycle = await runRenderSourceConformance(createSource);
  const source = await createSource();
  let session;
  try {
    session = await openRenderSource(source);
    const requiredCapabilities = [
      RenderCapability.PICK_RESOLVE,
      RenderCapability.CONTEXT_CREATE,
      RenderCapability.SOURCE_REVEAL,
    ];
    for (const capability of requiredCapabilities) {
      if (!session.descriptor.capabilities.includes(capability)) {
        throw new Error(
          `service RenderSource does not declare ${capability}`,
        );
      }
    }

    const snapshot = await session.getSnapshot();
    const layer = snapshot.layers.find(
      (candidate) => candidate.layerId === fixture.layerId,
    );
    if (!layer) {
      throw new Error(
        "service pick fixture layer is not in the render snapshot",
      );
    }
    const request = Object.freeze({
      protocolVersion: session.descriptor.protocolVersion,
      sessionId: session.descriptor.sessionId,
      sourceId: layer.sourceId,
      revisionId: snapshot.revisionId,
      snapshotId: snapshot.snapshotId,
      layerId: layer.layerId,
      renderId: fixture.renderId,
      pickId: fixture.pickId,
      worldPosition: fixture.worldPosition,
      worldBounds: fixture.worldBounds,
    });
    const identity = await session.resolvePick(request);
    const context = await session.createContext(identity);
    const reveal = await session.resolveSourceReveal(identity);

    await expectProtocolError(
      session.resolvePick({
        ...request,
        revisionId: "revision:stale-conformance",
      }),
      RenderProtocolDiagnosticCode.STALE_REVISION,
      "stale service pick",
    );

    await session.dispose();
    await session.dispose();
    await source.dispose();

    return Object.freeze({
      ...lifecycle,
      snapshotId: snapshot.snapshotId,
      layers: snapshot.layers.length,
      layerKinds: Object.freeze(
        snapshot.layers.map((candidate) => candidate.kind),
      ),
      renderId: identity.renderId,
      pickId: identity.pickId,
      hasExternalIdentity:
        identity.externalIdentityToken !== null,
      contextId: context.contextId,
      revealId: reveal.revealId,
      revealLabel: reveal.label,
    });
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => session?.dispose()),
      Promise.resolve().then(() => source.dispose()),
    ]);
  }
}

export async function runRenderDeltaConformance(createHarness) {
  if (typeof createHarness !== "function") {
    throw new TypeError(
      "render delta conformance requires a harness factory",
    );
  }
  const lifecycle = await runRenderSourceConformance(async () => {
    const harness = await createHarness();
    return harness?.source;
  });
  const harness = await createHarness();
  if (
    !harness ||
    !harness.source ||
    typeof harness.emitNext !== "function" ||
    typeof harness.emit !== "function"
  ) {
    throw new TypeError(
      "render delta harness requires source, emitNext(), and emit()",
    );
  }

  const source = harness.source;
  let session;
  let subscription;
  let controller;
  try {
    session = await openRenderSource(source);
    if (
      !session.descriptor.capabilities.includes(
        RenderCapability.RENDER_DELTA,
      )
    ) {
      throw new Error(
        "delta RenderSource does not declare render-delta",
      );
    }
    const snapshot = await session.getSnapshot();
    controller = new ViewerRenderDeltaController({
      sourceSession: session,
      snapshot,
    });
    const received = [];
    const errors = [];
    subscription = await session.subscribeRenderDeltas(
      (delta) => {
        const state = controller.applyCommitted(delta);
        received.push(delta);
        return state;
      },
      {
        onError(error) {
          errors.push(error);
        },
      },
    );

    await harness.emitNext();
    await subscription.whenIdle();
    if (received.length !== 1 || errors.length !== 0) {
      throw new Error(
        "first render delta was not applied atomically",
      );
    }
    const first = received[0];
    if (
      !first.operations.some(
        (operation) =>
          operation.kind === RenderDeltaOperationKind.UPSERT,
      )
    ) {
      throw new Error(
        "first render delta fixture must include an upsert",
      );
    }
    const firstState = controller.snapshot();
    if (
      session.revisionId !== first.toRevisionId ||
      firstState.revisionId !== first.toRevisionId
    ) {
      throw new Error(
        "render delta did not advance source and overlay together",
      );
    }

    await harness.emit(first);
    await subscription.whenIdle();
    if (
      errors.at(-1)?.code !==
        RenderProtocolDiagnosticCode.STALE_REVISION ||
      session.revisionId !== first.toRevisionId ||
      controller.revisionId !== first.toRevisionId
    ) {
      throw new Error(
        "replayed render delta did not fail closed",
      );
    }

    await harness.emitNext();
    await subscription.whenIdle();
    if (received.length !== 2) {
      throw new Error(
        "ordered render delta did not recover after stale input",
      );
    }
    const second = received[1];
    if (
      !second.operations.some(
        (operation) =>
          operation.kind === RenderDeltaOperationKind.TOMBSTONE,
      )
    ) {
      throw new Error(
        "second render delta fixture must include a tombstone",
      );
    }
    if (
      session.revisionId !== second.toRevisionId ||
      controller.revisionId !== second.toRevisionId
    ) {
      throw new Error(
        "second render delta did not advance atomically",
      );
    }

    await subscription.dispose();
    controller.dispose();
    await session.dispose();
    await source.dispose();

    return Object.freeze({
      ...lifecycle,
      baseSnapshotId: snapshot.snapshotId,
      revisionId: second.toRevisionId,
      deltaCount: received.length,
      staleRejected: true,
      operations: received.reduce(
        (total, delta) => total + delta.operations.length,
        0,
      ),
      disposed: session.disposed,
    });
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => subscription?.dispose()),
      Promise.resolve().then(() => controller?.dispose()),
      Promise.resolve().then(() => session?.dispose()),
      Promise.resolve().then(() => source.dispose()),
    ]);
  }
}

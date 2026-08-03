import {
  RenderCapability,
  RenderProtocolDiagnosticCode,
} from "@dwg-viewer/render-protocol";

import { openRenderSource } from "./render-source-session.mjs";

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

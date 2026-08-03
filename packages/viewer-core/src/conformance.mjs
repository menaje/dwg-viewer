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

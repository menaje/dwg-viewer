import {
  RenderCapability,
  RenderProtocolDiagnosticCode,
  RenderProtocolError,
  parseRenderSnapshotDescriptor,
} from "@menaje/viewer-render-protocol";

function rangeCapabilityError(message, details = {}) {
  return new RenderProtocolError(
    RenderProtocolDiagnosticCode.CAPABILITY_MISSING,
    message,
    details,
  );
}

export class RenderLayerRangeSource {
  #session;
  #handle;

  constructor(session, snapshot, { layerId } = {}) {
    if (
      !session ||
      typeof session.readRange !== "function" ||
      !session.descriptor
    ) {
      throw new TypeError(
        "RenderLayerRangeSource requires an open Viewer Core session",
      );
    }
    if (
      !session.descriptor.capabilities.includes(
        RenderCapability.RANGE_READ,
      )
    ) {
      throw rangeCapabilityError(
        "render source session does not provide range reads",
        { capability: RenderCapability.RANGE_READ },
      );
    }
    const parsedSnapshot = parseRenderSnapshotDescriptor(snapshot, {
      session: session.descriptor,
    });
    const candidates = parsedSnapshot.layers.filter(
      (layer) =>
        layer.rangeHandle &&
        (layerId === undefined || layer.layerId === layerId),
    );
    if (candidates.length !== 1) {
      throw rangeCapabilityError(
        layerId === undefined
          ? "render snapshot must expose exactly one range-backed layer"
          : "render snapshot does not expose the requested range-backed layer",
        {
          layerId: layerId ?? null,
          candidates: candidates.map((layer) => layer.layerId),
        },
      );
    }
    this.#session = session;
    this.#handle = candidates[0].rangeHandle;
    this.size = this.#handle.byteLength;
    this.maximumRequestBytes = this.#handle.maximumRequestBytes;
    this.layer = candidates[0];
  }

  read(offset, length, { signal } = {}) {
    return this.#session.readRange(
      this.#handle,
      offset,
      length,
      { signal },
    );
  }
}

export function createRenderLayerRangeSource(
  session,
  snapshot,
  options,
) {
  return new RenderLayerRangeSource(session, snapshot, options);
}

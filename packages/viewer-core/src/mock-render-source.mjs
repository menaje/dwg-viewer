import {
  RenderCapability,
  RenderProtocolDiagnosticCode,
  RenderProtocolError,
  RenderProtocolVersion,
  SupportedRenderProtocolVersions,
  ViewerLayerKind,
  ViewerRepresentation,
  parseRangeHandleDescriptor,
  parseRenderSessionDescriptor,
  parseRenderSnapshotDescriptor,
} from "@dwg-viewer/render-protocol";

function throwIfAborted(signal) {
  signal?.throwIfAborted?.();
  if (signal?.aborted) {
    const error = new Error("operation aborted");
    error.name = "AbortError";
    throw signal.reason ?? error;
  }
}

function sourceDisposed() {
  return new RenderProtocolError(
    RenderProtocolDiagnosticCode.SOURCE_DISPOSED,
    "mock RenderSource is disposed",
  );
}

function normalizeBuffer(value) {
  if (value instanceof ArrayBuffer) {
    return value.slice(0);
  }
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    );
  }
  throw new TypeError("MockRenderSource requires binary fixture bytes");
}

function sameHandle(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

class MockRenderSession {
  #buffer;
  #snapshot;
  #rangeHandle;
  #remainingReadBytes;
  #disposed = false;

  constructor({ buffer, descriptor, snapshot }) {
    this.#buffer = buffer;
    this.descriptor = descriptor;
    this.#snapshot = snapshot;
    this.#rangeHandle = snapshot.layers[0].rangeHandle;
    this.#remainingReadBytes = this.#rangeHandle.remainingReadBytes;
  }

  async getSnapshot({ signal } = {}) {
    if (this.#disposed) {
      throw sourceDisposed();
    }
    throwIfAborted(signal);
    return this.#snapshot;
  }

  async readRange(handle, offset, length, { signal } = {}) {
    if (this.#disposed) {
      throw sourceDisposed();
    }
    throwIfAborted(signal);
    const parsed = parseRangeHandleDescriptor(handle, {
      session: this.descriptor,
      layer: this.#snapshot.layers[0],
    });
    if (!sameHandle(parsed, this.#rangeHandle)) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.SCOPE_MISMATCH,
        "range handle does not belong to the mock snapshot",
      );
    }
    const end = offset + length;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      !Number.isSafeInteger(end) ||
      end > this.#buffer.byteLength ||
      length > this.#rangeHandle.maximumRequestBytes ||
      length > this.#remainingReadBytes
    ) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.RANGE_INVALID,
        "mock range is outside its resource or read budget",
      );
    }
    this.#remainingReadBytes -= length;
    return this.#buffer.slice(offset, end);
  }

  async dispose() {
    this.#disposed = true;
    this.#buffer = new ArrayBuffer(0);
  }
}

export class MockRenderSource {
  #configuration;
  #opened = false;
  #disposed = false;
  #session;

  constructor({
    bytes = Uint8Array.of(68, 87, 71, 0),
    sessionId = "session:browser-mock",
    sourceId = "source:browser-mock",
    revisionId = "revision:browser-mock:1",
    layerId = "layer:browser-mock",
    snapshotId = "snapshot:browser-mock:1",
    sha256 = "0".repeat(64),
  } = {}) {
    const buffer = normalizeBuffer(bytes);
    if (buffer.byteLength === 0) {
      throw new RangeError("MockRenderSource fixture must not be empty");
    }
    this.supportedProtocolVersions = SupportedRenderProtocolVersions;
    this.#configuration = Object.freeze({
      buffer,
      sessionId,
      sourceId,
      revisionId,
      layerId,
      snapshotId,
      sha256,
    });
  }

  async open({ protocolVersion, signal } = {}) {
    if (this.#disposed) {
      throw sourceDisposed();
    }
    if (this.#opened) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.MESSAGE_INVALID,
        "MockRenderSource can open only one session",
      );
    }
    if (protocolVersion !== RenderProtocolVersion) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.VERSION_INCOMPATIBLE,
        `MockRenderSource does not support ${protocolVersion}`,
      );
    }
    throwIfAborted(signal);
    this.#opened = true;
    const descriptor = parseRenderSessionDescriptor({
      protocolVersion,
      sessionId: this.#configuration.sessionId,
      sourceId: this.#configuration.sourceId,
      currentRevisionId: this.#configuration.revisionId,
      lastSuccessfulRevisionId: this.#configuration.revisionId,
      capabilities: [
        RenderCapability.LAYER_MANIFEST,
        RenderCapability.RANGE_READ,
        RenderCapability.RENDER_SNAPSHOT,
      ],
      resourceBudgetBytes: this.#configuration.buffer.byteLength,
    });
    const rangeHandle = {
      protocolVersion,
      handleId: "range:browser-mock",
      sessionId: descriptor.sessionId,
      sourceId: descriptor.sourceId,
      revisionId: descriptor.lastSuccessfulRevisionId,
      layerId: this.#configuration.layerId,
      mediaType: "application/vnd.dwg-viewer.mock-render-data",
      byteLength: this.#configuration.buffer.byteLength,
      maximumRequestBytes: this.#configuration.buffer.byteLength,
      remainingReadBytes: this.#configuration.buffer.byteLength,
      sha256: this.#configuration.sha256,
      expiresAt: null,
      disposeWithSession: true,
    };
    const snapshot = parseRenderSnapshotDescriptor(
      {
        protocolVersion,
        sessionId: descriptor.sessionId,
        sourceId: descriptor.sourceId,
        revisionId: descriptor.lastSuccessfulRevisionId,
        snapshotId: this.#configuration.snapshotId,
        sequence: 0,
        layers: [
          {
            layerId: this.#configuration.layerId,
            sourceId: descriptor.sourceId,
            revisionId: descriptor.lastSuccessfulRevisionId,
            kind: ViewerLayerKind.BASE,
            representation: ViewerRepresentation.TWO_DIMENSIONAL,
            order: 0,
            visible: true,
            rangeHandle,
          },
        ],
      },
      { session: descriptor },
    );
    this.#session = new MockRenderSession({
      buffer: this.#configuration.buffer.slice(0),
      descriptor,
      snapshot,
    });
    return this.#session;
  }

  async dispose() {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    await this.#session?.dispose();
  }
}

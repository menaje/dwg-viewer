import {
  RenderCapability,
  RenderProtocolDiagnosticCode,
  RenderProtocolError,
  SupportedRenderProtocolVersions,
  negotiateRenderProtocolVersion,
  parseRangeHandleDescriptor,
  parseRenderSessionDescriptor,
  parseRenderSnapshotDescriptor,
} from "@dwg-viewer/render-protocol";

import {
  assertRenderSource,
  assertRenderSourceSession,
} from "./contracts.mjs";

function throwIfAborted(signal) {
  signal?.throwIfAborted?.();
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("operation aborted", "AbortError");
  }
}

async function settleDisposal(...resources) {
  const disposals = resources
    .filter(Boolean)
    .map((resource) => Promise.resolve().then(() => resource.dispose()));
  const results = await Promise.allSettled(disposals);
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "render source disposal failed");
  }
}

function outOfOrder(message, details) {
  throw new RenderProtocolError(
    RenderProtocolDiagnosticCode.OUT_OF_ORDER,
    message,
    details,
  );
}

function disposedError() {
  return new RenderProtocolError(
    RenderProtocolDiagnosticCode.SOURCE_DISPOSED,
    "render source session is disposed",
  );
}

function binaryBuffer(value) {
  if (value instanceof ArrayBuffer) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    );
  }
  throw new TypeError("RenderSource range read must return binary bytes");
}

export class ViewerRenderSourceSession {
  #source;
  #session;
  #descriptor;
  #disposed = false;
  #disposePromise;
  #lastSnapshot;
  #rangeHandles = new Map();
  #remainingRangeBytes = new Map();

  constructor(source, session, descriptor) {
    this.#source = source;
    this.#session = session;
    this.#descriptor = descriptor;
  }

  get descriptor() {
    return this.#descriptor;
  }

  get disposed() {
    return this.#disposed;
  }

  async getSnapshot({ signal } = {}) {
    if (this.#disposed) {
      throw disposedError();
    }
    throwIfAborted(signal);
    const rawSnapshot = await this.#session.getSnapshot({ signal });
    throwIfAborted(signal);
    if (this.#disposed) {
      throw disposedError();
    }
    const snapshot = parseRenderSnapshotDescriptor(rawSnapshot, {
      session: this.#descriptor,
    });
    if (this.#lastSnapshot) {
      if (snapshot.sequence < this.#lastSnapshot.sequence) {
        outOfOrder("render snapshot sequence moved backwards", {
          previous: this.#lastSnapshot.sequence,
          received: snapshot.sequence,
        });
      }
      if (
        snapshot.sequence === this.#lastSnapshot.sequence &&
        (snapshot.snapshotId !== this.#lastSnapshot.snapshotId ||
          snapshot.revisionId !== this.#lastSnapshot.revisionId ||
          JSON.stringify(snapshot) !== JSON.stringify(this.#lastSnapshot))
      ) {
        outOfOrder(
          "one render snapshot sequence identifies different state",
          {
            sequence: snapshot.sequence,
          },
        );
      }
      if (snapshot.sequence === this.#lastSnapshot.sequence) {
        return this.#lastSnapshot;
      }
    }
    this.#lastSnapshot = snapshot;
    this.#rangeHandles.clear();
    this.#remainingRangeBytes.clear();
    for (const layer of snapshot.layers) {
      if (!layer.rangeHandle) {
        continue;
      }
      this.#rangeHandles.set(layer.rangeHandle.handleId, layer.rangeHandle);
      this.#remainingRangeBytes.set(
        layer.rangeHandle.handleId,
        layer.rangeHandle.remainingReadBytes,
      );
    }
    return snapshot;
  }

  async readRange(handle, offset, length, { signal } = {}) {
    if (this.#disposed) {
      throw disposedError();
    }
    if (
      !this.#descriptor.capabilities.includes(RenderCapability.RANGE_READ)
    ) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.CAPABILITY_MISSING,
        "render source session does not provide range reads",
        { capability: RenderCapability.RANGE_READ },
      );
    }
    throwIfAborted(signal);
    const parsed = parseRangeHandleDescriptor(handle, {
      session: this.#descriptor,
    });
    const active = this.#rangeHandles.get(parsed.handleId);
    if (
      !active ||
      active.sha256 !== parsed.sha256 ||
      active.sourceId !== parsed.sourceId ||
      active.layerId !== parsed.layerId ||
      active.revisionId !== parsed.revisionId ||
      active.byteLength !== parsed.byteLength ||
      active.maximumRequestBytes !== parsed.maximumRequestBytes ||
      active.remainingReadBytes !== parsed.remainingReadBytes ||
      active.mediaType !== parsed.mediaType ||
      active.expiresAt !== parsed.expiresAt ||
      active.disposeWithSession !== parsed.disposeWithSession
    ) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.SCOPE_MISMATCH,
        "range handle is not part of the active render snapshot",
        { handleId: parsed.handleId },
      );
    }
    if (
      active.expiresAt !== null &&
      Date.parse(active.expiresAt) <= Date.now()
    ) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.RANGE_INVALID,
        "range handle is expired",
        { handleId: active.handleId },
      );
    }
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      !Number.isSafeInteger(offset + length) ||
      offset + length > active.byteLength
    ) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.RANGE_INVALID,
        "range is outside the bounded resource",
        { offset, length, byteLength: active.byteLength },
      );
    }
    if (length > active.maximumRequestBytes) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.RANGE_INVALID,
        "range exceeds the handle request limit",
        {
          length,
          maximumRequestBytes: active.maximumRequestBytes,
        },
      );
    }
    const remaining =
      this.#remainingRangeBytes.get(active.handleId) ??
      active.remainingReadBytes;
    if (length > remaining) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.RANGE_INVALID,
        "range exceeds the remaining handle read budget",
        { length, remainingReadBytes: remaining },
      );
    }
    if (length === 0) {
      return new ArrayBuffer(0);
    }
    const activeSnapshot = this.#lastSnapshot;
    this.#remainingRangeBytes.set(active.handleId, remaining - length);
    const bytes = binaryBuffer(
      await this.#session.readRange(active, offset, length, { signal }),
    );
    throwIfAborted(signal);
    if (this.#disposed) {
      throw disposedError();
    }
    if (
      this.#lastSnapshot !== activeSnapshot ||
      this.#rangeHandles.get(active.handleId) !== active
    ) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.STALE_REVISION,
        "render snapshot changed while a range read was in flight",
        { handleId: active.handleId },
      );
    }
    if (bytes.byteLength !== length) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.RANGE_INVALID,
        "RenderSource returned a short range",
        { expected: length, received: bytes.byteLength },
      );
    }
    return bytes;
  }

  dispose() {
    if (!this.#disposePromise) {
      this.#disposed = true;
      this.#lastSnapshot = undefined;
      this.#rangeHandles.clear();
      this.#remainingRangeBytes.clear();
      this.#disposePromise = settleDisposal(this.#session, this.#source);
    }
    return this.#disposePromise;
  }
}

export async function openRenderSource(
  inputSource,
  {
    supportedProtocolVersions = SupportedRenderProtocolVersions,
    signal,
  } = {},
) {
  const source = assertRenderSource(inputSource);
  let protocolVersion;
  try {
    throwIfAborted(signal);
    protocolVersion = negotiateRenderProtocolVersion(
      supportedProtocolVersions,
      source.supportedProtocolVersions,
    );
  } catch (error) {
    try {
      await settleDisposal(source);
    } catch {
      // Preserve the negotiation/abort error.
    }
    throw error;
  }
  let sourceSession;
  try {
    sourceSession = await source.open({ protocolVersion, signal });
    throwIfAborted(signal);
    const descriptor = parseRenderSessionDescriptor(
      sourceSession?.descriptor,
    );
    if (descriptor.protocolVersion !== protocolVersion) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.SCOPE_MISMATCH,
        "RenderSource opened a different protocol version",
        {
          negotiated: protocolVersion,
          received: descriptor.protocolVersion,
        },
      );
    }
    assertRenderSourceSession(sourceSession, descriptor);
    return new ViewerRenderSourceSession(
      source,
      sourceSession,
      descriptor,
    );
  } catch (error) {
    try {
      await settleDisposal(sourceSession, source);
    } catch {
      // Preserve the contract/open error; cleanup failures are secondary here.
    }
    throw error;
  }
}

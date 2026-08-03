import {
  RenderDeltaOperationKind,
  RenderProtocolDiagnosticCode,
  RenderProtocolError,
  parseRenderDeltaDescriptor,
  parseRenderSnapshotDescriptor,
} from "@dwg-viewer/render-protocol";

const DEFAULT_CHECKPOINT_DELTA_COUNT = 64;
const DEFAULT_CHECKPOINT_PAYLOAD_BYTES = 64 * 1024 * 1024;
const DEFAULT_CHECKPOINT_OVERLAY_ENTRIES = 32_768;
const DEFAULT_MAXIMUM_DELTA_COUNT = 256;
const DEFAULT_MAXIMUM_PAYLOAD_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAXIMUM_OVERLAY_ENTRIES = 131_072;

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function invalidState(message) {
  return new DOMException(message, "InvalidStateError");
}

function assertAdapter(value) {
  if (value === null || value === undefined) {
    return null;
  }
  for (const method of [
    "applyDelta",
    "rollbackPreview",
    "promotePreview",
    "dispose",
  ]) {
    if (typeof value?.[method] !== "function") {
      throw new TypeError(
        `render delta adapter must implement ${method}()`,
      );
    }
  }
  return value;
}

function synchronous(value, label) {
  if (value && typeof value.then === "function") {
    throw new TypeError(`${label} must complete synchronously`);
  }
  return value;
}

function outOfOrder(message, details = {}) {
  throw new RenderProtocolError(
    RenderProtocolDiagnosticCode.OUT_OF_ORDER,
    message,
    details,
  );
}

function entryKey(layerId, renderId) {
  return `${layerId}\u0000${renderId}`;
}

function unionBounds(left, right) {
  if (!left) {
    return right;
  }
  return Object.freeze({
    min: Object.freeze(
      left.min.map((value, axis) =>
        Math.min(value, right.min[axis]),
      ),
    ),
    max: Object.freeze(
      left.max.map((value, axis) =>
        Math.max(value, right.max[axis]),
      ),
    ),
  });
}

function emptyState(revisionId) {
  return {
    revisionId,
    sequence: 0,
    deltaCount: 0,
    payloadBytes: 0,
    affectedWorldBounds: null,
    tombstones: new Map(),
    upserts: new Map(),
    identities: new Map(),
    invalidatedDependencyIds: new Set(),
  };
}

function overlayEntry(operation, renderId) {
  return Object.freeze({
    operationId: operation.operationId,
    kind: operation.kind,
    aspect: operation.aspect,
    layerId: operation.layerId,
    sourceId: operation.sourceId,
    renderId,
    affectedWorldBounds: operation.affectedWorldBounds,
    externalIdentityToken: operation.externalIdentityToken,
  });
}

function applyDeltaToState(state, delta) {
  const next = {
    revisionId: delta.toRevisionId,
    sequence: delta.sequence,
    deltaCount: state.deltaCount + 1,
    payloadBytes:
      state.payloadBytes + (delta.payload?.byteLength ?? 0),
    affectedWorldBounds: unionBounds(
      state.affectedWorldBounds,
      delta.affectedWorldBounds,
    ),
    tombstones: new Map(state.tombstones),
    upserts: new Map(state.upserts),
    identities: new Map(state.identities),
    invalidatedDependencyIds: new Set(
      state.invalidatedDependencyIds,
    ),
  };
  for (const operation of delta.operations) {
    for (const dependencyId of operation.dependencyIds) {
      next.invalidatedDependencyIds.add(dependencyId);
    }
    for (const renderId of operation.renderIds) {
      const key = entryKey(operation.layerId, renderId);
      const entry = overlayEntry(operation, renderId);
      if (operation.kind === RenderDeltaOperationKind.TOMBSTONE) {
        next.upserts.delete(key);
        next.identities.delete(key);
        next.tombstones.set(key, entry);
      } else {
        next.tombstones.delete(key);
        next.upserts.set(key, entry);
        next.identities.set(
          key,
          operation.externalIdentityToken,
        );
      }
    }
  }
  return next;
}

function sortedEntries(entries) {
  return Object.freeze(
    [...entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, value]) => value),
  );
}

export class ViewerRenderDeltaController {
  #descriptor;
  #snapshot;
  #committed;
  #preview = null;
  #disposed = false;
  #limits;
  #adapter;

  constructor({
    snapshot,
    sourceSession = null,
    adapter = null,
    checkpointDeltaCount = DEFAULT_CHECKPOINT_DELTA_COUNT,
    checkpointPayloadBytes = DEFAULT_CHECKPOINT_PAYLOAD_BYTES,
    checkpointOverlayEntries =
      DEFAULT_CHECKPOINT_OVERLAY_ENTRIES,
    maximumDeltaCount = DEFAULT_MAXIMUM_DELTA_COUNT,
    maximumPayloadBytes = DEFAULT_MAXIMUM_PAYLOAD_BYTES,
    maximumOverlayEntries = DEFAULT_MAXIMUM_OVERLAY_ENTRIES,
  }) {
    this.#descriptor = sourceSession?.descriptor;
    this.#adapter = assertAdapter(adapter);
    this.#snapshot = parseRenderSnapshotDescriptor(snapshot, {
      session: this.#descriptor,
    });
    this.#committed = emptyState(this.#snapshot.revisionId);
    this.#limits = Object.freeze({
      checkpointDeltaCount: positiveSafeInteger(
        checkpointDeltaCount,
        "checkpoint delta count",
      ),
      checkpointPayloadBytes: positiveSafeInteger(
        checkpointPayloadBytes,
        "checkpoint payload bytes",
      ),
      checkpointOverlayEntries: positiveSafeInteger(
        checkpointOverlayEntries,
        "checkpoint overlay entries",
      ),
      maximumDeltaCount: positiveSafeInteger(
        maximumDeltaCount,
        "maximum delta count",
      ),
      maximumPayloadBytes: positiveSafeInteger(
        maximumPayloadBytes,
        "maximum payload bytes",
      ),
      maximumOverlayEntries: positiveSafeInteger(
        maximumOverlayEntries,
        "maximum overlay entries",
      ),
    });
    if (
      this.#limits.checkpointDeltaCount >
        this.#limits.maximumDeltaCount ||
      this.#limits.checkpointPayloadBytes >
        this.#limits.maximumPayloadBytes ||
      this.#limits.checkpointOverlayEntries >
        this.#limits.maximumOverlayEntries
    ) {
      throw new RangeError(
        "render delta checkpoint thresholds must not exceed hard limits",
      );
    }
  }

  get disposed() {
    return this.#disposed;
  }

  get revisionId() {
    this.#assertOpen();
    return (this.#preview?.state ?? this.#committed).revisionId;
  }

  #assertOpen() {
    if (this.#disposed) {
      throw invalidState("Viewer render delta controller is disposed");
    }
  }

  #parse(delta, state) {
    return parseRenderDeltaDescriptor(delta, {
      session: this.#descriptor,
      snapshot: this.#snapshot,
      expectedRevisionId: state.revisionId,
      expectedSequence: state.sequence + 1,
    });
  }

  #assertWithinLimits(state) {
    const overlayEntries =
      state.tombstones.size + state.upserts.size;
    if (
      state.deltaCount > this.#limits.maximumDeltaCount ||
      state.payloadBytes > this.#limits.maximumPayloadBytes ||
      overlayEntries > this.#limits.maximumOverlayEntries
    ) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.MESSAGE_INVALID,
        "render delta overlay exceeds its bounded retention limit",
        {
          deltaCount: state.deltaCount,
          payloadBytes: state.payloadBytes,
          overlayEntries,
        },
      );
    }
  }

  #view(state, previewId) {
    const overlayEntries =
      state.tombstones.size + state.upserts.size;
    return Object.freeze({
      protocolVersion: this.#snapshot.protocolVersion,
      sessionId: this.#snapshot.sessionId,
      sourceId: this.#snapshot.sourceId,
      baseSnapshotId: this.#snapshot.snapshotId,
      baseRevisionId: this.#snapshot.revisionId,
      committedRevisionId: this.#committed.revisionId,
      revisionId: state.revisionId,
      sequence: state.sequence,
      previewId,
      deltaCount: state.deltaCount,
      payloadBytes: state.payloadBytes,
      overlayEntries,
      checkpointRecommended:
        state.deltaCount >=
          this.#limits.checkpointDeltaCount ||
        state.payloadBytes >=
          this.#limits.checkpointPayloadBytes ||
        overlayEntries >=
          this.#limits.checkpointOverlayEntries,
      affectedWorldBounds: state.affectedWorldBounds,
      tombstones: sortedEntries(state.tombstones),
      upserts: sortedEntries(state.upserts),
      invalidatedDependencyIds: Object.freeze(
        [...state.invalidatedDependencyIds].sort(),
      ),
    });
  }

  snapshot() {
    this.#assertOpen();
    return this.#preview
      ? this.#view(this.#preview.state, this.#preview.delta.deltaId)
      : this.#view(this.#committed, null);
  }

  applyCommitted(delta) {
    this.#assertOpen();
    if (this.#preview) {
      outOfOrder(
        "a committed render delta cannot replace an active preview",
        { previewId: this.#preview.delta.deltaId },
      );
    }
    const parsed = this.#parse(delta, this.#committed);
    const next = applyDeltaToState(this.#committed, parsed);
    this.#assertWithinLimits(next);
    synchronous(
      this.#adapter?.applyDelta(parsed, {
        preview: false,
      }),
      "render delta adapter applyDelta",
    );
    this.#committed = next;
    return this.snapshot();
  }

  applyPreview(delta) {
    this.#assertOpen();
    if (this.#preview) {
      outOfOrder("only one render preview may be active", {
        previewId: this.#preview.delta.deltaId,
      });
    }
    const parsed = this.#parse(delta, this.#committed);
    const state = applyDeltaToState(this.#committed, parsed);
    this.#assertWithinLimits(state);
    synchronous(
      this.#adapter?.applyDelta(parsed, {
        preview: true,
      }),
      "render delta adapter applyDelta",
    );
    this.#preview = Object.freeze({ delta: parsed, state });
    return this.snapshot();
  }

  promotePreview(deltaId) {
    this.#assertOpen();
    if (!this.#preview || this.#preview.delta.deltaId !== deltaId) {
      outOfOrder("render preview does not match the promotion request", {
        deltaId,
        previewId: this.#preview?.delta.deltaId ?? null,
      });
    }
    synchronous(
      this.#adapter?.promotePreview(this.#preview.delta),
      "render delta adapter promotePreview",
    );
    this.#committed = this.#preview.state;
    this.#preview = null;
    return this.snapshot();
  }

  rollbackPreview(deltaId = this.#preview?.delta.deltaId) {
    this.#assertOpen();
    if (!this.#preview || this.#preview.delta.deltaId !== deltaId) {
      outOfOrder("render preview does not match the rollback request", {
        deltaId: deltaId ?? null,
        previewId: this.#preview?.delta.deltaId ?? null,
      });
    }
    synchronous(
      this.#adapter?.rollbackPreview(this.#preview.delta),
      "render delta adapter rollbackPreview",
    );
    this.#preview = null;
    return this.snapshot();
  }

  lookup(layerId, renderId) {
    this.#assertOpen();
    const state = this.#preview?.state ?? this.#committed;
    const key = entryKey(layerId, renderId);
    if (state.tombstones.has(key)) {
      return Object.freeze({
        status: "tombstone",
        revisionId: state.revisionId,
        entry: state.tombstones.get(key),
      });
    }
    if (state.upserts.has(key)) {
      return Object.freeze({
        status: "upsert",
        revisionId: state.revisionId,
        entry: state.upserts.get(key),
      });
    }
    return Object.freeze({
      status: "base",
      revisionId: state.revisionId,
      entry: null,
    });
  }

  externalIdentity(layerId, renderId) {
    this.#assertOpen();
    const state = this.#preview?.state ?? this.#committed;
    return state.identities.get(entryKey(layerId, renderId));
  }

  dispose() {
    if (this.#disposed) {
      return false;
    }
    synchronous(
      this.#adapter?.dispose(),
      "render delta adapter dispose",
    );
    this.#disposed = true;
    this.#preview = null;
    this.#committed.tombstones.clear();
    this.#committed.upserts.clear();
    this.#committed.identities.clear();
    this.#committed.invalidatedDependencyIds.clear();
    return true;
  }
}

export {
  DEFAULT_CHECKPOINT_DELTA_COUNT,
  DEFAULT_CHECKPOINT_OVERLAY_ENTRIES,
  DEFAULT_CHECKPOINT_PAYLOAD_BYTES,
  DEFAULT_MAXIMUM_DELTA_COUNT,
  DEFAULT_MAXIMUM_OVERLAY_ENTRIES,
  DEFAULT_MAXIMUM_PAYLOAD_BYTES,
};

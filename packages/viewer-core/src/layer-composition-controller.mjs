import {
  RenderProtocolDiagnosticCode,
  RenderProtocolError,
  parseRenderSnapshotDescriptor,
} from "@menaje/viewer-render-protocol";

const MAXIMUM_IDENTIFIER_LENGTH = 512;

function invalidState(message) {
  return new DOMException(message, "InvalidStateError");
}

function boundedIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAXIMUM_IDENTIFIER_LENGTH
  ) {
    throw new TypeError(`${label} must be a bounded identifier`);
  }
  return value;
}

function synchronous(value, label) {
  if (value && typeof value.then === "function") {
    throw new TypeError(`${label} must complete synchronously`);
  }
  return value;
}

function assertSourceSession(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !value.descriptor ||
    typeof value.revisionId !== "string"
  ) {
    throw new TypeError(
      "layer composition requires an open RenderSource session",
    );
  }
  return value;
}

function assertAdapter(value) {
  for (const method of [
    "applyLayerComposition",
    "clearLayerComposition",
  ]) {
    if (typeof value?.[method] !== "function") {
      throw new TypeError(
        `layer composition adapter must implement ${method}()`,
      );
    }
  }
  return value;
}

function presentation(snapshot, overrides, sequence) {
  const layers = snapshot.layers
    .map((layer) =>
      Object.freeze({
        ...layer,
        visible: overrides.has(layer.layerId)
          ? overrides.get(layer.layerId)
          : layer.visible,
      }),
    )
    .sort(
      (left, right) =>
        left.order - right.order ||
        left.layerId.localeCompare(right.layerId),
    );
  return Object.freeze({
    protocolVersion: snapshot.protocolVersion,
    sessionId: snapshot.sessionId,
    sourceId: snapshot.sourceId,
    revisionId: snapshot.revisionId,
    snapshotId: snapshot.snapshotId,
    snapshotSequence: snapshot.sequence,
    sequence,
    layers: Object.freeze(layers),
  });
}

function transitionFailure(error, rollbackError) {
  return new AggregateError(
    [error, rollbackError],
    "layer composition transition and rollback failed",
    { cause: error },
  );
}

export class ViewerLayerCompositionController {
  #sourceSession;
  #adapter;
  #snapshot;
  #visibility = new Map();
  #presentation;
  #active = false;
  #synchronized = false;
  #transitioning = false;
  #disposed = false;

  constructor({ sourceSession: inputSourceSession, snapshot, adapter } = {}) {
    this.#sourceSession = assertSourceSession(inputSourceSession);
    this.#adapter = assertAdapter(adapter);
    this.#snapshot = parseRenderSnapshotDescriptor(snapshot, {
      session: this.#sourceSession.descriptor,
      expectedRevisionId: this.#sourceSession.revisionId,
    });
    this.#presentation = presentation(
      this.#snapshot,
      this.#visibility,
      0,
    );
  }

  get disposed() {
    return this.#disposed;
  }

  #assertOpen() {
    if (this.#disposed) {
      throw invalidState("Viewer layer composition is disposed");
    }
  }

  #assertIdle() {
    if (this.#transitioning) {
      throw invalidState("layer composition transition is active");
    }
  }

  #view() {
    return Object.freeze({
      active: this.#active,
      synchronized: this.#synchronized,
      presentation: this.#presentation,
    });
  }

  snapshot() {
    this.#assertOpen();
    return this.#view();
  }

  #apply(value) {
    return synchronous(
      this.#adapter.applyLayerComposition(value),
      "layer composition adapter applyLayerComposition",
    );
  }

  #clear() {
    return synchronous(
      this.#adapter.clearLayerComposition(),
      "layer composition adapter clearLayerComposition",
    );
  }

  #activate(nextSnapshot, nextVisibility) {
    const next = presentation(
      nextSnapshot,
      nextVisibility,
      this.#presentation.sequence + 1,
    );
    this.#transitioning = true;
    try {
      try {
        this.#apply(next);
      } catch (error) {
        try {
          if (this.#active) {
            this.#apply(this.#presentation);
          } else {
            this.#clear();
          }
          this.#synchronized = true;
        } catch (rollbackError) {
          this.#synchronized = false;
          throw transitionFailure(error, rollbackError);
        }
        throw error;
      }
      this.#snapshot = nextSnapshot;
      this.#visibility = nextVisibility;
      this.#presentation = next;
      this.#active = true;
      this.#synchronized = true;
      return this.#view();
    } finally {
      this.#transitioning = false;
    }
  }

  synchronize() {
    this.#assertOpen();
    this.#assertIdle();
    return this.#activate(
      this.#snapshot,
      new Map(this.#visibility),
    );
  }

  setLayerVisible(layerId, visible) {
    this.#assertOpen();
    this.#assertIdle();
    const identifier = boundedIdentifier(
      layerId,
      "composition layer ID",
    );
    if (typeof visible !== "boolean") {
      throw new TypeError("layer visibility must be a boolean");
    }
    const layer = this.#snapshot.layers.find(
      (candidate) => candidate.layerId === identifier,
    );
    if (!layer) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.SCOPE_MISMATCH,
        "layer is not part of the active composition snapshot",
        { layerId: identifier },
      );
    }
    const current = this.#visibility.has(identifier)
      ? this.#visibility.get(identifier)
      : layer.visible;
    if (current === visible) {
      return this.#view();
    }
    const nextVisibility = new Map(this.#visibility);
    nextVisibility.set(identifier, visible);
    return this.#activate(this.#snapshot, nextVisibility);
  }

  replaceSnapshot(snapshot) {
    this.#assertOpen();
    this.#assertIdle();
    const nextSnapshot = parseRenderSnapshotDescriptor(snapshot, {
      session: this.#sourceSession.descriptor,
      expectedRevisionId: this.#sourceSession.revisionId,
    });
    if (nextSnapshot.sequence < this.#snapshot.sequence) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.OUT_OF_ORDER,
        "composition snapshot sequence moved backwards",
        {
          previous: this.#snapshot.sequence,
          received: nextSnapshot.sequence,
        },
      );
    }
    if (
      nextSnapshot.sequence === this.#snapshot.sequence &&
      JSON.stringify(nextSnapshot) !== JSON.stringify(this.#snapshot)
    ) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.OUT_OF_ORDER,
        "one composition snapshot sequence identifies different state",
        { sequence: nextSnapshot.sequence },
      );
    }
    if (nextSnapshot === this.#snapshot) {
      return this.#view();
    }
    const layerIds = new Set(
      nextSnapshot.layers.map(({ layerId }) => layerId),
    );
    const nextVisibility = new Map(
      [...this.#visibility].filter(([layerId]) =>
        layerIds.has(layerId),
      ),
    );
    return this.#activate(nextSnapshot, nextVisibility);
  }

  clear() {
    this.#assertOpen();
    this.#assertIdle();
    if (!this.#active && this.#synchronized) {
      return false;
    }
    this.#transitioning = true;
    try {
      this.#clear();
      this.#active = false;
      this.#synchronized = true;
      return true;
    } catch (error) {
      this.#synchronized = false;
      throw error;
    } finally {
      this.#transitioning = false;
    }
  }

  dispose() {
    if (this.#disposed) {
      return false;
    }
    this.#assertIdle();
    if (this.#active || !this.#synchronized) {
      this.clear();
    }
    this.#disposed = true;
    this.#visibility.clear();
    return true;
  }
}

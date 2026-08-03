import {
  RenderCapability,
  RenderProtocolDiagnosticCode,
  RenderProtocolError,
  RenderProtocolVersion,
  SupportedRenderProtocolVersions,
  ViewerLayerKind,
  ViewerRepresentation,
  parseContextReferenceDescriptor,
  parsePickResolveRequest,
  parseRenderIdentityDescriptor,
  parseRenderSessionDescriptor,
  parseRenderSnapshotDescriptor,
  parseSourceRevealDescriptor,
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
    "mock Service RenderSource is disposed",
  );
}

function scopeMismatch(label, expected, received) {
  throw new RenderProtocolError(
    RenderProtocolDiagnosticCode.SCOPE_MISMATCH,
    `${label} does not identify the mock service entity`,
    { expected, received },
  );
}

function identityReferenceFields(identity) {
  return {
    protocolVersion: identity.protocolVersion,
    sessionId: identity.sessionId,
    sourceId: identity.sourceId,
    revisionId: identity.revisionId,
    snapshotId: identity.snapshotId,
    layerId: identity.layerId,
    renderId: identity.renderId,
    pickId: identity.pickId,
    externalIdentityToken: identity.externalIdentityToken,
  };
}

export const MockServicePickFixture = Object.freeze({
  layerId: "layer:service-live",
  renderId: "render:service:42",
  pickId: "pick:service:42",
  worldPosition: Object.freeze([10, 20, 0]),
  worldBounds: Object.freeze({
    min: Object.freeze([9, 19, 0]),
    max: Object.freeze([11, 21, 0]),
  }),
});

class MockServiceRenderSession {
  #snapshot;
  #identity;
  #contextId;
  #revealId;
  #revealLabel;
  #disposed = false;

  constructor({
    descriptor,
    snapshot,
    identity,
    contextId,
    revealId,
    revealLabel,
  }) {
    this.descriptor = descriptor;
    this.#snapshot = snapshot;
    this.#identity = identity;
    this.#contextId = contextId;
    this.#revealId = revealId;
    this.#revealLabel = revealLabel;
  }

  #assertOpen() {
    if (this.#disposed) {
      throw sourceDisposed();
    }
  }

  #assertKnownIdentity(identity) {
    for (const key of [
      "layerId",
      "renderId",
      "pickId",
      "externalIdentityToken",
    ]) {
      if (identity[key] !== this.#identity[key]) {
        scopeMismatch(
          `render identity ${key}`,
          this.#identity[key],
          identity[key],
        );
      }
    }
  }

  async getSnapshot({ signal } = {}) {
    this.#assertOpen();
    throwIfAborted(signal);
    return this.#snapshot;
  }

  async resolvePick(request, { signal } = {}) {
    this.#assertOpen();
    throwIfAborted(signal);
    const parsedRequest = parsePickResolveRequest(request, {
      session: this.descriptor,
      snapshot: this.#snapshot,
    });
    for (const key of ["layerId", "renderId", "pickId"]) {
      if (parsedRequest[key] !== this.#identity[key]) {
        scopeMismatch(
          `pick request ${key}`,
          this.#identity[key],
          parsedRequest[key],
        );
      }
    }
    return parseRenderIdentityDescriptor(
      {
        ...parsedRequest,
        externalIdentityToken:
          this.#identity.externalIdentityToken,
      },
      {
        session: this.descriptor,
        snapshot: this.#snapshot,
        request: parsedRequest,
      },
    );
  }

  async createContext(identity, { signal } = {}) {
    this.#assertOpen();
    throwIfAborted(signal);
    const parsedIdentity = parseRenderIdentityDescriptor(identity, {
      session: this.descriptor,
      snapshot: this.#snapshot,
    });
    this.#assertKnownIdentity(parsedIdentity);
    return parseContextReferenceDescriptor(
      {
        ...identityReferenceFields(parsedIdentity),
        contextId: this.#contextId,
        expiresAt: null,
        disposeWithSession: true,
      },
      {
        session: this.descriptor,
        snapshot: this.#snapshot,
        identity: parsedIdentity,
      },
    );
  }

  async resolveSourceReveal(identity, { signal } = {}) {
    this.#assertOpen();
    throwIfAborted(signal);
    const parsedIdentity = parseRenderIdentityDescriptor(identity, {
      session: this.descriptor,
      snapshot: this.#snapshot,
    });
    this.#assertKnownIdentity(parsedIdentity);
    return parseSourceRevealDescriptor(
      {
        ...identityReferenceFields(parsedIdentity),
        revealId: this.#revealId,
        label: this.#revealLabel,
        expiresAt: null,
        disposeWithSession: true,
      },
      {
        session: this.descriptor,
        snapshot: this.#snapshot,
        identity: parsedIdentity,
      },
    );
  }

  async dispose() {
    this.#disposed = true;
  }
}

export class MockServiceRenderSource {
  #configuration;
  #opened = false;
  #disposed = false;
  #session;

  constructor({
    sessionId = "session:service-mock",
    sourceId = "source:service-mock",
    revisionId = "revision:service-mock:1",
    snapshotId = "snapshot:service-mock:1",
    baseLayerId = "layer:service-base",
    baseSourceId = "source:service-base",
    liveLayerId = MockServicePickFixture.layerId,
    liveSourceId = "source:service-live",
    renderId = MockServicePickFixture.renderId,
    pickId = MockServicePickFixture.pickId,
    externalIdentityToken = "external:service:entity:42",
    contextId = "context:service:entity:42",
    revealId = "reveal:service:entity:42",
    revealLabel = "원본에서 보기",
  } = {}) {
    this.supportedProtocolVersions = SupportedRenderProtocolVersions;
    this.#configuration = Object.freeze({
      sessionId,
      sourceId,
      revisionId,
      snapshotId,
      baseLayerId,
      baseSourceId,
      liveLayerId,
      liveSourceId,
      renderId,
      pickId,
      externalIdentityToken,
      contextId,
      revealId,
      revealLabel,
    });
  }

  async open({ protocolVersion, signal } = {}) {
    if (this.#disposed) {
      throw sourceDisposed();
    }
    if (this.#opened) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.MESSAGE_INVALID,
        "MockServiceRenderSource can open only one session",
      );
    }
    if (protocolVersion !== RenderProtocolVersion) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.VERSION_INCOMPATIBLE,
        `MockServiceRenderSource does not support ${protocolVersion}`,
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
        RenderCapability.RENDER_SNAPSHOT,
        RenderCapability.PICK_RESOLVE,
        RenderCapability.CONTEXT_CREATE,
        RenderCapability.SOURCE_REVEAL,
      ],
      resourceBudgetBytes: 1024,
    });
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
            layerId: this.#configuration.baseLayerId,
            sourceId: this.#configuration.baseSourceId,
            revisionId: descriptor.lastSuccessfulRevisionId,
            kind: ViewerLayerKind.BASE,
            representation: ViewerRepresentation.TWO_DIMENSIONAL,
            order: 0,
            visible: true,
          },
          {
            layerId: this.#configuration.liveLayerId,
            sourceId: this.#configuration.liveSourceId,
            revisionId: descriptor.lastSuccessfulRevisionId,
            kind: ViewerLayerKind.LIVE,
            representation: ViewerRepresentation.TWO_DIMENSIONAL,
            order: 1,
            visible: true,
          },
        ],
      },
      { session: descriptor },
    );
    const identity = Object.freeze({
      layerId: this.#configuration.liveLayerId,
      renderId: this.#configuration.renderId,
      pickId: this.#configuration.pickId,
      externalIdentityToken:
        this.#configuration.externalIdentityToken,
    });
    this.#session = new MockServiceRenderSession({
      descriptor,
      snapshot,
      identity,
      contextId: this.#configuration.contextId,
      revealId: this.#configuration.revealId,
      revealLabel: this.#configuration.revealLabel,
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

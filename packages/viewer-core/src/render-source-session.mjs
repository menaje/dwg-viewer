import {
  RenderCapability,
  RenderProtocolDiagnosticCode,
  RenderProtocolError,
  RenderRevisionEventStatus,
  SupportedRenderProtocolVersions,
  negotiateRenderProtocolVersion,
  parseContextReferenceDescriptor,
  parsePickResolveRequest,
  parseRangeHandleDescriptor,
  parseRenderDiagnosticBatchDescriptor,
  parseRenderDeltaDescriptor,
  parseRenderIdentityDescriptor,
  parseRenderRevisionEventDescriptor,
  parseRenderSessionDescriptor,
  parseRenderSnapshotDescriptor,
  parseSourceRevealDescriptor,
} from "@menaje/viewer-render-protocol";

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

function expiredReference(reference, label) {
  if (
    reference.expiresAt !== null &&
    Date.parse(reference.expiresAt) <= Date.now()
  ) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      `${label} is already expired`,
      { expiresAt: reference.expiresAt },
    );
  }
  return reference;
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

function subscriptionDisposer(value, label = "subscription") {
  if (typeof value === "function") {
    return value;
  }
  if (value && typeof value.dispose === "function") {
    return () => value.dispose();
  }
  throw new TypeError(
    `RenderSource ${label} must return a disposer`,
  );
}

export class ViewerRenderSourceSession {
  #source;
  #session;
  #descriptor;
  #disposed = false;
  #disposePromise;
  #lastSnapshot;
  #renderRevisionId;
  #pendingRevisionEvent;
  #renderDeltaSequence = 0;
  #revisionEventSequence = 0;
  #diagnosticSequence = 0;
  #deltaSubscription;
  #revisionSubscription;
  #diagnosticSubscription;
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

  get revisionId() {
    return (
      this.#renderRevisionId ??
      this.#lastSnapshot?.revisionId ??
      this.#descriptor.lastSuccessfulRevisionId ??
      this.#descriptor.currentRevisionId
    );
  }

  #assertCapability(capability) {
    if (this.#disposed) {
      throw disposedError();
    }
    if (!this.#descriptor.capabilities.includes(capability)) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.CAPABILITY_MISSING,
        `render source session does not provide ${capability}`,
        { capability },
      );
    }
  }

  #activeSnapshot(capability) {
    this.#assertCapability(capability);
    if (!this.#lastSnapshot) {
      outOfOrder(
        `${capability} requires an active render snapshot`,
        { capability },
      );
    }
    return this.#lastSnapshot;
  }

  async #subscribeOrderedEvents({
    capability,
    label,
    listener,
    signal,
    onError,
    getSubscription,
    setSubscription,
    subscribe,
    parse,
    accept,
  }) {
    this.#assertCapability(capability);
    if (typeof listener !== "function") {
      throw new TypeError(`${label} listener must be a function`);
    }
    if (typeof onError !== "function") {
      throw new TypeError(
        `${label} error handler must be a function`,
      );
    }
    if (getSubscription()?.closed === false) {
      outOfOrder(`only one ${label} subscription may be active`);
    }
    throwIfAborted(signal);

    let closed = false;
    let lastError = null;
    let rawDispose = () => {};
    let disposePromise;
    let queue = Promise.resolve();
    let abort = () => {};
    const dispatch = (rawEvent) => {
      const operation = queue.then(async () => {
        if (closed || this.#disposed) {
          throw disposedError();
        }
        const event = parse(rawEvent);
        await listener(event);
        if (closed || this.#disposed) {
          throw disposedError();
        }
        accept(event);
        return event;
      });
      const observed = operation.catch((error) => {
        lastError = error;
        try {
          onError(error);
        } catch {
          // The source error remains the primary subscription failure.
        }
        return null;
      });
      queue = observed.then(() => undefined);
      return observed;
    };

    const subscription = {
      get closed() {
        return closed;
      },
      get lastError() {
        return lastError;
      },
      async whenIdle() {
        await queue;
        return lastError;
      },
      dispose: () => {
        if (!disposePromise) {
          closed = true;
          signal?.removeEventListener?.("abort", abort);
          disposePromise = Promise.resolve()
            .then(() => rawDispose())
            .then(() => queue)
            .then(() => {
              if (getSubscription() === subscription) {
                setSubscription(undefined);
              }
            });
        }
        return disposePromise;
      },
    };
    setSubscription(subscription);
    abort = () => {
      void subscription.dispose();
    };
    signal?.addEventListener?.("abort", abort, { once: true });
    try {
      rawDispose = subscriptionDisposer(
        await subscribe(dispatch),
        `${label} subscription`,
      );
      if (closed) {
        await rawDispose();
      }
      throwIfAborted(signal);
      return subscription;
    } catch (error) {
      await subscription.dispose();
      throw error;
    }
  }

  #assertSnapshotStillActive(snapshot, operation) {
    if (this.#disposed) {
      throw disposedError();
    }
    if (this.#lastSnapshot !== snapshot) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.STALE_REVISION,
        `render snapshot changed while ${operation} was in flight`,
        {
          snapshotId: snapshot.snapshotId,
          revisionId: snapshot.revisionId,
        },
      );
    }
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
    const pendingRevision = this.#pendingRevisionEvent;
    const snapshot = parseRenderSnapshotDescriptor(rawSnapshot, {
      session: this.#descriptor,
      expectedRevisionId:
        pendingRevision?.revisionId ??
        this.#lastSnapshot?.revisionId ??
        this.#descriptor.lastSuccessfulRevisionId ??
        this.#descriptor.currentRevisionId,
    });
    if (
      pendingRevision &&
      snapshot.snapshotId !== pendingRevision.snapshotId
    ) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.SCOPE_MISMATCH,
        "render snapshot does not match the announced revision event",
        {
          expected: pendingRevision.snapshotId,
          received: snapshot.snapshotId,
        },
      );
    }
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
    await this.#deltaSubscription?.dispose();
    this.#lastSnapshot = snapshot;
    this.#pendingRevisionEvent = undefined;
    this.#renderRevisionId = snapshot.revisionId;
    this.#renderDeltaSequence = 0;
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

  async subscribeRenderDeltas(
    listener,
    { signal, onError = () => {} } = {},
  ) {
    const snapshot = this.#activeSnapshot(
      RenderCapability.RENDER_DELTA,
    );
    if (typeof listener !== "function") {
      throw new TypeError("render delta listener must be a function");
    }
    if (typeof onError !== "function") {
      throw new TypeError("render delta error handler must be a function");
    }
    if (this.#deltaSubscription?.closed === false) {
      outOfOrder("only one render delta subscription may be active");
    }
    throwIfAborted(signal);

    let closed = false;
    let lastError = null;
    let rawDispose = () => {};
    let disposePromise;
    let queue = Promise.resolve();
    let abort = () => {};
    const dispatch = (rawDelta) => {
      const operation = queue.then(async () => {
        if (closed || this.#disposed) {
          throw disposedError();
        }
        this.#assertSnapshotStillActive(
          snapshot,
          "render delta delivery",
        );
        const delta = parseRenderDeltaDescriptor(rawDelta, {
          session: this.#descriptor,
          snapshot,
          expectedRevisionId: this.revisionId,
          expectedSequence: this.#renderDeltaSequence + 1,
        });
        await listener(delta);
        if (this.#disposed) {
          throw disposedError();
        }
        this.#assertSnapshotStillActive(
          snapshot,
          "render delta application",
        );
        this.#renderRevisionId = delta.toRevisionId;
        this.#renderDeltaSequence = delta.sequence;
        return delta;
      });
      const observed = operation.catch((error) => {
        lastError = error;
        try {
          onError(error);
        } catch {
          // The source error remains the primary subscription failure.
        }
        return null;
      });
      queue = observed.then(() => undefined);
      return observed;
    };

    const subscription = {
      get closed() {
        return closed;
      },
      get lastError() {
        return lastError;
      },
      async whenIdle() {
        await queue;
        return lastError;
      },
      dispose: () => {
        if (!disposePromise) {
          closed = true;
          signal?.removeEventListener?.("abort", abort);
          disposePromise = Promise.resolve()
            .then(() => rawDispose())
            .then(() => queue)
            .then(() => {
              if (this.#deltaSubscription === subscription) {
                this.#deltaSubscription = undefined;
              }
            });
        }
        return disposePromise;
      },
    };
    this.#deltaSubscription = subscription;
    abort = () => {
      void subscription.dispose();
    };
    signal?.addEventListener?.("abort", abort, { once: true });
    try {
      rawDispose = subscriptionDisposer(
        await this.#session.subscribeRenderDeltas(dispatch, {
          signal,
        }),
      );
      if (closed) {
        await rawDispose();
      }
      throwIfAborted(signal);
      return subscription;
    } catch (error) {
      await subscription.dispose();
      throw error;
    }
  }

  async subscribeRevisionEvents(
    listener,
    { signal, onError = () => {} } = {},
  ) {
    return this.#subscribeOrderedEvents({
      capability: RenderCapability.REVISION_EVENTS,
      label: "revision event",
      listener,
      signal,
      onError,
      getSubscription: () => this.#revisionSubscription,
      setSubscription: (value) => {
        this.#revisionSubscription = value;
      },
      subscribe: (dispatch) =>
        this.#session.subscribeRevisionEvents(dispatch, {
          signal,
        }),
      parse: (event) =>
        parseRenderRevisionEventDescriptor(event, {
          session: this.#descriptor,
          expectedSequence: this.#revisionEventSequence + 1,
        }),
      accept: (event) => {
        this.#revisionEventSequence = event.sequence;
        if (event.status === RenderRevisionEventStatus.AVAILABLE) {
          this.#pendingRevisionEvent = event;
        } else if (
          this.#pendingRevisionEvent &&
          event.lastSuccessfulRevisionId !==
            this.#pendingRevisionEvent.revisionId
        ) {
          this.#pendingRevisionEvent = undefined;
        }
      },
    });
  }

  async subscribeDiagnostics(
    listener,
    { signal, onError = () => {} } = {},
  ) {
    this.#activeSnapshot(RenderCapability.DIAGNOSTICS);
    return this.#subscribeOrderedEvents({
      capability: RenderCapability.DIAGNOSTICS,
      label: "diagnostic",
      listener,
      signal,
      onError,
      getSubscription: () => this.#diagnosticSubscription,
      setSubscription: (value) => {
        this.#diagnosticSubscription = value;
      },
      subscribe: (dispatch) =>
        this.#session.subscribeDiagnostics(dispatch, {
          signal,
        }),
      parse: (batch) =>
        parseRenderDiagnosticBatchDescriptor(batch, {
          session: this.#descriptor,
          snapshot: this.#lastSnapshot,
          expectedSequence: this.#diagnosticSequence + 1,
        }),
      accept: (batch) => {
        this.#diagnosticSequence = batch.sequence;
      },
    });
  }

  async resolvePick(request, { signal } = {}) {
    const snapshot = this.#activeSnapshot(
      RenderCapability.PICK_RESOLVE,
    );
    throwIfAborted(signal);
    const parsedRequest = parsePickResolveRequest(request, {
      session: this.#descriptor,
      snapshot,
      expectedRevisionId: this.revisionId,
    });
    const rawIdentity = await this.#session.resolvePick(
      parsedRequest,
      { signal },
    );
    throwIfAborted(signal);
    this.#assertSnapshotStillActive(snapshot, "pick resolution");
    return parseRenderIdentityDescriptor(rawIdentity, {
      session: this.#descriptor,
      snapshot,
      request: parsedRequest,
      expectedRevisionId: this.revisionId,
    });
  }

  async createContext(identity, { signal } = {}) {
    const snapshot = this.#activeSnapshot(
      RenderCapability.CONTEXT_CREATE,
    );
    throwIfAborted(signal);
    const parsedIdentity = parseRenderIdentityDescriptor(identity, {
      session: this.#descriptor,
      snapshot,
      expectedRevisionId: this.revisionId,
    });
    const rawContext = await this.#session.createContext(
      parsedIdentity,
      { signal },
    );
    throwIfAborted(signal);
    this.#assertSnapshotStillActive(snapshot, "context creation");
    return expiredReference(
      parseContextReferenceDescriptor(rawContext, {
        session: this.#descriptor,
        snapshot,
        identity: parsedIdentity,
        expectedRevisionId: this.revisionId,
      }),
      "context reference",
    );
  }

  async resolveSourceReveal(identity, { signal } = {}) {
    const snapshot = this.#activeSnapshot(
      RenderCapability.SOURCE_REVEAL,
    );
    throwIfAborted(signal);
    const parsedIdentity = parseRenderIdentityDescriptor(identity, {
      session: this.#descriptor,
      snapshot,
      expectedRevisionId: this.revisionId,
    });
    const rawReveal = await this.#session.resolveSourceReveal(
      parsedIdentity,
      { signal },
    );
    throwIfAborted(signal);
    this.#assertSnapshotStillActive(snapshot, "source reveal resolution");
    return expiredReference(
      parseSourceRevealDescriptor(rawReveal, {
        session: this.#descriptor,
        snapshot,
        identity: parsedIdentity,
        expectedRevisionId: this.revisionId,
      }),
      "source reveal",
    );
  }

  dispose() {
    if (!this.#disposePromise) {
      this.#disposed = true;
      this.#lastSnapshot = undefined;
      this.#renderRevisionId = undefined;
      this.#pendingRevisionEvent = undefined;
      this.#renderDeltaSequence = 0;
      this.#revisionEventSequence = 0;
      this.#diagnosticSequence = 0;
      this.#rangeHandles.clear();
      this.#remainingRangeBytes.clear();
      this.#disposePromise = settleDisposal(
        this.#deltaSubscription,
        this.#revisionSubscription,
        this.#diagnosticSubscription,
        this.#session,
        this.#source,
      );
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

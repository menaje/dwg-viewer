import {
  AllViewerRepresentations,
  RenderCapability,
  parseRenderSnapshotDescriptor,
} from "@menaje/viewer-render-protocol";

import { ViewerHostEventType } from "./constants.mjs";
import { assertViewerHost } from "./contracts.mjs";

const MAXIMUM_IDENTIFIER_LENGTH = 512;
const MAXIMUM_LABEL_LENGTH = 256;

function invalidState(message) {
  return new DOMException(message, "InvalidStateError");
}

function boundedText(value, label, maximum = MAXIMUM_IDENTIFIER_LENGTH) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} must be bounded text`);
  }
  return value;
}

function optionalOpaqueIdentifier(value, label) {
  if (value === null) {
    return null;
  }
  const identifier = boundedText(value, label);
  if (
    identifier.startsWith("/") ||
    identifier.includes("\\") ||
    /^file:/iu.test(identifier) ||
    /^[A-Za-z]:[\\/]/u.test(identifier)
  ) {
    throw new TypeError(`${label} must be opaque, not a path`);
  }
  return identifier;
}

function worldBounds(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Array.isArray(value.min) ||
    value.min.length !== 3 ||
    !value.min.every(Number.isFinite) ||
    !Array.isArray(value.max) ||
    value.max.length !== 3 ||
    !value.max.every(Number.isFinite) ||
    value.min.some((coordinate, axis) => coordinate > value.max[axis])
  ) {
    throw new TypeError("viewport world bounds are invalid");
  }
  return Object.freeze({
    min: Object.freeze([...value.min]),
    max: Object.freeze([...value.max]),
  });
}

function assertSourceSession(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !value.descriptor ||
    typeof value.revisionId !== "string"
  ) {
    throw new TypeError(
      "service event controller requires an open RenderSource session",
    );
  }
  return value;
}

function supports(session, capability) {
  return session.descriptor.capabilities.includes(capability);
}

function freezeEvent(type, detail) {
  return Object.freeze({
    type,
    detail: Object.freeze(detail),
  });
}

async function settleDisposal(...subscriptions) {
  const results = await Promise.allSettled(
    subscriptions
      .filter(Boolean)
      .map((subscription) => subscription.dispose()),
  );
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "service event subscription disposal failed",
    );
  }
}

export class ViewerServiceEventController {
  #host;
  #sourceSession;
  #snapshot;
  #revisionSubscription;
  #diagnosticSubscription;
  #viewportSequence = 0;
  #humanActionSequence = 0;
  #started = false;
  #disposed = false;
  #disposePromise;

  constructor({ host, sourceSession: inputSourceSession, snapshot } = {}) {
    this.#host = assertViewerHost(host);
    this.#sourceSession = assertSourceSession(inputSourceSession);
    this.#snapshot = parseRenderSnapshotDescriptor(snapshot, {
      session: this.#sourceSession.descriptor,
      expectedRevisionId: this.#sourceSession.revisionId,
    });
  }

  get started() {
    return this.#started;
  }

  get disposed() {
    return this.#disposed;
  }

  #assertOpen() {
    if (this.#disposed) {
      throw invalidState("Viewer service event controller is disposed");
    }
  }

  #scope() {
    return {
      protocolVersion: this.#snapshot.protocolVersion,
      sessionId: this.#snapshot.sessionId,
      sourceId: this.#snapshot.sourceId,
      revisionId: this.#sourceSession.revisionId,
      snapshotId: this.#snapshot.snapshotId,
    };
  }

  async start({ signal, onError = () => {} } = {}) {
    this.#assertOpen();
    if (this.#started) {
      throw invalidState(
        "Viewer service event controller is already started",
      );
    }
    if (typeof onError !== "function") {
      throw new TypeError(
        "service event error handler must be a function",
      );
    }
    this.#started = true;
    try {
      if (supports(this.#sourceSession, RenderCapability.REVISION_EVENTS)) {
        this.#revisionSubscription =
          await this.#sourceSession.subscribeRevisionEvents(
            (detail) =>
              this.#host.handleEvent(
                freezeEvent(
                  ViewerHostEventType.REVISION_CHANGED,
                  detail,
                ),
              ),
            {
              signal,
              onError(error) {
                onError(error, RenderCapability.REVISION_EVENTS);
              },
            },
          );
      }
      if (supports(this.#sourceSession, RenderCapability.DIAGNOSTICS)) {
        this.#diagnosticSubscription =
          await this.#sourceSession.subscribeDiagnostics(
            (detail) =>
              this.#host.handleEvent(
                freezeEvent(
                  ViewerHostEventType.DIAGNOSTICS_CHANGED,
                  detail,
                ),
              ),
            {
              signal,
              onError(error) {
                onError(error, RenderCapability.DIAGNOSTICS);
              },
            },
          );
      }
      return this;
    } catch (error) {
      this.#started = false;
      await settleDisposal(
        this.#revisionSubscription,
        this.#diagnosticSubscription,
      );
      this.#revisionSubscription = undefined;
      this.#diagnosticSubscription = undefined;
      throw error;
    }
  }

  async publishViewport(
    { representation, worldBounds: inputBounds },
    { reason = "interaction" } = {},
  ) {
    this.#assertOpen();
    if (!AllViewerRepresentations.includes(representation)) {
      throw new TypeError("viewport representation is invalid");
    }
    const detail = {
      ...this.#scope(),
      sequence: this.#viewportSequence + 1,
      reason: boundedText(reason, "viewport reason", 128),
      representation,
      worldBounds: worldBounds(inputBounds),
    };
    await this.#host.handleEvent(
      freezeEvent(ViewerHostEventType.VIEWPORT_CHANGED, detail),
    );
    this.#viewportSequence = detail.sequence;
    return Object.freeze(detail);
  }

  async requestHumanAction(
    {
      intentId,
      action,
      label,
      externalIdentityToken = null,
    },
    { reason = "user-request" } = {},
  ) {
    this.#assertOpen();
    const detail = {
      ...this.#scope(),
      sequence: this.#humanActionSequence + 1,
      reason: boundedText(reason, "human action reason", 128),
      intentId: optionalOpaqueIdentifier(
        intentId,
        "human action intent ID",
      ),
      action: boundedText(action, "human action", 128),
      label: boundedText(
        label,
        "human action label",
        MAXIMUM_LABEL_LENGTH,
      ),
      externalIdentityToken: optionalOpaqueIdentifier(
        externalIdentityToken,
        "human action external identity token",
      ),
    };
    await this.#host.handleEvent(
      freezeEvent(ViewerHostEventType.HUMAN_ACTION_REQUEST, detail),
    );
    this.#humanActionSequence = detail.sequence;
    return Object.freeze(detail);
  }

  dispose() {
    if (!this.#disposePromise) {
      this.#disposed = true;
      this.#disposePromise = settleDisposal(
        this.#revisionSubscription,
        this.#diagnosticSubscription,
      );
    }
    return this.#disposePromise;
  }
}

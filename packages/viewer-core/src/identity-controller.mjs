import {
  parsePickResolveRequest,
  parseRenderIdentityDescriptor,
  parseRenderSnapshotDescriptor,
} from "@dwg-viewer/render-protocol";

import { ViewerHostEventType } from "./constants.mjs";
import { assertViewerHost } from "./contracts.mjs";

const PICK_PROJECTION_KEYS = Object.freeze([
  "layerId",
  "renderId",
  "pickId",
  "worldPosition",
  "worldBounds",
]);

function reasonText(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("identity action reason is invalid");
  }
  return value;
}

function assertSourceSession(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.resolvePick !== "function" ||
    typeof value.createContext !== "function" ||
    typeof value.resolveSourceReveal !== "function"
  ) {
    throw new TypeError(
      "Viewer identity controller requires a service RenderSource session",
    );
  }
  return value;
}

function pickRequest(sourceSession, snapshot, value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("pick projection must be a plain object");
  }
  const unknown = Object.keys(value).filter(
    (key) => !PICK_PROJECTION_KEYS.includes(key),
  );
  if (unknown.length > 0) {
    throw new TypeError(
      `pick projection contains unknown fields: ${unknown.sort().join(", ")}`,
    );
  }
  const layer = snapshot.layers.find(
    (candidate) => candidate.layerId === value.layerId,
  );
  if (!layer) {
    throw new TypeError(
      "pick projection layer is not in the active snapshot",
    );
  }
  return parsePickResolveRequest(
    {
      protocolVersion: snapshot.protocolVersion,
      sessionId: snapshot.sessionId,
      sourceId: layer.sourceId,
      revisionId: sourceSession.revisionId ?? snapshot.revisionId,
      snapshotId: snapshot.snapshotId,
      layerId: layer.layerId,
      renderId: value.renderId,
      pickId: value.pickId,
      worldPosition: value.worldPosition,
      worldBounds: value.worldBounds,
    },
    {
      session: sourceSession.descriptor,
      snapshot,
      expectedRevisionId:
        sourceSession.revisionId ?? snapshot.revisionId,
    },
  );
}

export class ViewerIdentityController {
  #host;
  #sourceSession;
  #snapshot;
  #sequence = 0;
  #disposed = false;

  constructor({ host, sourceSession: inputSourceSession, snapshot }) {
    this.#host = assertViewerHost(host);
    this.#sourceSession = assertSourceSession(inputSourceSession);
    this.#snapshot = parseRenderSnapshotDescriptor(snapshot, {
      session: this.#sourceSession.descriptor,
    });
  }

  get disposed() {
    return this.#disposed;
  }

  #assertOpen() {
    if (this.#disposed) {
      throw new DOMException(
        "Viewer identity controller is disposed",
        "InvalidStateError",
      );
    }
  }

  #identity(value) {
    return parseRenderIdentityDescriptor(value, {
      session: this.#sourceSession.descriptor,
      snapshot: this.#snapshot,
      expectedRevisionId:
        this.#sourceSession.revisionId ??
        this.#snapshot.revisionId,
    });
  }

  #detail(reason, identity, key, reference) {
    this.#sequence += 1;
    return Object.freeze({
      protocolVersion: this.#snapshot.protocolVersion,
      sessionId: this.#snapshot.sessionId,
      sourceId: identity.sourceId,
      revisionId:
        this.#sourceSession.revisionId ??
        this.#snapshot.revisionId,
      snapshotId: this.#snapshot.snapshotId,
      layerId: identity.layerId,
      sequence: this.#sequence,
      reason,
      identity,
      [key]: reference,
    });
  }

  async resolvePick(projection, { signal } = {}) {
    this.#assertOpen();
    const request = pickRequest(
      this.#sourceSession,
      this.#snapshot,
      projection,
    );
    const identity = await this.#sourceSession.resolvePick(request, {
      signal,
    });
    this.#assertOpen();
    return this.#identity(identity);
  }

  async requestContext(
    inputIdentity,
    { reason = "selection", signal } = {},
  ) {
    this.#assertOpen();
    const normalizedReason = reasonText(reason);
    const identity = this.#identity(inputIdentity);
    const context = await this.#sourceSession.createContext(identity, {
      signal,
    });
    this.#assertOpen();
    const detail = this.#detail(
      normalizedReason,
      identity,
      "context",
      context,
    );
    await this.#host.handleEvent(
      Object.freeze({
        type: ViewerHostEventType.CONTEXT_REQUEST,
        detail,
      }),
    );
    return detail;
  }

  async requestSourceReveal(
    inputIdentity,
    { reason = "selection", signal } = {},
  ) {
    this.#assertOpen();
    const normalizedReason = reasonText(reason);
    const identity = this.#identity(inputIdentity);
    const reveal =
      await this.#sourceSession.resolveSourceReveal(identity, {
        signal,
      });
    this.#assertOpen();
    const detail = this.#detail(
      normalizedReason,
      identity,
      "reveal",
      reveal,
    );
    await this.#host.handleEvent(
      Object.freeze({
        type: ViewerHostEventType.SOURCE_REVEAL,
        detail,
      }),
    );
    return detail;
  }

  dispose() {
    if (this.#disposed) {
      return false;
    }
    this.#disposed = true;
    return true;
  }
}

import { ViewerHostEventType } from "./constants.mjs";
import { assertViewerHost } from "./contracts.mjs";

function boundedIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function scopeFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new TypeError(
      "Viewer selection controller requires a render snapshot",
    );
  }
  return Object.freeze({
    sessionId: boundedIdentifier(
      snapshot.sessionId,
      "selection session ID",
    ),
    sourceId: boundedIdentifier(
      snapshot.sourceId,
      "selection source ID",
    ),
    revisionId: boundedIdentifier(
      snapshot.revisionId,
      "selection revision ID",
    ),
    snapshotId: boundedIdentifier(
      snapshot.snapshotId,
      "selection snapshot ID",
    ),
  });
}

function reasonText(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128
  ) {
    throw new TypeError("selection change reason is invalid");
  }
  return value;
}

function projectedSelection(value) {
  if (
    value === null ||
    (typeof value === "object" && !Array.isArray(value))
  ) {
    return value;
  }
  throw new TypeError(
    "selection projection must return an object or null",
  );
}

export class ViewerSelectionController {
  #host;
  #scope;
  #projectSelection;
  #sameSelection;
  #selection = null;
  #sequence = 0;
  #reason = "initial";
  #disposed = false;

  constructor({
    host,
    snapshot,
    projectSelection = (value) => value,
    sameSelection = Object.is,
  }) {
    this.#host = assertViewerHost(host);
    this.#scope = scopeFromSnapshot(snapshot);
    if (typeof projectSelection !== "function") {
      throw new TypeError(
        "selection projector must be a function",
      );
    }
    if (typeof sameSelection !== "function") {
      throw new TypeError(
        "selection equality predicate must be a function",
      );
    }
    this.#projectSelection = projectSelection;
    this.#sameSelection = sameSelection;
  }

  get disposed() {
    return this.#disposed;
  }

  snapshot() {
    return Object.freeze({
      ...this.#scope,
      sequence: this.#sequence,
      reason: this.#reason,
      selection: this.#selection,
    });
  }

  replace(value, { reason = "pick", force = false } = {}) {
    if (this.#disposed) {
      throw new DOMException(
        "Viewer selection controller is disposed",
        "InvalidStateError",
      );
    }
    const next =
      value === null
        ? null
        : projectedSelection(this.#projectSelection(value));
    if (
      !force &&
      this.#sameSelection(this.#selection, next)
    ) {
      return this.snapshot();
    }
    this.#selection =
      next === null ? null : Object.freeze({ ...next });
    this.#sequence += 1;
    this.#reason = reasonText(reason);
    const detail = this.snapshot();
    this.#host.handleEvent(
      Object.freeze({
        type: ViewerHostEventType.SELECTION_CHANGED,
        detail,
      }),
    );
    return detail;
  }

  clear(options = {}) {
    return this.replace(null, {
      reason: "clear",
      ...options,
    });
  }

  dispose() {
    if (this.#disposed) {
      return false;
    }
    this.#disposed = true;
    this.#selection = null;
    return true;
  }
}

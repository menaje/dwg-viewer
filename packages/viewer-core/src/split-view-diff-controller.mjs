import {
  ViewerDiffStatus,
} from "./render-diff-controller.mjs";
import {
  AllViewerSplitViewSides,
  ViewerSplitViewSide,
} from "./split-view-camera-controller.mjs";

const MAXIMUM_CHANGED_ENTRIES = 131_072;
const MAXIMUM_IDENTIFIER_LENGTH = 1_024;
const MAXIMUM_IDENTITY_TOKEN_LENGTH = 4_096;
const CHANGED_STATUSES = new Set([
  ViewerDiffStatus.ADDED,
  ViewerDiffStatus.MODIFIED,
  ViewerDiffStatus.REMOVED,
]);

function invalidState(message) {
  return new DOMException(message, "InvalidStateError");
}

function plainRecord(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function boundedIdentifier(
  value,
  label,
  maximum = MAXIMUM_IDENTIFIER_LENGTH,
) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new TypeError(`${label} must be a bounded identifier`);
  }
  return value;
}

function optionalIdentifier(value, label) {
  return value === null
    ? null
    : boundedIdentifier(value, label);
}

function nonnegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

function normalizeBounds(value, label) {
  if (value === null) {
    return null;
  }
  const bounds = plainRecord(value, label);
  if (
    !Array.isArray(bounds.min) ||
    bounds.min.length !== 3 ||
    !bounds.min.every(Number.isFinite) ||
    !Array.isArray(bounds.max) ||
    bounds.max.length !== 3 ||
    !bounds.max.every(Number.isFinite) ||
    bounds.min.some((entry, axis) => entry > bounds.max[axis])
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return Object.freeze({
    min: Object.freeze([...bounds.min]),
    max: Object.freeze([...bounds.max]),
  });
}

function normalizeCounts(value) {
  const counts = plainRecord(value, "split-view diff counts");
  return Object.freeze({
    added: nonnegativeSafeInteger(
      counts.added,
      "split-view added count",
    ),
    removed: nonnegativeSafeInteger(
      counts.removed,
      "split-view removed count",
    ),
    modified: nonnegativeSafeInteger(
      counts.modified,
      "split-view modified count",
    ),
    unchanged: nonnegativeSafeInteger(
      counts.unchanged,
      "split-view unchanged count",
    ),
  });
}

function normalizeChangedEntry(value) {
  const entry = plainRecord(value, "split-view changed entry");
  if (!CHANGED_STATUSES.has(entry.status)) {
    throw new TypeError(
      "split-view changed entries cannot enumerate unchanged entities",
    );
  }
  return Object.freeze({
    status: entry.status,
    operationId: boundedIdentifier(
      entry.operationId,
      "split-view operation ID",
    ),
    aspect: boundedIdentifier(
      entry.aspect,
      "split-view change aspect",
    ),
    layerId: boundedIdentifier(
      entry.layerId,
      "split-view layer ID",
    ),
    sourceId: boundedIdentifier(
      entry.sourceId,
      "split-view source ID",
    ),
    renderId: boundedIdentifier(
      entry.renderId,
      "split-view Render ID",
    ),
    affectedWorldBounds: normalizeBounds(
      entry.affectedWorldBounds,
      "split-view entry bounds",
    ),
    externalIdentityToken:
      entry.externalIdentityToken === null
        ? null
        : boundedIdentifier(
            entry.externalIdentityToken,
            "split-view external identity token",
            MAXIMUM_IDENTITY_TOKEN_LENGTH,
          ),
  });
}

function createComparison(value) {
  const diff = plainRecord(value, "render diff snapshot");
  if (
    !Array.isArray(diff.changedEntries) ||
    diff.changedEntries.length > MAXIMUM_CHANGED_ENTRIES
  ) {
    throw new RangeError(
      "split-view changed entries exceed their bounded limit",
    );
  }
  const counts = normalizeCounts(diff.counts);
  const changedEntries = [];
  const seen = new Set();
  const observed = {
    added: 0,
    removed: 0,
    modified: 0,
  };
  for (const candidate of diff.changedEntries) {
    const entry = normalizeChangedEntry(candidate);
    const key = `${entry.layerId}\u0000${entry.renderId}`;
    if (seen.has(key)) {
      throw new TypeError(
        "split-view changed entries contain a duplicate Render ID",
      );
    }
    seen.add(key);
    observed[entry.status] += 1;
    changedEntries.push(entry);
  }
  for (const status of CHANGED_STATUSES) {
    if (observed[status] !== counts[status]) {
      throw new RangeError(
        `split-view ${status} count does not match changed entries`,
      );
    }
  }
  return Object.freeze({
    protocolVersion: boundedIdentifier(
      diff.protocolVersion,
      "split-view protocol version",
    ),
    sessionId: boundedIdentifier(
      diff.sessionId,
      "split-view session ID",
    ),
    sourceId: boundedIdentifier(
      diff.sourceId,
      "split-view source ID",
    ),
    baseSnapshotId: boundedIdentifier(
      diff.baseSnapshotId,
      "split-view base snapshot ID",
    ),
    baseRevisionId: boundedIdentifier(
      diff.baseRevisionId,
      "split-view base revision ID",
    ),
    committedRevisionId: boundedIdentifier(
      diff.committedRevisionId,
      "split-view committed revision ID",
    ),
    revisionId: boundedIdentifier(
      diff.revisionId,
      "split-view target revision ID",
    ),
    sequence: nonnegativeSafeInteger(
      diff.sequence,
      "split-view delta sequence",
    ),
    previewId: optionalIdentifier(
      diff.previewId,
      "split-view preview ID",
    ),
    affectedWorldBounds: normalizeBounds(
      diff.affectedWorldBounds,
      "split-view affected bounds",
    ),
    counts,
    changedEntries: Object.freeze(changedEntries),
  });
}

function synchronous(value, label) {
  if (value && typeof value.then === "function") {
    throw new TypeError(`${label} must complete synchronously`);
  }
  return value;
}

function assertRenderDiffController(value) {
  if (typeof value?.snapshot !== "function") {
    throw new TypeError(
      "split-view diff controller requires renderDiffController.snapshot()",
    );
  }
  return value;
}

function assertTarget(value, side) {
  for (const method of ["applySplitDiff", "clearSplitDiff"]) {
    if (typeof value?.[method] !== "function") {
      throw new TypeError(
        `split-view ${side} target must implement ${method}()`,
      );
    }
  }
  return value;
}

function transitionFailure(error, rollbackErrors) {
  if (rollbackErrors.length === 0) {
    return error;
  }
  return new AggregateError(
    [error, ...rollbackErrors],
    "split-view diff transition and rollback failed",
    { cause: error },
  );
}

function sameHighlight(left, right) {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.layerId === right.layerId &&
      left.renderId === right.renderId)
  );
}

export class ViewerSplitViewDiffController {
  #renderDiffController;
  #targets;
  #comparison;
  #highlight = null;
  #active = false;
  #synchronized = false;
  #disposed = false;
  #transitioning = false;

  constructor({ renderDiffController, before, after } = {}) {
    this.#renderDiffController = assertRenderDiffController(
      renderDiffController,
    );
    const beforeTarget = assertTarget(
      before,
      ViewerSplitViewSide.BEFORE,
    );
    const afterTarget = assertTarget(
      after,
      ViewerSplitViewSide.AFTER,
    );
    if (beforeTarget === afterTarget) {
      throw new TypeError(
        "split-view diff targets must be distinct",
      );
    }
    this.#targets = new Map([
      [ViewerSplitViewSide.BEFORE, beforeTarget],
      [ViewerSplitViewSide.AFTER, afterTarget],
    ]);
    this.#comparison = this.#latest();
  }

  get disposed() {
    return this.#disposed;
  }

  #assertOpen() {
    if (this.#disposed) {
      throw invalidState(
        "Viewer split-view diff controller is disposed",
      );
    }
  }

  #assertIdle() {
    if (this.#transitioning) {
      throw invalidState(
        "split-view diff transition is already active",
      );
    }
  }

  #latest() {
    const diff = synchronous(
      this.#renderDiffController.snapshot(),
      "render diff controller snapshot",
    );
    return createComparison(diff);
  }

  #view() {
    return Object.freeze({
      active: this.#active,
      synchronized: this.#synchronized,
      comparison: this.#comparison,
      highlight: this.#highlight,
    });
  }

  snapshot() {
    this.#assertOpen();
    return this.#view();
  }

  #presentation(side, comparison, highlight) {
    return Object.freeze({
      side,
      revisionId:
        side === ViewerSplitViewSide.BEFORE
          ? comparison.baseRevisionId
          : comparison.revisionId,
      counterpartRevisionId:
        side === ViewerSplitViewSide.BEFORE
          ? comparison.revisionId
          : comparison.baseRevisionId,
      comparison,
      highlight,
    });
  }

  #apply(side, comparison, highlight) {
    return synchronous(
      this.#targets
        .get(side)
        .applySplitDiff(
          this.#presentation(side, comparison, highlight),
        ),
      `split-view ${side} target applySplitDiff`,
    );
  }

  #clear(side) {
    return synchronous(
      this.#targets.get(side).clearSplitDiff(),
      `split-view ${side} target clearSplitDiff`,
    );
  }

  #restore() {
    const rollbackErrors = [];
    for (const side of [...AllViewerSplitViewSides].reverse()) {
      try {
        if (this.#active) {
          this.#apply(side, this.#comparison, this.#highlight);
        } else {
          this.#clear(side);
        }
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    this.#synchronized = rollbackErrors.length === 0;
    return rollbackErrors;
  }

  #activate(comparison, highlight) {
    this.#transitioning = true;
    try {
      try {
        for (const side of AllViewerSplitViewSides) {
          this.#apply(side, comparison, highlight);
        }
      } catch (error) {
        throw transitionFailure(error, this.#restore());
      }
      this.#comparison = comparison;
      this.#highlight = highlight;
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
    const comparison = this.#latest();
    const highlight = this.#highlight
      ? comparison.changedEntries.find(
          (entry) =>
            entry.layerId === this.#highlight.layerId &&
            entry.renderId === this.#highlight.renderId,
        ) ?? null
      : null;
    return this.#activate(comparison, highlight);
  }

  highlight(layerId, renderId) {
    this.#assertOpen();
    this.#assertIdle();
    const normalizedLayerId = boundedIdentifier(
      layerId,
      "split-view highlight layer ID",
    );
    const normalizedRenderId = boundedIdentifier(
      renderId,
      "split-view highlight Render ID",
    );
    const highlight = this.#comparison.changedEntries.find(
      (entry) =>
        entry.layerId === normalizedLayerId &&
        entry.renderId === normalizedRenderId,
    );
    if (!highlight) {
      throw new RangeError(
        "split-view highlight must identify a changed Render ID",
      );
    }
    if (
      this.#active &&
      this.#synchronized &&
      sameHighlight(this.#highlight, highlight)
    ) {
      return this.#view();
    }
    return this.#activate(this.#comparison, highlight);
  }

  clearHighlight() {
    this.#assertOpen();
    this.#assertIdle();
    if (this.#highlight === null) {
      return this.#view();
    }
    return this.#activate(this.#comparison, null);
  }

  clear() {
    this.#assertOpen();
    this.#assertIdle();
    if (!this.#active && this.#synchronized) {
      return false;
    }
    this.#transitioning = true;
    try {
      try {
        for (const side of AllViewerSplitViewSides) {
          this.#clear(side);
        }
      } catch (error) {
        throw transitionFailure(error, this.#restore());
      }
      this.#active = false;
      this.#highlight = null;
      this.#synchronized = true;
      return true;
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
    this.#targets.clear();
    this.#disposed = true;
    return true;
  }
}

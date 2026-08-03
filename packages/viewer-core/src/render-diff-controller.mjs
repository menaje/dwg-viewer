const MAXIMUM_DIFF_IDENTIFIER_LENGTH = 1_024;

export const ViewerDiffStatus = Object.freeze({
  ADDED: "added",
  REMOVED: "removed",
  MODIFIED: "modified",
  UNCHANGED: "unchanged",
});

export const AllViewerDiffStatuses = Object.freeze(
  Object.values(ViewerDiffStatus).sort(),
);

function boundedIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAXIMUM_DIFF_IDENTIFIER_LENGTH
  ) {
    throw new TypeError(`${label} must be a bounded identifier`);
  }
  return value;
}

function nonnegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

function synchronous(value, label) {
  if (value && typeof value.then === "function") {
    throw new TypeError(`${label} must complete synchronously`);
  }
  return value;
}

function assertRenderDeltaController(controller) {
  for (const method of ["snapshot", "lookup"]) {
    if (typeof controller?.[method] !== "function") {
      throw new TypeError(
        `render diff controller requires renderDeltaController.${method}()`,
      );
    }
  }
  return controller;
}

function diffEntry(status, entry) {
  return Object.freeze({
    status,
    operationId: entry.operationId,
    aspect: entry.aspect,
    layerId: entry.layerId,
    sourceId: entry.sourceId,
    renderId: entry.renderId,
    affectedWorldBounds: entry.affectedWorldBounds,
    externalIdentityToken: entry.externalIdentityToken,
  });
}

function compareEntries(left, right) {
  return (
    left.layerId.localeCompare(right.layerId) ||
    left.renderId.localeCompare(right.renderId)
  );
}

export class ViewerRenderDiffController {
  #renderDeltaController;
  #baseRenderIdCount;
  #hasBaseRenderId;

  constructor({
    renderDeltaController,
    baseRenderIdCount,
    hasBaseRenderId,
  } = {}) {
    this.#renderDeltaController = assertRenderDeltaController(
      renderDeltaController,
    );
    this.#baseRenderIdCount = nonnegativeSafeInteger(
      baseRenderIdCount,
      "baseRenderIdCount",
    );
    if (typeof hasBaseRenderId !== "function") {
      throw new TypeError(
        "render diff controller requires hasBaseRenderId()",
      );
    }
    this.#hasBaseRenderId = hasBaseRenderId;
  }

  #baseContains(layerId, renderId) {
    const present = synchronous(
      this.#hasBaseRenderId(layerId, renderId),
      "hasBaseRenderId",
    );
    if (typeof present !== "boolean") {
      throw new TypeError(
        "hasBaseRenderId() must return a boolean",
      );
    }
    return present;
  }

  classify(layerId, renderId) {
    const normalizedLayerId = boundedIdentifier(
      layerId,
      "diff layer ID",
    );
    const normalizedRenderId = boundedIdentifier(
      renderId,
      "diff Render ID",
    );
    const basePresent = this.#baseContains(
      normalizedLayerId,
      normalizedRenderId,
    );
    const overlay = this.#renderDeltaController.lookup(
      normalizedLayerId,
      normalizedRenderId,
    );
    if (overlay.status === "tombstone") {
      return basePresent ? ViewerDiffStatus.REMOVED : null;
    }
    if (overlay.status === "upsert") {
      return basePresent
        ? ViewerDiffStatus.MODIFIED
        : ViewerDiffStatus.ADDED;
    }
    return basePresent ? ViewerDiffStatus.UNCHANGED : null;
  }

  snapshot() {
    const delta = this.#renderDeltaController.snapshot();
    const entries = [];
    let added = 0;
    let removed = 0;
    let modified = 0;

    for (const entry of delta.tombstones) {
      if (!this.#baseContains(entry.layerId, entry.renderId)) {
        continue;
      }
      removed += 1;
      entries.push(diffEntry(ViewerDiffStatus.REMOVED, entry));
    }
    for (const entry of delta.upserts) {
      const basePresent = this.#baseContains(
        entry.layerId,
        entry.renderId,
      );
      if (basePresent) {
        modified += 1;
        entries.push(diffEntry(ViewerDiffStatus.MODIFIED, entry));
      } else {
        added += 1;
        entries.push(diffEntry(ViewerDiffStatus.ADDED, entry));
      }
    }
    const changedBase = removed + modified;
    if (changedBase > this.#baseRenderIdCount) {
      throw new RangeError(
        "render diff changed base count exceeds baseRenderIdCount",
      );
    }
    const unchanged = this.#baseRenderIdCount - changedBase;
    entries.sort(compareEntries);

    return Object.freeze({
      protocolVersion: delta.protocolVersion,
      sessionId: delta.sessionId,
      sourceId: delta.sourceId,
      baseSnapshotId: delta.baseSnapshotId,
      baseRevisionId: delta.baseRevisionId,
      committedRevisionId: delta.committedRevisionId,
      revisionId: delta.revisionId,
      previewId: delta.previewId,
      affectedWorldBounds: delta.affectedWorldBounds,
      counts: Object.freeze({
        added,
        removed,
        modified,
        unchanged,
      }),
      changedEntries: Object.freeze(entries),
    });
  }
}

import {
  RenderDeltaAspect,
} from "@menaje/viewer-render-protocol";

import { ViewerHostEventType } from "./constants.mjs";
import { assertViewerHost } from "./contracts.mjs";
import {
  ViewerDiffStatus,
} from "./render-diff-controller.mjs";

const MAXIMUM_DIFF_ENTRIES = 131_072;
const MAXIMUM_DEPENDENCY_IDS = 32_768;
const MAXIMUM_IDENTIFIER_LENGTH = 1_024;
const MAXIMUM_IDENTITY_TOKEN_LENGTH = 4_096;
const MAXIMUM_REASON_LENGTH = 128;
const CHANGED_STATUSES = new Set([
  ViewerDiffStatus.ADDED,
  ViewerDiffStatus.MODIFIED,
  ViewerDiffStatus.REMOVED,
]);
const NON_VISUAL_ASPECTS = new Set([
  RenderDeltaAspect.IDENTITY,
  RenderDeltaAspect.DEPENDENCY,
]);

export const ViewerSemanticDiffAspect = Object.freeze({
  IDENTITY: RenderDeltaAspect.IDENTITY,
  DEPENDENCY: RenderDeltaAspect.DEPENDENCY,
});

export const AllViewerSemanticDiffAspects = Object.freeze(
  [...NON_VISUAL_ASPECTS].sort(),
);

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

function boolean(value, label) {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

function normalizeReason(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAXIMUM_REASON_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("semantic diff reason is invalid");
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
  const counts = plainRecord(value, "semantic diff counts");
  return Object.freeze({
    added: nonnegativeSafeInteger(
      counts.added,
      "semantic diff added count",
    ),
    removed: nonnegativeSafeInteger(
      counts.removed,
      "semantic diff removed count",
    ),
    modified: nonnegativeSafeInteger(
      counts.modified,
      "semantic diff modified count",
    ),
    unchanged: nonnegativeSafeInteger(
      counts.unchanged,
      "semantic diff unchanged count",
    ),
  });
}

function normalizeSemanticEntry(value) {
  const entry = plainRecord(value, "semantic diff entry");
  if (!CHANGED_STATUSES.has(entry.status)) {
    throw new TypeError(
      "semantic diff entries must have a changed status",
    );
  }
  if (!NON_VISUAL_ASPECTS.has(entry.aspect)) {
    throw new TypeError(
      "semantic diff entry must have a non-visual aspect",
    );
  }
  return Object.freeze({
    status: entry.status,
    operationId: boundedIdentifier(
      entry.operationId,
      "semantic diff operation ID",
    ),
    aspect: entry.aspect,
    layerId: boundedIdentifier(
      entry.layerId,
      "semantic diff layer ID",
    ),
    sourceId: boundedIdentifier(
      entry.sourceId,
      "semantic diff source ID",
    ),
    renderId: boundedIdentifier(
      entry.renderId,
      "semantic diff Render ID",
    ),
    affectedWorldBounds: normalizeBounds(
      entry.affectedWorldBounds,
      "semantic diff entry bounds",
    ),
    externalIdentityToken:
      entry.externalIdentityToken === null
        ? null
        : boundedIdentifier(
            entry.externalIdentityToken,
            "semantic diff external identity token",
            MAXIMUM_IDENTITY_TOKEN_LENGTH,
          ),
  });
}

function normalizeDependencyIds(value) {
  if (
    !Array.isArray(value) ||
    value.length > MAXIMUM_DEPENDENCY_IDS
  ) {
    throw new RangeError(
      "semantic diff dependency IDs exceed their bounded limit",
    );
  }
  const seen = new Set();
  const identifiers = [];
  for (const candidate of value) {
    const identifier = boundedIdentifier(
      candidate,
      "semantic diff dependency ID",
    );
    if (seen.has(identifier)) {
      throw new TypeError(
        "semantic diff dependency IDs must be unique",
      );
    }
    seen.add(identifier);
    identifiers.push(identifier);
  }
  return Object.freeze(identifiers.sort());
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
      "semantic diff controller requires renderDiffController.snapshot()",
    );
  }
  return value;
}

function createDetail(diff, sequence, reason) {
  const snapshot = plainRecord(diff, "render diff snapshot");
  if (
    !Array.isArray(snapshot.changedEntries) ||
    snapshot.changedEntries.length > MAXIMUM_DIFF_ENTRIES
  ) {
    throw new RangeError(
      "semantic diff changed entries exceed their bounded limit",
    );
  }
  const nonVisualEntries = snapshot.changedEntries
    .filter((entry) => NON_VISUAL_ASPECTS.has(entry?.aspect))
    .map(normalizeSemanticEntry);
  const counts = normalizeCounts(snapshot.counts);
  if (
    snapshot.changedEntries.length !==
    counts.added + counts.removed + counts.modified
  ) {
    throw new RangeError(
      "semantic diff changed count does not match changed entries",
    );
  }
  return Object.freeze({
    protocolVersion: boundedIdentifier(
      snapshot.protocolVersion,
      "semantic diff protocol version",
    ),
    sessionId: boundedIdentifier(
      snapshot.sessionId,
      "semantic diff session ID",
    ),
    sourceId: boundedIdentifier(
      snapshot.sourceId,
      "semantic diff source ID",
    ),
    baseSnapshotId: boundedIdentifier(
      snapshot.baseSnapshotId,
      "semantic diff base snapshot ID",
    ),
    baseRevisionId: boundedIdentifier(
      snapshot.baseRevisionId,
      "semantic diff base revision ID",
    ),
    committedRevisionId: boundedIdentifier(
      snapshot.committedRevisionId,
      "semantic diff committed revision ID",
    ),
    revisionId: boundedIdentifier(
      snapshot.revisionId,
      "semantic diff revision ID",
    ),
    previewId: optionalIdentifier(
      snapshot.previewId,
      "semantic diff preview ID",
    ),
    deltaSequence: nonnegativeSafeInteger(
      snapshot.sequence,
      "semantic diff delta sequence",
    ),
    sequence,
    reason,
    checkpointRecommended: boolean(
      snapshot.checkpointRecommended,
      "semantic diff checkpoint recommendation",
    ),
    affectedWorldBounds: normalizeBounds(
      snapshot.affectedWorldBounds,
      "semantic diff affected bounds",
    ),
    counts,
    nonVisualEntries: Object.freeze(nonVisualEntries),
    invalidatedDependencyIds: normalizeDependencyIds(
      snapshot.invalidatedDependencyIds,
    ),
  });
}

export class ViewerDiffSemanticController {
  #host;
  #renderDiffController;
  #sequence = 0;
  #disposed = false;

  constructor({ host, renderDiffController } = {}) {
    this.#host = assertViewerHost(host);
    this.#renderDiffController = assertRenderDiffController(
      renderDiffController,
    );
  }

  get disposed() {
    return this.#disposed;
  }

  #assertOpen() {
    if (this.#disposed) {
      throw invalidState("Viewer semantic diff controller is disposed");
    }
  }

  async open({ reason = "review" } = {}) {
    this.#assertOpen();
    const normalizedReason = normalizeReason(reason);
    const diff = synchronous(
      this.#renderDiffController.snapshot(),
      "render diff controller snapshot",
    );
    const sequence = this.#sequence + 1;
    const detail = createDetail(
      diff,
      sequence,
      normalizedReason,
    );
    this.#sequence = sequence;
    await this.#host.handleEvent(
      Object.freeze({
        type: ViewerHostEventType.DIFF_OPEN,
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

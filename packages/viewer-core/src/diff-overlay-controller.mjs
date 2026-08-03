import {
  AllViewerDiffStatuses,
  ViewerDiffStatus,
} from "./render-diff-controller.mjs";

const MAXIMUM_DIFF_OVERLAY_ENTRIES = 131_072;
const MAXIMUM_IDENTIFIER_LENGTH = 1_024;
const MAXIMUM_IDENTITY_TOKEN_LENGTH = 4_096;
const STYLE_KEYS = Object.freeze(["color", "opacity", "visible"]);
const CHANGED_STATUSES = new Set([
  ViewerDiffStatus.ADDED,
  ViewerDiffStatus.MODIFIED,
  ViewerDiffStatus.REMOVED,
]);

const DEFAULT_STATUS_STYLES = Object.freeze({
  [ViewerDiffStatus.ADDED]: Object.freeze({
    color: "#3fb950",
    opacity: 1,
    visible: true,
  }),
  [ViewerDiffStatus.REMOVED]: Object.freeze({
    color: "#f85149",
    opacity: 1,
    visible: true,
  }),
  [ViewerDiffStatus.MODIFIED]: Object.freeze({
    color: "#d29922",
    opacity: 1,
    visible: true,
  }),
  [ViewerDiffStatus.UNCHANGED]: Object.freeze({
    color: null,
    opacity: 0.35,
    visible: true,
  }),
});

export const ViewerDiffOverlayVisibilityRule = Object.freeze({
  INTERSECT_SOURCE: "intersect-source",
});

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

function nonnegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

function assertStatus(value) {
  if (!AllViewerDiffStatuses.includes(value)) {
    throw new TypeError("diff overlay status is invalid");
  }
  return value;
}

function normalizeColor(value, label) {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    !/^#[0-9a-f]{6}$/iu.test(value)
  ) {
    throw new TypeError(
      `${label} must be null or a canonical six-digit hex color`,
    );
  }
  return value.toLowerCase();
}

function normalizeStyle(value, fallback, status) {
  const style = plainRecord(value, `${status} diff overlay style`);
  for (const key of Object.keys(style)) {
    if (!STYLE_KEYS.includes(key)) {
      throw new TypeError(
        `${status} diff overlay style contains unknown property ${key}`,
      );
    }
  }
  const visible =
    style.visible === undefined ? fallback.visible : style.visible;
  const opacity =
    style.opacity === undefined ? fallback.opacity : style.opacity;
  const color = style.color === undefined ? fallback.color : style.color;
  if (typeof visible !== "boolean") {
    throw new TypeError(
      `${status} diff overlay visibility must be a boolean`,
    );
  }
  if (
    !Number.isFinite(opacity) ||
    opacity < 0 ||
    opacity > 1
  ) {
    throw new RangeError(
      `${status} diff overlay opacity must be between zero and one`,
    );
  }
  return Object.freeze({
    color: normalizeColor(color, `${status} diff overlay color`),
    opacity,
    visible,
  });
}

export function createViewerDiffOverlayPolicy(overrides = {}) {
  const input = plainRecord(overrides, "diff overlay policy");
  for (const status of Object.keys(input)) {
    assertStatus(status);
  }
  return Object.freeze({
    [ViewerDiffStatus.ADDED]: normalizeStyle(
      input[ViewerDiffStatus.ADDED] === undefined
        ? {}
        : input[ViewerDiffStatus.ADDED],
      DEFAULT_STATUS_STYLES[ViewerDiffStatus.ADDED],
      ViewerDiffStatus.ADDED,
    ),
    [ViewerDiffStatus.REMOVED]: normalizeStyle(
      input[ViewerDiffStatus.REMOVED] === undefined
        ? {}
        : input[ViewerDiffStatus.REMOVED],
      DEFAULT_STATUS_STYLES[ViewerDiffStatus.REMOVED],
      ViewerDiffStatus.REMOVED,
    ),
    [ViewerDiffStatus.MODIFIED]: normalizeStyle(
      input[ViewerDiffStatus.MODIFIED] === undefined
        ? {}
        : input[ViewerDiffStatus.MODIFIED],
      DEFAULT_STATUS_STYLES[ViewerDiffStatus.MODIFIED],
      ViewerDiffStatus.MODIFIED,
    ),
    [ViewerDiffStatus.UNCHANGED]: normalizeStyle(
      input[ViewerDiffStatus.UNCHANGED] === undefined
        ? {}
        : input[ViewerDiffStatus.UNCHANGED],
      DEFAULT_STATUS_STYLES[ViewerDiffStatus.UNCHANGED],
      ViewerDiffStatus.UNCHANGED,
    ),
  });
}

export const DefaultViewerDiffOverlayPolicy =
  createViewerDiffOverlayPolicy();

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

function normalizeOptionalIdentifier(value, label) {
  return value === null
    ? null
    : boundedIdentifier(value, label);
}

function normalizeIdentityToken(value) {
  return value === null
    ? null
    : boundedIdentifier(
        value,
        "diff overlay external identity token",
        MAXIMUM_IDENTITY_TOKEN_LENGTH,
      );
}

function normalizeChangedEntry(value) {
  const entry = plainRecord(value, "diff overlay changed entry");
  const status = assertStatus(entry.status);
  if (!CHANGED_STATUSES.has(status)) {
    throw new TypeError(
      "diff overlay changed entries cannot enumerate unchanged entities",
    );
  }
  return Object.freeze({
    status,
    operationId: boundedIdentifier(
      entry.operationId,
      "diff overlay operation ID",
    ),
    aspect: boundedIdentifier(entry.aspect, "diff overlay aspect"),
    layerId: boundedIdentifier(
      entry.layerId,
      "diff overlay layer ID",
    ),
    sourceId: boundedIdentifier(
      entry.sourceId,
      "diff overlay source ID",
    ),
    renderId: boundedIdentifier(
      entry.renderId,
      "diff overlay Render ID",
    ),
    affectedWorldBounds: normalizeBounds(
      entry.affectedWorldBounds,
      "diff overlay entry bounds",
    ),
    externalIdentityToken: normalizeIdentityToken(
      entry.externalIdentityToken,
    ),
  });
}

function normalizeCounts(value) {
  const counts = plainRecord(value, "diff overlay counts");
  return Object.freeze({
    added: nonnegativeSafeInteger(counts.added, "added diff count"),
    removed: nonnegativeSafeInteger(
      counts.removed,
      "removed diff count",
    ),
    modified: nonnegativeSafeInteger(
      counts.modified,
      "modified diff count",
    ),
    unchanged: nonnegativeSafeInteger(
      counts.unchanged,
      "unchanged diff count",
    ),
  });
}

function createPresentation(value, policy) {
  const diff = plainRecord(value, "render diff snapshot");
  if (
    !Array.isArray(diff.changedEntries) ||
    diff.changedEntries.length > MAXIMUM_DIFF_OVERLAY_ENTRIES
  ) {
    throw new RangeError(
      "diff overlay changed entries exceed their bounded limit",
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
        "diff overlay changed entries contain a duplicate Render ID",
      );
    }
    seen.add(key);
    observed[entry.status] += 1;
    changedEntries.push(entry);
  }
  for (const status of CHANGED_STATUSES) {
    if (observed[status] !== counts[status]) {
      throw new RangeError(
        `diff overlay ${status} count does not match changed entries`,
      );
    }
  }
  return Object.freeze({
    protocolVersion: boundedIdentifier(
      diff.protocolVersion,
      "diff overlay protocol version",
    ),
    sessionId: boundedIdentifier(
      diff.sessionId,
      "diff overlay session ID",
    ),
    sourceId: boundedIdentifier(
      diff.sourceId,
      "diff overlay source ID",
    ),
    baseSnapshotId: boundedIdentifier(
      diff.baseSnapshotId,
      "diff overlay base snapshot ID",
    ),
    baseRevisionId: boundedIdentifier(
      diff.baseRevisionId,
      "diff overlay base revision ID",
    ),
    committedRevisionId: boundedIdentifier(
      diff.committedRevisionId,
      "diff overlay committed revision ID",
    ),
    revisionId: boundedIdentifier(
      diff.revisionId,
      "diff overlay revision ID",
    ),
    previewId: normalizeOptionalIdentifier(
      diff.previewId,
      "diff overlay preview ID",
    ),
    affectedWorldBounds: normalizeBounds(
      diff.affectedWorldBounds,
      "diff overlay affected bounds",
    ),
    visibilityRule:
      ViewerDiffOverlayVisibilityRule.INTERSECT_SOURCE,
    statusStyles: policy,
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
      "diff overlay controller requires renderDiffController.snapshot()",
    );
  }
  return value;
}

function assertAdapter(value) {
  for (const method of ["applyDiffOverlay", "clearDiffOverlay"]) {
    if (typeof value?.[method] !== "function") {
      throw new TypeError(
        `diff overlay adapter must implement ${method}()`,
      );
    }
  }
  return value;
}

function transitionFailure(error, rollbackError) {
  return new AggregateError(
    [error, rollbackError],
    "diff overlay transition and rollback failed",
    { cause: error },
  );
}

export class ViewerDiffOverlayController {
  #renderDiffController;
  #adapter;
  #policy;
  #presentation;
  #active = false;
  #synchronized = false;
  #disposed = false;
  #transitioning = false;

  constructor({ renderDiffController, adapter, policy = {} } = {}) {
    this.#renderDiffController = assertRenderDiffController(
      renderDiffController,
    );
    this.#adapter = assertAdapter(adapter);
    this.#policy = createViewerDiffOverlayPolicy(policy);
    this.#presentation = this.#latest(this.#policy);
  }

  get disposed() {
    return this.#disposed;
  }

  #assertOpen() {
    if (this.#disposed) {
      throw invalidState("Viewer diff overlay controller is disposed");
    }
  }

  #assertIdle() {
    if (this.#transitioning) {
      throw invalidState("diff overlay transition is already active");
    }
  }

  #latest(policy) {
    const diff = synchronous(
      this.#renderDiffController.snapshot(),
      "render diff controller snapshot",
    );
    return createPresentation(diff, policy);
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

  #apply(presentation) {
    return synchronous(
      this.#adapter.applyDiffOverlay(presentation),
      "diff overlay adapter applyDiffOverlay",
    );
  }

  #clear() {
    return synchronous(
      this.#adapter.clearDiffOverlay(),
      "diff overlay adapter clearDiffOverlay",
    );
  }

  #restoreAfterFailure(error) {
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

  #activate(policy, presentation) {
    this.#transitioning = true;
    try {
      try {
        this.#apply(presentation);
      } catch (error) {
        return this.#restoreAfterFailure(error);
      }
      this.#policy = policy;
      this.#presentation = presentation;
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
      this.#policy,
      this.#latest(this.#policy),
    );
  }

  setPolicy(policy) {
    this.#assertOpen();
    this.#assertIdle();
    const nextPolicy = createViewerDiffOverlayPolicy(policy);
    const presentation = this.#latest(nextPolicy);
    if (this.#active) {
      return this.#activate(nextPolicy, presentation);
    }
    this.#policy = nextPolicy;
    this.#presentation = presentation;
    return this.#view();
  }

  setStatusStyle(status, style) {
    this.#assertOpen();
    const normalizedStatus = assertStatus(status);
    const next = Object.fromEntries(
      AllViewerDiffStatuses.map((entry) => [
        entry,
        entry === normalizedStatus
          ? {
              ...this.#policy[entry],
              ...plainRecord(style, "diff overlay style"),
            }
          : this.#policy[entry],
      ]),
    );
    return this.setPolicy(next);
  }

  setStatusVisible(status, visible) {
    return this.setStatusStyle(status, { visible });
  }

  resetPolicy() {
    return this.setPolicy(DefaultViewerDiffOverlayPolicy);
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
        this.#clear();
      } catch (error) {
        this.#synchronized = false;
        throw error;
      }
      this.#active = false;
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
    this.#disposed = true;
    return true;
  }
}

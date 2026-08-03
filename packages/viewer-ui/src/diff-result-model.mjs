import { createViewerResultModel } from "./review-ui-controller.mjs";

const DEFAULT_DIFF_LABELS = Object.freeze({
  baseRevision: "Base revision",
  targetRevision: "Target revision",
  added: "Added",
  removed: "Removed",
  modified: "Modified",
  unchanged: "Unchanged",
});

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a nonnegative safe integer`);
  }
  return String(value);
}

function revision(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_048
  ) {
    throw new TypeError(`${label} must be a bounded revision ID`);
  }
  return value;
}

function labels(input) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    throw new TypeError("diff labels must be an object");
  }
  return Object.freeze({
    ...DEFAULT_DIFF_LABELS,
    ...input,
  });
}

export function createViewerDiffResultModel(
  diff,
  {
    title = "Revision diff",
    labels: inputLabels = DEFAULT_DIFF_LABELS,
  } = {},
) {
  if (!diff || typeof diff !== "object" || Array.isArray(diff)) {
    throw new TypeError("diff must be a render diff snapshot");
  }
  if (
    !diff.counts ||
    typeof diff.counts !== "object" ||
    Array.isArray(diff.counts)
  ) {
    throw new TypeError("diff counts must be an object");
  }
  const text = labels(inputLabels);
  return createViewerResultModel({
    title,
    rows: [
      [
        text.baseRevision,
        revision(diff.baseRevisionId, "baseRevisionId"),
      ],
      [
        text.targetRevision,
        revision(diff.revisionId, "revisionId"),
      ],
      [text.added, count(diff.counts.added, "added count")],
      [text.removed, count(diff.counts.removed, "removed count")],
      [text.modified, count(diff.counts.modified, "modified count")],
      [
        text.unchanged,
        count(diff.counts.unchanged, "unchanged count"),
      ],
    ],
    view: "revision-diff",
  });
}

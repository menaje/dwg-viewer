import assert from "node:assert/strict";
import test from "node:test";

import {
  DefaultViewerDiffOverlayPolicy,
  ViewerDiffOverlayController,
  ViewerDiffOverlayVisibilityRule,
  createViewerDiffOverlayPolicy,
} from "@dwg-viewer/viewer-core/diff-overlay";
import {
  ViewerDiffStatus,
} from "@dwg-viewer/viewer-core/render-diff";

function changedEntry(status, renderId) {
  return {
    status,
    operationId: `operation:${renderId}`,
    aspect: "geometry",
    layerId: "layer:live",
    sourceId: "source:live",
    renderId,
    affectedWorldBounds: {
      min: [0, 0, 0],
      max: [1, 1, 1],
    },
    externalIdentityToken:
      status === ViewerDiffStatus.REMOVED
        ? null
        : `external:${renderId}`,
  };
}

function diffSnapshot({
  revisionId = "revision:target",
  previewId = null,
  changedEntries = [
    changedEntry(ViewerDiffStatus.ADDED, "render:added"),
    changedEntry(ViewerDiffStatus.REMOVED, "render:removed"),
    changedEntry(ViewerDiffStatus.MODIFIED, "render:modified"),
  ],
  unchanged = 7,
} = {}) {
  const counts = {
    added: 0,
    removed: 0,
    modified: 0,
    unchanged,
  };
  for (const entry of changedEntries) {
    counts[entry.status] += 1;
  }
  return {
    protocolVersion: "0.1.0",
    sessionId: "session:diff",
    sourceId: "source:diff",
    baseSnapshotId: "snapshot:base",
    baseRevisionId: "revision:base",
    committedRevisionId: "revision:committed",
    revisionId,
    previewId,
    affectedWorldBounds: {
      min: [0, 0, 0],
      max: [3, 3, 1],
    },
    counts,
    changedEntries,
  };
}

function fixture({ apply = null, clear = null } = {}) {
  const state = {
    diff: diffSnapshot(),
    applied: [],
    clears: 0,
  };
  return {
    state,
    renderDiffController: {
      snapshot() {
        return state.diff;
      },
    },
    adapter: {
      applyDiffOverlay(presentation) {
        state.applied.push(presentation);
        return apply?.(presentation, state);
      },
      clearDiffOverlay() {
        state.clears += 1;
        return clear?.(state);
      },
    },
  };
}

test("applies bounded default styles without enumerating unchanged IDs", () => {
  const value = fixture();
  const controller = new ViewerDiffOverlayController({
    renderDiffController: value.renderDiffController,
    adapter: value.adapter,
  });

  assert.equal(controller.snapshot().active, false);
  assert.equal(controller.snapshot().synchronized, false);
  const active = controller.synchronize();
  const presentation = active.presentation;

  assert.equal(active.active, true);
  assert.equal(active.synchronized, true);
  assert.equal(
    presentation.visibilityRule,
    ViewerDiffOverlayVisibilityRule.INTERSECT_SOURCE,
  );
  assert.equal(presentation.statusStyles.added.color, "#3fb950");
  assert.equal(presentation.statusStyles.removed.color, "#f85149");
  assert.equal(presentation.statusStyles.modified.color, "#d29922");
  assert.deepEqual(presentation.statusStyles.unchanged, {
    color: null,
    opacity: 0.35,
    visible: true,
  });
  assert.equal(presentation.counts.unchanged, 7);
  assert.equal(presentation.changedEntries.length, 3);
  assert.equal(
    presentation.changedEntries.some(
      (entry) => entry.status === ViewerDiffStatus.UNCHANGED,
    ),
    false,
  );
  assert.equal(Object.isFrozen(presentation), true);
  assert.equal(value.state.applied.length, 1);

  value.state.diff = diffSnapshot({
    revisionId: "revision:preview",
    previewId: "preview:one",
  });
  const preview = controller.synchronize();
  assert.equal(preview.presentation.revisionId, "revision:preview");
  assert.equal(preview.presentation.previewId, "preview:one");
});

test("updates per-status color, opacity, and visibility atomically", () => {
  const value = fixture();
  const controller = new ViewerDiffOverlayController({
    renderDiffController: value.renderDiffController,
    adapter: value.adapter,
  });
  controller.synchronize();

  const hidden = controller.setStatusVisible(
    ViewerDiffStatus.REMOVED,
    false,
  );
  assert.equal(hidden.presentation.statusStyles.removed.visible, false);
  assert.equal(hidden.presentation.statusStyles.added.visible, true);

  const styled = controller.setStatusStyle(
    ViewerDiffStatus.MODIFIED,
    {
      color: "#AABBCC",
      opacity: 0.6,
    },
  );
  assert.deepEqual(styled.presentation.statusStyles.modified, {
    color: "#aabbcc",
    opacity: 0.6,
    visible: true,
  });
  assert.equal(value.state.applied.length, 3);

  assert.throws(
    () =>
      controller.setStatusStyle(ViewerDiffStatus.ADDED, {
        color: "red",
      }),
    /six-digit hex color/u,
  );
  assert.throws(
    () =>
      createViewerDiffOverlayPolicy({
        removed: { opacity: 1.1 },
      }),
    /between zero and one/u,
  );
  assert.throws(
    () =>
      createViewerDiffOverlayPolicy({
        added: { visible: null },
      }),
    /visibility must be a boolean/u,
  );
  assert.throws(
    () =>
      createViewerDiffOverlayPolicy({
        changed: { visible: true },
      }),
    /status is invalid/u,
  );
  assert.equal(value.state.applied.length, 3);
});

test("restores the previous presentation when an update fails", () => {
  let rejectHiddenRemoval = true;
  const value = fixture({
    apply(presentation) {
      if (
        !presentation.statusStyles.removed.visible &&
        rejectHiddenRemoval
      ) {
        rejectHiddenRemoval = false;
        throw new Error("renderer policy failed");
      }
    },
  });
  const controller = new ViewerDiffOverlayController({
    renderDiffController: value.renderDiffController,
    adapter: value.adapter,
  });
  controller.synchronize();

  assert.throws(
    () =>
      controller.setStatusVisible(
        ViewerDiffStatus.REMOVED,
        false,
      ),
    /renderer policy failed/u,
  );
  assert.equal(
    controller.snapshot().presentation.statusStyles.removed.visible,
    true,
  );
  assert.equal(controller.snapshot().synchronized, true);
  assert.equal(
    value.state.applied.at(-1).statusStyles.removed.visible,
    true,
  );

  const retried = controller.setStatusVisible(
    ViewerDiffStatus.REMOVED,
    false,
  );
  assert.equal(retried.presentation.statusStyles.removed.visible, false);
});

test("reports an incomplete rollback and recovers by synchronizing", () => {
  let failures = 0;
  const value = fixture({
    apply() {
      if (failures < 2) {
        failures += 1;
        throw new Error(`renderer failure ${failures}`);
      }
    },
  });
  const controller = new ViewerDiffOverlayController({
    renderDiffController: value.renderDiffController,
    adapter: value.adapter,
  });
  failures = 2;
  controller.synchronize();
  failures = 0;

  assert.throws(
    () =>
      controller.setStatusVisible(
        ViewerDiffStatus.UNCHANGED,
        false,
      ),
    AggregateError,
  );
  assert.equal(controller.snapshot().synchronized, false);
  assert.equal(
    controller.snapshot().presentation.statusStyles.unchanged.visible,
    true,
  );

  const recovered = controller.synchronize();
  assert.equal(recovered.synchronized, true);
  assert.equal(
    recovered.presentation.statusStyles.unchanged.visible,
    true,
  );
});

test("rejects inconsistent summaries and clears presentation on disposal", () => {
  const malformed = fixture();
  malformed.state.diff = {
    ...diffSnapshot(),
    counts: {
      added: 2,
      removed: 1,
      modified: 1,
      unchanged: 7,
    },
  };
  assert.throws(
    () =>
      new ViewerDiffOverlayController({
        renderDiffController: malformed.renderDiffController,
        adapter: malformed.adapter,
      }),
    /added count does not match/u,
  );

  const value = fixture();
  const controller = new ViewerDiffOverlayController({
    renderDiffController: value.renderDiffController,
    adapter: value.adapter,
    policy: DefaultViewerDiffOverlayPolicy,
  });
  controller.synchronize();
  assert.equal(controller.dispose(), true);
  assert.equal(value.state.clears, 1);
  assert.equal(controller.dispose(), false);
  assert.throws(() => controller.snapshot(), /disposed/u);
});

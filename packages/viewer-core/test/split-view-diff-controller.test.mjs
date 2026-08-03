import assert from "node:assert/strict";
import test from "node:test";

import {
  ViewerSplitViewDiffController,
  ViewerSplitViewSide,
} from "@dwg-viewer/viewer-core/split-view";
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
  sequence = 1,
  previewId = null,
  changedEntries = [
    changedEntry(ViewerDiffStatus.ADDED, "render:added"),
    changedEntry(ViewerDiffStatus.REMOVED, "render:removed"),
    changedEntry(ViewerDiffStatus.MODIFIED, "render:modified"),
  ],
} = {}) {
  const counts = {
    added: 0,
    removed: 0,
    modified: 0,
    unchanged: 99_997,
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
    sequence,
    previewId,
    affectedWorldBounds: {
      min: [0, 0, 0],
      max: [3, 3, 1],
    },
    counts,
    changedEntries,
  };
}

function target({ apply = null, clear = null } = {}) {
  const state = {
    presentation: null,
    applied: [],
    clears: 0,
  };
  return {
    state,
    adapter: {
      applySplitDiff(presentation) {
        const result = apply?.(presentation, state);
        state.presentation = presentation;
        state.applied.push(presentation);
        return result;
      },
      clearSplitDiff() {
        const result = clear?.(state);
        state.presentation = null;
        state.clears += 1;
        return result;
      },
    },
  };
}

function fixture({ before = target(), after = target() } = {}) {
  const state = {
    diff: diffSnapshot(),
  };
  return {
    state,
    before,
    after,
    controller: new ViewerSplitViewDiffController({
      renderDiffController: {
        snapshot() {
          return state.diff;
        },
      },
      before: before.adapter,
      after: after.adapter,
    }),
  };
}

test("binds independent before and after surfaces to one changed-ID mapping", () => {
  const value = fixture();
  const synchronized = value.controller.synchronize();
  const before = value.before.state.presentation;
  const after = value.after.state.presentation;

  assert.equal(synchronized.active, true);
  assert.equal(synchronized.synchronized, true);
  assert.equal(before.side, ViewerSplitViewSide.BEFORE);
  assert.equal(after.side, ViewerSplitViewSide.AFTER);
  assert.equal(before.revisionId, "revision:base");
  assert.equal(after.revisionId, "revision:target");
  assert.equal(before.counterpartRevisionId, "revision:target");
  assert.equal(after.counterpartRevisionId, "revision:base");
  assert.equal(before.comparison, after.comparison);
  assert.equal(
    before.comparison.changedEntries,
    after.comparison.changedEntries,
  );
  assert.deepEqual(
    before.comparison.changedEntries.map(
      ({ layerId, renderId, status }) => ({
        layerId,
        renderId,
        status,
      }),
    ),
    [
      {
        layerId: "layer:live",
        renderId: "render:added",
        status: ViewerDiffStatus.ADDED,
      },
      {
        layerId: "layer:live",
        renderId: "render:removed",
        status: ViewerDiffStatus.REMOVED,
      },
      {
        layerId: "layer:live",
        renderId: "render:modified",
        status: ViewerDiffStatus.MODIFIED,
      },
    ],
  );
  assert.equal(Object.isFrozen(before), true);
  assert.equal(Object.isFrozen(before.comparison), true);
});

test("applies the exact same corresponding-entity highlight to both surfaces", () => {
  const value = fixture();
  value.controller.synchronize();
  const highlighted = value.controller.highlight(
    "layer:live",
    "render:removed",
  );

  assert.equal(
    value.before.state.presentation.highlight,
    value.after.state.presentation.highlight,
  );
  assert.equal(
    value.before.state.presentation.highlight,
    highlighted.highlight,
  );
  assert.equal(
    highlighted.highlight.status,
    ViewerDiffStatus.REMOVED,
  );
  assert.throws(
    () =>
      value.controller.highlight(
        "layer:live",
        "render:unchanged",
      ),
    /must identify a changed Render ID/u,
  );

  value.controller.clearHighlight();
  assert.equal(value.before.state.presentation.highlight, null);
  assert.equal(value.after.state.presentation.highlight, null);
});

test("keeps a highlight across revisions only while its mapping remains changed", () => {
  const value = fixture();
  value.controller.synchronize();
  value.controller.highlight("layer:live", "render:modified");

  value.state.diff = diffSnapshot({
    revisionId: "revision:preview",
    sequence: 2,
    previewId: "preview:two",
  });
  const retained = value.controller.synchronize();
  assert.equal(retained.highlight.renderId, "render:modified");
  assert.equal(retained.comparison.previewId, "preview:two");
  assert.equal(
    value.after.state.presentation.revisionId,
    "revision:preview",
  );

  value.state.diff = diffSnapshot({
    revisionId: "revision:rollback",
    sequence: 3,
    changedEntries: [
      changedEntry(ViewerDiffStatus.ADDED, "render:other"),
    ],
  });
  const cleared = value.controller.synchronize();
  assert.equal(cleared.highlight, null);
});

test("restores the last good split presentation after one surface rejects an update", () => {
  let rejected = false;
  const before = target();
  const after = target({
    apply(presentation) {
      if (
        presentation.revisionId === "revision:preview" &&
        !rejected
      ) {
        rejected = true;
        throw new Error("after revision failed");
      }
    },
  });
  const value = fixture({ before, after });
  const baseline = value.controller.synchronize();
  value.state.diff = diffSnapshot({
    revisionId: "revision:preview",
    sequence: 2,
    previewId: "preview:failed",
  });

  assert.throws(
    () => value.controller.synchronize(),
    /after revision failed/u,
  );
  assert.equal(
    value.controller.snapshot().comparison,
    baseline.comparison,
  );
  assert.equal(
    value.before.state.presentation.revisionId,
    "revision:base",
  );
  assert.equal(
    value.after.state.presentation.revisionId,
    "revision:target",
  );
  assert.equal(value.controller.snapshot().synchronized, true);

  const retried = value.controller.synchronize();
  assert.equal(retried.comparison.revisionId, "revision:preview");
  assert.equal(
    value.after.state.presentation.revisionId,
    "revision:preview",
  );
});

test("validates distinct synchronous targets and clears them on disposal", () => {
  const shared = {
    applySplitDiff() {},
    clearSplitDiff() {},
  };
  assert.throws(
    () =>
      new ViewerSplitViewDiffController({
        renderDiffController: {
          snapshot: diffSnapshot,
        },
        before: shared,
        after: shared,
      }),
    /must be distinct/u,
  );

  const value = fixture({
    after: target({
      apply() {
        return Promise.resolve();
      },
    }),
  });
  assert.throws(
    () => value.controller.synchronize(),
    /must complete synchronously/u,
  );

  const disposable = fixture();
  disposable.controller.synchronize();
  assert.equal(disposable.controller.dispose(), true);
  assert.equal(disposable.before.state.clears, 1);
  assert.equal(disposable.after.state.clears, 1);
  assert.equal(disposable.controller.dispose(), false);
  assert.throws(() => disposable.controller.snapshot(), /disposed/u);
});

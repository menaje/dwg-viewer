import assert from "node:assert/strict";
import test from "node:test";

import {
  ViewerDiffSemanticController,
  ViewerSemanticDiffAspect,
} from "@menaje/viewer-core/diff-semantic";
import {
  ViewerDiffStatus,
} from "@menaje/viewer-core/render-diff";
import {
  ViewerHostEventType,
} from "@menaje/viewer-core";

function changedEntry(
  aspect,
  renderId,
  status = ViewerDiffStatus.MODIFIED,
) {
  return {
    status,
    operationId: `operation:${renderId}`,
    aspect,
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

function diffSnapshot() {
  return {
    protocolVersion: "0.1.0",
    sessionId: "session:diff",
    sourceId: "source:diff",
    baseSnapshotId: "snapshot:base",
    baseRevisionId: "revision:base",
    committedRevisionId: "revision:target",
    revisionId: "revision:preview",
    sequence: 7,
    previewId: "preview:semantic",
    checkpointRecommended: true,
    affectedWorldBounds: {
      min: [0, 0, 0],
      max: [3, 3, 1],
    },
    invalidatedDependencyIds: [
      "type:wall",
      "block:shared-door",
    ],
    counts: {
      added: 1,
      removed: 1,
      modified: 2,
      unchanged: 99_996,
    },
    changedEntries: [
      changedEntry("geometry", "render:geometry"),
      changedEntry(
        ViewerSemanticDiffAspect.IDENTITY,
        "render:identity",
        ViewerDiffStatus.ADDED,
      ),
      changedEntry(
        ViewerSemanticDiffAspect.DEPENDENCY,
        "render:dependency",
      ),
      changedEntry(
        "entity",
        "render:removed",
        ViewerDiffStatus.REMOVED,
      ),
    ],
  };
}

function fixture(snapshot = diffSnapshot()) {
  const events = [];
  return {
    events,
    controller: new ViewerDiffSemanticController({
      host: {
        async handleEvent(event) {
          await Promise.resolve();
          events.push(event);
        },
        dispose() {},
      },
      renderDiffController: {
        snapshot() {
          return snapshot;
        },
      },
    }),
  };
}

test("publishes a revision-bound bounded non-visual diff hook", async () => {
  const value = fixture();
  const detail = await value.controller.open({
    reason: "semantic-panel.open",
  });

  assert.equal(value.events.length, 1);
  assert.equal(
    value.events[0].type,
    ViewerHostEventType.DIFF_OPEN,
  );
  assert.equal(value.events[0].detail, detail);
  assert.equal(detail.baseRevisionId, "revision:base");
  assert.equal(detail.revisionId, "revision:preview");
  assert.equal(detail.previewId, "preview:semantic");
  assert.equal(detail.deltaSequence, 7);
  assert.equal(detail.sequence, 1);
  assert.equal(detail.reason, "semantic-panel.open");
  assert.equal(detail.checkpointRecommended, true);
  assert.deepEqual(detail.invalidatedDependencyIds, [
    "block:shared-door",
    "type:wall",
  ]);
  assert.deepEqual(
    detail.nonVisualEntries.map(({ aspect, renderId }) => ({
      aspect,
      renderId,
    })),
    [
      {
        aspect: ViewerSemanticDiffAspect.IDENTITY,
        renderId: "render:identity",
      },
      {
        aspect: ViewerSemanticDiffAspect.DEPENDENCY,
        renderId: "render:dependency",
      },
    ],
  );
  assert.equal(
    detail.nonVisualEntries.some(
      ({ aspect }) => aspect === "geometry" || aspect === "entity",
    ),
    false,
  );
  assert.equal(detail.counts.unchanged, 99_996);
  assert.equal(Object.isFrozen(value.events[0]), true);
  assert.equal(Object.isFrozen(detail), true);
  assert.equal(Object.isFrozen(detail.nonVisualEntries), true);
  assert.equal(Object.isFrozen(detail.nonVisualEntries[0]), true);

  const next = await value.controller.open();
  assert.equal(next.sequence, 2);
  assert.equal(next.reason, "review");
});

test("rejects unbounded or asynchronous snapshots before notifying the host", async () => {
  const duplicateDependencies = diffSnapshot();
  duplicateDependencies.invalidatedDependencyIds = [
    "type:wall",
    "type:wall",
  ];
  const malformed = fixture(duplicateDependencies);
  await assert.rejects(
    malformed.controller.open(),
    /must be unique/u,
  );
  assert.deepEqual(malformed.events, []);

  const asynchronous = fixture();
  asynchronous.controller = new ViewerDiffSemanticController({
    host: {
      handleEvent(event) {
        asynchronous.events.push(event);
      },
      dispose() {},
    },
    renderDiffController: {
      async snapshot() {
        return diffSnapshot();
      },
    },
  });
  await assert.rejects(
    asynchronous.controller.open(),
    /must complete synchronously/u,
  );
  assert.deepEqual(asynchronous.events, []);
});

test("validates reasons and disposes without owning the host", async () => {
  let hostDisposed = false;
  const controller = new ViewerDiffSemanticController({
    host: {
      handleEvent() {},
      dispose() {
        hostDisposed = true;
      },
    },
    renderDiffController: {
      snapshot: diffSnapshot,
    },
  });

  await assert.rejects(
    controller.open({ reason: "\n" }),
    /reason is invalid/u,
  );
  assert.equal(controller.dispose(), true);
  assert.equal(controller.dispose(), false);
  assert.equal(hostDisposed, false);
  await assert.rejects(controller.open(), /disposed/u);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  ViewerSelectionController,
} from "../src/selection-controller.mjs";

const snapshot = Object.freeze({
  sessionId: "session:test",
  sourceId: "source:test",
  revisionId: "revision:test",
  snapshotId: "snapshot:test",
});

test("projects picks into revision-bound ViewerHost selection events", () => {
  const events = [];
  const host = {
    handleEvent(event) {
      events.push(event);
    },
    dispose() {},
  };
  const controller = new ViewerSelectionController({
    host,
    snapshot,
    projectSelection(candidate) {
      return {
        renderId: `render:${candidate.id}`,
        position: Object.freeze([...candidate.position]),
      };
    },
  });
  const candidate = {
    id: "42",
    position: [10, 20, 0],
  };

  const selected = controller.replace(candidate);
  controller.clear({ reason: "tool.clear" });
  controller.clear({ reason: "tool.clear" });

  assert.equal(selected.sequence, 1);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    type: "selection.changed",
    detail: {
      sessionId: "session:test",
      sourceId: "source:test",
      revisionId: "revision:test",
      snapshotId: "snapshot:test",
      sequence: 1,
      reason: "pick",
      selection: {
        renderId: "render:42",
        position: [10, 20, 0],
      },
    },
  });
  assert.equal(events[1].detail.sequence, 2);
  assert.equal(events[1].detail.reason, "tool.clear");
  assert.equal(events[1].detail.selection, null);
});

test("disposal prevents stale selection publication", () => {
  const controller = new ViewerSelectionController({
    host: {
      handleEvent() {},
      dispose() {},
    },
    snapshot,
  });

  assert.equal(controller.dispose(), true);
  assert.equal(controller.dispose(), false);
  assert.throws(
    () => controller.replace({ renderId: "late" }),
    /disposed/u,
  );
});

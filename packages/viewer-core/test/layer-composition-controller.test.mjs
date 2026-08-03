import assert from "node:assert/strict";
import test from "node:test";

import {
  RenderProtocolDiagnosticCode,
  ViewerLayerKind,
  ViewerRepresentation,
} from "@menaje/viewer-render-protocol";

import {
  ViewerLayerCompositionController,
  openRenderSource,
} from "../src/index.mjs";
import {
  MockServiceRenderSource,
} from "../src/testing.mjs";

function fixture() {
  const applied = [];
  let clears = 0;
  let failure = null;
  const adapter = {
    applyLayerComposition(value) {
      if (failure) {
        const error = failure;
        failure = null;
        throw error;
      }
      applied.push(value);
    },
    clearLayerComposition() {
      clears += 1;
    },
  };
  return {
    adapter,
    applied,
    get clears() {
      return clears;
    },
    failNext(error = new Error("composition rejected")) {
      failure = error;
    },
  };
}

test("composes ordered source-neutral base, live, diff, and diagnostic layers", async () => {
  const source = new MockServiceRenderSource();
  const sourceSession = await openRenderSource(source);
  const snapshot = await sourceSession.getSnapshot();
  const state = fixture();
  const controller = new ViewerLayerCompositionController({
    sourceSession,
    snapshot,
    adapter: state.adapter,
  });

  const initial = controller.synchronize();
  assert.equal(initial.active, true);
  assert.equal(initial.synchronized, true);
  assert.deepEqual(
    initial.presentation.layers.map(({ kind }) => kind),
    [
      ViewerLayerKind.BASE,
      ViewerLayerKind.LIVE,
      ViewerLayerKind.ADDED,
      ViewerLayerKind.MODIFIED,
      ViewerLayerKind.REMOVED,
      ViewerLayerKind.DIAGNOSTIC,
    ],
  );
  assert.deepEqual(
    [
      ...new Set(
        initial.presentation.layers.map(
          ({ representation }) => representation,
        ),
      ),
    ],
    [
      ViewerRepresentation.TWO_DIMENSIONAL,
      ViewerRepresentation.SEMANTIC,
    ],
  );

  const shownRemoved = controller.setLayerVisible(
    "layer:service-removed",
    true,
  );
  assert.equal(
    shownRemoved.presentation.layers.find(
      ({ layerId }) => layerId === "layer:service-removed",
    ).visible,
    true,
  );
  assert.equal(shownRemoved.presentation.sequence, 2);
  assert.equal(Object.isFrozen(shownRemoved.presentation.layers), true);

  assert.throws(
    () => controller.setLayerVisible("layer:missing", true),
    (error) =>
      error.code === RenderProtocolDiagnosticCode.SCOPE_MISMATCH,
  );

  assert.equal(controller.dispose(), true);
  assert.equal(controller.dispose(), false);
  assert.equal(state.clears, 1);
  await sourceSession.dispose();
});

test("restores the last good layer composition after an adapter failure", async () => {
  const source = new MockServiceRenderSource();
  const sourceSession = await openRenderSource(source);
  const snapshot = await sourceSession.getSnapshot();
  const state = fixture();
  const controller = new ViewerLayerCompositionController({
    sourceSession,
    snapshot,
    adapter: state.adapter,
  });
  const initial = controller.synchronize();
  state.failNext();

  assert.throws(
    () =>
      controller.setLayerVisible(
        "layer:service-diagnostic",
        false,
      ),
    /composition rejected/u,
  );
  const restored = controller.snapshot();
  assert.equal(restored.synchronized, true);
  assert.equal(
    restored.presentation,
    initial.presentation,
  );
  assert.equal(
    state.applied.at(-1),
    initial.presentation,
  );

  const next = controller.setLayerVisible(
    "layer:service-diagnostic",
    false,
  );
  assert.equal(next.presentation.sequence, 2);
  assert.equal(
    next.presentation.layers.find(
      ({ layerId }) => layerId === "layer:service-diagnostic",
    ).visible,
    false,
  );

  controller.dispose();
  await sourceSession.dispose();
});

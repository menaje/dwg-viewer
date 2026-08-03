import assert from "node:assert/strict";
import test from "node:test";

import {
  ViewerSplitViewCameraController,
  ViewerSplitViewSide,
} from "@dwg-viewer/viewer-core/split-view";

const initialCamera = Object.freeze({
  origin: Object.freeze([0, 0, 0]),
  worldHeight: 100,
});

function target(
  revisionId,
  { aspect = 1, onSetCamera = null } = {},
) {
  const state = {
    revisionId,
    camera: null,
    renderedCamera: null,
    calls: [],
  };
  return {
    state,
    adapter: {
      setCamera(camera, context) {
        state.camera = camera;
        state.renderedCamera = Object.freeze({
          ...camera,
          worldWidth: camera.worldHeight * aspect,
        });
        state.calls.push({ camera, context });
        return onSetCamera?.(camera, context, state);
      },
    },
  };
}

test("synchronizes one logical camera without sharing renderer state", () => {
  const before = target("revision:before", { aspect: 2 });
  const after = target("revision:after", { aspect: 1.25 });
  const controller = new ViewerSplitViewCameraController({
    camera: initialCamera,
    before: before.adapter,
    after: after.adapter,
  });

  assert.deepEqual(controller.snapshot(), {
    sequence: 0,
    camera: initialCamera,
    sourceSide: null,
    interactive: false,
    synchronized: false,
  });
  const synchronized = controller.synchronize();

  assert.equal(synchronized.synchronized, true);
  assert.equal(before.state.camera, after.state.camera);
  assert.deepEqual(before.state.camera, initialCamera);
  assert.equal(before.state.renderedCamera.worldWidth, 200);
  assert.equal(after.state.renderedCamera.worldWidth, 125);
  assert.equal(before.state.revisionId, "revision:before");
  assert.equal(after.state.revisionId, "revision:after");

  const sourceCamera = {
    origin: [25, 40, 0],
    worldHeight: 50,
    worldWidth: 80,
    zoom: 2,
  };
  before.state.camera = sourceCamera;
  const next = controller.setCameraFrom(
    ViewerSplitViewSide.BEFORE,
    sourceCamera,
    { interactive: true },
  );

  assert.deepEqual(next, {
    sequence: 1,
    camera: {
      origin: [25, 40, 0],
      worldHeight: 50,
    },
    sourceSide: ViewerSplitViewSide.BEFORE,
    interactive: true,
    synchronized: true,
  });
  assert.equal(before.state.calls.length, 1);
  assert.equal(after.state.calls.length, 2);
  assert.deepEqual(after.state.calls.at(-1).context, {
    side: ViewerSplitViewSide.AFTER,
    sourceSide: ViewerSplitViewSide.BEFORE,
    sequence: 1,
    interactive: true,
    phase: "apply",
  });
  assert.equal(before.state.revisionId, "revision:before");
  assert.equal(after.state.revisionId, "revision:after");

  const settled = controller.setCameraFrom(
    ViewerSplitViewSide.BEFORE,
    sourceCamera,
    { interactive: false },
  );
  assert.equal(settled.sequence, 2);
  assert.equal(settled.interactive, false);
  assert.equal(after.state.calls.length, 3);

  const programmatic = controller.setCamera({
    origin: [-10, 5, 0],
    worldHeight: 20,
  });
  assert.equal(programmatic.sequence, 3);
  assert.equal(programmatic.sourceSide, null);
  assert.equal(before.state.camera, after.state.camera);
  assert.equal(before.state.renderedCamera.worldWidth, 40);
  assert.equal(after.state.renderedCamera.worldWidth, 25);
});

test("suppresses a synchronous echo from the updated view", () => {
  const before = target("revision:before");
  let controller;
  const after = target("revision:after", {
    onSetCamera(camera) {
      controller.setCameraFrom(ViewerSplitViewSide.AFTER, camera);
    },
  });
  controller = new ViewerSplitViewCameraController({
    camera: initialCamera,
    before: before.adapter,
    after: after.adapter,
  });

  controller.synchronize();
  before.state.camera = {
    origin: [10, 20, 0],
    worldHeight: 25,
  };
  controller.setCameraFrom(ViewerSplitViewSide.BEFORE, {
    origin: [10, 20, 0],
    worldHeight: 25,
  });

  assert.equal(before.state.calls.length, 1);
  assert.equal(after.state.calls.length, 2);
  assert.equal(controller.snapshot().sequence, 1);
});

test("rolls both views back before allowing a failed sync to retry", () => {
  const before = target("revision:before");
  let rejectNextApply = true;
  const after = target("revision:after", {
    onSetCamera(_camera, context) {
      if (context.phase === "apply" && rejectNextApply) {
        rejectNextApply = false;
        throw new Error("after redraw failed");
      }
    },
  });
  const controller = new ViewerSplitViewCameraController({
    camera: initialCamera,
    before: before.adapter,
    after: after.adapter,
  });
  controller.synchronize();
  const nextCamera = {
    origin: [8, 12, 0],
    worldHeight: 40,
  };

  before.state.camera = nextCamera;
  assert.throws(
    () =>
      controller.setCameraFrom(
        ViewerSplitViewSide.BEFORE,
        nextCamera,
      ),
    /after redraw failed/u,
  );
  assert.deepEqual(before.state.camera, initialCamera);
  assert.deepEqual(after.state.camera, initialCamera);
  assert.deepEqual(controller.snapshot(), {
    sequence: 0,
    camera: initialCamera,
    sourceSide: null,
    interactive: false,
    synchronized: true,
  });

  before.state.camera = nextCamera;
  const retried = controller.setCameraFrom(
    ViewerSplitViewSide.BEFORE,
    nextCamera,
  );
  assert.equal(retried.sequence, 1);
  assert.deepEqual(before.state.camera, nextCamera);
  assert.deepEqual(after.state.camera, nextCamera);
});

test("marks incomplete rollback as desynchronized and can recover", () => {
  let rejectApply = true;
  let rejectRollback = true;
  const before = target("revision:before", {
    onSetCamera(_camera, context) {
      if (context.phase === "rollback" && rejectRollback) {
        rejectRollback = false;
        throw new Error("before rollback failed");
      }
    },
  });
  const after = target("revision:after", {
    onSetCamera(_camera, context) {
      if (context.phase === "apply" && rejectApply) {
        rejectApply = false;
        throw new Error("after redraw failed");
      }
    },
  });
  const controller = new ViewerSplitViewCameraController({
    camera: initialCamera,
    before: before.adapter,
    after: after.adapter,
  });
  controller.synchronize();

  assert.throws(
    () =>
      controller.setCameraFrom(ViewerSplitViewSide.BEFORE, {
        origin: [2, 3, 0],
        worldHeight: 30,
      }),
    AggregateError,
  );
  assert.equal(controller.snapshot().synchronized, false);

  const recovered = controller.synchronize();
  assert.equal(recovered.synchronized, true);
  assert.deepEqual(before.state.camera, initialCamera);
  assert.deepEqual(after.state.camera, initialCamera);
});

test("validates synchronous distinct targets and disposal", async () => {
  const shared = { setCamera() {} };
  assert.throws(
    () =>
      new ViewerSplitViewCameraController({
        camera: initialCamera,
        before: shared,
        after: shared,
      }),
    /must be distinct/u,
  );

  const controller = new ViewerSplitViewCameraController({
    camera: initialCamera,
    before: shared,
    after: {
      async setCamera() {},
    },
  });
  assert.throws(
    () => controller.synchronize(),
    /must complete synchronously/u,
  );
  assert.equal(controller.dispose(), true);
  assert.equal(controller.dispose(), false);
  assert.throws(() => controller.snapshot(), /disposed/u);
});

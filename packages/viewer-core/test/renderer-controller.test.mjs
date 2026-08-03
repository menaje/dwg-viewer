import assert from "node:assert/strict";
import test from "node:test";

import {
  ViewerRendererController,
  assertViewerRenderer,
} from "../src/renderer-controller.mjs";

const camera = Object.freeze({
  origin: Object.freeze([0, 0, 0]),
  worldHeight: 100,
});

function makeRenderer() {
  const calls = [];
  const renderer = {
    redraw(value, options) {
      calls.push(["redraw", value, options]);
      return { camera: value };
    },
    cameraForView(value) {
      calls.push(["cameraForView", value]);
      return value;
    },
    fitAllCamera() {
      calls.push(["fitAllCamera"]);
      return camera;
    },
    addDetailBatch(batch) {
      calls.push(["add", batch.id]);
      return { id: batch.id };
    },
    deleteDetailBatch(id) {
      calls.push(["delete", id]);
      return true;
    },
    setDetailSelections(candidates) {
      calls.push(["select", candidates.map((value) => value.id)]);
    },
    addExternalDetailBatch(sourceId, batch) {
      calls.push(["external-add", sourceId, batch.id]);
      return { id: batch.id };
    },
    deleteExternalDetailBatch(sourceId, id) {
      calls.push(["external-delete", sourceId, id]);
      return true;
    },
    setExternalDetailSelections(sourceId, candidates) {
      calls.push([
        "external-select",
        sourceId,
        candidates.map((value) => value.id),
      ]);
    },
  };
  return { renderer, calls };
}

test("validates and coordinates root and external renderer detail targets", () => {
  const { renderer, calls } = makeRenderer();
  assert.equal(assertViewerRenderer(renderer), renderer);
  const controller = new ViewerRendererController(renderer);
  const root = controller.createDetailTarget();
  const external = controller.createDetailTarget("xref:one");

  root.addDetailBatch({ id: 1 }, { byteLength: 32 });
  root.setDetailSelections([{ id: 1 }]);
  external.addDetailBatch({ id: 2 }, { byteLength: 32 });
  external.setDetailSelections([{ id: 2 }]);
  assert.deepEqual(controller.redraw(camera), { camera });
  assert.equal(controller.cameraForView(camera), camera);
  assert.equal(controller.fitAllCamera(), camera);

  root.deleteDetailBatch(1);
  controller.dispose();
  controller.dispose();

  assert.deepEqual(
    calls.filter(([name]) => name === "delete"),
    [["delete", 1]],
  );
  assert.deepEqual(
    calls.filter(([name]) => name === "external-delete"),
    [["external-delete", "xref:one", 2]],
  );
  assert.throws(
    () => controller.redraw(camera),
    /disposed/u,
  );
});

test("fails closed when a renderer omits a lifecycle method", () => {
  assert.throws(
    () =>
      assertViewerRenderer({
        redraw() {},
        cameraForView() {},
        addDetailBatch() {},
        deleteDetailBatch() {},
      }),
    /setDetailSelections/u,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  DetailStreamingController,
} from "../src/detail-streaming-controller.mjs";

const camera = Object.freeze({
  origin: Object.freeze([0, 0, 0]),
  worldHeight: 100,
});

test("streams adapter-selected detail with bounded cache lifecycle", async () => {
  const mounted = [];
  const unmounted = [];
  const selections = [];
  const candidate = Object.freeze({
    id: "detail:one",
    byteLength: 32,
    selectedInstanceCount: 2,
  });
  const selected = [candidate];
  Object.defineProperty(selected, "byteLength", {
    value: 32,
  });
  Object.freeze(selected);
  const controller = new DetailStreamingController(
    {
      selectCandidates() {
        return selected;
      },
      async loadCandidate(value) {
        return {
          id: value.id,
          byteLength: value.byteLength,
        };
      },
      mountCandidate(value) {
        mounted.push(value.id);
        return { id: value.id };
      },
      unmountCandidate(value) {
        unmounted.push(value.id);
      },
      setSelection(value) {
        selections.push(value.map((entry) => entry.id));
      },
      redraw(value) {
        return { camera: value };
      },
    },
    { concurrency: 1 },
  );

  controller.update(camera);
  const snapshot = await controller.whenIdle();

  assert.deepEqual(mounted, ["detail:one"]);
  assert.deepEqual(selections, [["detail:one"]]);
  assert.equal(snapshot.selectedBytes, 32);
  assert.equal(snapshot.selectedInstances, 2);
  assert.equal(snapshot.cache.entries, 1);

  assert.equal(controller.dispose(), true);
  assert.equal(controller.dispose(), false);
  assert.deepEqual(unmounted, ["detail:one"]);
  assert.deepEqual(selections.at(-1), []);
});

test("rejects duplicate candidate identities before loading bytes", () => {
  let loads = 0;
  const candidate = Object.freeze({ id: 7, byteLength: 8 });
  const controller = new DetailStreamingController({
    selectCandidates() {
      return [candidate, candidate];
    },
    loadCandidate() {
      loads += 1;
      return { byteLength: 8 };
    },
    mountCandidate() {},
    unmountCandidate() {},
    setSelection() {},
    redraw(value) {
      return { camera: value };
    },
  });

  assert.throws(
    () => controller.update(camera),
    /duplicated/u,
  );
  assert.equal(loads, 0);
  controller.dispose();
});

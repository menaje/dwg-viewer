import assert from "node:assert/strict";
import test from "node:test";

import {
  CameraController2D,
  cameraViewportBounds,
} from "../src/camera.mjs";

test("pans in drawing coordinates and resets to the fitted view", () => {
  const camera = new CameraController2D({
    origin: [100, 200, 0],
    worldHeight: 100,
  });

  camera.panByPixels(20, -10, 200, 100);
  assert.deepEqual(camera.origin, [80, 190, 0]);
  assert.equal(camera.zoom, 1);

  camera.reset();
  assert.deepEqual(camera.origin, [100, 200, 0]);
  assert.equal(camera.worldHeight, 100);
});

test("keeps the world point below the cursor fixed while zooming", () => {
  const camera = new CameraController2D({
    origin: [0, 0, 0],
    worldHeight: 100,
  });

  camera.zoomAt(0.5, 150, 25, 200, 100);
  assert.equal(camera.worldHeight, 50);
  assert.equal(camera.zoom, 2);
  assert.deepEqual(camera.origin, [25, 12.5, 0]);
});

test("derives a world-space viewport from a rendered camera", () => {
  const bounds = cameraViewportBounds({
    origin: [10, 20, 0],
    worldWidth: 200,
    worldHeight: 100,
  });

  assert.deepEqual(bounds.min, [-90, -30, -Infinity]);
  assert.deepEqual(bounds.max, [110, 70, Infinity]);
});

test("focuses the camera on a drawing point with a bounded world height", () => {
  const camera = new CameraController2D({
    origin: [0, 0, 0],
    worldHeight: 100,
  });

  camera.focus([25, 40, 3], 10);

  assert.deepEqual(camera.origin, [25, 40, 3]);
  assert.equal(camera.worldHeight, 10);
  assert.equal(camera.zoom, 10);
});

test("fits a dragged screen rectangle while preserving the viewport aspect", () => {
  const camera = new CameraController2D({
    origin: [0, 0, 0],
    worldHeight: 100,
  });

  assert.deepEqual(
    camera.focusScreenRect(500, 125, 750, 375, 1_000, 500, {
      padding: 1,
    }),
    {
      origin: [25, 0, 0],
      worldHeight: 50,
      zoom: 2,
    },
  );
  assert.equal(
    camera.focusScreenRect(10, 10, 14, 14, 1_000, 500),
    null,
  );
});

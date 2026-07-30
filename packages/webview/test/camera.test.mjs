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

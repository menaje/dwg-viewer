import assert from "node:assert/strict";
import test from "node:test";

import {
  CameraController2D as CoreCameraController2D,
  cameraViewportBounds as coreCameraViewportBounds,
} from "@menaje/viewer-core/camera";
import {
  GpuBatchCache as CoreGpuBatchCache,
} from "@menaje/viewer-core/batch-cache";
import {
  ViewportInteraction as CoreViewportInteraction,
} from "@menaje/viewer-core/interaction";
import {
  DetailStreamingController,
} from "@menaje/viewer-core/detail-streaming";
import {
  ViewerRendererController,
} from "@menaje/viewer-core/renderer";
import {
  ViewerSelectionController,
} from "@menaje/viewer-core/selection";

import { GpuBatchCache } from "../src/batch-cache.mjs";
import {
  CameraController2D,
  cameraViewportBounds,
} from "../src/camera.mjs";
import { DetailStreamer } from "../src/detail-streamer.mjs";
import { ViewportInteraction } from "../src/interaction.mjs";

test("keeps legacy Webview core-module paths on Viewer Core", () => {
  assert.equal(CameraController2D, CoreCameraController2D);
  assert.equal(cameraViewportBounds, coreCameraViewportBounds);
  assert.equal(GpuBatchCache, CoreGpuBatchCache);
  assert.equal(
    CoreViewportInteraction.prototype.isPrototypeOf(
      ViewportInteraction.prototype,
    ),
    true,
  );
  assert.equal(
    DetailStreamingController.prototype.isPrototypeOf(
      DetailStreamer.prototype,
    ),
    true,
  );
  assert.equal(typeof ViewerRendererController, "function");
  assert.equal(typeof ViewerSelectionController, "function");
});

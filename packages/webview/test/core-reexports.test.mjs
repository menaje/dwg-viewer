import assert from "node:assert/strict";
import test from "node:test";

import {
  CameraController2D as CoreCameraController2D,
  cameraViewportBounds as coreCameraViewportBounds,
} from "@dwg-viewer/viewer-core/camera";
import {
  GpuBatchCache as CoreGpuBatchCache,
} from "@dwg-viewer/viewer-core/batch-cache";
import {
  ViewportInteraction as CoreViewportInteraction,
} from "@dwg-viewer/viewer-core/interaction";
import {
  DetailStreamingController,
} from "@dwg-viewer/viewer-core/detail-streaming";
import {
  ViewerRendererController,
} from "@dwg-viewer/viewer-core/renderer";
import {
  ViewerSelectionController,
} from "@dwg-viewer/viewer-core/selection";

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

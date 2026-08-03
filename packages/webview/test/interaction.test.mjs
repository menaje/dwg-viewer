import assert from "node:assert/strict";
import test from "node:test";

import {
  DETAIL_DEBOUNCE_MS,
  DETAIL_ZOOM_THRESHOLD,
  VIEW_COMMIT_DEBOUNCE_MS,
  ViewportInteraction,
} from "../src/interaction.mjs";
import { DEFAULT_MINIMUM_PIXEL_HEIGHT } from "../src/text-overlay.mjs";

test("streams bounded detail while zooming out and retains legible text", () => {
  assert.equal(DETAIL_ZOOM_THRESHOLD, 0);
  assert.equal(DETAIL_DEBOUNCE_MS, 650);
  assert.equal(VIEW_COMMIT_DEBOUNCE_MS, 220);
  assert.equal(DEFAULT_MINIMUM_PIXEL_HEIGHT, 0.5);
});

test("injects the DWG detail streamer into the Core interaction lifecycle", () => {
  const OriginalResizeObserver = globalThis.ResizeObserver;
  let observed = false;
  let disconnected = false;
  globalThis.ResizeObserver = class {
    observe() {
      observed = true;
    }

    disconnect() {
      disconnected = true;
    }
  };
  const canvas = {
    clientWidth: 800,
    clientHeight: 600,
    addEventListener() {},
    classList: {
      add() {},
      remove() {},
    },
  };
  const renderer = {
    addDetailBatch() {},
    cameraForView(camera) {
      return camera;
    },
    deleteDetailBatch() {},
    redraw(camera) {
      return { camera };
    },
    setDetailSelections() {},
  };
  try {
    const interaction = new ViewportInteraction(
      {
        reader: {
          async readBatchVertices() {
            return { byteLength: 0 };
          },
        },
        renderer,
        metadata: { batches: [] },
        instanceGraph: {},
        render: {
          camera: {
            origin: [0, 0, 0],
            worldHeight: 100,
          },
        },
      },
      canvas,
      {
        keyboardTarget: {
          addEventListener() {},
        },
      },
    );
    assert.equal(observed, true);
    assert.equal(interaction.snapshot().zoom, 1);
    interaction.dispose();
    assert.equal(disconnected, true);
  } finally {
    globalThis.ResizeObserver = OriginalResizeObserver;
  }
});

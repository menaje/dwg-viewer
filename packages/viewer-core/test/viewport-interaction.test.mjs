import assert from "node:assert/strict";
import test from "node:test";

import {
  DETAIL_DEBOUNCE_MS,
  DETAIL_ZOOM_THRESHOLD,
  VIEW_COMMIT_DEBOUNCE_MS,
  ViewportInteraction,
} from "../src/viewport-interaction.mjs";

test("keeps interaction timing policy in Viewer Core", () => {
  assert.equal(DETAIL_ZOOM_THRESHOLD, 0);
  assert.equal(DETAIL_DEBOUNCE_MS, 650);
  assert.equal(VIEW_COMMIT_DEBOUNCE_MS, 220);
});

test("requires product detail streaming through an injected factory", () => {
  assert.throws(
    () =>
      new ViewportInteraction(
        {
          render: {
            camera: {
              origin: [0, 0, 0],
              worldHeight: 100,
            },
          },
        },
        {},
      ),
    /detail streamer factory/u,
  );
});

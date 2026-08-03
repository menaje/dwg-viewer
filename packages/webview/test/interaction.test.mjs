import assert from "node:assert/strict";
import test from "node:test";

import {
  DETAIL_DEBOUNCE_MS,
  DETAIL_ZOOM_THRESHOLD,
  VIEW_COMMIT_DEBOUNCE_MS,
} from "../src/interaction.mjs";
import { DEFAULT_MINIMUM_PIXEL_HEIGHT } from "../src/text-overlay.mjs";

test("streams bounded detail while zooming out and retains legible text", () => {
  assert.equal(DETAIL_ZOOM_THRESHOLD, 0);
  assert.equal(DETAIL_DEBOUNCE_MS, 650);
  assert.equal(VIEW_COMMIT_DEBOUNCE_MS, 220);
  assert.equal(DEFAULT_MINIMUM_PIXEL_HEIGHT, 0.5);
});

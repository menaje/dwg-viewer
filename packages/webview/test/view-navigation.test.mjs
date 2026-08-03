import assert from "node:assert/strict";
import test from "node:test";

import {
  addViewBookmark,
  CameraViewHistory,
  cameraViewsEqual,
  normalizeViewBookmarks,
  removeViewBookmark,
  renameViewBookmark,
} from "../src/view-navigation.mjs";

function view(x, y, worldHeight) {
  return {
    origin: [x, y, 0],
    worldHeight,
  };
}

test("camera history commits logical views and truncates the forward branch", () => {
  const history = new CameraViewHistory(view(0, 0, 100), {
    maximumEntries: 4,
  });
  assert.equal(history.commit(view(0, 0, 100)), false);
  assert.equal(history.commit(view(10, 0, 50)), true);
  assert.equal(history.commit(view(20, 5, 25)), true);
  assert.deepEqual(history.back(), view(10, 0, 50));
  assert.equal(history.canForward, true);
  assert.equal(history.commit(view(-10, 4, 40)), true);
  assert.equal(history.canForward, false);
  assert.deepEqual(history.back(), view(10, 0, 50));
  assert.deepEqual(history.forward(), view(-10, 4, 40));
});

test("camera history is bounded and can replace an automatic fit update", () => {
  const history = new CameraViewHistory(view(0, 0, 100), {
    maximumEntries: 3,
  });
  history.commit(view(1, 0, 80));
  history.commit(view(2, 0, 60));
  history.commit(view(3, 0, 40));
  assert.deepEqual(history.back(), view(2, 0, 60));
  assert.equal(history.canBack, true);
  assert.equal(history.replace(view(2, 1, 55)), true);
  assert.deepEqual(history.current(), view(2, 1, 55));
  assert.deepEqual(history.back(), view(1, 0, 80));
});

test("camera comparison tolerates insignificant floating point drift", () => {
  assert.equal(
    cameraViewsEqual(
      view(1_000_000, -2_000_000, 500),
      view(1_000_000 + 1e-7, -2_000_000, 500 + 1e-8),
    ),
    true,
  );
  assert.equal(cameraViewsEqual(view(0, 0, 100), view(1, 0, 100)), false);
});

test("bookmarks preserve arbitrary scope names and reject malformed state", () => {
  const bookmarks = normalizeViewBookmarks([
    {
      id: "a",
      scope: "도면-임의 이름::배치 A-01",
      name: "  창호   상세  ",
      view: view(12, 34, 56),
      createdAt: 10,
    },
    {
      id: "bad",
      scope: "scope",
      name: "",
      view: view(0, 0, 10),
      createdAt: 20,
    },
    {
      id: "a",
      scope: "duplicate",
      name: "중복",
      view: view(0, 0, 10),
      createdAt: 30,
    },
  ]);
  assert.deepEqual(bookmarks, [
    {
      id: "a",
      scope: "도면-임의 이름::배치 A-01",
      name: "창호 상세",
      view: view(12, 34, 56),
      createdAt: 10,
    },
  ]);
});

test("adds, renames, and removes one scoped view bookmark immutably", () => {
  const original = Object.freeze([]);
  const added = addViewBookmark(original, {
    id: "bookmark-1",
    scope: "cache-any::model",
    name: "입구 확대",
    view: view(5, 6, 7),
    createdAt: 123,
  });
  const renamed = renameViewBookmark(added, "bookmark-1", "  주 출입구  ");
  const removed = removeViewBookmark(renamed, "bookmark-1");

  assert.equal(original.length, 0);
  assert.equal(added[0].name, "입구 확대");
  assert.equal(renamed[0].name, "주 출입구");
  assert.deepEqual(removed, []);
});

const DEFAULT_MAXIMUM_HISTORY = 100;
const DEFAULT_MAXIMUM_BOOKMARKS = 200;
const MAXIMUM_BOOKMARKS_PER_SCOPE = 50;
const MAXIMUM_BOOKMARK_NAME_LENGTH = 64;
const MAXIMUM_BOOKMARK_SCOPE_LENGTH = 256;

function finiteOrigin(value) {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    !Number.isFinite(value[0]) ||
    !Number.isFinite(value[1])
  ) {
    return null;
  }
  return Object.freeze([
    value[0],
    value[1],
    Number.isFinite(value[2]) ? value[2] : 0,
  ]);
}

export function normalizeCameraView(value) {
  const origin = finiteOrigin(value?.origin);
  if (
    !origin ||
    !Number.isFinite(value?.worldHeight) ||
    value.worldHeight <= 0
  ) {
    return null;
  }
  return Object.freeze({
    origin,
    worldHeight: value.worldHeight,
  });
}

export function cameraViewsEqual(left, right) {
  const a = normalizeCameraView(left);
  const b = normalizeCameraView(right);
  if (!a || !b) {
    return false;
  }
  const scale = Math.max(a.worldHeight, b.worldHeight, 1);
  const tolerance = scale * 1e-9;
  return (
    Math.abs(a.worldHeight - b.worldHeight) <= tolerance &&
    a.origin.every(
      (coordinate, axis) =>
        Math.abs(coordinate - b.origin[axis]) <= tolerance,
    )
  );
}

export class CameraViewHistory {
  constructor(initialView, { maximumEntries = DEFAULT_MAXIMUM_HISTORY } = {}) {
    if (
      !Number.isSafeInteger(maximumEntries) ||
      maximumEntries < 2 ||
      maximumEntries > 1_000
    ) {
      throw new RangeError("camera history maximum is invalid");
    }
    const initial = normalizeCameraView(initialView);
    if (!initial) {
      throw new TypeError("camera history requires a valid initial view");
    }
    this.maximumEntries = maximumEntries;
    this.entries = [initial];
    this.cursor = 0;
  }

  get canBack() {
    return this.cursor > 0;
  }

  get canForward() {
    return this.cursor + 1 < this.entries.length;
  }

  current() {
    return this.entries[this.cursor];
  }

  commit(value) {
    const view = normalizeCameraView(value);
    if (!view) {
      throw new TypeError("cannot commit an invalid camera view");
    }
    if (cameraViewsEqual(this.current(), view)) {
      return false;
    }
    this.entries.splice(this.cursor + 1, Infinity, view);
    if (this.entries.length > this.maximumEntries) {
      this.entries.splice(0, this.entries.length - this.maximumEntries);
    }
    this.cursor = this.entries.length - 1;
    return true;
  }

  replace(value) {
    const view = normalizeCameraView(value);
    if (!view) {
      throw new TypeError("cannot replace with an invalid camera view");
    }
    if (cameraViewsEqual(this.current(), view)) {
      return false;
    }
    this.entries[this.cursor] = view;
    return true;
  }

  back() {
    if (!this.canBack) {
      return null;
    }
    this.cursor -= 1;
    return this.current();
  }

  forward() {
    if (!this.canForward) {
      return null;
    }
    this.cursor += 1;
    return this.current();
  }
}

function normalizeBookmarkName(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/gu, " ")
    .slice(0, MAXIMUM_BOOKMARK_NAME_LENGTH);
}

function normalizeBookmarkScope(value) {
  const scope = String(value ?? "").trim();
  return scope.length > 0 && scope.length <= MAXIMUM_BOOKMARK_SCOPE_LENGTH
    ? scope
    : "";
}

function normalizeBookmark(value) {
  const id = String(value?.id ?? "").slice(0, 128);
  const scope = normalizeBookmarkScope(value?.scope);
  const name = normalizeBookmarkName(value?.name);
  const view = normalizeCameraView(value?.view);
  const createdAt = Number(value?.createdAt);
  if (
    !id ||
    !scope ||
    !name ||
    !view ||
    !Number.isFinite(createdAt) ||
    createdAt < 0
  ) {
    return null;
  }
  return Object.freeze({
    id,
    scope,
    name,
    view,
    createdAt,
  });
}

export function normalizeViewBookmarks(
  value,
  { maximumBookmarks = DEFAULT_MAXIMUM_BOOKMARKS } = {},
) {
  if (
    !Number.isSafeInteger(maximumBookmarks) ||
    maximumBookmarks < 1 ||
    maximumBookmarks > 1_000
  ) {
    throw new RangeError("view bookmark maximum is invalid");
  }
  if (!Array.isArray(value)) {
    return Object.freeze([]);
  }
  const normalized = [];
  const ids = new Set();
  const scopeCounts = new Map();
  for (const candidate of value) {
    const bookmark = normalizeBookmark(candidate);
    if (!bookmark || ids.has(bookmark.id)) {
      continue;
    }
    const scopeCount = scopeCounts.get(bookmark.scope) ?? 0;
    if (scopeCount >= MAXIMUM_BOOKMARKS_PER_SCOPE) {
      continue;
    }
    ids.add(bookmark.id);
    scopeCounts.set(bookmark.scope, scopeCount + 1);
    normalized.push(bookmark);
    if (normalized.length >= maximumBookmarks) {
      break;
    }
  }
  return Object.freeze(normalized);
}

export function addViewBookmark(
  bookmarks,
  { id, scope, name, view, createdAt = Date.now() },
) {
  const current = normalizeViewBookmarks(bookmarks);
  const normalizedScope = normalizeBookmarkScope(scope);
  const inScope = current.filter(
    (bookmark) => bookmark.scope === normalizedScope,
  ).length;
  if (inScope >= MAXIMUM_BOOKMARKS_PER_SCOPE) {
    throw new RangeError("view bookmark scope is full");
  }
  const bookmark = normalizeBookmark({
    id,
    scope: normalizedScope,
    name,
    view,
    createdAt,
  });
  if (!bookmark) {
    throw new TypeError("view bookmark is invalid");
  }
  return normalizeViewBookmarks([
    bookmark,
    ...current.filter((candidate) => candidate.id !== bookmark.id),
  ]);
}

export function renameViewBookmark(bookmarks, id, name) {
  const normalizedName = normalizeBookmarkName(name);
  if (!normalizedName) {
    throw new TypeError("view bookmark name is empty");
  }
  let changed = false;
  const next = normalizeViewBookmarks(bookmarks).map((bookmark) => {
    if (bookmark.id !== id || bookmark.name === normalizedName) {
      return bookmark;
    }
    changed = true;
    return Object.freeze({
      ...bookmark,
      name: normalizedName,
    });
  });
  return Object.freeze(changed ? next : [...next]);
}

export function removeViewBookmark(bookmarks, id) {
  return Object.freeze(
    normalizeViewBookmarks(bookmarks).filter(
      (bookmark) => bookmark.id !== id,
    ),
  );
}

export {
  DEFAULT_MAXIMUM_BOOKMARKS,
  DEFAULT_MAXIMUM_HISTORY,
  MAXIMUM_BOOKMARKS_PER_SCOPE,
  MAXIMUM_BOOKMARK_NAME_LENGTH,
};

import { GpuLineBatchKind } from "./scene-cache.mjs";

const DWG_RENDER_DEPENDENCY_PREFIX = "dwg-dependency";
const MAX_DEPENDENCY_IDS = 65_536;
const MAX_DEPENDENCY_ID_LENGTH = 1_024;
const MAX_SCENE_ID_LENGTH = 512;
const MAX_TYPE_KIND_LENGTH = 64;
const TYPE_KIND_PATTERN = /^[a-z][a-z0-9-]*$/u;

export const DwgRenderDependencyKind = Object.freeze({
  BLOCK: "block",
  TYPE: "type",
});

function normalizeText(value, label, maximumLength) {
  const normalized = String(value ?? "");
  if (
    normalized.length === 0 ||
    normalized.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return normalized;
}

function normalizeHandle(value, label) {
  let handle;
  try {
    handle =
      typeof value === "bigint"
        ? value
        : BigInt(
            typeof value === "string"
              ? `0x${value.replace(/^0x/iu, "")}`
              : value,
          );
  } catch {
    throw new TypeError(`${label} is invalid`);
  }
  if (handle < 0n || handle > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`${label} exceeds u64`);
  }
  return handle;
}

function encodeComponent(value, label, maximumLength) {
  return encodeURIComponent(
    normalizeText(value, label, maximumLength),
  );
}

function dependencyId(parts) {
  const value = [DWG_RENDER_DEPENDENCY_PREFIX, ...parts].join(":");
  if (value.length > MAX_DEPENDENCY_ID_LENGTH) {
    throw new RangeError("DWG render dependency ID is too long");
  }
  return value;
}

export function dwgBlockRenderDependencyId(sceneId, blockHandle) {
  return dependencyId([
    DwgRenderDependencyKind.BLOCK,
    encodeComponent(
      sceneId,
      "DWG render dependency scene ID",
      MAX_SCENE_ID_LENGTH,
    ),
    normalizeHandle(
      blockHandle,
      "DWG render dependency block handle",
    ).toString(16),
  ]);
}

export function dwgTypeRenderDependencyId(
  sceneId,
  typeKind,
  typeHandle,
) {
  const normalizedKind = normalizeText(
    typeKind,
    "DWG render dependency type kind",
    MAX_TYPE_KIND_LENGTH,
  );
  if (!TYPE_KIND_PATTERN.test(normalizedKind)) {
    throw new TypeError(
      "DWG render dependency type kind is invalid",
    );
  }
  return dependencyId([
    DwgRenderDependencyKind.TYPE,
    encodeComponent(
      sceneId,
      "DWG render dependency scene ID",
      MAX_SCENE_ID_LENGTH,
    ),
    normalizedKind,
    normalizeHandle(
      typeHandle,
      "DWG render dependency type handle",
    ).toString(16),
  ]);
}

function decodeComponent(value, label, maximumLength) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new TypeError(`${label} is invalid`);
  }
  return normalizeText(decoded, label, maximumLength);
}

export function parseDwgRenderDependencyId(value) {
  if (typeof value !== "string") {
    throw new TypeError("DWG render dependency ID must be a string");
  }
  if (!value.startsWith(`${DWG_RENDER_DEPENDENCY_PREFIX}:`)) {
    return null;
  }
  if (
    value.length === 0 ||
    value.length > MAX_DEPENDENCY_ID_LENGTH
  ) {
    throw new TypeError("DWG render dependency ID is invalid");
  }
  const parts = value.split(":");
  if (
    parts[0] !== DWG_RENDER_DEPENDENCY_PREFIX ||
    (parts[1] !== DwgRenderDependencyKind.BLOCK &&
      parts[1] !== DwgRenderDependencyKind.TYPE)
  ) {
    throw new TypeError("DWG render dependency ID is invalid");
  }
  const sceneId = decodeComponent(
    parts[2],
    "DWG render dependency scene ID",
    MAX_SCENE_ID_LENGTH,
  );
  if (
    parts[1] === DwgRenderDependencyKind.BLOCK &&
    parts.length === 4
  ) {
    const blockHandle = normalizeHandle(
      parts[3],
      "DWG render dependency block handle",
    );
    const canonical = dwgBlockRenderDependencyId(
      sceneId,
      blockHandle,
    );
    if (canonical !== value) {
      throw new TypeError(
        "DWG render dependency ID is not canonical",
      );
    }
    return Object.freeze({
      dependencyId: value,
      kind: DwgRenderDependencyKind.BLOCK,
      sceneId,
      blockHandle,
    });
  }
  if (
    parts[1] === DwgRenderDependencyKind.TYPE &&
    parts.length === 5
  ) {
    const typeKind = normalizeText(
      parts[3],
      "DWG render dependency type kind",
      MAX_TYPE_KIND_LENGTH,
    );
    if (!TYPE_KIND_PATTERN.test(typeKind)) {
      throw new TypeError(
        "DWG render dependency type kind is invalid",
      );
    }
    const typeHandle = normalizeHandle(
      parts[4],
      "DWG render dependency type handle",
    );
    const canonical = dwgTypeRenderDependencyId(
      sceneId,
      typeKind,
      typeHandle,
    );
    if (canonical !== value) {
      throw new TypeError(
        "DWG render dependency ID is not canonical",
      );
    }
    return Object.freeze({
      dependencyId: value,
      kind: DwgRenderDependencyKind.TYPE,
      sceneId,
      typeKind,
      typeHandle,
    });
  }
  throw new TypeError("DWG render dependency ID is invalid");
}

function normalizedScenes(value) {
  if (!(value instanceof Map)) {
    throw new TypeError(
      "DWG render dependency scenes must be a map",
    );
  }
  return value;
}

function normalizedScene(sceneId, scene, { indexBlocks = false } = {}) {
  const normalizedSceneId = normalizeText(
    sceneId,
    "DWG render dependency scene ID",
    MAX_SCENE_ID_LENGTH,
  );
  if (
    !scene ||
    !Array.isArray(scene.blocks) ||
    !(scene.instanceGraph?.instancesByBlock instanceof Map)
  ) {
    throw new TypeError(
      `DWG render dependency scene ${normalizedSceneId} is invalid`,
    );
  }
  if (!indexBlocks) {
    return scene;
  }
  const blockIndexByHandle = new Map();
  for (const block of scene.blocks) {
    if (
      !Number.isSafeInteger(block?.index) ||
      block.index < 0 ||
      typeof block.handle !== "bigint" ||
      block.handle < 0n ||
      block.handle > 0xffff_ffff_ffff_ffffn ||
      blockIndexByHandle.has(block.handle)
    ) {
      throw new TypeError(
        `DWG render dependency scene ${normalizedSceneId} has invalid blocks`,
      );
    }
    blockIndexByHandle.set(block.handle, block.index);
  }
  return {
    blocks: scene.blocks,
    instanceGraph: scene.instanceGraph,
    blockIndexByHandle,
  };
}

export function indexDwgRenderDeltaDependencies(
  dependencyIds,
  {
    scenes = new Map(),
    ignoreUnavailableScenes = false,
  } = {},
) {
  if (
    !Array.isArray(dependencyIds) ||
    dependencyIds.length > MAX_DEPENDENCY_IDS
  ) {
    throw new TypeError(
      "DWG render dependency IDs must be a bounded array",
    );
  }
  const normalizedSceneMap = normalizedScenes(scenes);
  const resolvedScenes = new Map();
  const ids = new Set();
  const byScene = new Map();
  let recognizedCount = 0;
  for (const dependencyId of dependencyIds) {
    if (
      typeof dependencyId !== "string" ||
      dependencyId.length === 0 ||
      dependencyId.length > MAX_DEPENDENCY_ID_LENGTH
    ) {
      throw new TypeError("DWG render dependency ID is invalid");
    }
    if (ids.has(dependencyId)) {
      continue;
    }
    ids.add(dependencyId);
    const parsed = parseDwgRenderDependencyId(dependencyId);
    if (!parsed) {
      continue;
    }
    const rawScene = normalizedSceneMap.get(parsed.sceneId);
    if (!rawScene) {
      if (ignoreUnavailableScenes) {
        continue;
      }
      throw new TypeError(
        `DWG render dependency scene ${parsed.sceneId} is unavailable`,
      );
    }
    const sceneKey = `${parsed.sceneId}\u0000${
      parsed.kind === DwgRenderDependencyKind.BLOCK
        ? "blocks"
        : "scene"
    }`;
    let scene = resolvedScenes.get(sceneKey);
    if (!scene) {
      scene = normalizedScene(parsed.sceneId, rawScene, {
        indexBlocks:
          parsed.kind === DwgRenderDependencyKind.BLOCK,
      });
      resolvedScenes.set(sceneKey, scene);
    }
    let target = byScene.get(parsed.sceneId);
    if (!target) {
      target = {
        blockHandles: new Set(),
        blockIndices: new Set(),
        typeKeys: new Set(),
      };
      byScene.set(parsed.sceneId, target);
    }
    if (parsed.kind === DwgRenderDependencyKind.BLOCK) {
      const blockIndex = scene.blockIndexByHandle.get(
        parsed.blockHandle,
      );
      if (blockIndex === undefined) {
        throw new TypeError(
          `DWG render dependency block ${parsed.blockHandle.toString(16)} is unavailable`,
        );
      }
      target.blockHandles.add(parsed.blockHandle);
      target.blockIndices.add(blockIndex);
    } else {
      target.typeKeys.add(
        `${parsed.typeKind}\u0000${parsed.typeHandle}`,
      );
    }
    recognizedCount += 1;
  }
  return Object.freeze({
    ids: Object.freeze([...ids].sort()),
    byScene,
    recognizedCount,
  });
}

export function isDwgRenderDeltaSceneInvalidated(index, sceneId) {
  return (index?.byScene?.get(sceneId)?.typeKeys.size ?? 0) > 0;
}

export function isDwgRenderDeltaBlockInvalidated(
  index,
  sceneId,
  blockIndex,
) {
  const scene = index?.byScene?.get(sceneId);
  return (
    Boolean(scene) &&
    (scene.typeKeys.size > 0 ||
      scene.blockIndices.has(blockIndex))
  );
}

function setsIntersect(left, right) {
  if (!(right instanceof Set) || left.size === 0 || right.size === 0) {
    return false;
  }
  const [smaller, larger] =
    left.size <= right.size ? [left, right] : [right, left];
  for (const value of smaller) {
    if (larger.has(value)) {
      return true;
    }
  }
  return false;
}

export function isDwgRenderDeltaBatchInvalidated(
  index,
  sceneId,
  batch,
  instanceGraph,
) {
  const scene = index?.byScene?.get(sceneId);
  if (!scene) {
    return false;
  }
  if (scene.typeKeys.size > 0) {
    return true;
  }
  if (batch?.kind === GpuLineBatchKind.BlockDefinition) {
    if (scene.blockIndices.has(batch.blockIndex)) {
      return true;
    }
    if (
      batch.blockIndex === -1 &&
      setsIntersect(
        scene.blockIndices,
        instanceGraph?.modelBlockIndices,
      )
    ) {
      return true;
    }
    return false;
  }
  return setsIntersect(
    scene.blockIndices,
    instanceGraph?.modelBlockIndices,
  );
}

export function isDwgRenderDeltaOwnerInvalidated(
  index,
  sceneId,
  ownerHandle,
  {
    blockIndexByHandle = new Map(),
    modelBlockIndices = new Set(),
  } = {},
) {
  const scene = index?.byScene?.get(sceneId);
  if (!scene) {
    return false;
  }
  if (scene.typeKeys.size > 0) {
    return true;
  }
  const blockIndex = blockIndexByHandle.get(ownerHandle);
  if (blockIndex !== undefined) {
    return scene.blockIndices.has(blockIndex);
  }
  return (
    ownerHandle === 0n &&
    setsIntersect(scene.blockIndices, modelBlockIndices)
  );
}

export {
  MAX_DEPENDENCY_IDS as MAX_DWG_RENDER_DEPENDENCY_IDS,
};

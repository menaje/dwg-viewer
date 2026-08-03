import {
  RenderDeltaAspect,
  RenderDeltaOperationKind,
} from "@dwg-viewer/render-protocol";

import { decodeDwgRenderDeltaText } from "./render-delta-text.mjs";
import {
  decodeDwgRenderDeltaTransform,
} from "./render-delta-transform.mjs";
import { ROOT_RENDER_DELTA_SCENE_ID } from "./renderer.mjs";

const DWG_RENDER_DELTA_MEDIA_TYPE_V1 =
  "application/vnd.dwg-viewer.dwg-render-delta.v1";
const DWG_RENDER_DELTA_MEDIA_TYPE_V2 =
  "application/vnd.dwg-viewer.dwg-render-delta.v2";
const DWG_RENDER_DELTA_MEDIA_TYPE_V3 =
  "application/vnd.dwg-viewer.dwg-render-delta.v3";
const DWG_RENDER_DELTA_MEDIA_TYPE_V4 =
  "application/vnd.dwg-viewer.dwg-render-delta.v4";
const DWG_RENDER_DELTA_MEDIA_TYPE =
  "application/vnd.dwg-viewer.dwg-render-delta.v5";
const DWG_LINE_VERTEX_STRIDE = 36;
const DWG_FILL_VERTEX_STRIDE = 32;
const DWG_POINT_VERTEX_STRIDE = 32;
const VISUAL_ASPECTS = new Set([
  RenderDeltaAspect.ENTITY,
  RenderDeltaAspect.GEOMETRY,
  RenderDeltaAspect.TEXT,
  RenderDeltaAspect.TRANSFORM,
  RenderDeltaAspect.STYLE,
]);

function invalidState(message) {
  return new DOMException(message, "InvalidStateError");
}

function plainRecord(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    keys.length !== wanted.length ||
    keys.some((key, index) => key !== wanted[index])
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
}

function synchronous(value, label) {
  if (value && typeof value.then === "function") {
    throw new TypeError(`${label} must complete synchronously`);
  }
  return value;
}

function assertRenderer(renderer) {
  for (const method of [
    "stageRenderDeltaLine",
    "stageRenderDeltaFill",
    "stageRenderDeltaPoint",
    "stageRenderDeltaText",
    "stageRenderDeltaTransform",
    "activateRenderDelta",
    "releaseRenderDeltaResources",
  ]) {
    if (typeof renderer?.[method] !== "function") {
      throw new TypeError(
        `DWG render delta renderer must implement ${method}()`,
      );
    }
  }
  return renderer;
}

function identityKey(identity) {
  return (
    `${identity.sceneId}\u0000` +
    `${identity.handleHigh}:${identity.handleLow}`
  );
}

function logicalKey(layerId, renderId) {
  return `${layerId}\u0000${renderId}`;
}

function normalizeHandle(value, label = "DWG handle") {
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

function normalizeIdentity(value, renderId) {
  const input = plainRecord(value, `DWG identity for ${renderId}`);
  const sceneId = String(input.sceneId ?? "");
  let handle;
  if (input.handle !== undefined) {
    handle = normalizeHandle(
      input.handle,
      `DWG identity for ${renderId}`,
    );
  } else {
    if (
      !Number.isInteger(input.handleLow) ||
      input.handleLow < 0 ||
      input.handleLow > 0xffff_ffff ||
      !Number.isInteger(input.handleHigh) ||
      input.handleHigh < 0 ||
      input.handleHigh > 0xffff_ffff
    ) {
      throw new TypeError(
        `DWG identity for ${renderId} is invalid`,
      );
    }
    handle =
      BigInt(input.handleLow) |
      (BigInt(input.handleHigh) << 32n);
  }
  if (
    sceneId.length === 0 ||
    sceneId.length > 512 ||
    handle < 0n ||
    handle > 0xffff_ffff_ffff_ffffn
  ) {
    throw new TypeError(`DWG identity for ${renderId} is invalid`);
  }
  return Object.freeze({
    sceneId,
    handle,
    handleLow: Number(handle & 0xffff_ffffn),
    handleHigh: Number(handle >> 32n),
  });
}

export function parseDwgRenderId(renderId) {
  if (typeof renderId !== "string") {
    throw new TypeError("DWG Render ID must be a string");
  }
  const match = /^dwg:(.+):([a-f0-9]{1,16})$/iu.exec(renderId);
  if (!match) {
    throw new TypeError(`DWG Render ID ${renderId} is invalid`);
  }
  return normalizeIdentity(
    {
      sceneId: match[1],
      handle: match[2],
    },
    renderId,
  );
}

function unionBounds(left, right) {
  if (!left) {
    return Object.freeze({
      min: Object.freeze([...right.min]),
      max: Object.freeze([...right.max]),
    });
  }
  return Object.freeze({
    min: Object.freeze(
      left.min.map((value, axis) =>
        Math.min(value, right.min[axis]),
      ),
    ),
    max: Object.freeze(
      left.max.map((value, axis) =>
        Math.max(value, right.max[axis]),
      ),
    ),
  });
}

function emptyState() {
  return {
    revisionId: null,
    sequence: 0,
    overlays: new Map(),
    suppressions: new Map(),
    identities: new Map(),
    renderIdentityKeys: new Map(),
    invalidatedDependencyIds: new Set(),
    affectedWorldBounds: null,
  };
}

function cloneState(state) {
  return {
    revisionId: state.revisionId,
    sequence: state.sequence,
    overlays: new Map(state.overlays),
    suppressions: new Map(state.suppressions),
    identities: new Map(state.identities),
    renderIdentityKeys: new Map(state.renderIdentityKeys),
    invalidatedDependencyIds: new Set(
      state.invalidatedDependencyIds,
    ),
    affectedWorldBounds: state.affectedWorldBounds,
  };
}

function resourcesForState(state) {
  const resources = new Set();
  for (const overlay of state.overlays.values()) {
    for (const line of overlay.lines) {
      resources.add(line);
    }
    for (const fill of overlay.fills) {
      resources.add(fill);
    }
    for (const point of overlay.points) {
      resources.add(point);
    }
    for (const text of overlay.texts) {
      resources.add(text);
    }
    for (const transform of overlay.transforms) {
      resources.add(transform);
    }
  }
  return resources;
}

function activeLines(state) {
  return [...state.overlays.values()].flatMap(
    (overlay) => overlay.lines,
  );
}

function activeFills(state) {
  return [...state.overlays.values()].flatMap(
    (overlay) => overlay.fills,
  );
}

function activePoints(state) {
  return [...state.overlays.values()].flatMap(
    (overlay) => overlay.points,
  );
}

function activeTexts(state) {
  return [...state.overlays.values()].flatMap(
    (overlay) => overlay.texts,
  );
}

function activeTransforms(state) {
  return [...state.overlays.values()].flatMap(
    (overlay) => overlay.transforms,
  );
}

function identityStatus({
  operation,
  renderId,
  identity,
  status,
  revisionId,
}) {
  return Object.freeze({
    status,
    revisionId,
    layerId: operation.layerId,
    renderId,
    sceneId: identity.sceneId,
    handle: identity.handle,
    handleLow: identity.handleLow,
    handleHigh: identity.handleHigh,
    externalIdentityToken: operation.externalIdentityToken,
  });
}

function validateLineIdentity(line, identity, label) {
  if (
    line.sceneId !== identity.sceneId ||
    !(line.vertices?.buffer instanceof ArrayBuffer) ||
    (line.vertices.recordSize ?? DWG_LINE_VERTEX_STRIDE) !==
      DWG_LINE_VERTEX_STRIDE ||
    line.vertices.buffer.byteLength !== line.vertices.byteLength ||
    line.vertices.byteLength !==
      line.vertices.vertexCount * DWG_LINE_VERTEX_STRIDE
  ) {
    throw new TypeError(`${label} has an invalid DWG line payload`);
  }
  const view = new DataView(line.vertices.buffer);
  for (
    let offset = 0;
    offset < line.vertices.byteLength;
    offset += DWG_LINE_VERTEX_STRIDE
  ) {
    if (
      view.getUint32(offset + 20, true) !== identity.handleLow ||
      view.getUint32(offset + 24, true) !== identity.handleHigh
    ) {
      throw new TypeError(
        `${label} contains a vertex for another Render ID`,
      );
    }
  }
}

function validateFillIdentity(fill, identity, label) {
  if (
    fill.sceneId !== identity.sceneId ||
    !(fill.vertices?.buffer instanceof ArrayBuffer) ||
    (fill.vertices.recordSize ?? DWG_FILL_VERTEX_STRIDE) !==
      DWG_FILL_VERTEX_STRIDE ||
    fill.vertices.buffer.byteLength !== fill.vertices.byteLength ||
    fill.vertices.byteLength !==
      fill.vertices.vertexCount * DWG_FILL_VERTEX_STRIDE ||
    fill.vertices.vertexCount === 0 ||
    fill.vertices.vertexCount % 3 !== 0
  ) {
    throw new TypeError(`${label} has an invalid DWG fill payload`);
  }
}

function validatePointIdentity(point, identity, label) {
  if (
    point.sceneId !== identity.sceneId ||
    !(point.vertices?.buffer instanceof ArrayBuffer) ||
    (point.vertices.recordSize ?? DWG_POINT_VERTEX_STRIDE) !==
      DWG_POINT_VERTEX_STRIDE ||
    point.vertices.buffer.byteLength !== point.vertices.byteLength ||
    point.vertices.byteLength !==
      point.vertices.vertexCount * DWG_POINT_VERTEX_STRIDE ||
    point.vertices.vertexCount === 0
  ) {
    throw new TypeError(`${label} has an invalid DWG point payload`);
  }
}

function validateTextIdentity(text, identity, label) {
  if (
    text.sceneId !== identity.sceneId ||
    !(text.buffer instanceof ArrayBuffer)
  ) {
    throw new TypeError(`${label} has an invalid DWG text payload`);
  }
  try {
    return decodeDwgRenderDeltaText(text.buffer, {
      expectedHandle: identity.handle,
    });
  } catch (error) {
    throw new TypeError(
      `${label} has an invalid DWG text payload`,
      { cause: error },
    );
  }
}

function validateTransformIdentity(transform, identity, label) {
  if (
    transform.sceneId !== identity.sceneId ||
    !(transform.buffer instanceof ArrayBuffer)
  ) {
    throw new TypeError(
      `${label} has an invalid DWG transform payload`,
    );
  }
  try {
    return decodeDwgRenderDeltaTransform(transform.buffer, {
      expectedHandle: identity.handle,
    });
  } catch (error) {
    throw new TypeError(
      `${label} has an invalid DWG transform payload`,
      { cause: error },
    );
  }
}

function parsePacket(
  value,
  payload,
  delta,
  identities,
) {
  const packet = plainRecord(value, "DWG render delta packet");
  exactKeys(
    packet,
    [
      "payloadId",
      "sha256",
      "byteLength",
      "operations",
    ],
    "DWG render delta packet",
  );
  const legacyLinePacket =
    payload.mediaType === DWG_RENDER_DELTA_MEDIA_TYPE_V1;
  const lineFillPacket =
    payload.mediaType === DWG_RENDER_DELTA_MEDIA_TYPE_V2;
  const lineFillPointPacket =
    payload.mediaType === DWG_RENDER_DELTA_MEDIA_TYPE_V3;
  const lineFillPointTextPacket =
    payload.mediaType === DWG_RENDER_DELTA_MEDIA_TYPE_V4;
  if (
    (!legacyLinePacket &&
      !lineFillPacket &&
      !lineFillPointPacket &&
      !lineFillPointTextPacket &&
      payload.mediaType !== DWG_RENDER_DELTA_MEDIA_TYPE) ||
    packet.payloadId !== payload.payloadId ||
    packet.sha256 !== payload.sha256 ||
    packet.byteLength !== payload.byteLength ||
    !Array.isArray(packet.operations)
  ) {
    throw new TypeError(
      "DWG render delta packet does not match its payload descriptor",
    );
  }
  const visualOperations = delta.operations.filter(
    (operation) =>
      operation.kind === RenderDeltaOperationKind.UPSERT &&
      VISUAL_ASPECTS.has(operation.aspect),
  );
  if (packet.operations.length !== visualOperations.length) {
    throw new TypeError(
      "DWG render delta packet operation coverage is incomplete",
    );
  }
  const expected = new Map(
    visualOperations.map((operation) => [
      operation.operationId,
      operation,
    ]),
  );
  const parsed = new Map();
  const buffers = new Set();
  let byteLength = 0;
  for (const rawOperation of packet.operations) {
    const packetOperation = plainRecord(
      rawOperation,
      "DWG render delta packet operation",
    );
    exactKeys(
      packetOperation,
      legacyLinePacket
        ? ["operationId", "lines"]
        : lineFillPacket
          ? ["operationId", "lines", "fills"]
          : lineFillPointPacket
            ? ["operationId", "lines", "fills", "points"]
            : lineFillPointTextPacket
              ? [
                  "operationId",
                  "lines",
                  "fills",
                  "points",
                  "texts",
                ]
              : [
                "operationId",
                "lines",
                "fills",
                "points",
                "texts",
                "transforms",
              ],
      "DWG render delta packet operation",
    );
    const packetLines = packetOperation.lines;
    const packetFills = legacyLinePacket
      ? []
      : packetOperation.fills;
    const packetPoints =
      legacyLinePacket || lineFillPacket
        ? []
        : packetOperation.points;
    const packetTexts =
      legacyLinePacket ||
      lineFillPacket ||
      lineFillPointPacket
        ? []
        : packetOperation.texts;
    const packetTransforms =
      legacyLinePacket ||
      lineFillPacket ||
      lineFillPointPacket ||
      lineFillPointTextPacket
        ? []
        : packetOperation.transforms;
    const operation = expected.get(packetOperation.operationId);
    const resourceCount =
      packetLines?.length +
      packetFills?.length +
      packetPoints?.length +
      packetTexts?.length +
      packetTransforms?.length;
    if (
      !operation ||
      parsed.has(operation.operationId) ||
      !Array.isArray(packetLines) ||
      !Array.isArray(packetFills) ||
      !Array.isArray(packetPoints) ||
      !Array.isArray(packetTexts) ||
      !Array.isArray(packetTransforms) ||
      resourceCount === 0 ||
      resourceCount > 4_096
    ) {
      throw new TypeError(
        "DWG render delta packet operation is invalid",
      );
    }
    const renderIds = new Set(operation.renderIds);
    const covered = new Set();
    const lines = [];
    const fills = [];
    const points = [];
    const texts = [];
    const transforms = [];
    const textRenderIds = new Set();
    const replacementRenderIds = new Set();
    for (const [index, rawLine] of packetLines.entries()) {
      const line = plainRecord(
        rawLine,
        "DWG render delta packet line",
      );
      exactKeys(
        line,
        [
          "renderId",
          "sceneId",
          "batch",
          "vertices",
          "instanceIndices",
        ],
        "DWG render delta packet line",
      );
      if (
        !renderIds.has(line.renderId) ||
        buffers.has(line.vertices?.buffer) ||
        (line.instanceIndices !== null &&
          !(line.instanceIndices instanceof Uint32Array))
      ) {
        throw new TypeError(
          "DWG render delta packet line scope is invalid",
        );
      }
      const identity = identities.get(
        logicalKey(operation.layerId, line.renderId),
      );
      validateLineIdentity(
        line,
        identity,
        `DWG render delta packet line ${index}`,
      );
      buffers.add(line.vertices.buffer);
      covered.add(line.renderId);
      replacementRenderIds.add(line.renderId);
      byteLength += line.vertices.byteLength;
      if (
        !Number.isSafeInteger(byteLength) ||
        byteLength > payload.byteLength
      ) {
        throw new RangeError(
          "DWG render delta packet exceeds its byte bound",
        );
      }
      lines.push(
        Object.freeze({
          renderId: line.renderId,
          sceneId: line.sceneId,
          batch: line.batch,
          vertices: line.vertices,
          instanceIndices: line.instanceIndices,
        }),
      );
    }
    for (const [index, rawFill] of packetFills.entries()) {
      const fill = plainRecord(
        rawFill,
        "DWG render delta packet fill",
      );
      exactKeys(
        fill,
        [
          "renderId",
          "sceneId",
          "batch",
          "vertices",
          "instanceIndices",
        ],
        "DWG render delta packet fill",
      );
      if (
        !renderIds.has(fill.renderId) ||
        buffers.has(fill.vertices?.buffer) ||
        (fill.instanceIndices !== null &&
          !(fill.instanceIndices instanceof Uint32Array))
      ) {
        throw new TypeError(
          "DWG render delta packet fill scope is invalid",
        );
      }
      const identity = identities.get(
        logicalKey(operation.layerId, fill.renderId),
      );
      validateFillIdentity(
        fill,
        identity,
        `DWG render delta packet fill ${index}`,
      );
      buffers.add(fill.vertices.buffer);
      covered.add(fill.renderId);
      replacementRenderIds.add(fill.renderId);
      byteLength += fill.vertices.byteLength;
      if (
        !Number.isSafeInteger(byteLength) ||
        byteLength > payload.byteLength
      ) {
        throw new RangeError(
          "DWG render delta packet exceeds its byte bound",
        );
      }
      fills.push(
        Object.freeze({
          renderId: fill.renderId,
          sceneId: fill.sceneId,
          batch: fill.batch,
          vertices: fill.vertices,
          instanceIndices: fill.instanceIndices,
        }),
      );
    }
    for (const [index, rawPoint] of packetPoints.entries()) {
      const point = plainRecord(
        rawPoint,
        "DWG render delta packet point",
      );
      exactKeys(
        point,
        [
          "renderId",
          "sceneId",
          "batch",
          "vertices",
          "instanceIndices",
        ],
        "DWG render delta packet point",
      );
      if (
        !renderIds.has(point.renderId) ||
        buffers.has(point.vertices?.buffer) ||
        (point.instanceIndices !== null &&
          !(point.instanceIndices instanceof Uint32Array))
      ) {
        throw new TypeError(
          "DWG render delta packet point scope is invalid",
        );
      }
      const identity = identities.get(
        logicalKey(operation.layerId, point.renderId),
      );
      validatePointIdentity(
        point,
        identity,
        `DWG render delta packet point ${index}`,
      );
      buffers.add(point.vertices.buffer);
      covered.add(point.renderId);
      replacementRenderIds.add(point.renderId);
      byteLength += point.vertices.byteLength;
      if (
        !Number.isSafeInteger(byteLength) ||
        byteLength > payload.byteLength
      ) {
        throw new RangeError(
          "DWG render delta packet exceeds its byte bound",
        );
      }
      points.push(
        Object.freeze({
          renderId: point.renderId,
          sceneId: point.sceneId,
          batch: point.batch,
          vertices: point.vertices,
          instanceIndices: point.instanceIndices,
        }),
      );
    }
    for (const [index, rawText] of packetTexts.entries()) {
      const text = plainRecord(
        rawText,
        "DWG render delta packet text",
      );
      exactKeys(
        text,
        ["renderId", "sceneId", "buffer"],
        "DWG render delta packet text",
      );
      if (
        !renderIds.has(text.renderId) ||
        buffers.has(text.buffer) ||
        textRenderIds.has(text.renderId)
      ) {
        throw new TypeError(
          "DWG render delta packet text scope is invalid",
        );
      }
      const identity = identities.get(
        logicalKey(operation.layerId, text.renderId),
      );
      const record = validateTextIdentity(
        text,
        identity,
        `DWG render delta packet text ${index}`,
      );
      buffers.add(text.buffer);
      textRenderIds.add(text.renderId);
      covered.add(text.renderId);
      replacementRenderIds.add(text.renderId);
      byteLength += text.buffer.byteLength;
      if (
        !Number.isSafeInteger(byteLength) ||
        byteLength > payload.byteLength
      ) {
        throw new RangeError(
          "DWG render delta packet exceeds its byte bound",
        );
      }
      texts.push(
        Object.freeze({
          renderId: text.renderId,
          sceneId: text.sceneId,
          record,
          byteLength: text.buffer.byteLength,
        }),
      );
    }
    const transformTargets = new Set();
    for (const [index, rawTransform] of packetTransforms.entries()) {
      const transform = plainRecord(
        rawTransform,
        "DWG render delta packet transform",
      );
      exactKeys(
        transform,
        ["renderId", "sceneId", "buffer"],
        "DWG render delta packet transform",
      );
      if (
        operation.aspect !== RenderDeltaAspect.TRANSFORM ||
        !renderIds.has(transform.renderId) ||
        buffers.has(transform.buffer) ||
        replacementRenderIds.has(transform.renderId)
      ) {
        throw new TypeError(
          "DWG render delta packet transform scope is invalid",
        );
      }
      const identity = identities.get(
        logicalKey(operation.layerId, transform.renderId),
      );
      const record = validateTransformIdentity(
        transform,
        identity,
        `DWG render delta packet transform ${index}`,
      );
      const target =
        `${transform.sceneId}\u0000${record.blockIndex}` +
        `\u0000${record.instanceIndex}`;
      if (transformTargets.has(target)) {
        throw new TypeError(
          "DWG render delta packet transform target is duplicated",
        );
      }
      transformTargets.add(target);
      buffers.add(transform.buffer);
      covered.add(transform.renderId);
      byteLength += transform.buffer.byteLength;
      if (
        !Number.isSafeInteger(byteLength) ||
        byteLength > payload.byteLength
      ) {
        throw new RangeError(
          "DWG render delta packet exceeds its byte bound",
        );
      }
      transforms.push(
        Object.freeze({
          renderId: transform.renderId,
          sceneId: transform.sceneId,
          record,
          byteLength: transform.buffer.byteLength,
        }),
      );
    }
    if (
      covered.size !== renderIds.size ||
      [...renderIds].some((renderId) => !covered.has(renderId))
    ) {
      throw new TypeError(
        "DWG render delta packet does not cover every Render ID",
      );
    }
    parsed.set(
      operation.operationId,
      Object.freeze({
        operation,
        lines: Object.freeze(lines),
        fills: Object.freeze(fills),
        points: Object.freeze(points),
        texts: Object.freeze(texts),
        transforms: Object.freeze(transforms),
      }),
    );
  }
  if (byteLength !== payload.byteLength) {
    throw new TypeError(
      "DWG render delta packet byte length is inconsistent",
    );
  }
  return parsed;
}

export class DwgRenderDeltaAdapter {
  #renderer;
  #resolvePacket;
  #resolveIdentity;
  #committed = emptyState();
  #preview = null;
  #disposed = false;

  constructor({
    renderer,
    resolvePacket,
    resolveIdentity = parseDwgRenderId,
  }) {
    this.#renderer = assertRenderer(renderer);
    if (typeof resolvePacket !== "function") {
      throw new TypeError(
        "DWG render delta adapter requires resolvePacket()",
      );
    }
    if (typeof resolveIdentity !== "function") {
      throw new TypeError(
        "DWG render delta adapter requires resolveIdentity()",
      );
    }
    this.#resolvePacket = resolvePacket;
    this.#resolveIdentity = resolveIdentity;
  }

  #assertOpen() {
    if (this.#disposed) {
      throw invalidState("DWG render delta adapter is disposed");
    }
  }

  #activeState() {
    return this.#preview?.state ?? this.#committed;
  }

  #activate(state) {
    return synchronous(
      this.#renderer.activateRenderDelta({
        lines: activeLines(state),
        fills: activeFills(state),
        points: activePoints(state),
        texts: activeTexts(state),
        transforms: activeTransforms(state),
        baseSuppressions: [...state.suppressions.values()],
        affectedWorldBounds: state.affectedWorldBounds,
      }),
      "DWG renderer activateRenderDelta",
    );
  }

  #release(resources) {
    if (resources.length === 0) {
      return;
    }
    synchronous(
      this.#renderer.releaseRenderDeltaResources(resources),
      "DWG renderer releaseRenderDeltaResources",
    );
  }

  #releaseDifference(previous, next) {
    const retained = resourcesForState(next);
    this.#release(
      [...resourcesForState(previous)].filter(
        (entry) => !retained.has(entry),
      ),
    );
  }

  #prepare(delta) {
    if (
      this.#committed.revisionId !== null &&
      delta.fromRevisionId !== this.#committed.revisionId
    ) {
      throw invalidState(
        "DWG render delta adapter revision is out of order",
      );
    }
    const identities = new Map();
    for (const operation of delta.operations) {
      for (const renderId of operation.renderIds) {
        const resolved = synchronous(
          this.#resolveIdentity(renderId, {
            operation,
            delta,
          }),
          "DWG identity resolver",
        );
        identities.set(
          logicalKey(operation.layerId, renderId),
          normalizeIdentity(resolved, renderId),
        );
      }
    }
    const packetOperations =
      delta.payload === null
        ? new Map()
        : parsePacket(
            synchronous(
              this.#resolvePacket(delta.payload, delta),
              "DWG packet resolver",
            ),
            delta.payload,
            delta,
            identities,
          );
    if (
      delta.payload === null &&
      delta.operations.some(
        (operation) =>
          operation.kind === RenderDeltaOperationKind.UPSERT &&
          VISUAL_ASPECTS.has(operation.aspect),
      )
    ) {
      throw new TypeError(
        "DWG visual render delta requires a packet payload",
      );
    }
    const staged = [];
    const linesByOperation = new Map();
    const fillsByOperation = new Map();
    const pointsByOperation = new Map();
    const textsByOperation = new Map();
    const transformsByOperation = new Map();
    try {
      for (const [
        operationId,
        packetOperation,
      ] of packetOperations) {
        const byRenderId = new Map();
        for (const [index, line] of packetOperation.lines.entries()) {
          const entry = synchronous(
            this.#renderer.stageRenderDeltaLine({
              key:
                `${delta.deltaId}\u0000${operationId}` +
                `\u0000${line.renderId}\u0000${index}`,
              sceneId: line.sceneId,
              batch: line.batch,
              vertices: line.vertices,
              instanceIndices: line.instanceIndices,
            }),
            "DWG renderer stageRenderDeltaLine",
          );
          if (!entry || typeof entry !== "object") {
            throw new TypeError(
              "DWG renderer returned an invalid staged line",
            );
          }
          staged.push(entry);
          const entries = byRenderId.get(line.renderId) ?? [];
          entries.push(entry);
          byRenderId.set(line.renderId, entries);
        }
        linesByOperation.set(operationId, byRenderId);
        const fillsByRenderId = new Map();
        for (const [index, fill] of packetOperation.fills.entries()) {
          const entry = synchronous(
            this.#renderer.stageRenderDeltaFill({
              key:
                `${delta.deltaId}\u0000${operationId}` +
                `\u0000${fill.renderId}\u0000fill:${index}`,
              sceneId: fill.sceneId,
              batch: fill.batch,
              vertices: fill.vertices,
              instanceIndices: fill.instanceIndices,
            }),
            "DWG renderer stageRenderDeltaFill",
          );
          if (!entry || typeof entry !== "object") {
            throw new TypeError(
              "DWG renderer returned an invalid staged fill",
            );
          }
          staged.push(entry);
          const entries =
            fillsByRenderId.get(fill.renderId) ?? [];
          entries.push(entry);
          fillsByRenderId.set(fill.renderId, entries);
        }
        fillsByOperation.set(operationId, fillsByRenderId);
        const pointsByRenderId = new Map();
        for (const [index, point] of packetOperation.points.entries()) {
          const entry = synchronous(
            this.#renderer.stageRenderDeltaPoint({
              key:
                `${delta.deltaId}\u0000${operationId}` +
                `\u0000${point.renderId}\u0000point:${index}`,
              sceneId: point.sceneId,
              batch: point.batch,
              vertices: point.vertices,
              instanceIndices: point.instanceIndices,
            }),
            "DWG renderer stageRenderDeltaPoint",
          );
          if (!entry || typeof entry !== "object") {
            throw new TypeError(
              "DWG renderer returned an invalid staged point",
            );
          }
          staged.push(entry);
          const entries =
            pointsByRenderId.get(point.renderId) ?? [];
          entries.push(entry);
          pointsByRenderId.set(point.renderId, entries);
        }
        pointsByOperation.set(operationId, pointsByRenderId);
        const textsByRenderId = new Map();
        for (const [index, text] of packetOperation.texts.entries()) {
          const entry = synchronous(
            this.#renderer.stageRenderDeltaText({
              key:
                `${delta.deltaId}\u0000${operationId}` +
                `\u0000${text.renderId}\u0000text:${index}`,
              sceneId: text.sceneId,
              record: text.record,
              byteLength: text.byteLength,
            }),
            "DWG renderer stageRenderDeltaText",
          );
          if (!entry || typeof entry !== "object") {
            throw new TypeError(
              "DWG renderer returned an invalid staged text",
            );
          }
          staged.push(entry);
          const entries =
            textsByRenderId.get(text.renderId) ?? [];
          entries.push(entry);
          textsByRenderId.set(text.renderId, entries);
        }
        textsByOperation.set(operationId, textsByRenderId);
        const transformsByRenderId = new Map();
        for (const [index, transform] of
          packetOperation.transforms.entries()) {
          const entry = synchronous(
            this.#renderer.stageRenderDeltaTransform({
              key:
                `${delta.deltaId}\u0000${operationId}` +
                `\u0000${transform.renderId}` +
                `\u0000transform:${index}`,
              sceneId: transform.sceneId,
              record: transform.record,
              byteLength: transform.byteLength,
            }),
            "DWG renderer stageRenderDeltaTransform",
          );
          if (!entry || typeof entry !== "object") {
            throw new TypeError(
              "DWG renderer returned an invalid staged transform",
            );
          }
          staged.push(entry);
          const entries =
            transformsByRenderId.get(transform.renderId) ?? [];
          entries.push(entry);
          transformsByRenderId.set(
            transform.renderId,
            entries,
          );
        }
        transformsByOperation.set(
          operationId,
          transformsByRenderId,
        );
      }
    } catch (error) {
      this.#release(staged);
      throw error;
    }
    return {
      identities,
      linesByOperation,
      fillsByOperation,
      pointsByOperation,
      textsByOperation,
      transformsByOperation,
      staged,
    };
  }

  #nextState(delta, prepared) {
    const next = cloneState(this.#committed);
    next.revisionId = delta.toRevisionId;
    next.sequence = delta.sequence;
    next.affectedWorldBounds = unionBounds(
      next.affectedWorldBounds,
      delta.affectedWorldBounds,
    );
    for (const operation of delta.operations) {
      for (const dependencyId of operation.dependencyIds) {
        next.invalidatedDependencyIds.add(dependencyId);
      }
      for (const renderId of operation.renderIds) {
        const key = logicalKey(operation.layerId, renderId);
        const identity = prepared.identities.get(key);
        const nativeKey = identityKey(identity);
        const previousNativeKey =
          next.renderIdentityKeys.get(key);
        if (
          previousNativeKey &&
          previousNativeKey !== nativeKey
        ) {
          next.identities.delete(previousNativeKey);
        }
        next.renderIdentityKeys.set(key, nativeKey);
        if (
          operation.kind === RenderDeltaOperationKind.TOMBSTONE
        ) {
          next.overlays.delete(key);
          next.suppressions.set(key, identity);
          next.identities.set(
            nativeKey,
            identityStatus({
              operation,
              renderId,
              identity,
              status: "tombstone",
              revisionId: next.revisionId,
            }),
          );
          continue;
        }
        if (VISUAL_ASPECTS.has(operation.aspect)) {
          const lines =
            prepared.linesByOperation
              .get(operation.operationId)
              ?.get(renderId) ?? [];
          const fills =
            prepared.fillsByOperation
              .get(operation.operationId)
              ?.get(renderId) ?? [];
          const points =
            prepared.pointsByOperation
              .get(operation.operationId)
              ?.get(renderId) ?? [];
          const texts =
            prepared.textsByOperation
              .get(operation.operationId)
              ?.get(renderId) ?? [];
          const transforms =
            prepared.transformsByOperation
              .get(operation.operationId)
              ?.get(renderId) ?? [];
          next.overlays.set(
            key,
            Object.freeze({
              layerId: operation.layerId,
              renderId,
              aspect: operation.aspect,
              lines: Object.freeze(lines),
              fills: Object.freeze(fills),
              points: Object.freeze(points),
              texts: Object.freeze(texts),
              transforms: Object.freeze(transforms),
            }),
          );
          next.suppressions.set(key, identity);
          next.identities.set(
            nativeKey,
            identityStatus({
              operation,
              renderId,
              identity,
              status: "upsert",
              revisionId: next.revisionId,
            }),
          );
          continue;
        }
        const existing = next.identities.get(nativeKey);
        next.identities.set(
          nativeKey,
          identityStatus({
            operation,
            renderId,
            identity,
            status: existing?.status ?? "base",
            revisionId: next.revisionId,
          }),
        );
      }
    }
    return next;
  }

  applyDelta(delta, { preview = false } = {}) {
    this.#assertOpen();
    if (this.#preview) {
      throw invalidState(
        "only one DWG render delta preview may be active",
      );
    }
    const prepared = this.#prepare(delta);
    let next;
    try {
      next = this.#nextState(delta, prepared);
      this.#activate(next);
    } catch (error) {
      this.#release(prepared.staged);
      throw error;
    }
    if (preview) {
      if (this.#committed.revisionId === null) {
        const base = cloneState(this.#committed);
        base.revisionId = delta.fromRevisionId;
        this.#committed = base;
      }
      this.#preview = Object.freeze({
        deltaId: delta.deltaId,
        state: next,
      });
    } else {
      const previous = this.#committed;
      this.#committed = next;
      this.#releaseDifference(previous, next);
    }
    return this.snapshot();
  }

  promotePreview(delta) {
    this.#assertOpen();
    if (!this.#preview || this.#preview.deltaId !== delta.deltaId) {
      throw invalidState(
        "DWG render delta preview does not match promotion",
      );
    }
    const previous = this.#committed;
    this.#committed = this.#preview.state;
    this.#preview = null;
    this.#releaseDifference(previous, this.#committed);
    return this.snapshot();
  }

  rollbackPreview(delta) {
    this.#assertOpen();
    if (!this.#preview || this.#preview.deltaId !== delta.deltaId) {
      throw invalidState(
        "DWG render delta preview does not match rollback",
      );
    }
    const preview = this.#preview.state;
    this.#activate(this.#committed);
    this.#preview = null;
    this.#releaseDifference(preview, this.#committed);
    return this.snapshot();
  }

  snapshot() {
    this.#assertOpen();
    const state = this.#activeState();
    return Object.freeze({
      revisionId: state.revisionId,
      sequence: state.sequence,
      previewId: this.#preview?.deltaId ?? null,
      overlayEntities: state.overlays.size,
      lineBatches: activeLines(state).length,
      fillBatches: activeFills(state).length,
      pointBatches: activePoints(state).length,
      textRecords: activeTexts(state).length,
      textBytes: activeTexts(state).reduce(
        (total, entry) => total + entry.byteLength,
        0,
      ),
      transformRecords: activeTransforms(state).length,
      transformBytes: activeTransforms(state).reduce(
        (total, entry) => total + entry.byteLength,
        0,
      ),
      baseSuppressions: state.suppressions.size,
      affectedWorldBounds: state.affectedWorldBounds,
      invalidatedDependencyIds: Object.freeze(
        [...state.invalidatedDependencyIds].sort(),
      ),
    });
  }

  lookupIdentity(sceneId, handle) {
    this.#assertOpen();
    const state = this.#activeState();
    const normalized = normalizeIdentity(
      { sceneId, handle },
      "selection",
    );
    const entry = state.identities.get(
      identityKey(normalized),
    );
    return entry
      ? Object.freeze({
          ...entry,
          revisionId: state.revisionId,
        })
      : Object.freeze({
        status: "base",
        revisionId: state.revisionId,
        layerId: null,
        renderId: null,
        sceneId: normalized.sceneId,
        handle: normalized.handle,
        handleLow: normalized.handleLow,
        handleHigh: normalized.handleHigh,
        externalIdentityToken: null,
      });
  }

  acceptsBasePick(sceneId, handle) {
    return this.lookupIdentity(sceneId, handle).status === "base";
  }

  dispose() {
    if (this.#disposed) {
      return false;
    }
    const state = this.#activeState();
    synchronous(
      this.#renderer.activateRenderDelta(),
      "DWG renderer activateRenderDelta",
    );
    this.#release([...resourcesForState(state)]);
    if (this.#preview) {
      this.#releaseDifference(this.#committed, state);
    }
    this.#preview = null;
    this.#committed = emptyState();
    this.#disposed = true;
    return true;
  }
}

export {
  DWG_FILL_VERTEX_STRIDE,
  DWG_LINE_VERTEX_STRIDE,
  DWG_POINT_VERTEX_STRIDE,
  DWG_RENDER_DELTA_MEDIA_TYPE,
  DWG_RENDER_DELTA_MEDIA_TYPE_V1,
  DWG_RENDER_DELTA_MEDIA_TYPE_V2,
  DWG_RENDER_DELTA_MEDIA_TYPE_V3,
  DWG_RENDER_DELTA_MEDIA_TYPE_V4,
};

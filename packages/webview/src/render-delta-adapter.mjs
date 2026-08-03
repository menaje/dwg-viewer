import {
  RenderDeltaAspect,
  RenderDeltaOperationKind,
} from "@dwg-viewer/render-protocol";

import { ROOT_RENDER_DELTA_SCENE_ID } from "./renderer.mjs";

const DWG_RENDER_DELTA_MEDIA_TYPE =
  "application/vnd.dwg-viewer.dwg-render-delta.v1";
const DWG_LINE_VERTEX_STRIDE = 36;
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
    "activateRenderDelta",
    "releaseRenderDeltaLines",
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
  }
  return resources;
}

function activeLines(state) {
  return [...state.overlays.values()].flatMap(
    (overlay) => overlay.lines,
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
  if (
    payload.mediaType !== DWG_RENDER_DELTA_MEDIA_TYPE ||
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
      ["operationId", "lines"],
      "DWG render delta packet operation",
    );
    const operation = expected.get(packetOperation.operationId);
    if (
      !operation ||
      parsed.has(operation.operationId) ||
      !Array.isArray(packetOperation.lines) ||
      packetOperation.lines.length === 0 ||
      packetOperation.lines.length > 4_096
    ) {
      throw new TypeError(
        "DWG render delta packet operation is invalid",
      );
    }
    const renderIds = new Set(operation.renderIds);
    const covered = new Set();
    const lines = [];
    for (const [index, rawLine] of packetOperation.lines.entries()) {
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
        baseSuppressions: [...state.suppressions.values()],
        affectedWorldBounds: state.affectedWorldBounds,
      }),
      "DWG renderer activateRenderDelta",
    );
  }

  #release(lines) {
    if (lines.length === 0) {
      return;
    }
    synchronous(
      this.#renderer.releaseRenderDeltaLines(lines),
      "DWG renderer releaseRenderDeltaLines",
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
      }
    } catch (error) {
      this.#release(staged);
      throw error;
    }
    return { identities, linesByOperation, staged };
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
          next.overlays.set(
            key,
            Object.freeze({
              layerId: operation.layerId,
              renderId,
              aspect: operation.aspect,
              lines: Object.freeze(lines),
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
  DWG_LINE_VERTEX_STRIDE,
  DWG_RENDER_DELTA_MEDIA_TYPE,
};

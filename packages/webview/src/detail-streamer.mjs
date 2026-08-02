import { GpuBatchCache } from "./batch-cache.mjs";
import { cameraViewportBounds } from "./camera.mjs";
import {
  boundsIntersect2D,
  packedBoundsIntersect2D,
  transformedBounds2D,
} from "./math.mjs";
import {
  GPU_LINE_VERTEX_RECORD_SIZE,
  GpuLineBatchKind,
} from "./scene-cache.mjs";
import { effectiveClipBounds } from "./instance-graph.mjs";

const DEFAULT_CACHE_BYTES = 96 * 1024 * 1024;
const DEFAULT_VISIBLE_BYTES = 32 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 2;

function sameInstanceSelection(left, right) {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function squaredDistance(x, y, centerX, centerY) {
  const deltaX = x - centerX;
  const deltaY = y - centerY;
  return deltaX * deltaX + deltaY * deltaY;
}

function candidateForModel(batch, viewport, centerX, centerY) {
  if (!boundsIntersect2D(batch.bounds, viewport)) {
    return null;
  }
  const batchCenterX = batch.bounds.min[0] * 0.5 + batch.bounds.max[0] * 0.5;
  const batchCenterY = batch.bounds.min[1] * 0.5 + batch.bounds.max[1] * 0.5;
  return {
    batch,
    instanceIndices: null,
    distance: squaredDistance(batchCenterX, batchCenterY, centerX, centerY),
  };
}

function candidateForInstances(
  batch,
  instances,
  instanceGraph,
  viewport,
  centerX,
  centerY,
) {
  if (!instances || instances.count === 0) {
    return null;
  }
  const visible = [];
  const transformed = new Float64Array(4);
  const clipBoundsCache = new Map();
  let distance = Infinity;
  for (let index = 0; index < instances.count; index += 1) {
    transformedBounds2D(batch.bounds, instances.data, index * 16, transformed);
    const clipId = instances.clipIds?.[index] ?? 0;
    if (clipId > 0) {
      let clipBounds = clipBoundsCache.get(clipId);
      if (clipBounds === undefined) {
        clipBounds = effectiveClipBounds(
          instanceGraph.clipNodes,
          clipId,
        );
        clipBoundsCache.set(clipId, clipBounds);
      }
      if (!clipBounds) {
        continue;
      }
      transformed[0] = Math.max(transformed[0], clipBounds.min[0]);
      transformed[1] = Math.max(transformed[1], clipBounds.min[1]);
      transformed[2] = Math.min(transformed[2], clipBounds.max[0]);
      transformed[3] = Math.min(transformed[3], clipBounds.max[1]);
      if (transformed[0] > transformed[2] || transformed[1] > transformed[3]) {
        continue;
      }
    }
    if (!packedBoundsIntersect2D(transformed, viewport)) {
      continue;
    }
    visible.push(index);
    distance = Math.min(
      distance,
      squaredDistance(
        transformed[0] * 0.5 + transformed[2] * 0.5,
        transformed[1] * 0.5 + transformed[3] * 0.5,
        centerX,
        centerY,
      ),
    );
  }
  if (visible.length === 0) {
    return null;
  }
  return {
    batch,
    instanceIndices: Uint32Array.from(visible),
    distance,
  };
}

function candidateForBlock(
  batch,
  instanceGraph,
  viewport,
  centerX,
  centerY,
) {
  return candidateForInstances(
    batch,
    instanceGraph.instancesByBlock.get(batch.blockIndex),
    instanceGraph,
    viewport,
    centerX,
    centerY,
  );
}

export function selectVisibleDetailBatches(
  batches,
  instanceGraph,
  camera,
  { maximumBytes = DEFAULT_VISIBLE_BYTES } = {},
) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new RangeError("visible detail byte budget must be positive");
  }
  const viewport = cameraViewportBounds(camera);
  const centerX = camera.origin[0];
  const centerY = camera.origin[1];
  const candidates = [];

  for (const batch of batches) {
    if (batch.lodLevel !== 1) {
      continue;
    }
    const candidate =
      batch.kind === GpuLineBatchKind.BlockDefinition
        ? candidateForBlock(
            batch,
            instanceGraph,
            viewport,
            centerX,
            centerY,
          )
        : instanceGraph.modelInstances
          ? candidateForInstances(
              batch,
              instanceGraph.modelInstances,
              instanceGraph,
              viewport,
              centerX,
              centerY,
            )
          : candidateForModel(batch, viewport, centerX, centerY);
    if (!candidate) {
      continue;
    }
    candidate.byteLength =
      batch.vertexCount * GPU_LINE_VERTEX_RECORD_SIZE;
    candidates.push(candidate);
  }

  candidates.sort(
    (left, right) =>
      left.distance - right.distance || left.batch.id - right.batch.id,
  );
  const selected = [];
  let selectedBytes = 0;
  for (const candidate of candidates) {
    if (candidate.byteLength > maximumBytes - selectedBytes) {
      continue;
    }
    selectedBytes += candidate.byteLength;
    selected.push(
      Object.freeze({
        ...candidate,
        selectedInstanceCount: candidate.instanceIndices?.length ?? 1,
      }),
    );
  }
  Object.defineProperty(selected, "byteLength", {
    value: selectedBytes,
    enumerable: false,
  });
  return Object.freeze(selected);
}

export class DetailStreamer {
  constructor(
    reader,
    renderer,
    batches,
    instanceGraph,
    {
      maximumCacheBytes = DEFAULT_CACHE_BYTES,
      maximumVisibleBytes = DEFAULT_VISIBLE_BYTES,
      concurrency = DEFAULT_CONCURRENCY,
      onUpdate = () => {},
      onError = () => {},
      onReviewBatch = () => false,
      onReviewBatchEvicted = () => {},
      onReviewSelection = () => {},
    } = {},
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
      throw new RangeError("detail streaming concurrency must be positive");
    }
    this.reader = reader;
    this.renderer = renderer;
    this.batches = batches;
    this.instanceGraph = instanceGraph;
    this.maximumVisibleBytes = maximumVisibleBytes;
    this.concurrency = concurrency;
    this.onUpdate = onUpdate;
    this.onError = onError;
    this.onReviewBatch = onReviewBatch;
    this.onReviewBatchEvicted = onReviewBatchEvicted;
    this.onReviewSelection = onReviewSelection;
    this.revision = 0;
    this.candidates = Object.freeze([]);
    this.loading = 0;
    this.lastRender = null;
    this.lastError = null;
    this.active = Promise.resolve();
    this.disposed = false;
    this.renderCamera = null;
    this.renderOptions = Object.freeze({});
    this.renderRequest = null;
    this.renderPromise = Promise.resolve();
    this.pendingRender = null;
    this.reviewEnabled = false;
    this.reviewRevision = 0;
    this.reviewActive = Promise.resolve();
    this.reviewedSelections = new Map();
    this.cache = new GpuBatchCache(
      async (batch) => {
        const vertices = await this.reader.readBatchVertices(batch);
        if (this.disposed) {
          return Object.freeze({
            batchId: batch.id,
            byteLength: vertices.byteLength,
            resource: null,
          });
        }
        const resource = this.renderer.addDetailBatch(batch, vertices);
        const candidate = this.candidates.find(
          (value) => value.batch.id === batch.id,
        );
        if (this.reviewEnabled && candidate) {
          this.publishReviewBatch(batch, vertices, candidate);
        }
        return Object.freeze({
          batchId: batch.id,
          byteLength: vertices.byteLength,
          resource,
        });
      },
      {
        maximumBytes: maximumCacheBytes,
        onEvict: (value) => {
          if (value.resource) {
            this.renderer.deleteDetailBatch(value.batchId);
          }
          this.reviewedSelections.delete(value.batchId);
          this.onReviewBatchEvicted(value.batchId);
        },
      },
    );
  }

  update(
    camera,
    { enabled = true, redraw = true, emit = true } = {},
  ) {
    if (this.disposed) {
      throw new Error("cannot update a disposed detail streamer");
    }
    const revision = ++this.revision;
    this.setRenderCamera(camera);
    this.lastError = null;
    this.candidates = enabled
      ? selectVisibleDetailBatches(
          this.batches,
          this.instanceGraph,
          camera,
          { maximumBytes: this.maximumVisibleBytes },
        )
      : Object.freeze([]);
    this.renderer.setDetailSelections(this.candidates);
    this.syncReviewSelection();
    this.lastRender = redraw ? this.renderer.redraw(camera) : null;

    const queue = [];
    for (const candidate of this.candidates) {
      if (this.cache.has(candidate.batch.id)) {
        void this.cache.get(candidate.batch);
      } else {
        queue.push(candidate.batch);
      }
    }
    this.loading = queue.length;
    if (emit) {
      this.emit();
    }
    let cursor = 0;
    const worker = async () => {
      while (revision === this.revision && cursor < queue.length) {
        const batch = queue[cursor];
        cursor += 1;
        try {
          await this.cache.get(batch);
        } catch (error) {
          if (revision === this.revision) {
            this.lastError = error;
            this.onError(error);
          }
          return;
        } finally {
          if (revision === this.revision) {
            this.loading = Math.max(this.loading - 1, 0);
          }
        }
        if (revision !== this.revision) {
          return;
        }
        this.scheduleRedraw(revision);
      }
    };
    const workerCount = Math.min(this.concurrency, queue.length);
    this.active = Promise.all(
      Array.from({ length: workerCount }, () => worker()),
    ).then(async () => {
      await this.renderPromise;
      if (revision === this.revision) {
        this.loading = 0;
        this.requestReviewBatches();
        this.emit();
      }
    });
    return this.snapshot();
  }

  async whenIdle() {
    await this.active;
    await this.reviewActive;
    return this.snapshot();
  }

  publishReviewBatch(batch, vertices, candidate) {
    if (!this.reviewEnabled || this.disposed) {
      return false;
    }
    const accepted = this.onReviewBatch(batch, vertices, candidate) !== false;
    if (accepted) {
      this.reviewedSelections.set(
        batch.id,
        candidate.instanceIndices
          ? Uint32Array.from(candidate.instanceIndices)
          : null,
      );
    }
    return accepted;
  }

  reviewSelectionIsCurrent(candidate) {
    return (
      this.reviewedSelections.has(candidate.batch.id) &&
      sameInstanceSelection(
        this.reviewedSelections.get(candidate.batch.id),
        candidate.instanceIndices,
      )
    );
  }

  syncReviewSelection() {
    if (!this.reviewEnabled) {
      return;
    }
    const selectedIds = new Set(
      this.candidates.map((candidate) => candidate.batch.id),
    );
    for (const batchId of this.reviewedSelections.keys()) {
      if (!selectedIds.has(batchId)) {
        this.reviewedSelections.delete(batchId);
      }
    }
    this.onReviewSelection(this.candidates);
  }

  requestReviewBatches() {
    if (!this.reviewEnabled || this.disposed) {
      return this.reviewActive;
    }
    const revision = ++this.reviewRevision;
    const candidates = [...this.candidates];
    this.reviewActive = this.reviewActive
      .catch(() => undefined)
      .then(async () => {
        for (const candidate of candidates) {
          if (
            revision !== this.reviewRevision ||
            !this.reviewEnabled ||
            this.disposed
          ) {
            return;
          }
          if (
            !this.cache.has(candidate.batch.id) ||
            this.reviewSelectionIsCurrent(candidate)
          ) {
            continue;
          }
          try {
            const vertices = await this.reader.readBatchVertices(
              candidate.batch,
            );
            const current = this.candidates.find(
              (value) => value.batch.id === candidate.batch.id,
            );
            if (
              revision === this.reviewRevision &&
              current &&
              this.reviewEnabled &&
              !this.disposed
            ) {
              this.publishReviewBatch(candidate.batch, vertices, current);
            }
          } catch (error) {
            if (
              revision === this.reviewRevision &&
              this.reviewEnabled &&
              !this.disposed
            ) {
              this.onError(error);
            }
          }
        }
      });
    return this.reviewActive;
  }

  setReviewEnabled(enabled) {
    const next = Boolean(enabled);
    if (next === this.reviewEnabled) {
      if (next) {
        this.syncReviewSelection();
        this.requestReviewBatches();
      }
      return next;
    }
    this.reviewEnabled = next;
    this.reviewRevision += 1;
    this.reviewedSelections.clear();
    if (next) {
      this.syncReviewSelection();
      this.requestReviewBatches();
    } else {
      this.onReviewSelection(Object.freeze([]));
    }
    return next;
  }

  snapshot() {
    return Object.freeze({
      revision: this.revision,
      selectedBatches: this.candidates.length,
      selectedBytes: this.candidates.byteLength ?? 0,
      selectedInstances: this.candidates.reduce(
        (total, candidate) => total + candidate.selectedInstanceCount,
        0,
      ),
      loading: this.loading,
      cache: this.cache.snapshot(),
      render: this.lastRender,
      error: this.lastError,
    });
  }

  emit() {
    this.onUpdate(this.snapshot());
  }

  setRenderCamera(camera, renderOptions = {}) {
    if (this.disposed) {
      return false;
    }
    if (
      !camera ||
      !Array.isArray(camera.origin) ||
      !Number.isFinite(camera.worldHeight) ||
      camera.worldHeight <= 0
    ) {
      throw new TypeError("detail render camera is invalid");
    }
    this.renderCamera = camera;
    this.renderOptions = Object.freeze({ ...renderOptions });
    return true;
  }

  scheduleRedraw(revision) {
    this.pendingRender = { revision };
    if (this.renderRequest !== null) {
      return;
    }
    const schedule =
      globalThis.requestAnimationFrame ??
      ((callback) => globalThis.setTimeout(callback, 0));
    this.renderPromise = new Promise((resolve) => {
      this.renderRequest = schedule(() => {
        this.renderRequest = null;
        const pending = this.pendingRender;
        this.pendingRender = null;
        if (
          pending?.revision === this.revision &&
          this.renderCamera
        ) {
          this.lastRender = this.renderer.redraw(
            this.renderCamera,
            this.renderOptions,
          );
          this.emit();
        }
        resolve();
      });
    });
  }

  dispose() {
    this.disposed = true;
    this.revision += 1;
    this.reviewRevision += 1;
    this.loading = 0;
    this.candidates = Object.freeze([]);
    this.renderCamera = null;
    this.renderOptions = Object.freeze({});
    this.renderer.setDetailSelections(this.candidates);
    this.reviewedSelections.clear();
    this.onReviewSelection(Object.freeze([]));
    this.cache.clear();
  }
}

export {
  DEFAULT_CACHE_BYTES,
  DEFAULT_CONCURRENCY,
  DEFAULT_VISIBLE_BYTES,
};

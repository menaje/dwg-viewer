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

const DEFAULT_CACHE_BYTES = 96 * 1024 * 1024;
const DEFAULT_VISIBLE_BYTES = 32 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 2;

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

function candidateForBlock(
  batch,
  instanceGraph,
  viewport,
  centerX,
  centerY,
) {
  const instances = instanceGraph.instancesByBlock.get(batch.blockIndex);
  if (!instances || instances.count === 0) {
    return null;
  }
  const visible = [];
  const transformed = new Float64Array(4);
  let distance = Infinity;
  for (let index = 0; index < instances.count; index += 1) {
    transformedBounds2D(batch.bounds, instances.data, index * 16, transformed);
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
    this.revision = 0;
    this.candidates = Object.freeze([]);
    this.loading = 0;
    this.lastRender = null;
    this.lastError = null;
    this.active = Promise.resolve();
    this.disposed = false;
    this.renderRequest = null;
    this.renderPromise = Promise.resolve();
    this.pendingRender = null;
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
        },
      },
    );
  }

  update(camera, { enabled = true } = {}) {
    if (this.disposed) {
      throw new Error("cannot update a disposed detail streamer");
    }
    const revision = ++this.revision;
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
    this.lastRender = this.renderer.redraw(camera);

    const queue = [];
    for (const candidate of this.candidates) {
      if (this.cache.has(candidate.batch.id)) {
        void this.cache.get(candidate.batch);
      } else {
        queue.push(candidate.batch);
      }
    }
    this.loading = queue.length;
    this.emit();
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
        this.scheduleRedraw(revision, camera);
      }
    };
    const workerCount = Math.min(this.concurrency, queue.length);
    this.active = Promise.all(
      Array.from({ length: workerCount }, () => worker()),
    ).then(async () => {
      await this.renderPromise;
      if (revision === this.revision) {
        this.loading = 0;
        this.emit();
      }
    });
    return this.snapshot();
  }

  async whenIdle() {
    await this.active;
    return this.snapshot();
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

  scheduleRedraw(revision, camera) {
    this.pendingRender = { revision, camera };
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
        if (pending?.revision === this.revision) {
          this.lastRender = this.renderer.redraw(pending.camera);
          this.emit();
        }
        resolve();
      });
    });
  }

  dispose() {
    this.disposed = true;
    this.revision += 1;
    this.loading = 0;
    this.candidates = Object.freeze([]);
    this.renderer.setDetailSelections(this.candidates);
    this.cache.clear();
  }
}

export {
  DEFAULT_CACHE_BYTES,
  DEFAULT_CONCURRENCY,
  DEFAULT_VISIBLE_BYTES,
};

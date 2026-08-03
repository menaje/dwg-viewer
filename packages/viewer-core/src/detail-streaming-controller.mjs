import { GpuBatchCache } from "./batch-cache.mjs";

const DEFAULT_CACHE_BYTES = 96 * 1024 * 1024;
const DEFAULT_VISIBLE_BYTES = 32 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 2;

function method(value, name) {
  if (typeof value?.[name] !== "function") {
    throw new TypeError(
      `detail streaming adapter must implement ${name}()`,
    );
  }
}

function assertAdapter(value) {
  for (const name of [
    "selectCandidates",
    "loadCandidate",
    "mountCandidate",
    "unmountCandidate",
    "setSelection",
    "redraw",
  ]) {
    method(value, name);
  }
  if (
    value.dispose !== undefined &&
    typeof value.dispose !== "function"
  ) {
    throw new TypeError(
      "detail streaming adapter dispose must be a function when provided",
    );
  }
  if (
    value.sameSelection !== undefined &&
    typeof value.sameSelection !== "function"
  ) {
    throw new TypeError(
      "detail streaming adapter sameSelection must be a function when provided",
    );
  }
  return value;
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be positive`);
  }
  return value;
}

function candidateId(candidate) {
  if (
    candidate?.id === undefined ||
    candidate.id === null ||
    (typeof candidate.id !== "string" &&
      !Number.isSafeInteger(candidate.id))
  ) {
    throw new TypeError(
      "detail candidate must have a string or safe-integer id",
    );
  }
  return candidate.id;
}

function candidateArray(value) {
  if (!Array.isArray(value)) {
    throw new TypeError(
      "detail streaming adapter must return a candidate array",
    );
  }
  const identifiers = new Set();
  for (const candidate of value) {
    const id = candidateId(candidate);
    if (identifiers.has(id)) {
      throw new TypeError(`detail candidate ${id} is duplicated`);
    }
    identifiers.add(id);
  }
  return value;
}

function payloadBytes(value) {
  if (
    !Number.isSafeInteger(value?.byteLength) ||
    value.byteLength <= 0
  ) {
    throw new TypeError(
      "detail candidate payload must report a positive byteLength",
    );
  }
  return value.byteLength;
}

function assertCamera(camera) {
  if (
    !camera ||
    !Array.isArray(camera.origin) ||
    camera.origin.length < 2 ||
    !camera.origin.every(Number.isFinite) ||
    !Number.isFinite(camera.worldHeight) ||
    camera.worldHeight <= 0
  ) {
    throw new TypeError("detail render camera is invalid");
  }
  return camera;
}

export class DetailStreamingController {
  constructor(
    adapter,
    {
      maximumCacheBytes = DEFAULT_CACHE_BYTES,
      maximumVisibleBytes = DEFAULT_VISIBLE_BYTES,
      concurrency = DEFAULT_CONCURRENCY,
      onUpdate = () => {},
      onError = () => {},
      onReviewCandidate = () => false,
      onReviewCandidateEvicted = () => {},
      onReviewSelection = () => {},
    } = {},
  ) {
    this.adapter = assertAdapter(adapter);
    this.maximumVisibleBytes = positiveSafeInteger(
      maximumVisibleBytes,
      "visible detail byte budget",
    );
    this.concurrency = positiveSafeInteger(
      concurrency,
      "detail streaming concurrency",
    );
    this.onUpdate = onUpdate;
    this.onError = onError;
    this.onReviewCandidate = onReviewCandidate;
    this.onReviewCandidateEvicted = onReviewCandidateEvicted;
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
      async (candidate) => {
        const payload = await this.adapter.loadCandidate(candidate);
        const byteLength = payloadBytes(payload);
        if (this.disposed) {
          return Object.freeze({
            candidate,
            byteLength,
            resource: null,
          });
        }
        const resource = this.adapter.mountCandidate(
          candidate,
          payload,
        );
        const current = this.candidates.find(
          (value) => value.id === candidate.id,
        );
        if (this.reviewEnabled && current) {
          this.publishReviewCandidate(current, payload);
        }
        return Object.freeze({
          candidate,
          byteLength,
          resource,
        });
      },
      {
        maximumBytes: positiveSafeInteger(
          maximumCacheBytes,
          "detail cache byte budget",
        ),
        onEvict: (value, id) => {
          if (value.resource !== null && value.resource !== undefined) {
            this.adapter.unmountCandidate(
              value.candidate,
              value.resource,
            );
          }
          this.reviewedSelections.delete(id);
          this.onReviewCandidateEvicted(id);
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
      ? candidateArray(
          this.adapter.selectCandidates(camera, {
            maximumBytes: this.maximumVisibleBytes,
          }),
        )
      : Object.freeze([]);
    this.adapter.setSelection(this.candidates);
    this.syncReviewSelection();
    this.lastRender = redraw
      ? this.adapter.redraw(camera, this.renderOptions)
      : null;

    const queue = [];
    for (const candidate of this.candidates) {
      if (this.cache.has(candidate.id)) {
        void this.cache.get(candidate);
      } else {
        queue.push(candidate);
      }
    }
    this.loading = queue.length;
    if (emit) {
      this.emit();
    }
    let cursor = 0;
    const worker = async () => {
      while (revision === this.revision && cursor < queue.length) {
        const candidate = queue[cursor];
        cursor += 1;
        try {
          await this.cache.get(candidate);
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
        this.requestReviewCandidates();
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

  publishReviewCandidate(candidate, payload) {
    if (!this.reviewEnabled || this.disposed) {
      return false;
    }
    const accepted =
      this.onReviewCandidate(candidate, payload) !== false;
    if (accepted) {
      this.reviewedSelections.set(candidate.id, candidate);
    }
    return accepted;
  }

  reviewSelectionIsCurrent(candidate) {
    const reviewed = this.reviewedSelections.get(candidate.id);
    if (!reviewed) {
      return false;
    }
    return this.adapter.sameSelection
      ? this.adapter.sameSelection(reviewed, candidate)
      : reviewed === candidate;
  }

  syncReviewSelection() {
    if (!this.reviewEnabled) {
      return;
    }
    const selectedIds = new Set(
      this.candidates.map((candidate) => candidate.id),
    );
    for (const id of this.reviewedSelections.keys()) {
      if (!selectedIds.has(id)) {
        this.reviewedSelections.delete(id);
      }
    }
    this.onReviewSelection(this.candidates);
  }

  requestReviewCandidates() {
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
            !this.cache.has(candidate.id) ||
            this.reviewSelectionIsCurrent(candidate)
          ) {
            continue;
          }
          try {
            const payload =
              await this.adapter.loadCandidate(candidate);
            payloadBytes(payload);
            const current = this.candidates.find(
              (value) => value.id === candidate.id,
            );
            if (
              revision === this.reviewRevision &&
              current &&
              this.reviewEnabled &&
              !this.disposed
            ) {
              this.publishReviewCandidate(current, payload);
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
        this.requestReviewCandidates();
      }
      return next;
    }
    this.reviewEnabled = next;
    this.reviewRevision += 1;
    this.reviewedSelections.clear();
    if (next) {
      this.syncReviewSelection();
      this.requestReviewCandidates();
    } else {
      this.onReviewSelection(Object.freeze([]));
    }
    return next;
  }

  snapshot() {
    const selectedBytes =
      Number.isSafeInteger(this.candidates.byteLength) &&
      this.candidates.byteLength >= 0
        ? this.candidates.byteLength
        : this.candidates.reduce(
            (total, candidate) =>
              total +
              (Number.isSafeInteger(candidate.byteLength)
                ? candidate.byteLength
                : 0),
            0,
          );
    return Object.freeze({
      revision: this.revision,
      selectedBatches: this.candidates.length,
      selectedBytes,
      selectedInstances: this.candidates.reduce(
        (total, candidate) =>
          total +
          (Number.isSafeInteger(candidate.selectedInstanceCount)
            ? candidate.selectedInstanceCount
            : 1),
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
    this.renderCamera = assertCamera(camera);
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
          this.lastRender = this.adapter.redraw(
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
    if (this.disposed) {
      return false;
    }
    this.disposed = true;
    this.revision += 1;
    this.reviewRevision += 1;
    this.loading = 0;
    this.candidates = Object.freeze([]);
    this.renderCamera = null;
    this.renderOptions = Object.freeze({});
    this.adapter.setSelection(this.candidates);
    this.reviewedSelections.clear();
    this.onReviewSelection(Object.freeze([]));
    this.cache.clear();
    this.adapter.dispose?.();
    return true;
  }
}

export {
  DEFAULT_CACHE_BYTES,
  DEFAULT_CONCURRENCY,
  DEFAULT_VISIBLE_BYTES,
};

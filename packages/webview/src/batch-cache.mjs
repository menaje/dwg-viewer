const DEFAULT_MAXIMUM_BYTES = 128 * 1024 * 1024;

export class GpuBatchCache {
  constructor(reader, { maximumBytes = DEFAULT_MAXIMUM_BYTES } = {}) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new RangeError("GPU batch cache maximumBytes must be positive");
    }
    this.reader = reader;
    this.maximumBytes = maximumBytes;
    this.entries = new Map();
    this.pending = new Map();
    this.bytes = 0;
    this.generation = 0;
  }

  async get(batch) {
    const existing = this.entries.get(batch.id);
    if (existing) {
      this.entries.delete(batch.id);
      this.entries.set(batch.id, existing);
      return existing.value;
    }
    if (this.pending.has(batch.id)) {
      return this.pending.get(batch.id);
    }

    const generation = this.generation;
    let promise;
    promise = this.reader
      .readBatchVertices(batch)
      .then((value) => {
        if (this.pending.get(batch.id) === promise) {
          this.pending.delete(batch.id);
        }
        if (generation !== this.generation) {
          return value;
        }
        if (value.byteLength > this.maximumBytes) {
          return value;
        }
        this.entries.set(batch.id, { value, byteLength: value.byteLength });
        this.bytes += value.byteLength;
        this.evict();
        return value;
      })
      .catch((error) => {
        if (this.pending.get(batch.id) === promise) {
          this.pending.delete(batch.id);
        }
        throw error;
      });
    this.pending.set(batch.id, promise);
    return promise;
  }

  has(batchId) {
    return this.entries.has(batchId);
  }

  clear() {
    this.generation += 1;
    this.entries.clear();
    this.pending.clear();
    this.bytes = 0;
  }

  snapshot() {
    return Object.freeze({
      entries: this.entries.size,
      pending: this.pending.size,
      bytes: this.bytes,
      maximumBytes: this.maximumBytes,
    });
  }

  evict() {
    for (const [batchId, entry] of this.entries) {
      if (this.bytes <= this.maximumBytes) {
        break;
      }
      this.entries.delete(batchId);
      this.bytes -= entry.byteLength;
    }
  }
}

export { DEFAULT_MAXIMUM_BYTES };

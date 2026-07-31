export const WEBVIEW_MEMORY_HARD_LIMIT_BYTES = 300 * 1024 * 1024;

function byteCount(value) {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  return Math.floor(value);
}

export function readJsHeapSnapshot(
  performanceObject = globalThis.performance,
) {
  const memory = performanceObject?.memory;
  const usedJsHeapBytes = byteCount(memory?.usedJSHeapSize);
  if (usedJsHeapBytes === null) {
    return null;
  }
  return Object.freeze({
    usedJsHeapBytes,
    totalJsHeapBytes: byteCount(memory.totalJSHeapSize),
    jsHeapLimitBytes: byteCount(memory.jsHeapSizeLimit),
  });
}

export class WebviewMemoryTelemetry {
  constructor({
    performanceObject = globalThis.performance,
    hardLimitBytes = WEBVIEW_MEMORY_HARD_LIMIT_BYTES,
  } = {}) {
    if (!Number.isSafeInteger(hardLimitBytes) || hardLimitBytes <= 0) {
      throw new RangeError("Webview memory hard limit must be positive");
    }
    this.performanceObject = performanceObject;
    this.hardLimitBytes = hardLimitBytes;
    this.peakUsedJsHeapBytes = null;
    this.peakGpuTrackedBytes = 0;
  }

  sample(gpuTrackedBytes = 0) {
    const normalizedGpuBytes = byteCount(gpuTrackedBytes);
    if (normalizedGpuBytes === null) {
      throw new RangeError("tracked GPU bytes must be finite and non-negative");
    }
    const heap = readJsHeapSnapshot(this.performanceObject);
    if (heap) {
      this.peakUsedJsHeapBytes = Math.max(
        this.peakUsedJsHeapBytes ?? 0,
        heap.usedJsHeapBytes,
      );
    }
    this.peakGpuTrackedBytes = Math.max(
      this.peakGpuTrackedBytes,
      normalizedGpuBytes,
    );
    return Object.freeze({
      jsHeapAvailable: Boolean(heap),
      usedJsHeapBytes: heap?.usedJsHeapBytes ?? null,
      totalJsHeapBytes: heap?.totalJsHeapBytes ?? null,
      jsHeapLimitBytes: heap?.jsHeapLimitBytes ?? null,
      peakUsedJsHeapBytes: this.peakUsedJsHeapBytes,
      gpuTrackedBytes: normalizedGpuBytes,
      peakGpuTrackedBytes: this.peakGpuTrackedBytes,
      hardLimitBytes: this.hardLimitBytes,
      hardLimitExceeded:
        this.peakUsedJsHeapBytes !== null &&
        this.peakUsedJsHeapBytes > this.hardLimitBytes,
    });
  }
}

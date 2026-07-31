import { validateRange } from "./range-source.mjs";

export const MAX_HOST_RANGE_BYTES = 8 * 1024 * 1024;
export const WORKER_RANGE_REQUEST = "dwg-worker-range-read/1";
export const WORKER_RANGE_RESPONSE = "dwg-worker-range-response/1";

function responseBuffer(bytes, expectedLength) {
  let buffer;
  if (bytes instanceof ArrayBuffer) {
    buffer = bytes;
  } else if (ArrayBuffer.isView(bytes)) {
    buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
  } else if (Array.isArray(bytes)) {
    buffer = Uint8Array.from(bytes).buffer;
  } else {
    throw new TypeError("range response does not contain binary bytes");
  }
  if (buffer.byteLength !== expectedLength) {
    throw new Error(
      `short range response: expected ${expectedLength} bytes, received ${buffer.byteLength}`,
    );
  }
  return buffer;
}

export class MessageRangeSource {
  constructor({
    size,
    send,
    subscribe,
    requestType,
    responseType,
    requestFields = {},
    maximumBytes = MAX_HOST_RANGE_BYTES,
  }) {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new RangeError("message range source size is invalid");
    }
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new RangeError("message range source limit must be positive");
    }
    if (typeof send !== "function" || typeof subscribe !== "function") {
      throw new TypeError("message range source requires a message channel");
    }
    this.size = size;
    this.send = send;
    this.requestType = requestType;
    this.responseType = responseType;
    this.requestFields = Object.freeze({ ...requestFields });
    this.maximumBytes = maximumBytes;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.disposed = false;
    this.unsubscribe = subscribe((message) => {
      this.receive(message);
    });
  }

  read(offset, length) {
    validateRange(offset, length, this.size);
    if (length > this.maximumBytes) {
      throw new RangeError(
        `range request exceeds the ${this.maximumBytes}-byte host limit`,
      );
    }
    if (this.disposed) {
      return Promise.reject(
        new DOMException("range source disposed", "AbortError"),
      );
    }
    if (length === 0) {
      return Promise.resolve(new ArrayBuffer(0));
    }
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { length, resolve, reject });
      try {
        this.send({
          type: this.requestType,
          ...this.requestFields,
          requestId,
          offset,
          length,
        });
      } catch (error) {
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  receive(message) {
    if (message?.type !== this.responseType) {
      return;
    }
    const request = this.pending.get(message.requestId);
    if (!request) {
      return;
    }
    this.pending.delete(message.requestId);
    if (!message.ok) {
      request.reject(
        new Error(
          typeof message.error === "string"
            ? message.error.slice(0, 500)
            : "range request failed",
        ),
      );
      return;
    }
    try {
      request.resolve(responseBuffer(message.bytes, request.length));
    } catch (error) {
      request.reject(error);
    }
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const error = new DOMException("range source disposed", "AbortError");
    for (const request of this.pending.values()) {
      request.reject(error);
    }
    this.pending.clear();
  }
}

export function createVsCodeRangeSource(
  vscodeApi,
  { cacheId, size },
  messageTarget = globalThis.window,
) {
  if (!vscodeApi || typeof vscodeApi.postMessage !== "function") {
    throw new TypeError("VS Code range source requires the Webview API");
  }
  if (typeof cacheId !== "string" || !/^[a-f0-9]{64}$/.test(cacheId)) {
    throw new TypeError("VS Code cache ID is invalid");
  }
  return new MessageRangeSource({
    size,
    requestType: "dwg-cache-range-read/1",
    responseType: "dwg-cache-range-response/1",
    requestFields: { cacheId },
    send: (message) => vscodeApi.postMessage(message),
    subscribe: (listener) => {
      const handler = (event) => {
        if (event.data?.cacheId === cacheId) {
          listener(event.data);
        }
      };
      messageTarget.addEventListener("message", handler);
      return () => messageTarget.removeEventListener("message", handler);
    },
  });
}

export function createWorkerHostRangeSource(
  { size },
  workerScope = globalThis.self,
) {
  return new MessageRangeSource({
    size,
    requestType: WORKER_RANGE_REQUEST,
    responseType: WORKER_RANGE_RESPONSE,
    send: (message) => workerScope.postMessage(message),
    subscribe: (listener) => {
      const handler = (event) => listener(event.data);
      workerScope.addEventListener("message", handler);
      return () => workerScope.removeEventListener("message", handler);
    },
  });
}

export function installWorkerRangeProxy(worker, source) {
  if (!worker || typeof worker.addEventListener !== "function") {
    throw new TypeError("worker range proxy requires a Worker");
  }
  if (!source || typeof source.read !== "function") {
    throw new TypeError("worker range proxy requires a range source");
  }
  let disposed = false;
  const handler = async (event) => {
    const message = event.data;
    if (disposed || message?.type !== WORKER_RANGE_REQUEST) {
      return;
    }
    try {
      const bytes = await source.read(message.offset, message.length);
      if (disposed) {
        return;
      }
      worker.postMessage(
        {
          type: WORKER_RANGE_RESPONSE,
          requestId: message.requestId,
          ok: true,
          bytes,
        },
        [bytes],
      );
    } catch (error) {
      if (!disposed) {
        worker.postMessage({
          type: WORKER_RANGE_RESPONSE,
          requestId: message.requestId,
          ok: false,
          error: error instanceof Error ? error.message.slice(0, 500) : "range request failed",
        });
      }
    }
  };
  worker.addEventListener("message", handler);
  return () => {
    disposed = true;
    worker.removeEventListener("message", handler);
  };
}

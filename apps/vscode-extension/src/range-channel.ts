import { open, type FileHandle } from "node:fs/promises";

export const MAX_RANGE_BYTES = 8 * 1024 * 1024;
// At most 32 MiB of host-side range buffers can be live concurrently.
const MAX_CONCURRENT_READS = 4;
const MAX_QUEUED_READS = 32;

interface RangeRequestMessage {
  type: "dwg-cache-range-read/1";
  cacheId: string;
  requestId: number;
  offset: number;
  length: number;
}

interface PendingRange {
  request: RangeRequestMessage;
}

type PostMessage = (message: unknown) => PromiseLike<boolean>;

function validRequestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function errorText(error: unknown): string {
  if (error instanceof RangeError) {
    return error.message.slice(0, 200);
  }
  return "cache range read failed";
}

export class CacheRangeChannel {
  private readonly queue: PendingRange[] = [];
  private activeReads = 0;
  private disposed = false;

  private constructor(
    readonly cacheId: string,
    readonly size: number,
    private readonly handle: FileHandle,
    private readonly postMessage: PostMessage,
  ) {}

  static async open(
    cacheId: string,
    cachePath: string,
    expectedSize: number,
    postMessage: PostMessage,
  ): Promise<CacheRangeChannel> {
    if (!/^[a-f0-9]{64}$/.test(cacheId)) {
      throw new TypeError("invalid cache ID");
    }
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
      throw new RangeError("invalid cache size");
    }
    const handle = await open(cachePath, "r");
    try {
      const metadata = await handle.stat();
      if (metadata.size !== expectedSize) {
        throw new Error("cache size changed before opening");
      }
      return new CacheRangeChannel(
        cacheId,
        expectedSize,
        handle,
        postMessage,
      );
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  handleMessage(message: unknown): boolean {
    if (
      typeof message !== "object" ||
      message === null ||
      (message as { type?: unknown }).type !== "dwg-cache-range-read/1"
    ) {
      return false;
    }
    const candidate = message as Partial<RangeRequestMessage>;
    if (!validRequestId(candidate.requestId)) {
      return true;
    }
    if (this.disposed) {
      void this.respondError(candidate.requestId, "cache channel disposed");
      return true;
    }
    try {
      this.validateRequest(candidate);
    } catch (error) {
      void this.respondError(candidate.requestId, errorText(error));
      return true;
    }
    if (this.queue.length >= MAX_QUEUED_READS) {
      void this.respondError(candidate.requestId, "cache range queue is full");
      return true;
    }
    this.queue.push({ request: candidate as RangeRequestMessage });
    this.pump();
    return true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const { request } of this.queue.splice(0)) {
      await this.respondError(request.requestId, "cache channel disposed");
    }
    await this.handle.close().catch(() => undefined);
  }

  private validateRequest(
    request: Partial<RangeRequestMessage>,
  ): asserts request is RangeRequestMessage {
    if (request.cacheId !== this.cacheId) {
      throw new RangeError("cache ID mismatch");
    }
    if (!Number.isSafeInteger(request.offset) || (request.offset ?? -1) < 0) {
      throw new RangeError("invalid cache range offset");
    }
    if (!Number.isSafeInteger(request.length) || (request.length ?? -1) < 0) {
      throw new RangeError("invalid cache range length");
    }
    if ((request.length as number) > MAX_RANGE_BYTES) {
      throw new RangeError("cache range exceeds the 8 MiB limit");
    }
    const end = (request.offset as number) + (request.length as number);
    if (!Number.isSafeInteger(end) || end > this.size) {
      throw new RangeError("cache range exceeds the cache size");
    }
  }

  private pump(): void {
    while (
      !this.disposed &&
      this.activeReads < MAX_CONCURRENT_READS &&
      this.queue.length > 0
    ) {
      const pending = this.queue.shift();
      if (!pending) {
        return;
      }
      this.activeReads += 1;
      void this.execute(pending.request).finally(() => {
        this.activeReads -= 1;
        this.pump();
      });
    }
  }

  private async execute(request: RangeRequestMessage): Promise<void> {
    try {
      const bytes = new Uint8Array(request.length);
      let readBytes = 0;
      while (readBytes < request.length) {
        const result = await this.handle.read(
          bytes,
          readBytes,
          request.length - readBytes,
          request.offset + readBytes,
        );
        if (result.bytesRead === 0) {
          throw new Error("short cache read");
        }
        readBytes += result.bytesRead;
      }
      if (!this.disposed) {
        await this.postMessage({
          type: "dwg-cache-range-response/1",
          cacheId: this.cacheId,
          requestId: request.requestId,
          ok: true,
          bytes: bytes.buffer,
        });
      }
    } catch (error) {
      if (!this.disposed) {
        await this.respondError(request.requestId, errorText(error));
      }
    }
  }

  private async respondError(
    requestId: number,
    message: string,
  ): Promise<void> {
    await Promise.resolve(
      this.postMessage({
        type: "dwg-cache-range-response/1",
        cacheId: this.cacheId,
        requestId,
        ok: false,
        error: message.slice(0, 200),
      }),
    ).catch(() => false);
  }
}

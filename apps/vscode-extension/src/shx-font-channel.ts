import { open, opendir, type FileHandle } from "node:fs/promises";
import path from "node:path";

export const MAX_SHX_FONT_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_SHX_FONT_TRANSFER_BYTES = 64 * 1024 * 1024;
export const MAX_SHX_FONT_DIRECTORIES = 32;
export const MAX_SHX_FONT_REQUESTS = 128;

const MAX_INDEXED_FONT_FILES = 16_384;
const MAX_FONT_NAME_BYTES = 512;

type FontSource = "drawing" | "configured" | "mapping";
type FontFailureStatus =
  | "missing"
  | "invalid"
  | "too-large"
  | "budget-exceeded"
  | "unreadable";

interface FontReadRequest {
  type: "dwg-font-read/1";
  cacheId: string;
  requestId: number;
  name: string;
}

interface FontCandidate {
  filePath: string;
  resolvedName: string;
  source: FontSource;
}

interface IndexedFont {
  filePath: string;
  resolvedName: string;
  source: Exclude<FontSource, "mapping">;
}

export interface ShxFontChannelOptions {
  drawingDirectory: string;
  fontDirectories?: readonly string[];
  fontMappings?: Readonly<Record<string, string>>;
  maximumFileBytes?: number;
  maximumTransferBytes?: number;
}

type PostMessage = (message: unknown) => PromiseLike<boolean>;

function validRequestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function aliasesForCanonicalName(name: string): readonly string[] {
  const aliases = new Set([name]);
  if (name.endsWith(".shx")) {
    aliases.add(name.slice(0, -4));
  } else {
    aliases.add(`${name}.shx`);
  }
  return [...aliases];
}

export function normalizeShxFontName(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const unquoted = value.trim().replace(/^["']|["']$/gu, "");
  if (
    unquoted.length === 0 ||
    Buffer.byteLength(unquoted, "utf8") > MAX_FONT_NAME_BYTES ||
    unquoted.includes("\0")
  ) {
    return "";
  }
  const basename = unquoted.split(/[\\/]/u).at(-1)?.trim() ?? "";
  if (
    basename.length === 0 ||
    basename === "." ||
    basename === ".." ||
    basename.includes("\0")
  ) {
    return "";
  }
  const normalized = basename.toLocaleLowerCase("en-US");
  if (normalized.endsWith(".shx")) {
    return normalized;
  }
  if (normalized.includes(".")) {
    return "";
  }
  return `${normalized}.shx`;
}

function normalizedPathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32"
    ? resolved.toLocaleLowerCase("en-US")
    : resolved;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return resolved;
}

class ShxFontResolver {
  private readonly directories: readonly {
    directoryPath: string;
    source: Exclude<FontSource, "mapping">;
  }[];
  private readonly mappings = new Map<string, string>();
  private readonly index = new Map<string, IndexedFont>();
  private nextDirectoryIndex = 0;
  private indexedFiles = 0;

  constructor(options: ShxFontChannelOptions) {
    const directories: {
      directoryPath: string;
      source: Exclude<FontSource, "mapping">;
    }[] = [];
    const seen = new Set<string>();
    const addDirectory = (
      value: unknown,
      source: Exclude<FontSource, "mapping">,
    ): void => {
      if (
        typeof value !== "string" ||
        value.trim().length === 0 ||
        !path.isAbsolute(value)
      ) {
        return;
      }
      const directoryPath = path.resolve(value);
      const key = normalizedPathKey(directoryPath);
      if (seen.has(key) || directories.length >= MAX_SHX_FONT_DIRECTORIES) {
        return;
      }
      seen.add(key);
      directories.push({ directoryPath, source });
    };

    addDirectory(options.drawingDirectory, "drawing");
    for (const directory of options.fontDirectories ?? []) {
      addDirectory(directory, "configured");
    }
    this.directories = Object.freeze(directories);

    for (const [requestedName, replacement] of Object.entries(
      options.fontMappings ?? {},
    )) {
      const normalized = normalizeShxFontName(requestedName);
      if (
        !normalized ||
        typeof replacement !== "string" ||
        replacement.trim().length === 0
      ) {
        continue;
      }
      for (const alias of aliasesForCanonicalName(normalized)) {
        this.mappings.set(alias, replacement.trim());
      }
    }
  }

  async resolve(requestedName: string): Promise<FontCandidate | undefined> {
    const normalized = normalizeShxFontName(requestedName);
    if (!normalized) {
      return undefined;
    }
    let replacement: string | undefined;
    for (const alias of aliasesForCanonicalName(normalized)) {
      replacement = this.mappings.get(alias);
      if (replacement) {
        break;
      }
    }
    if (replacement && path.isAbsolute(replacement)) {
      const normalized = normalizeShxFontName(path.basename(replacement));
      if (!normalized) {
        return undefined;
      }
      return {
        filePath: path.resolve(replacement),
        resolvedName: path.basename(replacement),
        source: "mapping",
      };
    }
    const targetName = replacement
      ? normalizeShxFontName(replacement)
      : normalized;
    if (!targetName) {
      return undefined;
    }
    let indexed = this.findIndexed(targetName);
    while (
      !indexed &&
      this.nextDirectoryIndex < this.directories.length &&
      this.indexedFiles < MAX_INDEXED_FONT_FILES
    ) {
      const directory = this.directories[this.nextDirectoryIndex];
      this.nextDirectoryIndex += 1;
      await this.scanDirectory(directory);
      indexed = this.findIndexed(targetName);
    }
    if (!indexed) {
      return undefined;
    }
    return replacement ? { ...indexed, source: "mapping" } : indexed;
  }

  private findIndexed(name: string): IndexedFont | undefined {
    for (const alias of aliasesForCanonicalName(name)) {
      const indexed = this.index.get(alias);
      if (indexed) {
        return indexed;
      }
    }
    return undefined;
  }

  private async scanDirectory(
    directory: {
      directoryPath: string;
      source: Exclude<FontSource, "mapping">;
    },
  ): Promise<void> {
    try {
      const handle = await opendir(directory.directoryPath);
      for await (const entry of handle) {
        if (this.indexedFiles >= MAX_INDEXED_FONT_FILES) {
          break;
        }
        if (!entry.isFile()) {
          continue;
        }
        const normalized = normalizeShxFontName(entry.name);
        if (
          !normalized ||
          !entry.name.toLocaleLowerCase("en-US").endsWith(".shx")
        ) {
          continue;
        }
        const candidate: IndexedFont = {
          filePath: path.join(directory.directoryPath, entry.name),
          resolvedName: entry.name,
          source: directory.source,
        };
        let added = false;
        for (const alias of aliasesForCanonicalName(normalized)) {
          if (!this.index.has(alias)) {
            this.index.set(alias, candidate);
            added = true;
          }
        }
        if (added) {
          this.indexedFiles += 1;
        }
      }
    } catch {
      // Missing or unreadable user-configured directories are treated as empty.
    }
  }
}

async function readExactFile(
  handle: FileHandle,
  byteLength: number,
): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(byteLength);
  let readBytes = 0;
  while (readBytes < byteLength) {
    const result = await handle.read(
      bytes,
      readBytes,
      byteLength - readBytes,
      readBytes,
    );
    if (result.bytesRead === 0) {
      throw new Error("short SHX font read");
    }
    readBytes += result.bytesRead;
  }
  return bytes.buffer;
}

export class ShxFontChannel {
  private readonly resolver: ShxFontResolver;
  private readonly maximumFileBytes: number;
  private readonly maximumTransferBytes: number;
  private readonly queue: FontReadRequest[] = [];
  private active = false;
  private disposed = false;
  private acceptedRequests = 0;
  private transferredBytes = 0;

  constructor(
    readonly cacheId: string,
    options: ShxFontChannelOptions,
    private readonly postMessage: PostMessage,
  ) {
    if (!/^[a-f0-9]{64}$/u.test(cacheId)) {
      throw new TypeError("invalid cache ID");
    }
    this.maximumFileBytes = boundedPositiveInteger(
      options.maximumFileBytes,
      MAX_SHX_FONT_FILE_BYTES,
      "maximumFileBytes",
    );
    this.maximumTransferBytes = boundedPositiveInteger(
      options.maximumTransferBytes,
      MAX_SHX_FONT_TRANSFER_BYTES,
      "maximumTransferBytes",
    );
    this.resolver = new ShxFontResolver(options);
  }

  handleMessage(message: unknown): boolean {
    if (
      typeof message !== "object" ||
      message === null ||
      (message as { type?: unknown }).type !== "dwg-font-read/1"
    ) {
      return false;
    }
    const candidate = message as Partial<FontReadRequest>;
    if (!validRequestId(candidate.requestId)) {
      return true;
    }
    if (this.disposed) {
      return true;
    }
    if (candidate.cacheId !== this.cacheId) {
      void this.respondFailure(
        candidate.requestId,
        typeof candidate.name === "string" ? candidate.name : "",
        "invalid",
        "글꼴 요청이 현재 도면과 일치하지 않습니다.",
      );
      return true;
    }
    const normalized = normalizeShxFontName(candidate.name);
    if (!normalized) {
      void this.respondFailure(
        candidate.requestId,
        typeof candidate.name === "string" ? candidate.name : "",
        "invalid",
        "올바른 SHX 글꼴 이름이 아닙니다.",
      );
      return true;
    }
    if (
      this.acceptedRequests >= MAX_SHX_FONT_REQUESTS ||
      this.queue.length >= MAX_SHX_FONT_REQUESTS
    ) {
      void this.respondFailure(
        candidate.requestId,
        candidate.name as string,
        "budget-exceeded",
        "한 도면에서 요청할 수 있는 SHX 글꼴 수를 초과했습니다.",
      );
      return true;
    }
    this.acceptedRequests += 1;
    this.queue.push(candidate as FontReadRequest);
    this.pump();
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
  }

  private pump(): void {
    if (this.disposed || this.active) {
      return;
    }
    const request = this.queue.shift();
    if (!request) {
      return;
    }
    this.active = true;
    void this.execute(request).finally(() => {
      this.active = false;
      this.pump();
    });
  }

  private async execute(request: FontReadRequest): Promise<void> {
    const candidate = await this.resolver.resolve(request.name);
    if (this.disposed) {
      return;
    }
    if (!candidate) {
      await this.respondFailure(
        request.requestId,
        request.name,
        "missing",
        "등록된 폴더에서 글꼴을 찾지 못했습니다.",
      );
      return;
    }

    let handle: FileHandle | undefined;
    try {
      handle = await open(candidate.filePath, "r");
      const before = await handle.stat();
      if (
        !before.isFile() ||
        !Number.isSafeInteger(before.size) ||
        before.size <= 0
      ) {
        await this.respondFailure(
          request.requestId,
          request.name,
          "unreadable",
          "글꼴 파일을 읽을 수 없습니다.",
        );
        return;
      }
      if (before.size > this.maximumFileBytes) {
        await this.respondFailure(
          request.requestId,
          request.name,
          "too-large",
          `글꼴 파일이 ${Math.floor(this.maximumFileBytes / 1024 / 1024)} MiB 제한을 초과했습니다.`,
        );
        return;
      }
      if (
        this.transferredBytes + before.size >
        this.maximumTransferBytes
      ) {
        await this.respondFailure(
          request.requestId,
          request.name,
          "budget-exceeded",
          `한 도면의 SHX 전송량이 ${Math.floor(this.maximumTransferBytes / 1024 / 1024)} MiB 제한을 초과했습니다.`,
        );
        return;
      }
      const bytes = await readExactFile(handle, before.size);
      const after = await handle.stat();
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs
      ) {
        await this.respondFailure(
          request.requestId,
          request.name,
          "unreadable",
          "읽는 동안 글꼴 파일이 변경되었습니다.",
        );
        return;
      }
      if (this.disposed) {
        return;
      }
      this.transferredBytes += before.size;
      await Promise.resolve(
        this.postMessage({
          type: "dwg-font-read-response/1",
          cacheId: this.cacheId,
          requestId: request.requestId,
          requestedName: request.name,
          status: "loaded",
          resolvedName: candidate.resolvedName,
          source: candidate.source,
          size: before.size,
          bytes,
        }),
      ).catch(() => false);
    } catch {
      if (!this.disposed) {
        await this.respondFailure(
          request.requestId,
          request.name,
          "unreadable",
          "글꼴 파일을 읽을 수 없습니다.",
        );
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async respondFailure(
    requestId: number,
    requestedName: string,
    status: FontFailureStatus,
    error: string,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    await Promise.resolve(
      this.postMessage({
        type: "dwg-font-read-response/1",
        cacheId: this.cacheId,
        requestId,
        requestedName: requestedName.slice(0, MAX_FONT_NAME_BYTES),
        status,
        error: error.slice(0, 200),
      }),
    ).catch(() => false);
  }
}

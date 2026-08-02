import {
  open,
  opendir,
  stat,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";

const CTB_PREFIX =
  "PIAFILEVERSION_2.0,CTBVER1,compress\r\npmzlibcodec";
const CTB_BODY_OFFSET = 60;
const MAX_CTB_FILE_BYTES = 16 * 1024 * 1024;
const MAX_CTB_CONTENT_BYTES = 8 * 1024 * 1024;
const MAX_CTB_SEARCH_DEPTH = 4;
const MAX_CTB_SEARCH_ENTRIES = 50_000;
const MAX_CTB_REQUESTS = 16;
const OBJECT_COLOR = -1;
const OBJECT_COLOR_2 = -1006632961;
const DEFAULT_LINE_WEIGHTS = Object.freeze([
  0, 0.05, 0.09, 0.1, 0.13, 0.15, 0.18, 0.2, 0.25, 0.3, 0.35, 0.4,
  0.45, 0.5, 0.53, 0.6, 0.65, 0.7, 0.8, 0.9, 1, 1.06, 1.2, 1.4, 1.58,
  2, 2.11,
]);

interface CtbMapping {
  [name: string]: string | CtbMapping;
}
type CtbValue = string | CtbMapping;
type PostMessage = (message: unknown) => PromiseLike<boolean>;

export interface CtbPlotStyle {
  aci: number;
  color?: number;
  screen: number;
  grayscale: boolean;
  dithering: boolean;
  lineWeight?: number;
  linetype: number;
  adaptiveLinetype: boolean;
  fillStyle: number;
  endStyle: number;
  joinStyle: number;
}

export interface CtbPlotStyleTable {
  description: string;
  scaleFactor: number;
  applyFactor: boolean;
  styles: readonly CtbPlotStyle[];
}

export interface CtbPlotStyleChannelOptions {
  drawingDirectory: string;
  projectDirectories?: readonly string[];
  resourceDirectories?: readonly string[];
  maximumSearchDepth?: number;
  maximumSearchEntries?: number;
}

interface PlotStyleReadRequest {
  type: "dwg-plot-style-read/1";
  cacheId: string;
  requestId: number;
  name: string;
}

interface CtbCandidate {
  filePath: string;
  resolvedName: string;
  source: "stored" | "drawing" | "project" | "configured" | "mapping";
}

function normalizedPathKey(value: string): string {
  const resolved = path.resolve(value).normalize("NFC");
  return process.platform === "win32"
    ? resolved.toLocaleLowerCase("en-US")
    : resolved;
}

export function normalizeCtbName(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const basename = value
    .trim()
    .replace(/^["']|["']$/gu, "")
    .split(/[\\/]/u)
    .at(-1)
    ?.trim();
  if (
    !basename ||
    basename === "." ||
    basename === ".." ||
    basename.includes("\0") ||
    Buffer.byteLength(basename, "utf8") > 512 ||
    path.extname(basename).toLocaleLowerCase("en-US") !== ".ctb"
  ) {
    return "";
  }
  return basename.normalize("NFC").toLocaleLowerCase("en-US");
}

function storedResourcePath(
  value: unknown,
  drawingDirectory: string,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const unquoted = value.trim().replace(/^["']|["']$/gu, "");
  if (
    !unquoted ||
    unquoted.includes("\0") ||
    Buffer.byteLength(unquoted, "utf8") > 4096 ||
    !/[\\/]/u.test(unquoted)
  ) {
    return undefined;
  }
  if (path.isAbsolute(unquoted)) {
    return path.resolve(unquoted);
  }
  if (
    /^[a-z]:[\\/]/iu.test(unquoted) ||
    /^\\\\/u.test(unquoted) ||
    unquoted.startsWith("/")
  ) {
    return undefined;
  }
  return path.resolve(
    drawingDirectory,
    unquoted.replace(/[\\/]+/gu, path.sep),
  );
}

function parseMapping(text: string): CtbMapping {
  const root: CtbMapping = {};
  const stack: CtbMapping[] = [root];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line === "}") {
      if (stack.length <= 1) {
        throw new Error("CTB contains an unmatched closing block");
      }
      stack.pop();
      continue;
    }
    if (line.endsWith("{")) {
      const name = line.slice(0, -1).trim();
      if (!name || stack.length > 8) {
        throw new Error("CTB contains an invalid nested block");
      }
      const child: CtbMapping = {};
      stack.at(-1)![name] = child;
      stack.push(child);
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.startsWith('"')) {
      value = value.slice(1);
    }
    stack.at(-1)![name] = value;
  }
  if (stack.length !== 1) {
    throw new Error("CTB contains an unterminated block");
  }
  return root;
}

function mapping(value: CtbValue | undefined): CtbMapping {
  return typeof value === "object" && value !== null ? value : {};
}

function textValue(value: CtbValue | undefined, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(
  value: CtbValue | undefined,
  fallback: number,
): number {
  const parsed = Number(textValue(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolValue(value: CtbValue | undefined, fallback: boolean): boolean {
  const normalized = textValue(value).toUpperCase();
  if (normalized === "TRUE") {
    return true;
  }
  if (normalized === "FALSE") {
    return false;
  }
  return fallback;
}

export function parseCtbPlotStyle(
  source: Uint8Array,
): CtbPlotStyleTable {
  if (
    !(source instanceof Uint8Array) ||
    source.byteLength < CTB_BODY_OFFSET ||
    source.byteLength > MAX_CTB_FILE_BYTES
  ) {
    throw new Error("CTB file size is invalid");
  }
  const prefix = Buffer.from(
    source.buffer,
    source.byteOffset,
    CTB_PREFIX.length,
  ).toString("ascii");
  if (prefix !== CTB_PREFIX) {
    throw new Error("unsupported CTB header");
  }
  const view = new DataView(
    source.buffer,
    source.byteOffset,
    source.byteLength,
  );
  const expectedContentBytes = view.getUint32(52, true);
  const compressedBytes = view.getUint32(56, true);
  if (
    expectedContentBytes <= 0 ||
    expectedContentBytes > MAX_CTB_CONTENT_BYTES ||
    compressedBytes <= 0 ||
    compressedBytes !== source.byteLength - CTB_BODY_OFFSET
  ) {
    throw new Error("CTB compressed size metadata is invalid");
  }
  const inflated = inflateSync(source.subarray(CTB_BODY_OFFSET), {
    maxOutputLength: MAX_CTB_CONTENT_BYTES,
  });
  if (
    inflated.byteLength !== expectedContentBytes ||
    inflated.at(-1) !== 0
  ) {
    throw new Error("CTB uncompressed size metadata is invalid");
  }
  const root = parseMapping(
    inflated.subarray(0, inflated.byteLength - 1).toString("utf8"),
  );
  const customWeights = mapping(root.custom_lineweight_table);
  const lineWeights = [...DEFAULT_LINE_WEIGHTS];
  for (const [key, value] of Object.entries(customWeights)) {
    const index = Number(key);
    const weight = numberValue(value, Number.NaN);
    if (
      Number.isSafeInteger(index) &&
      index >= 0 &&
      index < 1_024 &&
      Number.isFinite(weight) &&
      weight >= 0 &&
      weight <= 100
    ) {
      lineWeights[index] = weight;
    }
  }
  const styles: CtbPlotStyle[] = [];
  for (const [key, value] of Object.entries(mapping(root.plot_style))) {
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= 255) {
      continue;
    }
    const row = mapping(value);
    const rawColor = Math.trunc(numberValue(row.color, OBJECT_COLOR));
    const modeColor = Math.trunc(numberValue(row.mode_color, rawColor));
    const colorPolicy = Math.trunc(numberValue(row.color_policy, 1));
    const lineWeightIndex = Math.trunc(numberValue(row.lineweight, 0));
    const lineWeightMillimeters =
      lineWeightIndex > 0 ? lineWeights[lineWeightIndex] : undefined;
    styles.push(
      Object.freeze({
        aci: index + 1,
        ...(rawColor === OBJECT_COLOR || rawColor === OBJECT_COLOR_2
          ? {}
          : { color: (modeColor >>> 0) & 0xffffff }),
        screen: Math.max(
          0,
          Math.min(100, Math.trunc(numberValue(row.screen, 100))),
        ),
        grayscale: Boolean(colorPolicy & 2),
        dithering: Boolean(colorPolicy & 1),
        ...(Number.isFinite(lineWeightMillimeters)
          ? {
              lineWeight: Math.max(
                0,
                Math.min(
                  211,
                  Math.round((lineWeightMillimeters as number) * 100),
                ),
              ),
            }
          : {}),
        linetype: Math.trunc(numberValue(row.linetype, 31)),
        adaptiveLinetype: boolValue(row.adaptive_linetype, true),
        fillStyle: Math.trunc(numberValue(row.fill_style, 73)),
        endStyle: Math.trunc(numberValue(row.end_style, 4)),
        joinStyle: Math.trunc(numberValue(row.join_style, 5)),
      }),
    );
  }
  styles.sort((left, right) => left.aci - right.aci);
  if (styles.length === 0) {
    throw new Error("CTB contains no color-dependent plot styles");
  }
  return Object.freeze({
    description: textValue(root.description),
    scaleFactor: numberValue(root.scale_factor, 1),
    applyFactor: boolValue(root.apply_factor, false),
    styles: Object.freeze(styles),
  });
}

async function readExactFile(
  handle: FileHandle,
  byteLength: number,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    const result = await handle.read(
      bytes,
      offset,
      byteLength - offset,
      offset,
    );
    if (result.bytesRead === 0) {
      throw new Error("short CTB read");
    }
    offset += result.bytesRead;
  }
  return bytes;
}

class CtbResolver {
  private readonly drawingDirectory: string;
  private readonly resourceDirectories: readonly string[];
  private readonly projectDirectories: readonly string[];
  private readonly maximumSearchDepth: number;
  private readonly maximumSearchEntries: number;
  private readonly cache = new Map<
    string,
    CtbCandidate | "ambiguous" | "missing"
  >();

  constructor(options: CtbPlotStyleChannelOptions) {
    this.drawingDirectory = path.resolve(options.drawingDirectory);
    this.resourceDirectories = Object.freeze(
      (options.resourceDirectories ?? [])
        .filter((value) => path.isAbsolute(value))
        .map((value) => path.resolve(value))
        .slice(0, 32),
    );
    this.projectDirectories = Object.freeze(
      (options.projectDirectories ?? [])
        .filter((value) => path.isAbsolute(value))
        .map((value) => path.resolve(value))
        .slice(0, 32),
    );
    this.maximumSearchDepth = Math.min(
      16,
      Math.max(1, options.maximumSearchDepth ?? MAX_CTB_SEARCH_DEPTH),
    );
    this.maximumSearchEntries = Math.min(
      1_000_000,
      Math.max(1, options.maximumSearchEntries ?? MAX_CTB_SEARCH_ENTRIES),
    );
  }

  async resolve(name: string): Promise<CtbCandidate | "ambiguous" | undefined> {
    const normalized = normalizeCtbName(name);
    if (!normalized) {
      return undefined;
    }
    const cached = this.cache.get(normalized);
    if (cached) {
      return cached === "missing" ? undefined : cached;
    }
    const stored = await this.resolveStoredPath(name);
    if (stored) {
      this.cache.set(normalized, stored);
      return stored;
    }
    const drawing = await this.findImmediate(
      this.drawingDirectory,
      normalized,
      "drawing",
    );
    if (drawing) {
      this.cache.set(normalized, drawing);
      return drawing;
    }
    for (const root of this.projectDirectories) {
      const result = await this.findRecursive(root, normalized);
      if (result) {
        this.cache.set(normalized, result);
        return result;
      }
    }
    for (const directory of this.resourceDirectories) {
      const candidate = await this.findImmediate(
        directory,
        normalized,
        "configured",
      );
      if (candidate) {
        this.cache.set(normalized, candidate);
        return candidate;
      }
    }
    this.cache.set(normalized, "missing");
    return undefined;
  }

  setMapping(name: string, filePath: string): boolean {
    const normalized = normalizeCtbName(name);
    const resolvedName = path.basename(filePath);
    if (
      !normalized ||
      !normalizeCtbName(resolvedName) ||
      !path.isAbsolute(filePath)
    ) {
      return false;
    }
    this.cache.set(normalized, {
      filePath: path.resolve(filePath),
      resolvedName,
      source: "mapping",
    });
    return true;
  }

  private async resolveStoredPath(
    name: string,
  ): Promise<CtbCandidate | undefined> {
    const filePath = storedResourcePath(name, this.drawingDirectory);
    if (!filePath || !normalizeCtbName(path.basename(filePath))) {
      return undefined;
    }
    try {
      const metadata = await stat(filePath);
      return metadata.isFile()
        ? {
            filePath,
            resolvedName: path.basename(filePath),
            source: "stored",
          }
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async findImmediate(
    directory: string,
    normalized: string,
    source: "drawing" | "configured",
  ): Promise<CtbCandidate | "ambiguous" | undefined> {
    const matches: CtbCandidate[] = [];
    try {
      const handle = await opendir(directory);
      for await (const entry of handle) {
        if (entry.isFile() && normalizeCtbName(entry.name) === normalized) {
          matches.push({
            filePath: path.join(directory, entry.name),
            resolvedName: entry.name,
            source,
          });
        }
      }
    } catch {
      return undefined;
    }
    return matches.length === 1
      ? matches[0]
      : matches.length > 1
        ? "ambiguous"
        : undefined;
  }

  private async findRecursive(
    root: string,
    normalized: string,
  ): Promise<CtbCandidate | "ambiguous" | undefined> {
    const matches: { filePath: string; resolvedName: string; depth: number }[] =
      [];
    const seenDirectories = new Set<string>();
    let visitedEntries = 0;
    let truncated = false;
    const visit = async (directory: string, depth: number): Promise<void> => {
      const key = normalizedPathKey(directory);
      if (
        truncated ||
        depth > this.maximumSearchDepth ||
        seenDirectories.has(key)
      ) {
        return;
      }
      seenDirectories.add(key);
      try {
        const handle = await opendir(directory);
        for await (const entry of handle) {
          visitedEntries += 1;
          if (visitedEntries > this.maximumSearchEntries) {
            truncated = true;
            return;
          }
          const candidatePath = path.join(directory, entry.name);
          if (entry.isDirectory() && !entry.isSymbolicLink()) {
            await visit(candidatePath, depth + 1);
          } else if (
            entry.isFile() &&
            normalizeCtbName(entry.name) === normalized
          ) {
            matches.push({
              filePath: candidatePath,
              resolvedName: entry.name,
              depth,
            });
          }
        }
      } catch {
        // Missing project resources are treated as absent.
      }
    };
    await visit(root, 0);
    if (matches.length === 0) {
      return undefined;
    }
    const nearestDepth = Math.min(...matches.map((match) => match.depth));
    const nearest = matches.filter((match) => match.depth === nearestDepth);
    if (nearest.length !== 1) {
      return "ambiguous";
    }
    return {
      filePath: nearest[0].filePath,
      resolvedName: nearest[0].resolvedName,
      source: "project",
    };
  }
}

export class CtbPlotStyleChannel {
  private readonly resolver: CtbResolver;
  private requests = 0;
  private disposed = false;

  constructor(
    readonly cacheId: string,
    options: CtbPlotStyleChannelOptions,
    private readonly postMessage: PostMessage,
  ) {
    if (!/^[a-f0-9]{64}$/u.test(cacheId)) {
      throw new TypeError("invalid cache ID");
    }
    this.resolver = new CtbResolver(options);
  }

  handleMessage(message: unknown): boolean {
    if (
      typeof message !== "object" ||
      message === null ||
      (message as { type?: unknown }).type !== "dwg-plot-style-read/1"
    ) {
      return false;
    }
    const request = message as Partial<PlotStyleReadRequest>;
    if (
      this.disposed ||
      request.cacheId !== this.cacheId ||
      !Number.isSafeInteger(request.requestId) ||
      (request.requestId as number) <= 0 ||
      !normalizeCtbName(request.name) ||
      this.requests >= MAX_CTB_REQUESTS
    ) {
      return true;
    }
    this.requests += 1;
    void this.execute(request as PlotStyleReadRequest);
    return true;
  }

  setSessionMapping(name: string, filePath: string): boolean {
    return !this.disposed && this.resolver.setMapping(name, filePath);
  }

  dispose(): void {
    this.disposed = true;
  }

  private async execute(request: PlotStyleReadRequest): Promise<void> {
    const candidate = await this.resolver.resolve(request.name);
    if (this.disposed) {
      return;
    }
    if (!candidate || candidate === "ambiguous") {
      await this.respond({
        type: "dwg-plot-style-read-response/1",
        cacheId: this.cacheId,
        requestId: request.requestId,
        requestedName: request.name,
        status: candidate === "ambiguous" ? "ambiguous" : "missing",
      });
      return;
    }
    let handle: FileHandle | undefined;
    try {
      handle = await open(candidate.filePath, "r");
      const before = await handle.stat();
      if (
        !before.isFile() ||
        !Number.isSafeInteger(before.size) ||
        before.size <= 0 ||
        before.size > MAX_CTB_FILE_BYTES
      ) {
        throw new Error("invalid CTB file size");
      }
      const bytes = await readExactFile(handle, before.size);
      const after = await handle.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new Error("CTB changed while reading");
      }
      const table = parseCtbPlotStyle(bytes);
      await this.respond({
        type: "dwg-plot-style-read-response/1",
        cacheId: this.cacheId,
        requestId: request.requestId,
        requestedName: request.name,
        resolvedName: candidate.resolvedName,
        source: candidate.source,
        status: "loaded",
        table,
      });
    } catch (error) {
      await this.respond({
        type: "dwg-plot-style-read-response/1",
        cacheId: this.cacheId,
        requestId: request.requestId,
        requestedName: request.name,
        status: "invalid",
        error: error instanceof Error ? error.message.slice(0, 200) : "invalid CTB",
      });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async respond(message: unknown): Promise<void> {
    if (!this.disposed) {
      await Promise.resolve(this.postMessage(message)).catch(() => false);
    }
  }
}

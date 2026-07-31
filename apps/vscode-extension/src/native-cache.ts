import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

export const ADAPTER_PROTOCOL = "dwg-engine-adapter/1";
export const CACHE_SCHEMA_VERSION = "dwg-scene-cache/1.11";
export const DOCTOR_REPORT_SCHEMA = "dwg-engine-doctor/1";
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_DOCTOR_STDOUT_BYTES = 64 * 1024;
const DEFAULT_DOCTOR_TIMEOUT_MS = 5_000;
const TERMINATION_GRACE_MS = 1_500;

export class NativeCacheError extends Error {
  constructor(
    readonly code: string,
    readonly userMessage: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "NativeCacheError";
  }
}

export function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export interface AdapterSelection {
  configuredPath?: string;
  environmentPath?: string;
  extensionPath: string;
  platform?: NodeJS.Platform;
  architecture?: string;
}

export async function resolveLibreDwgAdapter(
  selection: AdapterSelection,
): Promise<string> {
  const platform = selection.platform ?? process.platform;
  const architecture = selection.architecture ?? process.arch;
  const executableName =
    platform === "win32" ? "libredwg-adapter.exe" : "libredwg-adapter";
  const bundledPath = path.join(
    selection.extensionPath,
    "native",
    `${platform}-${architecture}`,
    executableName,
  );
  const candidate =
    selection.configuredPath?.trim() ||
    selection.environmentPath?.trim() ||
    bundledPath;

  if (!path.isAbsolute(candidate)) {
    throw new NativeCacheError(
      "ADAPTER_PATH_NOT_ABSOLUTE",
      "LibreDWG 변환기 경로를 절대 경로로 설정해 주세요.",
    );
  }

  try {
    await access(candidate, platform === "win32" ? undefined : 1);
    const metadata = await stat(candidate);
    if (!metadata.isFile()) {
      throw new Error("not a file");
    }
  } catch (error) {
    throw new NativeCacheError(
      "ADAPTER_NOT_FOUND",
      "LibreDWG 변환기를 찾을 수 없습니다. DWG Viewer 설정에서 변환기 경로를 지정해 주세요.",
      { cause: error },
    );
  }
  return candidate;
}

export interface CacheIdentity {
  sourcePath: string;
  sourceSize: bigint;
  sourceMtimeNs: bigint;
  adapterPath: string;
  adapterSize: bigint;
  adapterMtimeNs: bigint;
}

export function computeCacheId(identity: CacheIdentity): string {
  const hash = createHash("sha256");
  const fields = [
    CACHE_SCHEMA_VERSION,
    path.resolve(identity.sourcePath),
    identity.sourceSize.toString(),
    identity.sourceMtimeNs.toString(),
    path.resolve(identity.adapterPath),
    identity.adapterSize.toString(),
    identity.adapterMtimeNs.toString(),
  ];
  for (const field of fields) {
    const encoded = Buffer.from(field, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32LE(encoded.byteLength);
    hash.update(length);
    hash.update(encoded);
  }
  return hash.digest("hex");
}

interface AdapterReport {
  schema?: unknown;
  status?: unknown;
  cache?: {
    size_bytes?: unknown;
    validated?: unknown;
  };
}

export function parseAdapterReport(
  output: string,
  actualCacheBytes: bigint,
): void {
  let report: AdapterReport;
  try {
    report = JSON.parse(output.trim()) as AdapterReport;
  } catch (error) {
    throw new NativeCacheError(
      "ADAPTER_REPORT_INVALID",
      "LibreDWG 변환기가 올바른 완료 보고서를 반환하지 않았습니다.",
      { cause: error },
    );
  }
  const reportSize = report.cache?.size_bytes;
  const sizeMatches =
    (typeof reportSize === "number" &&
      Number.isSafeInteger(reportSize) &&
      BigInt(reportSize) === actualCacheBytes) ||
    (typeof reportSize === "string" &&
      /^\d+$/.test(reportSize) &&
      BigInt(reportSize) === actualCacheBytes);
  if (
    report.schema !== "dwg-scene-cache/1" ||
    report.status !== "ok" ||
    report.cache?.validated !== true ||
    !sizeMatches ||
    actualCacheBytes <= 0n
  ) {
    throw new NativeCacheError(
      "ADAPTER_REPORT_REJECTED",
      "LibreDWG 변환 결과의 무결성 검사를 통과하지 못했습니다.",
    );
  }
}

interface RawDoctorReport {
  schema?: unknown;
  status?: unknown;
  protocol?: unknown;
  engine?: {
    id?: unknown;
    version?: unknown;
    license?: unknown;
    linkage?: unknown;
  };
  cache?: {
    schema?: unknown;
  };
  target?: {
    platform?: unknown;
    architecture?: unknown;
  };
}

export interface LibreDwgDoctorReport {
  engineVersion: string;
  linkage: "static" | "dynamic" | "unknown";
  platform: string;
  architecture: string;
}

function isSafeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 40 &&
    /^[a-zA-Z0-9._+-]+$/u.test(value)
  );
}

export function parseLibreDwgDoctorReport(
  output: string,
): LibreDwgDoctorReport {
  let report: RawDoctorReport;
  try {
    report = JSON.parse(output.trim()) as RawDoctorReport;
  } catch (error) {
    throw new NativeCacheError(
      "ADAPTER_DOCTOR_REPORT_INVALID",
      "LibreDWG 변환기가 올바른 진단 보고서를 반환하지 않았습니다.",
      { cause: error },
    );
  }

  const linkage = report.engine?.linkage;
  if (
    report.schema !== DOCTOR_REPORT_SCHEMA ||
    report.status !== "ok" ||
    report.protocol !== ADAPTER_PROTOCOL ||
    report.engine?.id !== "libredwg" ||
    !isSafeIdentifier(report.engine.version) ||
    report.engine.license !== "GPL-3.0-or-later" ||
    (linkage !== "static" &&
      linkage !== "dynamic" &&
      linkage !== "unknown") ||
    report.cache?.schema !== CACHE_SCHEMA_VERSION ||
    !isSafeIdentifier(report.target?.platform) ||
    !isSafeIdentifier(report.target?.architecture)
  ) {
    throw new NativeCacheError(
      "ADAPTER_DOCTOR_REPORT_REJECTED",
      "선택한 LibreDWG 변환기는 이 버전의 DWG Viewer와 호환되지 않습니다.",
    );
  }

  return {
    engineVersion: report.engine.version,
    linkage,
    platform: report.target.platform,
    architecture: report.target.architecture,
  };
}

export interface DiagnoseAdapterOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function diagnoseLibreDwgAdapter(
  adapterPath: string,
  {
    signal = new AbortController().signal,
    timeoutMs = DEFAULT_DOCTOR_TIMEOUT_MS,
  }: DiagnoseAdapterOptions = {},
): Promise<LibreDwgDoctorReport> {
  if (signal.aborted) {
    throw abortError();
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 30_000
  ) {
    throw new TypeError("doctor timeout is outside the supported range");
  }

  let child;
  try {
    child = spawn(adapterPath, ["doctor"], {
      env: {
        ...process.env,
        DWG_VIEWER_ADAPTER_PROTOCOL: ADAPTER_PROTOCOL,
        DWG_VIEWER_BENCHMARK_PHASE: "doctor",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      cwd: path.dirname(adapterPath),
    });
  } catch (error) {
    throw new NativeCacheError(
      "ADAPTER_START_FAILED",
      "LibreDWG 변환기를 시작하지 못했습니다.",
      { cause: error },
    );
  }

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputError: Error | undefined;
  let timedOut = false;
  let terminationTimer: NodeJS.Timeout | undefined;

  const terminate = (): void => {
    if (
      terminationTimer ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return;
    }
    child.kill("SIGTERM");
    terminationTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, TERMINATION_GRACE_MS);
    terminationTimer.unref();
  };
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  timeoutTimer.unref();
  const onAbort = (): void => terminate();
  signal.addEventListener("abort", onAbort, { once: true });

  child.stdout.on("data", (value: Buffer | string) => {
    if (outputError) {
      return;
    }
    try {
      stdoutBytes = appendBounded(
        stdout,
        Buffer.from(value),
        stdoutBytes,
        MAX_DOCTOR_STDOUT_BYTES,
      );
    } catch (error) {
      outputError = error as Error;
      terminate();
    }
  });
  child.stderr.on("data", (value: Buffer | string) => {
    if (outputError) {
      return;
    }
    try {
      stderrBytes = appendBounded(
        stderr,
        Buffer.from(value),
        stderrBytes,
        MAX_STDERR_BYTES,
      );
    } catch (error) {
      outputError = error as Error;
      terminate();
    }
  });

  const result = await new Promise<{
    code: number | null;
    error?: Error;
  }>((resolve) => {
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => {
      resolve({ code, error: spawnError });
    });
  });

  clearTimeout(timeoutTimer);
  signal.removeEventListener("abort", onAbort);
  if (terminationTimer) {
    clearTimeout(terminationTimer);
  }
  if (signal.aborted) {
    throw abortError();
  }
  if (timedOut) {
    throw new NativeCacheError(
      "ADAPTER_DOCTOR_TIMEOUT",
      "LibreDWG 변환기 진단이 제한 시간 안에 끝나지 않았습니다.",
    );
  }
  if (outputError) {
    throw outputError;
  }
  if (result.error) {
    throw new NativeCacheError(
      "ADAPTER_START_FAILED",
      "LibreDWG 변환기를 시작하지 못했습니다.",
      { cause: result.error },
    );
  }
  if (result.code !== 0) {
    throw new NativeCacheError(
      "ADAPTER_DOCTOR_FAILED",
      "LibreDWG 변환기 자체 진단에 실패했습니다.",
    );
  }
  return parseLibreDwgDoctorReport(
    Buffer.concat(stdout, stdoutBytes).toString("utf8"),
  );
}

interface RunAdapterOptions {
  adapterPath: string;
  inputPath: string;
  outputPath: string;
  signal: AbortSignal;
  onPhase?: (phase: "converting" | "validating") => void;
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  currentBytes: number,
  maximumBytes: number,
): number {
  const nextBytes = currentBytes + chunk.byteLength;
  if (nextBytes > maximumBytes) {
    throw new NativeCacheError(
      "ADAPTER_OUTPUT_LIMIT",
      "LibreDWG 변환기가 허용 범위를 넘는 출력을 반환했습니다.",
    );
  }
  chunks.push(chunk);
  return nextBytes;
}

export async function runLibreDwgAdapter({
  adapterPath,
  inputPath,
  outputPath,
  signal,
  onPhase,
}: RunAdapterOptions): Promise<void> {
  if (signal.aborted) {
    throw abortError();
  }

  let child;
  try {
    child = spawn(adapterPath, ["convert", inputPath, outputPath], {
      env: {
        ...process.env,
        DWG_VIEWER_ADAPTER_PROTOCOL: ADAPTER_PROTOCOL,
        DWG_VIEWER_BENCHMARK_PHASE: "convert",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      cwd: path.dirname(outputPath),
    });
  } catch (error) {
    throw new NativeCacheError(
      "ADAPTER_START_FAILED",
      "LibreDWG 변환기를 시작하지 못했습니다.",
      { cause: error },
    );
  }

  onPhase?.("converting");
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputError: Error | undefined;
  let terminationTimer: NodeJS.Timeout | undefined;

  const terminate = (): void => {
    if (
      terminationTimer ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return;
    }
    child.kill("SIGTERM");
    terminationTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, TERMINATION_GRACE_MS);
    terminationTimer.unref();
  };
  const onAbort = (): void => terminate();
  signal.addEventListener("abort", onAbort, { once: true });

  child.stdout.on("data", (value: Buffer | string) => {
    if (outputError) {
      return;
    }
    try {
      stdoutBytes = appendBounded(
        stdout,
        Buffer.from(value),
        stdoutBytes,
        MAX_STDOUT_BYTES,
      );
    } catch (error) {
      outputError = error as Error;
      terminate();
    }
  });
  child.stderr.on("data", (value: Buffer | string) => {
    if (outputError) {
      return;
    }
    try {
      stderrBytes = appendBounded(
        stderr,
        Buffer.from(value),
        stderrBytes,
        MAX_STDERR_BYTES,
      );
    } catch (error) {
      outputError = error as Error;
      terminate();
    }
  });

  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  }>((resolve) => {
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, closeSignal) => {
      resolve({ code, signal: closeSignal, error: spawnError });
    });
  });

  signal.removeEventListener("abort", onAbort);
  if (terminationTimer) {
    clearTimeout(terminationTimer);
  }
  if (signal.aborted) {
    throw abortError();
  }
  if (outputError) {
    throw outputError;
  }
  if (result.error) {
    throw new NativeCacheError(
      "ADAPTER_START_FAILED",
      "LibreDWG 변환기를 시작하지 못했습니다.",
      { cause: result.error },
    );
  }
  if (result.code !== 0) {
    throw new NativeCacheError(
      "ADAPTER_CONVERSION_FAILED",
      "DWG 변환에 실패했습니다. 변환기 호환성과 도면 상태를 확인해 주세요.",
    );
  }

  onPhase?.("validating");
  let outputMetadata;
  try {
    outputMetadata = await stat(outputPath, { bigint: true });
  } catch (error) {
    throw new NativeCacheError(
      "CACHE_OUTPUT_MISSING",
      "LibreDWG 변환기가 캐시 파일을 만들지 못했습니다.",
      { cause: error },
    );
  }
  parseAdapterReport(
    Buffer.concat(stdout, stdoutBytes).toString("utf8"),
    outputMetadata.size,
  );
}

export interface PreparedCache {
  cacheId: string;
  cachePath: string;
  size: number;
  reused: boolean;
}

export interface PrepareCacheOptions {
  force?: boolean;
  signal: AbortSignal;
  onPhase?: (
    phase: "checking" | "converting" | "validating" | "ready",
  ) => void;
}

export class NativeCacheManager {
  constructor(
    private readonly cacheRoot: string,
    private readonly adapterPath: string,
  ) {}

  async prepare(
    sourcePath: string,
    { force = false, signal, onPhase }: PrepareCacheOptions,
  ): Promise<PreparedCache> {
    if (signal.aborted) {
      throw abortError();
    }
    onPhase?.("checking");
    await mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });

    let sourceMetadata;
    let adapterMetadata;
    try {
      [sourceMetadata, adapterMetadata] = await Promise.all([
        stat(sourcePath, { bigint: true }),
        stat(this.adapterPath, { bigint: true }),
      ]);
    } catch (error) {
      throw new NativeCacheError(
        "INPUT_METADATA_FAILED",
        "도면 또는 LibreDWG 변환기 정보를 읽지 못했습니다.",
        { cause: error },
      );
    }
    if (!sourceMetadata.isFile()) {
      throw new NativeCacheError(
        "INPUT_NOT_FILE",
        "선택한 DWG 파일을 읽을 수 없습니다.",
      );
    }

    const cacheId = computeCacheId({
      sourcePath,
      sourceSize: sourceMetadata.size,
      sourceMtimeNs: sourceMetadata.mtimeNs,
      adapterPath: this.adapterPath,
      adapterSize: adapterMetadata.size,
      adapterMtimeNs: adapterMetadata.mtimeNs,
    });
    const cachePath = path.join(this.cacheRoot, `${cacheId}.dwg.cache`);

    if (force) {
      await rm(cachePath, { force: true });
    } else {
      const existing = await this.readExistingCache(cacheId, cachePath);
      if (existing) {
        onPhase?.("ready");
        return existing;
      }
    }

    const temporaryPath = path.join(
      this.cacheRoot,
      `${cacheId}.${randomBytes(8).toString("hex")}.tmp`,
    );
    try {
      await runLibreDwgAdapter({
        adapterPath: this.adapterPath,
        inputPath: sourcePath,
        outputPath: temporaryPath,
        signal,
        onPhase,
      });
      if (signal.aborted) {
        throw abortError();
      }
      const [finalSourceMetadata, finalAdapterMetadata] = await Promise.all([
        stat(sourcePath, { bigint: true }),
        stat(this.adapterPath, { bigint: true }),
      ]);
      if (
        finalSourceMetadata.size !== sourceMetadata.size ||
        finalSourceMetadata.mtimeNs !== sourceMetadata.mtimeNs ||
        finalAdapterMetadata.size !== adapterMetadata.size ||
        finalAdapterMetadata.mtimeNs !== adapterMetadata.mtimeNs
      ) {
        throw new NativeCacheError(
          "CACHE_INPUT_CHANGED",
          "변환 중 도면 또는 LibreDWG 변환기가 변경되었습니다. 다시 시도해 주세요.",
        );
      }
      try {
        await rename(temporaryPath, cachePath);
      } catch (error) {
        const racedCache = await this.readExistingCache(cacheId, cachePath);
        if (racedCache) {
          onPhase?.("ready");
          return racedCache;
        }
        throw new NativeCacheError(
          "CACHE_COMMIT_FAILED",
          "변환 캐시를 저장하지 못했습니다.",
          { cause: error },
        );
      }
      if (process.platform !== "win32") {
        await chmod(cachePath, 0o600);
      }
      const prepared = await this.readExistingCache(cacheId, cachePath);
      if (!prepared) {
        throw new NativeCacheError(
          "CACHE_COMMIT_FAILED",
          "변환 캐시를 저장하지 못했습니다.",
        );
      }
      onPhase?.("ready");
      return { ...prepared, reused: false };
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async readExistingCache(
    cacheId: string,
    cachePath: string,
  ): Promise<PreparedCache | undefined> {
    try {
      const metadata = await stat(cachePath);
      if (!metadata.isFile() || metadata.size <= 0) {
        await rm(cachePath, { force: true });
        return undefined;
      }
      if (!Number.isSafeInteger(metadata.size)) {
        throw new NativeCacheError(
          "CACHE_TOO_LARGE",
          "변환 캐시가 지원 가능한 크기를 넘었습니다.",
        );
      }
      return {
        cacheId,
        cachePath,
        size: metadata.size,
        reused: true,
      };
    } catch (error) {
      if (
        error instanceof NativeCacheError ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
      return undefined;
    }
  }
}

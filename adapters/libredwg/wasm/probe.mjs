// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import { fileURLToPath } from "node:url";

export const WASM_PROBE_SCHEMA = "dwg-wasm-probe/1";
export const CONCURRENT_MEMORY_HARD_LIMIT_BYTES = 800_000_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CAPTURED_LINES = 16;
const MAX_CAPTURED_LINE_LENGTH = 1_048_576;

function usage() {
  return [
    "usage:",
    "  node probe.mjs --module MODULE_JS --input DRAWING",
    "    [--expected-cache CACHE] [--cancel-after-ms N] [--timeout-ms N]",
  ].join("\n");
}

function positiveInteger(value, name, { allowZero = false } = {}) {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    (allowZero ? parsed < 0 : parsed <= 0)
  ) {
    throw new Error(`${name} is outside the supported range`);
  }
  return parsed;
}

export function parseProbeArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !name?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error(usage());
    }
    if (values.has(name)) {
      throw new Error(`duplicate option: ${name}`);
    }
    values.set(name, value);
  }
  const modulePath = values.get("--module");
  const inputPath = values.get("--input");
  if (!modulePath || !inputPath) {
    throw new Error(usage());
  }
  for (const name of values.keys()) {
    if (
      name !== "--module" &&
      name !== "--input" &&
      name !== "--expected-cache" &&
      name !== "--cancel-after-ms" &&
      name !== "--timeout-ms"
    ) {
      throw new Error(`unknown option: ${name}`);
    }
  }
  return Object.freeze({
    modulePath: path.resolve(modulePath),
    inputPath: path.resolve(inputPath),
    expectedCachePath: values.has("--expected-cache")
      ? path.resolve(values.get("--expected-cache"))
      : undefined,
    cancelAfterMs: values.has("--cancel-after-ms")
      ? positiveInteger(
          values.get("--cancel-after-ms"),
          "--cancel-after-ms",
          { allowZero: true },
        )
      : undefined,
    timeoutMs: values.has("--timeout-ms")
      ? positiveInteger(values.get("--timeout-ms"), "--timeout-ms")
      : DEFAULT_TIMEOUT_MS,
  });
}

export function classifyConcurrentMemory(maxRssBytes) {
  if (!Number.isSafeInteger(maxRssBytes) || maxRssBytes < 0) {
    throw new TypeError("max RSS must be a non-negative safe integer");
  }
  return Object.freeze({
    hardLimitBytes: CONCURRENT_MEMORY_HARD_LIMIT_BYTES,
    measuredBytes: maxRssBytes,
    passed: maxRssBytes <= CONCURRENT_MEMORY_HARD_LIMIT_BYTES,
  });
}

function boundedLine(lines, value) {
  if (lines.length >= MAX_CAPTURED_LINES) {
    return;
  }
  lines.push(String(value).slice(0, MAX_CAPTURED_LINE_LENGTH));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeU64(view, offset, label) {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds JavaScript's safe integer range`);
  }
  return Number(value);
}

export function fingerprintSceneCache(bytes) {
  const value =
    bytes instanceof Uint8Array
      ? bytes
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (value.byteLength < 64) {
    throw new Error("Scene Cache is shorter than its header");
  }
  const view = new DataView(
    value.buffer,
    value.byteOffset,
    value.byteLength,
  );
  const sectionCount = view.getUint32(16, true);
  const directoryEntrySize = view.getUint32(20, true);
  const directoryOffset = safeU64(view, 32, "directory offset");
  if (
    sectionCount === 0 ||
    sectionCount > 1024 ||
    directoryEntrySize !== 40 ||
    directoryOffset < 64 ||
    directoryOffset + sectionCount * directoryEntrySize > value.byteLength
  ) {
    throw new Error("Scene Cache has an invalid section directory");
  }
  const sections = [];
  let firstSectionOffset = value.byteLength;
  for (let index = 0; index < sectionCount; index += 1) {
    const entryOffset = directoryOffset + index * directoryEntrySize;
    const kind = view.getUint32(entryOffset, true);
    const offset = safeU64(view, entryOffset + 8, "section offset");
    const length = safeU64(view, entryOffset + 16, "section length");
    const flags = view.getUint32(entryOffset + 32, true);
    if (offset > value.byteLength || length > value.byteLength - offset) {
      throw new Error(`Scene Cache section ${kind} is outside the file`);
    }
    let stringTableSha256;
    if ((flags & 1) !== 0) {
      if (length < 16) {
        throw new Error(`Scene Cache string section ${kind} is too short`);
      }
      const stringOffset = safeU64(
        view,
        offset + 8,
        "string-table offset",
      );
      if (stringOffset > length) {
        throw new Error(
          `Scene Cache string section ${kind} has an invalid table`,
        );
      }
      stringTableSha256 = sha256(
        value.subarray(offset + stringOffset, offset + length),
      );
    }
    firstSectionOffset = Math.min(firstSectionOffset, offset);
    sections.push({
      kind,
      bytes: length,
      sha256: sha256(value.subarray(offset, offset + length)),
      stringTableSha256,
    });
  }
  return Object.freeze({
    bytes: value.byteLength,
    sha256: sha256(value),
    prefixSha256: sha256(value.subarray(0, firstSectionOffset)),
    sections: Object.freeze(sections),
  });
}

async function runWorker() {
  const require = createRequire(import.meta.url);
  const stdout = [];
  const stderr = [];
  try {
    const createModule = require(workerData.modulePath);
    const moduleStarted = performance.now();
    const module = await createModule({
      noInitialRun: true,
      noExitRuntime: true,
      locateFile: (name) =>
        path.join(path.dirname(workerData.modulePath), name),
      print: (line) => boundedLine(stdout, line),
      printErr: (line) => boundedLine(stderr, line),
    });
    const moduleReady = performance.now();
    const input = await readFile(workerData.inputPath);
    module.FS.writeFile("/input.dwg", input);
    const inputReady = performance.now();
    parentPort.postMessage({ type: "converting" });
    module.callMain(["convert", "/input.dwg", "/output.cache"]);
    const converted = performance.now();
    const report = JSON.parse(stdout.at(-1));
    const outputStat = module.FS.stat("/output.cache");
    const outputFingerprint = workerData.hashOutput
      ? fingerprintSceneCache(module.FS.readFile("/output.cache"))
      : undefined;
    const memory = process.memoryUsage();
    parentPort.postMessage({
      type: "result",
      result: {
        schema: WASM_PROBE_SCHEMA,
        status: "ok",
        runtime: "node-worker",
        timings: {
          moduleMs: moduleReady - moduleStarted,
          inputCopyMs: inputReady - moduleReady,
          convertMs: converted - inputReady,
        },
        memory: {
          wasmBytes: module.HEAPU8.buffer.byteLength,
          rssBytes: memory.rss,
          externalBytes: memory.external,
          arrayBufferBytes: memory.arrayBuffers,
          maxRssBytes: process.resourceUsage().maxRSS * 1024,
        },
        output: {
          bytes: outputStat.size,
          sha256: outputFingerprint?.sha256,
          prefixSha256: outputFingerprint?.prefixSha256,
          sections: outputFingerprint?.sections,
        },
        report,
        stderr,
      },
    });
  } catch (error) {
    parentPort.postMessage({
      type: "result",
      result: {
        schema: WASM_PROBE_SCHEMA,
        status: "failed",
        runtime: "node-worker",
        error: error instanceof Error ? error.message : String(error),
        stderr,
      },
    });
  }
}

async function expectedFingerprint(expectedCachePath) {
  return expectedCachePath
    ? fingerprintSceneCache(await readFile(expectedCachePath))
    : undefined;
}

export async function runProbe(options) {
  const expectedCache = await expectedFingerprint(
    options.expectedCachePath,
  );
  const worker = new Worker(new URL(import.meta.url), {
    workerData: {
      modulePath: options.modulePath,
      inputPath: options.inputPath,
      hashOutput: expectedCache !== undefined,
    },
  });
  let timeout;
  let cancelTimer;
  let conversionStarted;
  let cancellationRequested = false;
  try {
    return await new Promise((resolve, reject) => {
      timeout = setTimeout(async () => {
        await worker.terminate();
        reject(new Error(`WASM probe timed out after ${options.timeoutMs} ms`));
      }, options.timeoutMs);
      worker.once("error", reject);
      worker.on("message", (message) => {
        if (
          message.type === "converting" &&
          options.cancelAfterMs !== undefined
        ) {
          conversionStarted = performance.now();
          cancelTimer = setTimeout(async () => {
            cancellationRequested = true;
            const exitCode = await worker.terminate();
            resolve({
              schema: WASM_PROBE_SCHEMA,
              status: "cancelled",
              runtime: "node-worker",
              cancellation: {
                requestedAfterMs: options.cancelAfterMs,
                terminateMs: performance.now() - conversionStarted,
                exitCode,
              },
            });
          }, options.cancelAfterMs);
          return;
        }
        if (message.type !== "result" || cancellationRequested) {
          return;
        }
        const result = message.result;
        if (result.status === "ok") {
          const actualSections = new Map(
            (result.output.sections ?? []).map((section) => [
              section.kind,
              section,
            ]),
          );
          const differingSectionKinds =
            expectedCache === undefined
              ? undefined
              : expectedCache.sections
                  .filter(
                    (section) =>
                      actualSections.get(section.kind)?.sha256 !==
                      section.sha256,
                  )
                  .map((section) => section.kind);
          const differingStringTableKinds =
            expectedCache === undefined
              ? undefined
              : expectedCache.sections
                  .filter(
                    (section) =>
                      section.stringTableSha256 !== undefined &&
                      actualSections.get(section.kind)
                        ?.stringTableSha256 !==
                        section.stringTableSha256,
                  )
                  .map((section) => section.kind);
          result.admission = {
            concurrentMemory: classifyConcurrentMemory(
              result.memory.maxRssBytes,
            ),
            outputMatchesExpected:
              expectedCache === undefined
                ? undefined
                : result.output.sha256 === expectedCache.sha256,
            prefixMatchesExpected:
              expectedCache === undefined
                ? undefined
                : result.output.prefixSha256 ===
                  expectedCache.prefixSha256,
            differingSectionKinds,
            differingStringTableKinds,
          };
        }
        resolve(result);
      });
    });
  } finally {
    clearTimeout(timeout);
    clearTimeout(cancelTimer);
    if (!cancellationRequested) {
      await worker.terminate();
    }
  }
}

async function main() {
  try {
    const result = await runProbe(parseProbeArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (
      result.status === "failed" ||
      result.admission?.outputMatchesExpected === false
    ) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

if (isMainThread) {
  if (process.argv[1] === fileURLToPath(import.meta.url)) {
    await main();
  }
} else {
  await runWorker();
}

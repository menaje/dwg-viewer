// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  classifyConcurrentMemory,
  CONCURRENT_MEMORY_HARD_LIMIT_BYTES,
  fingerprintSceneCache,
  parseProbeArguments,
} from "./probe.mjs";

test("classifies the concurrent memory hard gate at the exact boundary", () => {
  assert.deepEqual(
    classifyConcurrentMemory(CONCURRENT_MEMORY_HARD_LIMIT_BYTES),
    {
      hardLimitBytes: CONCURRENT_MEMORY_HARD_LIMIT_BYTES,
      measuredBytes: CONCURRENT_MEMORY_HARD_LIMIT_BYTES,
      passed: true,
    },
  );
  assert.equal(
    classifyConcurrentMemory(
      CONCURRENT_MEMORY_HARD_LIMIT_BYTES + 1,
    ).passed,
    false,
  );
  assert.throws(() => classifyConcurrentMemory(-1), /non-negative/u);
});

test("parses bounded probe arguments without exposing an implicit product backend", () => {
  const options = parseProbeArguments([
    "--module",
    "./module.js",
    "--input",
    "./drawing.dwg",
    "--cancel-after-ms",
    "0",
    "--timeout-ms",
    "5000",
  ]);
  assert.equal(options.cancelAfterMs, 0);
  assert.equal(options.timeoutMs, 5000);
  assert.equal(path.isAbsolute(options.modulePath), true);
  assert.equal(path.isAbsolute(options.inputPath), true);
  assert.throws(
    () =>
      parseProbeArguments([
        "--module",
        "module.js",
        "--input",
        "drawing.dwg",
        "--unknown",
        "value",
      ]),
    /unknown option/u,
  );
});

test("fingerprints Scene Cache section bodies independently", () => {
  const cache = Buffer.alloc(115);
  cache.write("DWGSCN01", 0, "ascii");
  cache.writeUInt32LE(64, 12);
  cache.writeUInt32LE(1, 16);
  cache.writeUInt32LE(40, 20);
  cache.writeBigUInt64LE(64n, 32);
  cache.writeBigUInt64LE(BigInt(cache.byteLength), 40);
  cache.writeUInt32LE(10, 64);
  cache.writeUInt32LE(1, 68);
  cache.writeBigUInt64LE(112n, 72);
  cache.writeBigUInt64LE(3n, 80);
  cache.writeBigUInt64LE(3n, 88);
  cache.set([1, 2, 3], 112);
  const first = fingerprintSceneCache(cache);
  cache[114] = 4;
  const second = fingerprintSceneCache(cache);
  assert.equal(first.bytes, 115);
  assert.equal(first.sections[0].kind, 10);
  assert.notEqual(first.sha256, second.sha256);
  assert.equal(first.prefixSha256, second.prefixSha256);
  assert.notEqual(
    first.sections[0].sha256,
    second.sections[0].sha256,
  );
});

test("pins the qualification toolchain and keeps WASM out of the extension", async () => {
  const [buildScript, extensionPackage, extensionSource] =
    await Promise.all([
      readFile(path.join(import.meta.dirname, "build.sh"), "utf8"),
      readFile(
        path.join(
          import.meta.dirname,
          "..",
          "..",
          "..",
          "apps",
          "vscode-extension",
          "package.json",
        ),
        "utf8",
      ),
      readFile(
        path.join(
          import.meta.dirname,
          "..",
          "..",
          "..",
          "apps",
          "vscode-extension",
          "src",
          "extension.ts",
        ),
        "utf8",
      ),
    ]);
  assert.match(buildScript, /LIBREDWG_VERSION=0\.14/u);
  assert.match(
    buildScript,
    /LIBREDWG_SHA256=62ebb73b984f865960f20ed26619ea5f8789d5e3fd088fa40a2598384da81275/u,
  );
  assert.match(buildScript, /EMSDK_VERSION=4\.0\.15/u);
  assert.match(
    buildScript,
    /emscripten\/emsdk@sha256:27bc6267cb285223b8aebb7627bfebae7cb3ad2aaa0d5923b8aa5321793033e8/u,
  );
  assert.match(buildScript, /-sENVIRONMENT=node,worker/u);
  assert.match(buildScript, /-sALLOW_MEMORY_GROWTH=1/u);
  assert.doesNotMatch(extensionPackage, /wasm-worker|libredwg-wasm/u);
  assert.doesNotMatch(extensionSource, /LibreDwgWasm|libredwg-wasm/u);
});

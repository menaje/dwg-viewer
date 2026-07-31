import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  computeCacheId,
  isAbortError,
  NativeCacheManager,
  parseAdapterReport,
  resolveLibreDwgAdapter,
} from "../src/native-cache";

test("cache identity is deterministic and changes with source metadata", () => {
  const identity = {
    sourcePath: "/drawings/example.dwg",
    sourceSize: 100n,
    sourceMtimeNs: 200n,
    adapterPath: "/tools/libredwg-adapter",
    adapterSize: 300n,
    adapterMtimeNs: 400n,
  };
  const first = computeCacheId(identity);
  assert.equal(first, computeCacheId(identity));
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.notEqual(
    first,
    computeCacheId({ ...identity, sourceMtimeNs: 201n }),
  );
});

test("adapter report requires the expected schema, validation, and size", () => {
  parseAdapterReport(
    JSON.stringify({
      schema: "dwg-scene-cache/1",
      status: "ok",
      cache: { size_bytes: 5, validated: true },
    }),
    5n,
  );
  assert.throws(
    () =>
      parseAdapterReport(
        JSON.stringify({
          schema: "dwg-scene-cache/1",
          status: "ok",
          cache: { size_bytes: 4, validated: true },
        }),
        5n,
      ),
    /ADAPTER_REPORT_REJECTED/u,
  );
});

test("resolves only an absolute executable adapter path", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dwg-adapter-path-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const adapterPath = path.join(root, "libredwg-adapter");
  await writeFile(adapterPath, "#!/bin/sh\nexit 0\n");
  await chmod(adapterPath, 0o700);

  assert.equal(
    await resolveLibreDwgAdapter({
      configuredPath: adapterPath,
      extensionPath: root,
    }),
    adapterPath,
  );
  await assert.rejects(
    resolveLibreDwgAdapter({
      configuredPath: "relative/adapter",
      extensionPath: root,
    }),
    /ADAPTER_PATH_NOT_ABSOLUTE/u,
  );
});

test(
  "creates, reuses, rebuilds, and cancels native caches",
  { skip: process.platform === "win32" },
  async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dwg-native-cache-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const sourcePath = path.join(root, "drawing.dwg");
    const adapterPath = path.join(root, "libredwg-adapter");
    const cacheRoot = path.join(root, "cache");
    await writeFile(sourcePath, "fast");
    await writeFile(
      adapterPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const input = process.argv[3];
const output = process.argv[4];
if (
  process.env.DWG_VIEWER_ADAPTER_PROTOCOL !== "dwg-engine-adapter/1" ||
  process.env.DWG_VIEWER_BENCHMARK_PHASE !== "convert"
) process.exit(12);
const mode = fs.readFileSync(input, "utf8");
fs.writeFileSync(output, "cache");
const report = () => process.stdout.write(JSON.stringify({
  schema: "dwg-scene-cache/1",
  status: "ok",
  cache: { size_bytes: 5, validated: true }
}) + "\\n");
if (mode === "slow") setInterval(() => {}, 1000);
else if (mode === "change") setTimeout(report, 300);
else report();
`,
    );
    await chmod(adapterPath, 0o700);

    const manager = new NativeCacheManager(cacheRoot, adapterPath);
    const first = await manager.prepare(sourcePath, {
      signal: new AbortController().signal,
    });
    assert.equal(first.reused, false);
    assert.equal(await readFile(first.cachePath, "utf8"), "cache");

    const second = await manager.prepare(sourcePath, {
      signal: new AbortController().signal,
    });
    assert.equal(second.reused, true);
    assert.equal(second.cacheId, first.cacheId);

    const rebuilt = await manager.prepare(sourcePath, {
      force: true,
      signal: new AbortController().signal,
    });
    assert.equal(rebuilt.reused, false);

    await writeFile(sourcePath, "change");
    const changedInput = manager.prepare(sourcePath, {
      signal: new AbortController().signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeFile(sourcePath, "changed");
    await assert.rejects(changedInput, /CACHE_INPUT_CHANGED/u);

    await writeFile(sourcePath, "slow");
    const controller = new AbortController();
    const cancelled = manager.prepare(sourcePath, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(cancelled, (error) => isAbortError(error));
    assert.equal(
      (await readdir(cacheRoot)).some((name) => name.endsWith(".tmp")),
      false,
    );
  },
);

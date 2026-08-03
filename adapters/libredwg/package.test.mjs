// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  createDeterministicTarGzip,
  licenseExtractionArguments,
  LIBREDWG_SOURCE_SHA256,
  LIBREDWG_VERSION,
} from "./package.mjs";

const execFileAsync = promisify(execFile);

test("creates a deterministic archive with fixed paths and executable modes", async (context) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "dwg-adapter-package-test-"),
  );
  context.after(() => rm(root, { recursive: true, force: true }));
  const archivePath = path.join(root, "adapter.tar.gz");
  const files = [
    {
      name: "package/bin/libredwg-adapter",
      data: Buffer.from("binary"),
      mode: 0o755,
    },
    {
      name: "package/source/README.txt",
      data: Buffer.from("source"),
      mode: 0o644,
    },
  ];
  const first = createDeterministicTarGzip(files);
  const second = createDeterministicTarGzip([...files].reverse());
  assert.deepEqual(first, second);
  assert.equal(first.readUInt32LE(4), 0);
  assert.equal(first[9], 255);
  await writeFile(archivePath, first);

  const listing = await execFileAsync(
    "tar",
    ["-tvzf", archivePath],
    { encoding: "utf8" },
  );
  assert.match(
    listing.stdout,
    /-rwxr-xr-x.*package\/bin\/libredwg-adapter/u,
  );
  assert.match(
    listing.stdout,
    /-rw-r--r--.*package\/source\/README\.txt/u,
  );
  assert.doesNotMatch(listing.stdout, /\/private\/|\/Users\//u);
});

test("rejects traversal, absolute, backslash, and duplicate archive paths", () => {
  for (const name of [
    "../escape",
    "/absolute",
    "folder\\windows",
  ]) {
    assert.throws(
      () =>
        createDeterministicTarGzip([
          { name, data: Buffer.alloc(0), mode: 0o644 },
        ]),
      /unsafe archive path/u,
    );
  }
  assert.throws(
    () =>
      createDeterministicTarGzip([
        { name: "same", data: Buffer.alloc(0), mode: 0o644 },
        { name: "same", data: Buffer.alloc(0), mode: 0o644 },
      ]),
    /duplicate archive path/u,
  );
});

test("forces local GNU tar handling for Windows drive archives", () => {
  assert.deepEqual(
    licenseExtractionArguments(
      String.raw`D:\a\_temp\libredwg-0.14.tar.xz`,
      "win32",
    ),
    [
      "--force-local",
      "-xOf",
      "D:/a/_temp/libredwg-0.14.tar.xz",
      "libredwg-0.14/COPYING",
    ],
  );
  assert.deepEqual(
    licenseExtractionArguments("/tmp/libredwg-0.14.tar.xz", "linux"),
    [
      "-xOf",
      "/tmp/libredwg-0.14.tar.xz",
      "libredwg-0.14/COPYING",
    ],
  );
});

test("keeps package and source preparation pins synchronized", async () => {
  const [prepareScript, buildScript, nativeEngineSource] = await Promise.all([
    readFile(path.join(import.meta.dirname, "prepare.sh"), "utf8"),
    readFile(path.join(import.meta.dirname, "build.sh"), "utf8"),
    readFile(
      path.join(
        import.meta.dirname,
        "..",
        "..",
        "apps",
        "vscode-extension",
        "src",
        "native-cache.ts",
      ),
      "utf8",
    ),
  ]);
  assert.match(
    prepareScript,
    new RegExp(`LIBREDWG_VERSION=${LIBREDWG_VERSION.replace(".", "\\.")}`, "u"),
  );
  assert.match(
    prepareScript,
    new RegExp(`LIBREDWG_SHA256=${LIBREDWG_SOURCE_SHA256}`, "u"),
  );
  assert.match(prepareScript, /--disable-shared/u);
  assert.match(prepareScript, /--enable-static/u);
  assert.match(
    buildScript,
    new RegExp(`LIBREDWG_VERSION=${LIBREDWG_VERSION.replace(".", "\\.")}`, "u"),
  );
  assert.match(buildScript, /--exact-version="\$LIBREDWG_VERSION"/u);
  assert.match(buildScript, /static_library=.*libredwg\.a/u);
  assert.match(buildScript, /"\$static_library" -lm/u);
  assert.match(buildScript, /MINGW\*.*MSYS\*.*CYGWIN\*/u);
  assert.match(buildScript, /-static -static-libgcc/u);
  assert.match(buildScript, /"\$strip" "\$output"/u);
  assert.match(
    nativeEngineSource,
    new RegExp(
      `LIBREDWG_NATIVE_ENGINE_VERSION = "${LIBREDWG_VERSION.replace(".", "\\.")}"`,
      "u",
    ),
  );
});

test("uses native Windows isolation and a path-safe piped input contract", async () => {
  const [adapterSource, sceneCacheSource, hostSource] = await Promise.all([
    readFile(
      path.join(import.meta.dirname, "libredwg_adapter.c"),
      "utf8",
    ),
    readFile(
      path.join(import.meta.dirname, "libredwg_scene_cache.c"),
      "utf8",
    ),
    readFile(
      path.join(
        import.meta.dirname,
        "..",
        "..",
        "apps",
        "vscode-extension",
        "src",
        "native-cache.ts",
      ),
      "utf8",
    ),
  ]);
  assert.match(adapterSource, /DWG_VIEWER_NULL_DEVICE "NUL"/u);
  assert.match(adapterSource, /QueryPerformanceCounter/u);
  assert.match(adapterSource, /DWG_VIEWER_STDIN_SOURCE_SIZE/u);
  assert.match(adapterSource, /dwg_read_file \(path, dwg\)/u);
  assert.match(sceneCacheSource, /CreateFileW/u);
  assert.match(sceneCacheSource, /FILE_FLAG_DELETE_ON_CLOSE/u);
  assert.match(sceneCacheSource, /_O_NOINHERIT/u);
  assert.match(sceneCacheSource, /_lseeki64/u);
  assert.match(hostSource, /adapterInputPath = "-"/u);
  assert.match(hostSource, /windowsChildPath/u);
  assert.match(hostSource, /createReadStream\(inputPath\)/u);
});

test("keeps Windows in the reproducible attested release set", async () => {
  const [releaseWorkflow, distributionGuide] = await Promise.all([
    readFile(
      path.join(
        import.meta.dirname,
        "..",
        "..",
        ".github",
        "workflows",
        "release.yml",
      ),
      "utf8",
    ),
    readFile(
      path.join(
        import.meta.dirname,
        "..",
        "..",
        "docs",
        "distribution.md",
      ),
      "utf8",
    ),
  ]);
  assert.match(releaseWorkflow, /runner: windows-2025/u);
  assert.match(releaseWorkflow, /target: win32-x64/u);
  assert.match(
    releaseWorkflow,
    /dwg-viewer-libredwg-0\.14-win32-x64\.tar\.gz/u,
  );
  assert.match(
    releaseWorkflow,
    /Build, diagnose, reproduce, and verify Windows package/u,
  );
  assert.match(distributionGuide, /Windows native-path/u);
  assert.doesNotMatch(
    distributionGuide,
    /Windows artifacts are not published/u,
  );
});

test("normalizes legacy inspection text before corpus metrics", async () => {
  const adapterSource = await readFile(
    path.join(import.meta.dirname, "libredwg_adapter.c"),
    "utf8",
  );
  assert.match(
    adapterSource,
    /inspect_text_entity \(const Dwg_Data \*dwg,/u,
  );
  assert.match(
    adapterSource,
    /converted = bit_TV_to_utf8 \(text, dwg->header\.codepage\);/u,
  );
  assert.match(
    adapterSource,
    /text_include \(summary, source\);/u,
  );
});

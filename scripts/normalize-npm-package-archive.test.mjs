// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  normalizeNpmPackageArchive,
  normalizeNpmPackageArchiveBytes,
} from "./normalize-npm-package-archive.mjs";

function platformShapedArchive(content) {
  const archive = gzipSync(content);
  archive.set([1, 2, 3, 4], 4);
  archive[9] = 19;
  return archive;
}

test("normalizes only platform gzip metadata", () => {
  const content = Buffer.from("deterministic npm package content");
  const original = platformShapedArchive(content);
  const normalized = normalizeNpmPackageArchiveBytes(original);

  assert.deepEqual(normalized.subarray(4, 8), Buffer.alloc(4));
  assert.equal(normalized[9], 3);
  assert.deepEqual(gunzipSync(normalized), content);
  assert.deepEqual(
    normalizeNpmPackageArchiveBytes(normalized),
    normalized,
  );
});

test("normalizes an npm package archive in place", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "dwg-viewer-npm-archive-"),
  );
  try {
    const archivePath = path.join(directory, "package.tgz");
    await writeFile(
      archivePath,
      platformShapedArchive(Buffer.from("package bytes")),
    );
    const first = await normalizeNpmPackageArchive(archivePath);
    const firstBytes = await readFile(archivePath);
    const second = await normalizeNpmPackageArchive(archivePath);
    const secondBytes = await readFile(archivePath);

    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.deepEqual(secondBytes, firstBytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects unsupported gzip headers and filenames", async () => {
  const archive = platformShapedArchive(Buffer.from("package bytes"));
  archive[3] = 4;
  assert.throws(
    () => normalizeNpmPackageArchiveBytes(archive),
    /without optional fields/u,
  );
  await assert.rejects(
    normalizeNpmPackageArchive("package.tar.gz"),
    /must use a \.tgz filename/u,
  );
});

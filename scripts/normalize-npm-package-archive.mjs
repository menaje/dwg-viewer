// SPDX-License-Identifier: MPL-2.0

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GZIP_HEADER_BYTES = 10;
const GZIP_TRAILER_BYTES = 8;
const GZIP_DEFLATE_METHOD = 8;
const GZIP_UNIX_OS = 3;
const MAXIMUM_ARCHIVES = 32;

export function normalizeNpmPackageArchiveBytes(bytes) {
  const normalized = Buffer.from(bytes);
  if (
    normalized.byteLength <
      GZIP_HEADER_BYTES + GZIP_TRAILER_BYTES ||
    normalized[0] !== 0x1f ||
    normalized[1] !== 0x8b ||
    normalized[2] !== GZIP_DEFLATE_METHOD
  ) {
    throw new Error("npm package archive must use gzip deflate");
  }
  if (normalized[3] !== 0) {
    throw new Error(
      "npm package archive must use the bounded header without optional fields",
    );
  }

  normalized.fill(0, 4, 8);
  normalized[9] = GZIP_UNIX_OS;
  return normalized;
}

export async function normalizeNpmPackageArchive(filePath) {
  const absolutePath = path.resolve(filePath);
  if (!absolutePath.endsWith(".tgz")) {
    throw new Error("npm package archive must use a .tgz filename");
  }
  const original = await readFile(absolutePath);
  const normalized = normalizeNpmPackageArchiveBytes(original);
  const changed = Buffer.compare(original, normalized) !== 0;
  if (changed) {
    await writeFile(absolutePath, normalized);
  }
  return Object.freeze({
    path: absolutePath,
    bytes: normalized.byteLength,
    changed,
  });
}

async function main() {
  const archivePaths = process.argv.slice(2);
  if (
    archivePaths.length === 0 ||
    archivePaths.length > MAXIMUM_ARCHIVES
  ) {
    throw new Error(
      `expected between 1 and ${MAXIMUM_ARCHIVES} npm package archives`,
    );
  }
  for (const archivePath of archivePaths) {
    await normalizeNpmPackageArchive(archivePath);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
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
  normalizeVsixArchive,
  normalizeVsixArchiveBytes,
} from "./normalize-vsix-archive.mjs";

function minimalVsix(time, date) {
  const name = Buffer.from("extension/empty.txt");
  const local = Buffer.alloc(30 + name.byteLength);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt16LE(name.byteLength, 26);
  name.copy(local, 30);

  const central = Buffer.alloc(46 + name.byteLength);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x031e, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt16LE(name.byteLength, 28);
  name.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.byteLength, 12);
  end.writeUInt32LE(local.byteLength, 16);
  return Buffer.concat([local, central, end]);
}

test("normalizes local and central VSIX timestamps", () => {
  const original = minimalVsix(0x6b31, 0x5d04);
  const normalized = normalizeVsixArchiveBytes(original);
  const centralOffset = 30 + Buffer.byteLength("extension/empty.txt");

  assert.equal(normalized.readUInt16LE(10), 0);
  assert.equal(normalized.readUInt16LE(12), 0x21);
  assert.equal(normalized.readUInt16LE(centralOffset + 12), 0);
  assert.equal(
    normalized.readUInt16LE(centralOffset + 14),
    0x21,
  );
  assert.deepEqual(normalizeVsixArchiveBytes(normalized), normalized);
});

test("normalizes a VSIX archive in place", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "dwg-viewer-vsix-archive-"),
  );
  try {
    const archivePath = path.join(directory, "viewer.vsix");
    await writeFile(archivePath, minimalVsix(0x6b31, 0x5d04));
    const first = await normalizeVsixArchive(archivePath);
    const firstBytes = await readFile(archivePath);
    const second = await normalizeVsixArchive(archivePath);
    const secondBytes = await readFile(archivePath);

    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.deepEqual(secondBytes, firstBytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects encrypted VSIX entries", async () => {
  const encrypted = minimalVsix(0x6b31, 0x5d04);
  const centralOffset = 30 + Buffer.byteLength("extension/empty.txt");
  encrypted.writeUInt16LE(0x0001, 6);
  encrypted.writeUInt16LE(0x0001, centralOffset + 8);
  assert.throws(
    () => normalizeVsixArchiveBytes(encrypted),
    /must not be encrypted/u,
  );
  await assert.rejects(
    normalizeVsixArchive("viewer.zip"),
    /must use a \.vsix filename/u,
  );
});

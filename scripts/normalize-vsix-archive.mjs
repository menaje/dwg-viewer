// SPDX-License-Identifier: MPL-2.0

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_BYTES = 22;
const MAXIMUM_END_SEARCH_BYTES = 65_557;
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 0x21;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const ENCRYPTED_FLAG = 0x0001;
const ZIP64_SENTINEL = 0xffff_ffff;

function endOffset(bytes) {
  const first = Math.max(0, bytes.byteLength - MAXIMUM_END_SEARCH_BYTES);
  for (let offset = bytes.byteLength - END_BYTES; offset >= first; offset -= 1) {
    if (bytes.readUInt32LE(offset) === END_SIGNATURE) {
      const commentBytes = bytes.readUInt16LE(offset + 20);
      if (offset + END_BYTES + commentBytes === bytes.byteLength) {
        return offset;
      }
    }
  }
  throw new Error("VSIX end-of-central-directory record is missing");
}

function assertBoundedExtraFields(bytes, offset, length) {
  const end = offset + length;
  let cursor = offset;
  while (cursor < end) {
    if (cursor + 4 > end) {
      throw new Error("VSIX ZIP extra field is truncated");
    }
    const identifier = bytes.readUInt16LE(cursor);
    const valueBytes = bytes.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + valueBytes > end) {
      throw new Error("VSIX ZIP extra field value is truncated");
    }
    if (identifier === 0x5455 || identifier === 0x000a) {
      throw new Error("VSIX must not retain extended timestamp fields");
    }
    cursor += valueBytes;
  }
}

function assertSupportedFlags(flags) {
  if ((flags & ENCRYPTED_FLAG) !== 0) {
    throw new Error("VSIX ZIP entries must not be encrypted");
  }
}

export function normalizeVsixArchiveBytes(bytes) {
  const normalized = Buffer.from(bytes);
  const end = endOffset(normalized);
  const disk = normalized.readUInt16LE(end + 4);
  const centralDisk = normalized.readUInt16LE(end + 6);
  const diskEntries = normalized.readUInt16LE(end + 8);
  const totalEntries = normalized.readUInt16LE(end + 10);
  const centralBytes = normalized.readUInt32LE(end + 12);
  const centralOffset = normalized.readUInt32LE(end + 16);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries
  ) {
    throw new Error("VSIX must use one non-spanned ZIP archive");
  }
  if (
    centralBytes === ZIP64_SENTINEL ||
    centralOffset === ZIP64_SENTINEL ||
    centralOffset + centralBytes !== end
  ) {
    throw new Error("VSIX must use a bounded non-ZIP64 directory");
  }

  let centralCursor = centralOffset;
  const entries = [];
  for (let index = 0; index < totalEntries; index += 1) {
    if (
      centralCursor + CENTRAL_HEADER_BYTES > end ||
      normalized.readUInt32LE(centralCursor) !==
        CENTRAL_FILE_SIGNATURE
    ) {
      throw new Error("VSIX central directory is malformed");
    }
    const flags = normalized.readUInt16LE(centralCursor + 8);
    assertSupportedFlags(flags);
    const method = normalized.readUInt16LE(centralCursor + 10);
    const crc32 = normalized.readUInt32LE(centralCursor + 16);
    const compressedBytes = normalized.readUInt32LE(
      centralCursor + 20,
    );
    const uncompressedBytes = normalized.readUInt32LE(
      centralCursor + 24,
    );
    const nameBytes = normalized.readUInt16LE(centralCursor + 28);
    const extraBytes = normalized.readUInt16LE(centralCursor + 30);
    const commentBytes = normalized.readUInt16LE(centralCursor + 32);
    const localHeaderOffset = normalized.readUInt32LE(
      centralCursor + 42,
    );
    if (
      compressedBytes === ZIP64_SENTINEL ||
      uncompressedBytes === ZIP64_SENTINEL ||
      localHeaderOffset === ZIP64_SENTINEL
    ) {
      throw new Error("VSIX central entries must not use ZIP64");
    }
    if (localHeaderOffset >= centralOffset) {
      throw new Error("VSIX local entry offset is outside file data");
    }
    const nameOffset = centralCursor + CENTRAL_HEADER_BYTES;
    const extraOffset =
      nameOffset + nameBytes;
    assertBoundedExtraFields(normalized, extraOffset, extraBytes);
    entries.push(
      Object.freeze({
        flags,
        method,
        crc32,
        compressedBytes,
        uncompressedBytes,
        localHeaderOffset,
        name: Buffer.from(
          normalized.subarray(nameOffset, nameOffset + nameBytes),
        ),
      }),
    );
    normalized.writeUInt16LE(FIXED_DOS_TIME, centralCursor + 12);
    normalized.writeUInt16LE(FIXED_DOS_DATE, centralCursor + 14);
    centralCursor =
      extraOffset + extraBytes + commentBytes;
  }
  if (centralCursor !== end) {
    throw new Error("VSIX central directory length is inconsistent");
  }

  const orderedEntries = [...entries].sort(
    (left, right) =>
      left.localHeaderOffset - right.localHeaderOffset,
  );
  for (let index = 0; index < orderedEntries.length; index += 1) {
    const entry = orderedEntries[index];
    const localOffset = entry.localHeaderOffset;
    const boundary =
      orderedEntries[index + 1]?.localHeaderOffset ??
      centralOffset;
    if (
      localOffset + LOCAL_HEADER_BYTES > boundary ||
      normalized.readUInt32LE(localOffset) !== LOCAL_FILE_SIGNATURE
    ) {
      throw new Error("VSIX local file directory is malformed");
    }
    const flags = normalized.readUInt16LE(localOffset + 6);
    const method = normalized.readUInt16LE(localOffset + 8);
    assertSupportedFlags(flags);
    if (flags !== entry.flags || method !== entry.method) {
      throw new Error("VSIX local and central entry metadata differ");
    }
    const localCrc32 = normalized.readUInt32LE(localOffset + 14);
    const localCompressedBytes = normalized.readUInt32LE(
      localOffset + 18,
    );
    const localUncompressedBytes = normalized.readUInt32LE(
      localOffset + 22,
    );
    const nameBytes = normalized.readUInt16LE(localOffset + 26);
    const extraBytes = normalized.readUInt16LE(localOffset + 28);
    const nameOffset = localOffset + LOCAL_HEADER_BYTES;
    const extraOffset = nameOffset + nameBytes;
    const dataOffset = extraOffset + extraBytes;
    assertBoundedExtraFields(normalized, extraOffset, extraBytes);
    if (
      Buffer.compare(
        normalized.subarray(nameOffset, nameOffset + nameBytes),
        entry.name,
      ) !== 0
    ) {
      throw new Error("VSIX local and central entry names differ");
    }
    const dataEnd = dataOffset + entry.compressedBytes;
    if (dataEnd > boundary) {
      throw new Error("VSIX local file data exceeds its boundary");
    }
    if ((flags & DATA_DESCRIPTOR_FLAG) !== 0) {
      if (
        (localCrc32 !== 0 && localCrc32 !== entry.crc32) ||
        (localCompressedBytes !== 0 &&
          localCompressedBytes !== entry.compressedBytes) ||
        (localUncompressedBytes !== 0 &&
          localUncompressedBytes !== entry.uncompressedBytes)
      ) {
        throw new Error("VSIX local data descriptor metadata differs");
      }
      let descriptorOffset = dataEnd;
      if (
        descriptorOffset + 4 <= boundary &&
        normalized.readUInt32LE(descriptorOffset) === 0x08074b50
      ) {
        descriptorOffset += 4;
      }
      if (descriptorOffset + 12 !== boundary) {
        throw new Error("VSIX data descriptor length is inconsistent");
      }
      if (
        normalized.readUInt32LE(descriptorOffset) !==
          entry.crc32 ||
        normalized.readUInt32LE(descriptorOffset + 4) !==
          entry.compressedBytes ||
        normalized.readUInt32LE(descriptorOffset + 8) !==
          entry.uncompressedBytes
      ) {
        throw new Error("VSIX data descriptor values differ");
      }
    } else {
      if (
        localCrc32 !== entry.crc32 ||
        localCompressedBytes !== entry.compressedBytes ||
        localUncompressedBytes !== entry.uncompressedBytes ||
        dataEnd !== boundary
      ) {
        throw new Error("VSIX local and central sizes differ");
      }
    }
    normalized.writeUInt16LE(FIXED_DOS_TIME, localOffset + 10);
    normalized.writeUInt16LE(FIXED_DOS_DATE, localOffset + 12);
  }
  return normalized;
}

export async function normalizeVsixArchive(filePath) {
  const absolutePath = path.resolve(filePath);
  if (!absolutePath.endsWith(".vsix")) {
    throw new Error("VSIX archive must use a .vsix filename");
  }
  const original = await readFile(absolutePath);
  const normalized = normalizeVsixArchiveBytes(original);
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
  if (archivePaths.length === 0 || archivePaths.length > 8) {
    throw new Error("expected between 1 and 8 VSIX archives");
  }
  for (const archivePath of archivePaths) {
    await normalizeVsixArchive(archivePath);
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

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import {
  buildDownloadUrl,
  crc32,
  extractDwgEntries,
  fetchPublicCorpus,
  parseArguments,
  validateAssetManifest,
} from "./public-korean-corpus.mjs";

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.isBuffer(entry.name)
      ? entry.name
      : Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const compressed = deflateRawSync(data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    localParts.push(local, name, compressed);
    centralParts.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function rawManifest(zip) {
  return {
    schema: "dwg-public-korean-corpus-assets/1",
    sources: [
      {
        id: "public-fixture-001",
        title: "공개 테스트 도면",
        publisher: "국가유산청",
        catalogUrl:
          "https://www.data.go.kr/data/15032398/fileData.do",
        license: {
          id: "KOGL-Type-1",
          name: "공공누리 제1유형(출처표시)",
          termsUrl:
            "https://www.copyright.or.kr/gov/nuri/guide/index.do",
        },
        download: {
          endpoint:
            "https://www.data.go.kr/cmm/cmm/fileDownload.do",
          parameters: {
            atchFileId: "FILE_000000002914783",
            fileDetailSn: "1",
            dataNm: "국가유산청_공개 테스트 도면",
          },
          sizeBytes: zip.length,
          sha256: createHash("sha256").update(zip).digest("hex"),
        },
        expected: {
          dwgFiles: 1,
          versions: ["AC1018"],
          discipline: "architecture",
        },
      },
    ],
  };
}

function binaryResponse(bytes) {
  let consumed = false;
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return name.toLocaleLowerCase() === "content-length"
          ? String(bytes.length)
          : null;
      },
    },
    body: {
      getReader() {
        return {
          async read() {
            if (consumed) {
              return { done: true, value: undefined };
            }
            consumed = true;
            return { done: false, value: new Uint8Array(bytes) };
          },
          async cancel() {
            consumed = true;
          },
        };
      },
    },
  };
}

test("parses only absolute fetch paths", () => {
  assert.deepEqual(
    parseArguments([
      "--manifest",
      "/private/assets.json",
      "--output",
      "/private/corpus",
    ]),
    {
      manifestPath: "/private/assets.json",
      outputPath: "/private/corpus",
    },
  );
  assert.throws(
    () =>
      parseArguments([
        "--manifest",
        "relative.json",
        "--output",
        "/private/corpus",
      ]),
    /absolute path/u,
  );
});

test("validates the pinned portal, KOGL license, and download URL", () => {
  const zip = createZip([
    {
      name: "fixture.dwg",
      data: Buffer.from("AC1018drawing"),
    },
  ]);
  const manifest = validateAssetManifest(rawManifest(zip));
  const url = new URL(buildDownloadUrl(manifest.sources[0]));
  assert.equal(url.hostname, "www.data.go.kr");
  assert.equal(
    url.searchParams.get("atchFileId"),
    "FILE_000000002914783",
  );
  assert.equal(
    url.searchParams.get("dataNm"),
    "국가유산청_공개 테스트 도면",
  );

  const untrusted = rawManifest(zip);
  untrusted.sources[0].download.endpoint =
    "https://example.com/archive.zip";
  assert.throws(
    () => validateAssetManifest(untrusted),
    /trusted data portal/u,
  );
});

test("extracts DWG bytes without trusting ZIP entry names", () => {
  const drawing = Buffer.concat([
    Buffer.from("AC1018", "ascii"),
    Buffer.from([0x0d, 0x0a, 0x1a, 0xff, 0x00]),
  ]);
  const zip = createZip([
    {
      name: Buffer.from([
        0x2e, 0x2e, 0x2f, 0xb0, 0xa1, 0x2e, 0x64, 0x77, 0x67,
      ]),
      data: drawing,
    },
    {
      name: "preview.png",
      data: Buffer.from("\u0089PNG\r\n"),
    },
  ]);
  const extracted = extractDwgEntries(zip);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].version, "AC1018");
  assert.deepEqual(extracted[0].bytes, drawing);

  const corrupted = Buffer.from(zip);
  corrupted[40] ^= 0x01;
  assert.throws(
    () => extractDwgEntries(corrupted),
    /CRC-32|invalid|distance|data/u,
  );
});

test("downloads exact pins into a new owner-only deterministic corpus", async (context) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "dwg-public-corpus-test-"),
  );
  context.after(() => rm(root, { recursive: true, force: true }));
  const outputPath = path.join(root, "corpus");
  const drawing = Buffer.from("AC1018public-drawing");
  const zip = createZip([
    { name: "../../escape.dwg", data: drawing },
    { name: "notice.txt", data: Buffer.from("public") },
  ]);
  const manifest = validateAssetManifest(rawManifest(zip));
  const requests = [];
  const provenance = await fetchPublicCorpus(
    manifest,
    outputPath,
    {
      async fetch(url, options) {
        requests.push({ url, options });
        return new URL(url).pathname.startsWith("/data/")
          ? binaryResponse(
              Buffer.from(
                "이용허락범위 공공저작물 : 출처표시 (제 1유형)",
                "utf8",
              ),
            )
          : binaryResponse(zip);
      },
    },
  );
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /\/data\/15032398\//u);
  assert.match(requests[1].url, /\/cmm\/cmm\/fileDownload\.do/u);
  assert.equal(requests[1].options.redirect, "error");
  assert.deepEqual(
    await readFile(
      path.join(outputPath, "public-fixture-001-001.dwg"),
    ),
    drawing,
  );
  assert.equal(provenance.summary.dwgFiles, 1);
  assert.equal(
    provenance.sources[0].catalogLicenseVerified,
    true,
  );
  assert.equal(provenance.sources[0].extracted.dwgBytesModified, false);
  assert.deepEqual(
    provenance.sources[0].extracted.files,
    ["public-fixture-001-001.dwg"],
  );
  assert.doesNotMatch(
    await readFile(
      path.join(outputPath, "PUBLIC-CORPUS-PROVENANCE.json"),
      "utf8",
    ),
    /\.\.\/escape/u,
  );
  if (process.platform !== "win32") {
    assert.equal((await stat(outputPath)).mode & 0o777, 0o700);
  }
  await assert.rejects(
    () => fetchPublicCorpus(manifest, outputPath, {
      fetch: async () => binaryResponse(zip),
    }),
    /EEXIST/u,
  );

  const rejectedPath = path.join(root, "rejected");
  await assert.rejects(
    () =>
      fetchPublicCorpus(manifest, rejectedPath, {
        fetch: async () =>
          binaryResponse(
            Buffer.from(
              "공공저작물 : 출처표시, 상업적 이용금지 (제 2유형)",
              "utf8",
            ),
          ),
      }),
    /no longer declares KOGL Type 1/u,
  );
  await assert.rejects(stat(rejectedPath), /ENOENT/u);
});

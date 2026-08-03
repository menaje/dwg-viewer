import assert from "node:assert/strict";
import test from "node:test";
import {
  bytesToBase64,
  fitCameraView,
  makeLayoutPngZipEntries,
  makeRasterPdf,
  makeStoredZip,
  pixelsForPage,
  resolvePageGeometry,
  sanitizeExportStem,
  scaleCameraView,
} from "../src/drawing-export.mjs";

const JPEG_FIXTURE = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
  0x49, 0x46, 0x00, 0x01, 0xff, 0xd9,
]);

test("uses arbitrary drawing paper metadata before presets", () => {
  assert.deepEqual(
    resolvePageGeometry({
      layout: {
        paperWidth: 914.4,
        paperHeight: 609.6,
        canonicalMediaName: "ARCH_D",
      },
      paper: "drawing",
      orientation: "drawing",
    }),
    {
      widthMm: 914.4,
      heightMm: 609.6,
      label: "ARCH_D",
      source: "drawing",
      orientation: "landscape",
    },
  );
  assert.deepEqual(
    resolvePageGeometry({
      layout: {
        paperWidth: 297,
        paperHeight: 420,
        rotation: 1,
      },
      paper: "drawing",
      orientation: "drawing",
    }),
    {
      widthMm: 420,
      heightMm: 297,
      label: "도면 용지",
      source: "drawing",
      orientation: "landscape",
    },
  );
  assert.deepEqual(
    resolvePageGeometry({
      layout: { paperWidth: 0, paperHeight: 0 },
      paper: "drawing",
      orientation: "landscape",
    }),
    {
      widthMm: 297,
      heightMm: 210,
      label: "A4",
      source: "fallback",
      orientation: "landscape",
    },
  );
});

test("limits pixels while preserving the paper aspect", () => {
  const pixels = pixelsForPage(
    { widthMm: 1_189, heightMm: 841 },
    600,
  );
  assert.equal(pixels.limited, true);
  assert.ok(pixels.width <= 8_192);
  assert.ok(pixels.height <= 8_192);
  assert.ok(pixels.width * pixels.height <= 12_000_000);
  assert.ok(
    Math.abs(pixels.width / pixels.height - 1_189 / 841) < 0.002,
  );
});

test("creates fitted and explicit scale camera views", () => {
  assert.deepEqual(
    fitCameraView(
      { min: [0, 0, 0], max: [400, 100, 0] },
      2,
      1,
    ),
    { origin: [200, 50, 0], worldHeight: 200 },
  );
  assert.deepEqual(
    scaleCameraView([10, 20, 0], 200, 50, 1),
    { origin: [10, 20, 0], worldHeight: 10_000 },
  );
  assert.deepEqual(
    scaleCameraView([10, 20, 0], 254, 10, 1 / 25.4),
    { origin: [10, 20, 0], worldHeight: 100 },
  );
});

test("writes a multi-page PDF with mixed page sizes", () => {
  const pdf = makeRasterPdf([
    {
      jpeg: JPEG_FIXTURE,
      pixelWidth: 100,
      pixelHeight: 200,
      widthMm: 210,
      heightMm: 297,
    },
    {
      jpeg: JPEG_FIXTURE,
      pixelWidth: 200,
      pixelHeight: 100,
      widthMm: 420,
      heightMm: 297,
    },
  ]);
  const text = new TextDecoder("latin1").decode(pdf);
  assert.ok(text.startsWith("%PDF-1.7"));
  assert.match(text, /\/Count 2/);
  assert.match(text, /\/MediaBox \[0 0 595\.2756 841\.8898\]/);
  assert.match(text, /\/MediaBox \[0 0 1190\.5512 841\.8898\]/);
  assert.ok(text.endsWith("%%EOF\n"));
});

test("writes portable layout PNG names and a UTF-8 name manifest", () => {
  const entries = makeLayoutPngZipEntries([
    {
      label: "배치 1",
      data: Uint8Array.from([1, 2, 3]),
    },
    {
      label: "A/B",
      data: Uint8Array.from([4, 5]),
    },
  ]);
  assert.deepEqual(
    entries.map((entry) => `${entry.name}${entry.extension}`),
    ["01-layout.png", "02-layout.png", "layout-names.txt"],
  );
  assert.match(
    new TextDecoder().decode(entries[2].data),
    /01-layout\.png\t배치 1/,
  );
  const zip = makeStoredZip(entries);
  const text = new TextDecoder().decode(zip);
  const view = new DataView(zip.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(6, true) & 0x0800, 0x0800);
  assert.equal(
    view.getUint16(30 + view.getUint16(26, true), true),
    0x7075,
  );
  assert.match(text, /01-layout\.png/);
  assert.match(text, /02-layout\.png/);
  assert.match(text, /layout-names\.txt/);
  assert.match(text, /배치 1/);
  assert.equal(
    new DataView(zip.buffer).getUint32(zip.length - 22, true),
    0x06054b50,
  );
});

test("sanitizes file stems and emits bounded base64", () => {
  assert.equal(sanitizeExportStem('A<1>:"?.dwg'), "A_1____");
  assert.equal(bytesToBase64(Uint8Array.from([0, 1, 2, 255])), "AAEC/w==");
});

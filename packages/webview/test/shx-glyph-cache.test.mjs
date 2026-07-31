import assert from "node:assert/strict";
import test from "node:test";

import {
  ShxFont,
  ShxFontType,
} from "#shx-parser";

import {
  ShxGlyphCache,
  encodeLegacyBigFontCode,
  normalizeShxFontName,
} from "../src/shx-glyph-cache.mjs";

function buildMinimalShapesShx(entries) {
  const headerBytes = new TextEncoder().encode(
    "AutoCAD-86 shapes V1.0\r\n\x1a",
  );
  const tableSize = 6 + entries.length * 4;
  const dataBytes = entries.reduce((sum, entry) => sum + entry.raw.length, 0);
  const buffer = new ArrayBuffer(headerBytes.length + tableSize + dataBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes.set(headerBytes);
  let offset = headerBytes.length;
  view.setInt16(offset, 0, true);
  view.setInt16(offset + 2, 0, true);
  view.setInt16(offset + 4, entries.length, true);
  offset += 6;
  for (const entry of entries) {
    view.setUint16(offset, entry.code, true);
    view.setUint16(offset + 2, entry.raw.length, true);
    offset += 4;
  }
  for (const entry of entries) {
    bytes.set(entry.raw, offset);
    offset += entry.raw.length;
  }
  return buffer;
}

function textFontBuffer(codes = [65]) {
  const info = new Uint8Array([
    ...new TextEncoder().encode("test"),
    0,
    8,
    2,
    0,
  ]);
  const glyph = new Uint8Array([
    ...new TextEncoder().encode("GLYPH"),
    0,
    0x01,
    0x80,
    0x02,
    0x00,
  ]);
  return buildMinimalShapesShx([
    { code: 0, raw: info },
    ...codes.map((code) => ({ code, raw: glyph })),
  ]);
}

function bigFontFactory(code) {
  const fontData = {
    header: {
      fontType: ShxFontType.BIGFONT,
      fileHeader: "AutoCAD-86 bigfont V1.0",
      fileVersion: "1.0",
    },
    content: {
      data: {
        [code]: new Uint8Array([0x01, 0x80, 0x02, 0x00]),
      },
      info: "test",
      orientation: "horizontal",
      baseUp: 7,
      baseDown: 1,
      height: 8,
      width: 8,
      isExtended: false,
    },
  };
  return () => new ShxFont(fontData);
}

test("normalizes Windows and POSIX SHX font references", () => {
  assert.equal(normalizeShxFontName("C:\\Fonts\\WHGTXT.SHX"), "whgtxt.shx");
  assert.equal(normalizeShxFontName("/fonts/TXT.SHX"), "txt.shx");
  assert.equal(normalizeShxFontName(""), "");
});

test("parses a compiled SHX lazily and caches compact line segments", () => {
  const cache = new ShxGlyphCache();
  cache.registerFont("TXT.SHX", textFontBuffer([65]));

  const glyph = cache.getGlyph({ fontFile: "txt" }, 65);
  assert.ok(glyph);
  assert.equal(glyph.fontName, "txt.shx");
  assert.equal(glyph.segmentCount, 1);
  assert.equal(glyph.vertices.byteLength, 16);
  assert.equal(cache.getGlyph({ fontFile: "TXT.SHX" }, 65), glyph);
  assert.equal(cache.stats.hits, 1);
  assert.equal(cache.stats.glyphs, 1);
  assert.ok(cache.stats.glyphBytes <= 80);

  cache.dispose();
  assert.equal(cache.stats.registeredFonts, 0);
});

test("maps Unicode Hangul to a paired EUC-KR BigFont code", () => {
  const codePoint = "한".codePointAt(0);
  const legacyCode = encodeLegacyBigFontCode(codePoint);
  assert.equal(legacyCode, 0xc7d1);

  const cache = new ShxGlyphCache({
    fontFactory: bigFontFactory(legacyCode),
  });
  cache.registerFont("KSC.SHX", new Uint8Array([1]));
  const glyph = cache.getGlyph({ fontFile: "", bigFontFile: "ksc.shx" }, codePoint);

  assert.ok(glyph);
  assert.equal(glyph.encodedCode, legacyCode);
  assert.equal(glyph.fontType, ShxFontType.BIGFONT);
  assert.equal(glyph.segmentCount, 1);
});

test("evicts least-recently-used compiled glyphs at the configured cap", () => {
  const cache = new ShxGlyphCache({
    maximumGlyphs: 2,
    maximumGlyphBytes: 1_024,
  });
  cache.registerFont("simplex.shx", textFontBuffer([65, 66, 67]));
  for (const code of [65, 66, 67]) {
    assert.ok(cache.getGlyph({ fontFile: "simplex.shx" }, code));
  }

  assert.equal(cache.stats.glyphs, 2);
  assert.equal(cache.stats.evictions, 1);
  assert.ok(cache.stats.glyphBytes <= 1_024);
});

test("rejects oversized font files before parsing", () => {
  const cache = new ShxGlyphCache({
    maximumFontFileBytes: 4,
    maximumTotalFontBytes: 8,
    maximumParsedFontBytes: 8,
  });
  assert.throws(
    () => cache.registerFont("large.shx", new Uint8Array(5)),
    /allowed range/,
  );
});

test("enforces the parsed-font limit at registration", () => {
  const cache = new ShxGlyphCache({
    maximumFontFileBytes: 8,
    maximumTotalFontBytes: 8,
    maximumParsedFontBytes: 4,
  });
  assert.throws(
    () => cache.registerFont("large.shx", new Uint8Array(5)),
    /parsed-font limit/,
  );
});

test("isolates a malformed glyph without disabling the rest of the font", () => {
  const cache = new ShxGlyphCache({
    fontFactory(buffer) {
      const font = new ShxFont(buffer);
      const getLayoutCharShape = font.getLayoutCharShape.bind(font);
      font.getLayoutCharShape = (code, size) => {
        if (code === 65) {
          throw new Error("malformed glyph");
        }
        return getLayoutCharShape(code, size);
      };
      return font;
    },
  });
  cache.registerFont("mixed.shx", textFontBuffer([65, 66]));

  assert.equal(cache.getGlyph({ fontFile: "mixed.shx" }, 65), undefined);
  assert.ok(cache.getGlyph({ fontFile: "mixed.shx" }, 66));
});

test("isolates a malformed character lookup", () => {
  const cache = new ShxGlyphCache({
    fontFactory(buffer) {
      const font = new ShxFont(buffer);
      const hasChar = font.hasChar.bind(font);
      font.hasChar = (code) => {
        if (code === 65) {
          throw new Error("malformed lookup");
        }
        return hasChar(code);
      };
      return font;
    },
  });
  cache.registerFont("mixed.shx", textFontBuffer([65, 66]));

  assert.equal(cache.getGlyph({ fontFile: "mixed.shx" }, 65), undefined);
  assert.ok(cache.getGlyph({ fontFile: "mixed.shx" }, 66));
});

test("reports and removes a font whose parser cannot be opened", () => {
  const cache = new ShxGlyphCache({
    fontFactory() {
      throw new Error("invalid SHX header");
    },
  });
  cache.registerFont("broken.shx", new Uint8Array([1]));

  assert.equal(cache.fontStatus("broken.shx").state, "registered");
  assert.equal(
    cache.getGlyph({ fontFile: "broken.shx" }, 65),
    undefined,
  );
  assert.equal(cache.fontStatus("broken.shx").state, "invalid");
  assert.deepEqual(
    cache.missingFonts([{ fontFile: "broken.shx", bigFontFile: "" }]),
    ["broken.shx"],
  );
  assert.equal(cache.unregisterFont("broken.shx"), true);
  assert.equal(cache.fontStatus("broken.shx").state, "missing");
  assert.equal(cache.stats.registeredFontBytes, 0);
});

test("closes parser windows without retaining parsed-font bytes", () => {
  const cache = new ShxGlyphCache({
    parserGlyphWindow: 1,
  });
  cache.registerFont("window.shx", textFontBuffer([65, 66]));

  assert.ok(cache.getGlyph({ fontFile: "window.shx" }, 65));
  assert.equal(cache.stats.parsedFontBytes, 0);
  assert.ok(cache.getGlyph({ fontFile: "window.shx" }, 66));
  assert.equal(cache.stats.parsedFontBytes, 0);
  cache.clearGlyphs();
  assert.equal(cache.stats.parsedFontBytes, 0);
});

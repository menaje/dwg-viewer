import {
  ShxFont,
  resolveAdvanceWidth,
} from "#shx-parser";

const DEFAULT_MAX_FONT_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_FONT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_PARSED_FONT_BYTES = 48 * 1024 * 1024;
const DEFAULT_MAX_GLYPH_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_GLYPHS = 4_096;
const DEFAULT_MAX_SEGMENTS_PER_GLYPH = 8_192;
const DEFAULT_PARSER_GLYPH_WINDOW = 256;
const COMPILED_SEGMENT_BYTES = 4 * Float32Array.BYTES_PER_ELEMENT;
const GLYPH_OVERHEAD_BYTES = 64;

const legacyCodeMaps = new Map();

export function normalizeShxFontName(value) {
  if (typeof value !== "string") {
    return "";
  }
  const unquoted = value.trim().replace(/^["']|["']$/g, "");
  return unquoted.split(/[\\/]/).at(-1)?.toLocaleLowerCase("en-US") ?? "";
}

function fontAliases(name) {
  const normalized = normalizeShxFontName(name);
  if (!normalized) {
    return [];
  }
  const aliases = new Set([normalized]);
  if (normalized.endsWith(".shx")) {
    aliases.add(normalized.slice(0, -4));
  } else {
    aliases.add(`${normalized}.shx`);
  }
  return [...aliases];
}

function asExactArrayBuffer(value) {
  if (value instanceof ArrayBuffer) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    );
  }
  throw new TypeError("SHX font data must be an ArrayBuffer or typed-array view");
}

function buildLegacyCodeMap(encoding) {
  let decoder;
  try {
    decoder = new TextDecoder(encoding, { fatal: true });
  } catch {
    return new Map();
  }
  const bytes = new Uint8Array(2);
  const mapping = new Map();
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    bytes[0] = lead;
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) {
        continue;
      }
      bytes[1] = trail;
      try {
        const decoded = decoder.decode(bytes);
        const characters = [...decoded];
        if (characters.length !== 1) {
          continue;
        }
        const codePoint = characters[0].codePointAt(0);
        if (codePoint > 0x7f && !mapping.has(codePoint)) {
          mapping.set(codePoint, (lead << 8) | trail);
        }
      } catch {
        // Invalid byte pairs are expected while building the reverse index.
      }
    }
  }
  return mapping;
}

export function encodeLegacyBigFontCode(
  codePoint,
  encoding = "euc-kr",
) {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return undefined;
  }
  if (!legacyCodeMaps.has(encoding)) {
    legacyCodeMaps.set(encoding, buildLegacyCodeMap(encoding));
  }
  return legacyCodeMaps.get(encoding).get(codePoint);
}

function compileGlyph(shape, maximumSegments) {
  let segmentCount = 0;
  for (const polyline of shape.polylines) {
    segmentCount += Math.max(0, polyline.length - 1);
    if (segmentCount > maximumSegments) {
      throw new Error(
        `SHX glyph has ${segmentCount} segments, above the ${maximumSegments}-segment limit`,
      );
    }
  }
  const vertices = new Float32Array(segmentCount * 4);
  let cursor = 0;
  for (const polyline of shape.polylines) {
    for (let index = 1; index < polyline.length; index += 1) {
      const start = polyline[index - 1];
      const end = polyline[index];
      for (const value of [start.x, start.y, end.x, end.y]) {
        if (!Number.isFinite(value)) {
          throw new Error("SHX glyph contains a non-finite coordinate");
        }
        const encoded = Math.fround(value);
        if (!Number.isFinite(encoded)) {
          throw new Error("SHX glyph coordinate exceeds the f32 display range");
        }
        vertices[cursor] = encoded;
        cursor += 1;
      }
    }
  }
  return { vertices, segmentCount };
}

export class ShxGlyphCache {
  constructor({
    maximumFontFileBytes = DEFAULT_MAX_FONT_FILE_BYTES,
    maximumTotalFontBytes = DEFAULT_MAX_TOTAL_FONT_BYTES,
    maximumParsedFontBytes = DEFAULT_MAX_PARSED_FONT_BYTES,
    maximumGlyphBytes = DEFAULT_MAX_GLYPH_BYTES,
    maximumGlyphs = DEFAULT_MAX_GLYPHS,
    maximumSegmentsPerGlyph = DEFAULT_MAX_SEGMENTS_PER_GLYPH,
    parserGlyphWindow = DEFAULT_PARSER_GLYPH_WINDOW,
    legacyEncoding = "euc-kr",
    fontFactory = (buffer) => new ShxFont(buffer),
  } = {}) {
    for (const [label, value] of Object.entries({
      maximumFontFileBytes,
      maximumTotalFontBytes,
      maximumParsedFontBytes,
      maximumGlyphBytes,
      maximumGlyphs,
      maximumSegmentsPerGlyph,
      parserGlyphWindow,
    })) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${label} must be a positive safe integer`);
      }
    }
    this.maximumFontFileBytes = maximumFontFileBytes;
    this.maximumTotalFontBytes = maximumTotalFontBytes;
    this.maximumParsedFontBytes = maximumParsedFontBytes;
    this.maximumGlyphBytes = maximumGlyphBytes;
    this.maximumGlyphs = maximumGlyphs;
    this.maximumSegmentsPerGlyph = maximumSegmentsPerGlyph;
    this.parserGlyphWindow = parserGlyphWindow;
    this.legacyEncoding = legacyEncoding;
    this.fontFactory = fontFactory;
    this.aliases = new Map();
    this.fonts = new Set();
    this.glyphs = new Map();
    this.nextFontId = 1;
    this.totalFontBytes = 0;
    this.parsedFontBytes = 0;
    this.glyphBytes = 0;
    this.glyphSegments = 0;
    this.clock = 0;
    this.hitCount = 0;
    this.missCount = 0;
    this.evictionCount = 0;
  }

  registerFont(name, data) {
    const aliases = fontAliases(name);
    if (aliases.length === 0) {
      throw new Error("SHX font name is empty");
    }
    const buffer = asExactArrayBuffer(data);
    if (buffer.byteLength === 0 || buffer.byteLength > this.maximumFontFileBytes) {
      throw new RangeError(
        `SHX font is ${buffer.byteLength} bytes; allowed range is 1-${this.maximumFontFileBytes}`,
      );
    }
    if (buffer.byteLength > this.maximumParsedFontBytes) {
      throw new RangeError(
        `SHX font is ${buffer.byteLength} bytes and cannot fit within the ${this.maximumParsedFontBytes}-byte parsed-font limit`,
      );
    }
    const existing = this.aliases.get(aliases[0]);
    if (existing) {
      this.#removeFont(existing);
    }
    if (
      this.totalFontBytes + buffer.byteLength >
      this.maximumTotalFontBytes
    ) {
      throw new RangeError(
        `registered SHX fonts exceed the ${this.maximumTotalFontBytes}-byte limit`,
      );
    }
    const record = {
      id: this.nextFontId,
      name: aliases[0],
      aliases,
      buffer,
      font: null,
      error: null,
      lastUsed: 0,
      parsedGlyphs: 0,
    };
    this.nextFontId += 1;
    this.fonts.add(record);
    for (const alias of aliases) {
      this.aliases.set(alias, record);
    }
    this.totalFontBytes += buffer.byteLength;
    return Object.freeze({ name: record.name, size: buffer.byteLength });
  }

  async registerFiles(files) {
    const registered = [];
    for (const file of files) {
      if (!file || typeof file.name !== "string") {
        throw new TypeError("SHX font input must expose a file name");
      }
      if (
        Number.isFinite(file.size) &&
        (file.size <= 0 || file.size > this.maximumFontFileBytes)
      ) {
        throw new RangeError(
          `SHX font is ${file.size} bytes; allowed range is 1-${this.maximumFontFileBytes}`,
        );
      }
      if (typeof file.arrayBuffer !== "function") {
        throw new TypeError("SHX font input must expose arrayBuffer()");
      }
      registered.push(this.registerFont(file.name, await file.arrayBuffer()));
    }
    return Object.freeze(registered);
  }

  hasFont(name) {
    return this.#resolveFont(name) !== undefined;
  }

  missingFonts(styles) {
    const missing = new Set();
    for (const style of styles) {
      for (const name of [style.fontFile, style.bigFontFile]) {
        if (name && !this.hasFont(name)) {
          missing.add(name);
        }
      }
    }
    return Object.freeze([...missing]);
  }

  getGlyph(style, codePoint) {
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
      throw new RangeError(`invalid Unicode code point: ${codePoint}`);
    }
    const primary = this.#resolveFont(style?.fontFile);
    const big = this.#resolveFont(style?.bigFontFile);
    for (const record of [primary, big]) {
      const glyph = this.#getGlyphForCode(record, codePoint);
      if (glyph) {
        return glyph;
      }
    }
    if (codePoint > 0x7f) {
      const legacyCode = encodeLegacyBigFontCode(
        codePoint,
        this.legacyEncoding,
      );
      if (legacyCode !== undefined) {
        for (const record of [big, primary]) {
          const glyph = this.#getGlyphForCode(record, legacyCode);
          if (glyph) {
            return glyph;
          }
        }
      }
    }
    this.missCount += 1;
    return undefined;
  }

  clearGlyphs() {
    this.glyphs.clear();
    this.glyphBytes = 0;
    this.glyphSegments = 0;
    for (const record of this.fonts) {
      record.font?.release();
      record.parsedGlyphs = 0;
    }
  }

  dispose() {
    this.clearGlyphs();
    for (const record of this.fonts) {
      this.#closeParser(record);
    }
    this.aliases.clear();
    this.fonts.clear();
    this.totalFontBytes = 0;
  }

  get stats() {
    return Object.freeze({
      registeredFonts: this.fonts.size,
      registeredFontBytes: this.totalFontBytes,
      parsedFontBytes: this.parsedFontBytes,
      glyphs: this.glyphs.size,
      glyphBytes: this.glyphBytes,
      glyphSegments: this.glyphSegments,
      hits: this.hitCount,
      misses: this.missCount,
      evictions: this.evictionCount,
    });
  }

  #resolveFont(name) {
    for (const alias of fontAliases(name)) {
      const record = this.aliases.get(alias);
      if (record) {
        return record;
      }
    }
    return undefined;
  }

  #openParser(record) {
    if (!record || record.error) {
      return undefined;
    }
    record.lastUsed = ++this.clock;
    if (record.font) {
      return record.font;
    }
    this.#makeParsedFontRoom(record.buffer.byteLength, record);
    try {
      record.font = this.fontFactory(record.buffer);
      this.parsedFontBytes += record.buffer.byteLength;
      record.parsedGlyphs = 0;
      return record.font;
    } catch (error) {
      record.error = error instanceof Error ? error : new Error(String(error));
      return undefined;
    }
  }

  #makeParsedFontRoom(byteLength, excludedRecord) {
    while (
      this.parsedFontBytes + byteLength > this.maximumParsedFontBytes
    ) {
      let oldest;
      for (const record of this.fonts) {
        if (
          record !== excludedRecord &&
          record.font &&
          (!oldest || record.lastUsed < oldest.lastUsed)
        ) {
          oldest = record;
        }
      }
      if (!oldest) {
        break;
      }
      this.#closeParser(oldest);
    }
  }

  #closeParser(record) {
    if (!record.font) {
      return;
    }
    record.font.release();
    record.font = null;
    record.parsedGlyphs = 0;
    this.parsedFontBytes -= record.buffer.byteLength;
  }

  #getGlyphForCode(record, encodedCode) {
    if (!record) {
      return undefined;
    }
    const key = `${record.id}:${encodedCode}`;
    if (this.glyphs.has(key)) {
      const cached = this.glyphs.get(key);
      this.glyphs.delete(key);
      this.glyphs.set(key, cached);
      record.lastUsed = ++this.clock;
      this.hitCount += 1;
      return cached.glyph ?? undefined;
    }
    const font = this.#openParser(record);
    if (!font) {
      return undefined;
    }
    try {
      if (!font.hasChar(encodedCode)) {
        this.#storeGlyph(key, { glyph: null, bytes: 0, segments: 0 });
        return undefined;
      }
      const shape = font.getLayoutCharShape(encodedCode, 1);
      if (!shape) {
        this.#storeGlyph(key, { glyph: null, bytes: 0, segments: 0 });
        return undefined;
      }
      const compiled = compileGlyph(shape, this.maximumSegmentsPerGlyph);
      const advance = resolveAdvanceWidth(shape, font.fontData, 1);
      if (!Number.isFinite(advance)) {
        throw new Error("SHX glyph has a non-finite advance width");
      }
      const glyph = Object.freeze({
        fontName: record.name,
        fontType: font.fontData.header.fontType,
        encodedCode,
        advance,
        vertices: compiled.vertices,
        segmentCount: compiled.segmentCount,
      });
      this.#storeGlyph(key, {
        glyph,
        bytes: compiled.vertices.byteLength + GLYPH_OVERHEAD_BYTES,
        segments: compiled.segmentCount,
      });
      record.parsedGlyphs += 1;
      if (record.parsedGlyphs >= this.parserGlyphWindow) {
        font.release();
        record.parsedGlyphs = 0;
      }
      return glyph;
    } catch {
      this.#storeGlyph(key, { glyph: null, bytes: 0, segments: 0 });
      font.release();
      record.parsedGlyphs = 0;
      return undefined;
    }
  }

  #storeGlyph(key, entry) {
    if (entry.bytes > this.maximumGlyphBytes) {
      return;
    }
    while (
      this.glyphs.size >= this.maximumGlyphs ||
      this.glyphBytes + entry.bytes > this.maximumGlyphBytes
    ) {
      const oldestKey = this.glyphs.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      const oldest = this.glyphs.get(oldestKey);
      this.glyphs.delete(oldestKey);
      this.glyphBytes -= oldest.bytes;
      this.glyphSegments -= oldest.segments;
      this.evictionCount += 1;
    }
    this.glyphs.set(key, entry);
    this.glyphBytes += entry.bytes;
    this.glyphSegments += entry.segments;
  }

  #removeFont(record) {
    this.#closeParser(record);
    for (const alias of record.aliases) {
      if (this.aliases.get(alias) === record) {
        this.aliases.delete(alias);
      }
    }
    this.fonts.delete(record);
    this.totalFontBytes -= record.buffer.byteLength;
    for (const [key, entry] of this.glyphs) {
      if (key.startsWith(`${record.id}:`)) {
        this.glyphs.delete(key);
        this.glyphBytes -= entry.bytes;
        this.glyphSegments -= entry.segments;
      }
    }
  }
}

export {
  DEFAULT_MAX_FONT_FILE_BYTES,
  DEFAULT_MAX_GLYPH_BYTES,
  DEFAULT_MAX_GLYPHS,
  DEFAULT_MAX_PARSED_FONT_BYTES,
  DEFAULT_MAX_SEGMENTS_PER_GLYPH,
  DEFAULT_MAX_TOTAL_FONT_BYTES,
};

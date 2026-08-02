import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeCp949Code,
  encodeEucKrCode,
  encodeJohabCode,
  encodeLegacyBigFontCode,
  legacyKoreanCodeCandidates,
  normalizeLegacyKoreanEncoding,
} from "../src/legacy-korean-encoding.mjs";

test("normalizes explicit Korean legacy encoding names", () => {
  assert.equal(normalizeLegacyKoreanEncoding("EUC-KR"), "euc-kr");
  assert.equal(normalizeLegacyKoreanEncoding("UHC"), "cp949");
  assert.equal(normalizeLegacyKoreanEncoding("CP1361"), "johab");
  assert.equal(normalizeLegacyKoreanEncoding("unknown"), "auto");
  assert.equal(
    normalizeLegacyKoreanEncoding("unknown", ""),
    "",
  );
});

test("keeps strict EUC-KR separate from the CP949 extension", () => {
  assert.equal(encodeEucKrCode("한".codePointAt(0)), 0xc7d1);
  assert.equal(encodeCp949Code("한".codePointAt(0)), 0xc7d1);
  assert.equal(encodeEucKrCode("갂".codePointAt(0)), undefined);
  assert.equal(encodeCp949Code("갂".codePointAt(0)), 0x8141);
  assert.equal(encodeEucKrCode("힣".codePointAt(0)), undefined);
  assert.equal(encodeCp949Code("힣".codePointAt(0)), 0xc652);

  let strictSyllables = 0;
  let cp949Syllables = 0;
  for (let codePoint = 0xac00; codePoint <= 0xd7a3; codePoint += 1) {
    strictSyllables += encodeEucKrCode(codePoint) === undefined ? 0 : 1;
    cp949Syllables += encodeCp949Code(codePoint) === undefined ? 0 : 1;
  }
  assert.equal(strictSyllables, 2_350);
  assert.equal(cp949Syllables, 11_172);
});

test("encodes all modern Hangul syllables into unique Johab codes", () => {
  const codes = new Set();
  for (let codePoint = 0xac00; codePoint <= 0xd7a3; codePoint += 1) {
    const encoded = encodeJohabCode(codePoint);
    assert.ok(Number.isInteger(encoded));
    codes.add(encoded);
  }
  assert.equal(codes.size, 11_172);
  assert.equal(encodeJohabCode("가".codePointAt(0)), 0x8861);
  assert.equal(encodeJohabCode("각".codePointAt(0)), 0x8862);
  assert.equal(encodeJohabCode("나".codePointAt(0)), 0x9061);
  assert.equal(encodeJohabCode("한".codePointAt(0)), 0xd065);
  assert.equal(encodeJohabCode("힣".codePointAt(0)), 0xd3bd);
  assert.equal(encodeJohabCode("A".codePointAt(0)), undefined);
});

test("maps the complete CP1361 KS X 1001 symbol and Hanja rows", () => {
  assert.equal(encodeJohabCode("°".codePointAt(0)), 0xd956);
  assert.equal(encodeJohabCode("±".codePointAt(0)), 0xd94e);
  assert.equal(encodeJohabCode("®".codePointAt(0)), 0xd9e7);
  assert.equal(encodeJohabCode("€".codePointAt(0)), 0xd9e6);
  assert.equal(encodeJohabCode("一".codePointAt(0)), 0xf179);
  assert.equal(encodeJohabCode("中".codePointAt(0)), 0xf3e9);
  assert.equal(encodeJohabCode("韓".codePointAt(0)), 0xf7db);

  const codes = new Set();
  let symbols = 0;
  let hanja = 0;
  for (let codePoint = 0; codePoint <= 0xffff; codePoint += 1) {
    const eucKrCode = encodeEucKrCode(codePoint);
    if (eucKrCode === undefined) {
      continue;
    }
    const lead = eucKrCode >>> 8;
    const isSymbol =
      lead >= 0xa1 && lead <= 0xac && lead !== 0xa4;
    const isHanja = lead >= 0xca && lead <= 0xfd;
    if (!isSymbol && !isHanja) {
      continue;
    }
    const johabCode = encodeJohabCode(codePoint);
    assert.ok(Number.isInteger(johabCode));
    codes.add(johabCode);
    symbols += isSymbol ? 1 : 0;
    hanja += isHanja ? 1 : 0;
  }
  assert.equal(symbols, 892);
  assert.equal(hanja, 4_888);
  assert.equal(codes.size, symbols + hanja);
  assert.equal(encodeJohabCode("ㄱ".codePointAt(0)), undefined);
});

test("returns deterministic auto candidates without duplicate codes", () => {
  assert.deepEqual(
    legacyKoreanCodeCandidates("한".codePointAt(0)),
    [
      { encoding: "euc-kr", code: 0xc7d1 },
      { encoding: "johab", code: 0xd065 },
    ],
  );
  assert.deepEqual(
    legacyKoreanCodeCandidates("갂".codePointAt(0)),
    [
      { encoding: "cp949", code: 0x8141 },
      { encoding: "johab", code: 0x8863 },
    ],
  );
  assert.equal(
    encodeLegacyBigFontCode("갂".codePointAt(0), "cp949"),
    0x8141,
  );
  assert.equal(
    encodeLegacyBigFontCode("갂".codePointAt(0), "euc-kr"),
    undefined,
  );
  assert.deepEqual(
    legacyKoreanCodeCandidates("中".codePointAt(0)),
    [
      { encoding: "euc-kr", code: 0xf1e9 },
      { encoding: "johab", code: 0xf3e9 },
    ],
  );
});

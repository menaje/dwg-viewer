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
});

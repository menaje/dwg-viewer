import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeBigFontEncodingMappings,
} from "../src/bigfont-encoding";

test("normalizes bounded per-font Korean encoding mappings", () => {
  assert.deepEqual(
    normalizeBigFontEncodingMappings({
      "KSC.SHX": "EUC-KR",
      whgtxt: "UHC",
      "johab.shx": "CP1361",
      "bad.ttf": "cp949",
      "unknown.shx": "guess",
    }),
    {
      "johab.shx": "johab",
      "ksc.shx": "euc-kr",
      "whgtxt.shx": "cp949",
    },
  );
});

test("bounds mappings and lets a canonical duplicate update its value", () => {
  assert.deepEqual(
    normalizeBigFontEncodingMappings(
      {
        first: "euc-kr",
        "FIRST.SHX": "johab",
        second: "cp949",
      },
      1,
    ),
    {
      "first.shx": "johab",
    },
  );
  assert.deepEqual(normalizeBigFontEncodingMappings([]), {});
  assert.throws(
    () => normalizeBigFontEncodingMappings({}, 0),
    /positive safe integer/u,
  );
});

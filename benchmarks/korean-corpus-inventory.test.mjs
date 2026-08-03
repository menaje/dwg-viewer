import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySize,
  deriveCorpusMetadata,
  parseInventoryArguments,
  selectCorpusCases,
} from "./korean-corpus-inventory.mjs";

function inspection({
  version = "AC1024",
  storage = "unicode",
  codepage = "ANSI_949",
  primaryShx = 1,
  outline = 1,
  bigfont = 1,
  hangul = 20,
  embeddedHangul = 3,
} = {}) {
  return {
    schema: "dwg-inspection/1",
    status: "ok",
    drawing: { version },
    text_environment: {
      storage,
      codepage,
      font_references: {
        primary_shx: primaryShx,
        outline,
        other: 0,
        bigfont,
      },
    },
    text: {
      hangul_characters: hangul,
      question_marks: 1,
      replacement_characters: 0,
      null_characters: 0,
    },
    embedded_text: {
      hangul_characters: embeddedHangul,
      question_marks: 0,
      replacement_characters: 0,
      null_characters: 0,
    },
  };
}

test("parses bounded absolute inventory options", () => {
  assert.deepEqual(
    parseInventoryArguments([
      "--root",
      "/private/drawings",
      "--adapter",
      "/private/adapter",
      "--output",
      "/private/manifest.json",
      "--limit",
      "20",
      "--discipline",
      "mep",
      "--include-xrefs",
    ]),
    {
      rootPath: "/private/drawings",
      adapterPath: "/private/adapter",
      outputPath: "/private/manifest.json",
      limit: 20,
      discipline: "mep",
      timeoutMs: 120_000,
      includeXrefs: true,
      redistributable: false,
    },
  );
  assert.throws(
    () =>
      parseInventoryArguments([
        "--root",
        "relative",
        "--adapter",
        "/adapter",
        "--output",
        "/manifest",
      ]),
    /absolute path/u,
  );
});

test("classifies the fixed private corpus size bands", () => {
  assert.equal(classifySize(199_999), "small");
  assert.equal(classifySize(200_000), "medium");
  assert.equal(classifySize(499_999), "medium");
  assert.equal(classifySize(500_000), "large");
});

test("derives only observed Korean text, encoding and font metadata", () => {
  const candidate = {
    inputPath: "/private/one.dwg",
    sizeClass: "large",
    dwgVersion: "AC1024",
  };
  assert.deepEqual(
    deriveCorpusMetadata(candidate, inspection(), "architecture"),
    {
      path: "/private/one.dwg",
      redistributable: false,
      discipline: "architecture",
      sizeClass: "large",
      dwgVersion: "AC1024",
      encodings: ["unicode"],
      fontKinds: ["shx", "bigfont", "ttf"],
      expectedText: {
        minimumHangulCharacters: 23,
        maximumReplacementCharacters: 0,
        maximumNullCharacters: 0,
        maximumQuestionMarks: 1,
      },
    },
  );
  assert.equal(
    deriveCorpusMetadata(
      candidate,
      inspection({ hangul: 0, embeddedHangul: 0 }),
      "architecture",
    ),
    null,
  );
  assert.deepEqual(
    deriveCorpusMetadata(
      candidate,
      inspection({ primaryShx: 0, outline: 0, bigfont: 0 }),
      "architecture",
    ),
    {
      path: "/private/one.dwg",
      redistributable: false,
      discipline: "architecture",
      sizeClass: "large",
      dwgVersion: "AC1024",
      encodings: ["unicode"],
      fontKinds: [],
      expectedText: {
        minimumHangulCharacters: 23,
        maximumReplacementCharacters: 0,
        maximumNullCharacters: 0,
        maximumQuestionMarks: 1,
      },
    },
  );
});

test("creates relative paths only after an explicit redistribution assertion", async () => {
  const candidate = {
    inputPath: "/public/corpus/sub/one.dwg",
    sizeClass: "small",
    dwgVersion: "AC1018",
  };
  const result = await selectCorpusCases(
    [candidate],
    {
      limit: 1,
      discipline: "architecture",
      redistributable: true,
      rootPath: "/public/corpus",
    },
    async () =>
      inspection({
        version: "AC1018",
        storage: "legacy",
        codepage: "ANSI_949",
      }),
  );
  assert.equal(result.manifest.cases[0].path, "sub/one.dwg");
  assert.equal(result.manifest.cases[0].redistributable, true);
});

test("maps observed legacy Korean codepages without claiming EUC-KR", () => {
  const cp949 = deriveCorpusMetadata(
    {
      inputPath: "/private/cp949.dwg",
      sizeClass: "small",
      dwgVersion: "AC1018",
    },
    inspection({
      version: "AC1018",
      storage: "legacy",
      codepage: "ANSI_949",
    }),
    "architecture",
  );
  assert.deepEqual(cp949.encodings, ["cp949"]);

  const johab = deriveCorpusMetadata(
    {
      inputPath: "/private/johab.dwg",
      sizeClass: "small",
      dwgVersion: "AC1018",
    },
    inspection({
      version: "AC1018",
      storage: "legacy",
      codepage: "ANSI_1361",
    }),
    "architecture",
  );
  assert.deepEqual(johab.encodings, ["johab"]);
});

test("interleaves version and size groups and anonymizes selected IDs", async () => {
  const candidates = [
    ["AC1024", "large", "/private/z.dwg"],
    ["AC1018", "small", "/private/b.dwg"],
    ["AC1024", "large", "/private/a.dwg"],
    ["AC1021", "medium", "/private/c.dwg"],
  ].map(([dwgVersion, sizeClass, inputPath]) => ({
    dwgVersion,
    sizeClass,
    inputPath,
  }));
  const versionByPath = new Map(
    candidates.map(({ inputPath, dwgVersion }) => [
      inputPath,
      dwgVersion,
    ]),
  );
  const result = await selectCorpusCases(
    candidates,
    { limit: 3, discipline: "architecture" },
    async (inputPath) =>
      inspection({ version: versionByPath.get(inputPath) }),
  );
  assert.equal(result.inspected, 3);
  assert.deepEqual(
    result.manifest.cases.map(({ id }) => id),
    ["case-001", "case-002", "case-003"],
  );
  assert.deepEqual(
    new Set(result.manifest.cases.map(({ dwgVersion }) => dwgVersion)),
    new Set(["AC1018", "AC1021", "AC1024"]),
  );
  assert.doesNotMatch(JSON.stringify(result.manifest), /z\.dwg/u);
});

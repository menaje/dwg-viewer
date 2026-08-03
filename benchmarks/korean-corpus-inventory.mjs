#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import {
  open,
  opendir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);

const MANIFEST_SCHEMA = "dwg-korean-corpus-manifest/1";
const INSPECTION_SCHEMA = "dwg-inspection/1";
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 64;
const MAX_CANDIDATES = 4_096;
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000;
const SMALL_FILE_LIMIT = 200_000;
const MEDIUM_FILE_LIMIT = 500_000;
const DWG_VERSIONS = new Set([
  "AC1015",
  "AC1018",
  "AC1021",
  "AC1024",
  "AC1027",
  "AC1032",
]);
const DISCIPLINES = new Set([
  "architecture",
  "civil",
  "mep",
  "other",
]);

function integerOption(value, option, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new TypeError(
      `${option} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new TypeError(`${option} requires a value`);
  }
  return value;
}

export function parseInventoryArguments(argv) {
  const options = {
    limit: DEFAULT_LIMIT,
    discipline: "architecture",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    includeXrefs: false,
    redistributable: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--include-xrefs") {
      options.includeXrefs = true;
      continue;
    }
    if (option === "--redistributable") {
      options.redistributable = true;
      continue;
    }
    const value = optionValue(argv, index, option);
    index += 1;
    switch (option) {
      case "--root":
        options.rootPath = value;
        break;
      case "--adapter":
        options.adapterPath = value;
        break;
      case "--output":
        options.outputPath = value;
        break;
      case "--limit":
        options.limit = integerOption(value, option, 1, MAX_LIMIT);
        break;
      case "--discipline":
        if (!DISCIPLINES.has(value)) {
          throw new TypeError(`${option} is unsupported`);
        }
        options.discipline = value;
        break;
      case "--timeout-ms":
        options.timeoutMs = integerOption(
          value,
          option,
          1_000,
          10 * 60 * 1_000,
        );
        break;
      default:
        throw new TypeError(`unknown option: ${option}`);
    }
  }
  for (const key of ["rootPath", "adapterPath", "outputPath"]) {
    if (!options[key] || !path.isAbsolute(options[key])) {
      throw new TypeError(`${key} must be an absolute path`);
    }
  }
  if (
    options.redistributable &&
    path.resolve(path.dirname(options.outputPath)) !==
      path.resolve(options.rootPath)
  ) {
    throw new TypeError(
      "a redistributable manifest must be written inside its corpus root",
    );
  }
  return Object.freeze(options);
}

export function classifySize(sizeBytes) {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new TypeError("sizeBytes must be a non-negative integer");
  }
  if (sizeBytes < SMALL_FILE_LIMIT) {
    return "small";
  }
  if (sizeBytes < MEDIUM_FILE_LIMIT) {
    return "medium";
  }
  return "large";
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function combinedText(report) {
  const result = {
    hangulCharacters: 0,
    questionMarks: 0,
    replacementCharacters: 0,
    nullCharacters: 0,
  };
  for (const [sourceName, source] of [
    ["text", report.text],
    ["embedded_text", report.embedded_text ?? {}],
  ]) {
    result.hangulCharacters += nonnegativeInteger(
      source.hangul_characters ?? 0,
      `${sourceName}.hangul_characters`,
    );
    result.questionMarks += nonnegativeInteger(
      source.question_marks ?? 0,
      `${sourceName}.question_marks`,
    );
    result.replacementCharacters += nonnegativeInteger(
      source.replacement_characters ?? 0,
      `${sourceName}.replacement_characters`,
    );
    result.nullCharacters += nonnegativeInteger(
      source.null_characters ?? 0,
      `${sourceName}.null_characters`,
    );
  }
  return Object.freeze(result);
}

function detectedEncodings(textEnvironment) {
  if (textEnvironment?.storage === "unicode") {
    return Object.freeze(["unicode"]);
  }
  if (textEnvironment?.storage !== "legacy") {
    return Object.freeze([]);
  }
  const codepage = textEnvironment.codepage;
  if (codepage === "CP949" || codepage === "ANSI_949") {
    return Object.freeze(["cp949"]);
  }
  if (codepage === "JOHAB" || codepage === "ANSI_1361") {
    return Object.freeze(["johab"]);
  }
  return Object.freeze([]);
}

function detectedFontKinds(textEnvironment) {
  const references = textEnvironment?.font_references;
  if (!references || typeof references !== "object") {
    return Object.freeze([]);
  }
  const kinds = [];
  if (nonnegativeInteger(references.primary_shx, "primary_shx") > 0) {
    kinds.push("shx");
  }
  if (nonnegativeInteger(references.bigfont, "bigfont") > 0) {
    kinds.push("bigfont");
  }
  if (nonnegativeInteger(references.outline, "outline") > 0) {
    kinds.push("ttf");
  }
  return Object.freeze(kinds);
}

export function deriveCorpusMetadata(
  candidate,
  report,
  discipline,
  redistributable = false,
) {
  if (
    report?.schema !== INSPECTION_SCHEMA ||
    report?.status !== "ok" ||
    report?.drawing?.version !== candidate.dwgVersion
  ) {
    return null;
  }
  const text = combinedText(report);
  const encodings = detectedEncodings(report.text_environment);
  const fontKinds = detectedFontKinds(report.text_environment);
  if (
    text.hangulCharacters === 0 ||
    encodings.length === 0
  ) {
    return null;
  }
  return Object.freeze({
    path: candidate.inputPath,
    redistributable,
    discipline,
    sizeClass: candidate.sizeClass,
    dwgVersion: candidate.dwgVersion,
    encodings,
    fontKinds,
    expectedText: Object.freeze({
      minimumHangulCharacters: text.hangulCharacters,
      maximumReplacementCharacters: text.replacementCharacters,
      maximumNullCharacters: text.nullCharacters,
      maximumQuestionMarks: text.questionMarks,
    }),
  });
}

function publicManifestCandidate(candidate, options) {
  if (!options.redistributable) {
    return candidate;
  }
  const relativePath = path.relative(
    options.rootPath,
    candidate.inputPath,
  );
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    throw new Error("candidate is outside the public corpus root");
  }
  return Object.freeze({
    ...candidate,
    inputPath: relativePath.split(path.sep).join("/"),
  });
}

function candidateGroup(candidate) {
  return `${candidate.dwgVersion}/${candidate.sizeClass}`;
}

function interleaveCandidates(candidates) {
  const grouped = new Map();
  for (const candidate of candidates) {
    const key = candidateGroup(candidate);
    const values = grouped.get(key) ?? [];
    values.push(candidate);
    grouped.set(key, values);
  }
  const groups = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, values]) =>
      values.sort((left, right) =>
        left.inputPath.localeCompare(right.inputPath),
      ),
    );
  const interleaved = [];
  for (let offset = 0; ; offset += 1) {
    let appended = false;
    for (const group of groups) {
      if (offset < group.length) {
        interleaved.push(group[offset]);
        appended = true;
      }
    }
    if (!appended) {
      return interleaved;
    }
  }
}

export async function selectCorpusCases(
  candidates,
  options,
  inspectCandidate,
) {
  const selected = [];
  let inspected = 0;
  for (const candidate of interleaveCandidates(candidates)) {
    if (selected.length >= options.limit) {
      break;
    }
    inspected += 1;
    let report;
    try {
      report = await inspectCandidate(candidate.inputPath);
    } catch {
      continue;
    }
    let metadata;
    try {
      metadata = deriveCorpusMetadata(
        publicManifestCandidate(candidate, options),
        report,
        options.discipline,
        options.redistributable,
      );
    } catch {
      continue;
    }
    if (metadata) {
      selected.push({
        id: `case-${String(selected.length + 1).padStart(3, "0")}`,
        ...metadata,
      });
    }
  }
  return Object.freeze({
    inspected,
    manifest: Object.freeze({
      schema: MANIFEST_SCHEMA,
      cases: Object.freeze(selected),
    }),
  });
}

function isXrefPath(rootPath, inputPath) {
  return path
    .relative(rootPath, path.dirname(inputPath))
    .split(path.sep)
    .some((part) => part.toLocaleLowerCase() === "xref");
}

async function readDwgVersion(inputPath) {
  const file = await open(inputPath, "r");
  try {
    const buffer = Buffer.alloc(6);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== buffer.length) {
      return null;
    }
    const version = buffer.toString("ascii");
    return DWG_VERSIONS.has(version) ? version : null;
  } finally {
    await file.close();
  }
}

async function scanCandidates(rootPath, includeXrefs) {
  const candidates = [];
  const directories = [rootPath];
  while (directories.length > 0) {
    const directory = directories.pop();
    const entries = [];
    for await (const entry of await opendir(directory)) {
      entries.push(entry);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const inputPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(inputPath);
        continue;
      }
      if (
        !entry.isFile() ||
        path.extname(entry.name).toLocaleLowerCase() !== ".dwg" ||
        (!includeXrefs && isXrefPath(rootPath, inputPath))
      ) {
        continue;
      }
      if (candidates.length >= MAX_CANDIDATES) {
        throw new RangeError(
          `candidate count exceeds the ${MAX_CANDIDATES}-file limit`,
        );
      }
      const [metadata, dwgVersion] = await Promise.all([
        stat(inputPath),
        readDwgVersion(inputPath),
      ]);
      if (!metadata.isFile() || !dwgVersion) {
        continue;
      }
      candidates.push(
        Object.freeze({
          inputPath,
          sizeBytes: metadata.size,
          sizeClass: classifySize(metadata.size),
          dwgVersion,
        }),
      );
    }
  }
  return Object.freeze(candidates);
}

async function inspectWithAdapter(inputPath, options) {
  const { stdout } = await execFile(
    options.adapterPath,
    ["inspect", inputPath],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: options.timeoutMs,
      windowsHide: true,
    },
  );
  return JSON.parse(stdout);
}

function coverage(cases) {
  return Object.freeze({
    versions: Object.freeze([
      ...new Set(cases.map(({ dwgVersion }) => dwgVersion)),
    ].sort()),
    sizeClasses: Object.freeze([
      ...new Set(cases.map(({ sizeClass }) => sizeClass)),
    ].sort()),
    encodings: Object.freeze([
      ...new Set(cases.flatMap(({ encodings }) => encodings)),
    ].sort()),
    fontKinds: Object.freeze([
      ...new Set(cases.flatMap(({ fontKinds }) => fontKinds)),
    ].sort()),
  });
}

async function main(argv) {
  const options = parseInventoryArguments(argv);
  const candidates = await scanCandidates(
    options.rootPath,
    options.includeXrefs,
  );
  const result = await selectCorpusCases(
    candidates,
    options,
    (inputPath) => inspectWithAdapter(inputPath, options),
  );
  if (result.manifest.cases.length === 0) {
    throw new Error("no Korean DWG cases passed inventory inspection");
  }
  await writeFile(
    options.outputPath,
    `${JSON.stringify(result.manifest, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  process.stdout.write(
    `${JSON.stringify({
      candidates: candidates.length,
      inspected: result.inspected,
      selected: result.manifest.cases.length,
      coverage: coverage(result.manifest.cases),
      pathsIncludedInSummary: false,
    })}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Korean corpus inventory failed: ${
        error instanceof Error ? error.message : "unknown error"
      }\n`,
    );
    process.exitCode = 1;
  });
}

export {
  DEFAULT_LIMIT,
  MANIFEST_SCHEMA,
  MEDIUM_FILE_LIMIT,
  SMALL_FILE_LIMIT,
};

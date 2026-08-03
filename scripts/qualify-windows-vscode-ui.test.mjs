// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  parseWindowsUiArguments,
  rectIsContained,
  WINDOWS_UI_CLEANUP_OPTIONS,
  WINDOWS_UI_EXTENSION_ID,
} from "./qualify-windows-vscode-ui.mjs";

test("parses only the bounded Windows UI qualification inputs", () => {
  const options = parseWindowsUiArguments([
    "--adapter",
    "./adapter.exe",
    "--drawing",
    "./drawing.dwg",
    "--vsix",
    "./viewer.vsix",
    "--output-dir",
    "./evidence",
  ]);
  assert.equal(options.adapterPath, path.resolve("./adapter.exe"));
  assert.equal(options.drawingPath, path.resolve("./drawing.dwg"));
  assert.equal(options.vsixPath, path.resolve("./viewer.vsix"));
  assert.equal(options.outputDirectory, path.resolve("./evidence"));
  assert.throws(
    () =>
      parseWindowsUiArguments([
        "--adapter",
        "./adapter.exe",
        "--drawing",
        "./drawing.dwg",
        "--vsix",
        "./viewer.vsix",
        "--output-dir",
        "./evidence",
        "--unknown",
        "value",
      ]),
    /unsupported option/u,
  );
});

test("accepts only visible rectangles contained by the CSS viewport", () => {
  const viewport = { width: 800, height: 600 };
  assert.equal(
    rectIsContained(
      {
        left: 8,
        top: 8,
        right: 108,
        bottom: 58,
        width: 100,
        height: 50,
      },
      viewport,
    ),
    true,
  );
  assert.equal(
    rectIsContained(
      {
        left: 790,
        top: 8,
        right: 830,
        bottom: 58,
        width: 40,
        height: 50,
      },
      viewport,
    ),
    false,
  );
  assert.equal(
    rectIsContained(
      {
        left: 8,
        top: 8,
        right: 8,
        bottom: 58,
        width: 0,
        height: 50,
      },
      viewport,
    ),
    false,
  );
});

test("uses the packaged extension manifest identity", async () => {
  const manifest = JSON.parse(
    await readFile(
      path.resolve("apps/vscode-extension/package.json"),
      "utf8",
    ),
  );
  assert.equal(
    WINDOWS_UI_EXTENSION_ID,
    `${manifest.publisher}.${manifest.name}`,
  );
});

test("bounds Windows profile lock cleanup retries", () => {
  assert.deepEqual(WINDOWS_UI_CLEANUP_OPTIONS, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
});

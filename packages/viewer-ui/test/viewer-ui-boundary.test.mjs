import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import {
  ViewerUiApi,
  ViewerUiVersion,
} from "../src/index.mjs";

test("keeps Viewer UI free of product and source implementations", async () => {
  const sourceDirectory = new URL("../src/", import.meta.url);
  const sources = await Promise.all(
    (await readdir(sourceDirectory))
      .filter((name) => name.endsWith(".mjs"))
      .map((name) =>
        readFile(new URL(name, sourceDirectory), "utf8"),
      ),
  );
  const combined = sources.join("\n");

  assert.doesNotMatch(combined, /from\s+["']vscode["']/u);
  assert.doesNotMatch(combined, /acquireVsCodeApi/u);
  assert.doesNotMatch(combined, /SceneCacheReader/u);
  assert.doesNotMatch(combined, /@dwg-viewer\/dwg-scene-source/u);
  assert.doesNotMatch(combined, /Workspace/u);
});

test("keeps Viewer UI version and compatibility manifest aligned", async () => {
  const root = new URL("../../../", import.meta.url);
  const [manifest, packageDocument] = await Promise.all([
    readFile(new URL("compatibility/viewer-core.json", root), "utf8"),
    readFile(
      new URL("packages/viewer-ui/package.json", root),
      "utf8",
    ),
  ]).then((documents) => documents.map(JSON.parse));

  assert.equal(manifest.viewerUi.package, packageDocument.name);
  assert.equal(manifest.viewerUi.version, packageDocument.version);
  assert.equal(manifest.viewerUi.version, ViewerUiVersion);
  assert.equal(manifest.viewerUi.api, ViewerUiApi);
  assert.equal(
    manifest.components.reviewUi,
    "canonical-dom-lifecycle-with-dwg-result-and-revision-diff-adapters",
  );
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const artifactDirectory = process.argv[2];
const tag = process.argv[3] ?? null;

if (!artifactDirectory || process.argv.length > 4) {
  throw new Error(
    "usage: node scripts/verify-viewer-webgl-artifacts.mjs " +
      "<artifact-directory> [tag]",
  );
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

const [compatibility, webglPackage, sceneSourcePackage] =
  await Promise.all([
    readJson(
      path.join(
        repositoryRoot,
        "compatibility",
        "viewer-webgl.json",
      ),
    ),
    readJson(
      path.join(
        repositoryRoot,
        "packages",
        "webview",
        "package.json",
      ),
    ),
    readJson(
      path.join(
        repositoryRoot,
        "packages",
        "dwg-scene-source",
        "package.json",
      ),
    ),
  ]);

assert.equal(
  compatibility.schema,
  "menaje-viewer-webgl-compatibility/1",
);
assert.equal(
  compatibility.distribution.tagPublicationApproved,
  true,
);
assert.equal(
  webglPackage.name,
  compatibility.viewerWebGl.package,
);
assert.equal(
  sceneSourcePackage.name,
  compatibility.dwgSceneSource.package,
);
assert.equal(
  webglPackage.version,
  compatibility.viewerWebGl.version,
);
assert.equal(
  sceneSourcePackage.version,
  compatibility.dwgSceneSource.version,
);
assert.equal(webglPackage.version, sceneSourcePackage.version);

const expectedTag = `viewer-webgl-v${webglPackage.version}`;
assert.equal(compatibility.distribution.tag, expectedTag);
if (tag) {
  assert.equal(tag, expectedTag);
}

for (const [key, packageManifest] of [
  ["viewerWebGl", webglPackage],
  ["dwgSceneSource", sceneSourcePackage],
]) {
  const expected =
    compatibility.distribution.artifacts[key];
  const expectedFile =
    `${packageManifest.name.slice(1).replace("/", "-")}-` +
    `${packageManifest.version}.tgz`;
  assert.equal(expected.file, expectedFile);

  const artifactPath = path.join(
    artifactDirectory,
    expected.file,
  );
  const [bytes, metadata] = await Promise.all([
    readFile(artifactPath),
    stat(artifactPath),
  ]);
  assert.equal(metadata.size, expected.bytes);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    expected.sha256,
  );
}

console.log(
  JSON.stringify({
    status: "passed",
    version: webglPackage.version,
    tag: expectedTag,
    artifacts: compatibility.distribution.artifacts,
  }),
);

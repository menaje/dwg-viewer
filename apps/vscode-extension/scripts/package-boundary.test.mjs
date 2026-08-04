// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const extensionRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(extensionRoot, "..", "..");

test("keeps the MPL VSIX and GPL adapter distribution boundaries explicit", async () => {
  const [
    manifestText,
    repositoryManifestText,
    ignoreRules,
    readme,
    repositoryReadme,
    packagedLicense,
    repositoryLicense,
    packagedNotices,
    repositoryNotices,
  ] = await Promise.all([
    readFile(path.join(extensionRoot, "package.json"), "utf8"),
    readFile(path.join(repositoryRoot, "package.json"), "utf8"),
    readFile(path.join(extensionRoot, ".vscodeignore"), "utf8"),
    readFile(path.join(extensionRoot, "README.md"), "utf8"),
    readFile(path.join(repositoryRoot, "README.md"), "utf8"),
    readFile(path.join(extensionRoot, "LICENSE"), "utf8"),
    readFile(path.join(repositoryRoot, "LICENSE"), "utf8"),
    readFile(
      path.join(extensionRoot, "THIRD_PARTY_NOTICES.md"),
      "utf8",
    ),
    readFile(path.join(repositoryRoot, "THIRD_PARTY_NOTICES.md"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const repositoryManifest = JSON.parse(repositoryManifestText);

  assert.equal(manifest.license, "MPL-2.0");
  assert.equal(
    manifest.repository?.url,
    "https://github.com/menaje/dwg-viewer.git",
  );
  assert.match(ignoreRules, /(?:^|\n)native\/\*\*(?:\n|$)/u);
  assert.match(
    readme,
    /complete source form[\s\S]*menaje\/dwg-viewer repository/u,
  );
  assert.match(
    readme,
    /GPL-3\.0-or-later LibreDWG adapter is never included in the VSIX/u,
  );
  assert.equal(packagedLicense, repositoryLicense);
  assert.equal(packagedNotices, repositoryNotices);
  assert.match(repositoryReadme, /오픈소스/u);
  assert.match(readme, /open-source/iu);
  assert.match(repositoryManifest.description, /open-source/iu);
  assert.match(manifest.description, /open-source/iu);
  for (const marketingText of [
    repositoryReadme,
    readme,
    repositoryManifest.description,
    manifest.description,
  ]) {
    assert.doesNotMatch(marketingText, /무료/u);
    assert.doesNotMatch(marketingText, /(?:^|[^A-Za-z])free(?:[^A-Za-z]|$)/iu);
  }
  assert.match(packagedNotices, /Copyright \(c\) 2024 mlight-lee/u);
  assert.match(
    packagedNotices,
    /Permission is hereby granted, free of charge/u,
  );
  assert.match(packagedNotices, /Copyright \(c\) 2026, Mapbox/u);
  assert.match(
    packagedNotices,
    /Permission to use, copy, modify, and\/or distribute/u,
  );
});

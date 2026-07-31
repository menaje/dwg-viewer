import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderWebviewHtml } from "../src/webview-html";

const template = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <script type="importmap">{"imports":{"x":"./x.js"}}</script>
    <script type="module" src="./src/main.mjs"></script>
  </body>
</html>`;

test("renders a nonce-protected VS Code webview without an import map", () => {
  const html = renderWebviewHtml(template, {
    cspSource: "vscode-webview:",
    nonce: "abcdefghijklmnopqrstuvwxyz",
    stylesUri: "vscode-webview://test/styles.css",
    scriptUri: "vscode-webview://test/main.mjs",
  });

  assert.match(html, /default-src 'none'/u);
  assert.match(html, /worker-src blob:/u);
  assert.match(html, /connect-src vscode-webview:/u);
  assert.match(html, /nonce-abcdefghijklmnopqrstuvwxyz/u);
  assert.match(
    html,
    /nonce="abcdefghijklmnopqrstuvwxyz" type="module"/u,
  );
  assert.match(html, /data-host="vscode"/u);
  assert.match(html, /vscode-webview:\/\/test\/styles\.css/u);
  assert.match(html, /vscode-webview:\/\/test\/main\.mjs/u);
  assert.doesNotMatch(html, /importmap/u);
});

test("rejects a weak webview nonce", () => {
  assert.throws(
    () =>
      renderWebviewHtml(template, {
        cspSource: "vscode-webview:",
        nonce: "short",
        stylesUri: "styles",
        scriptUri: "script",
      }),
    /nonce is invalid/u,
  );
});

test("renders the repository Webview template with the strict policy", async () => {
  const repositoryTemplate = await readFile(
    path.resolve(
      __dirname,
      "../../../..",
      "packages",
      "webview",
      "index.html",
    ),
    "utf8",
  );
  const html = renderWebviewHtml(repositoryTemplate, {
    cspSource: "vscode-webview:",
    nonce: "repositorytemplate012345",
    stylesUri: "vscode-webview://test/styles.css",
    scriptUri: "vscode-webview://test/main.mjs",
  });
  assert.match(html, /Content-Security-Policy/u);
  assert.doesNotMatch(html, /node_modules/u);
  assert.doesNotMatch(html, /importmap/u);
});

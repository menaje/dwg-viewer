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

test("repository Webview CSS keeps host-only controls hidden", async () => {
  const repositoryStyles = await readFile(
    path.resolve(
      __dirname,
      "../../../..",
      "packages",
      "webview",
      "styles.css",
    ),
    "utf8",
  );
  assert.match(
    repositoryStyles,
    /\[hidden\]\s*\{\s*display:\s*none\s*!important;/u,
  );
  assert.match(
    repositoryStyles,
    /body\[data-host="vscode"\]\s+#metrics\s*\{\s*display:\s*none;/u,
  );
  assert.match(
    repositoryStyles,
    /body\[data-host="vscode"\]\s+\.viewport,[\s\S]*?border:\s*0;/u,
  );
  assert.match(
    repositoryStyles,
    /header:hover\s+\.toolbar,[\s\S]*?pointer-events:\s*auto;/u,
  );
  assert.match(
    repositoryStyles,
    /body\[data-host="vscode"\]\s+\.layout-tabs\s*\{[\s\S]*?opacity:\s*0\.88;[\s\S]*?transform:\s*translate\(-50%,\s*0\);/u,
  );
  assert.doesNotMatch(
    repositoryStyles,
    /\.layout-tabs\s*\{[\s\S]*?translate\(-50%,\s*calc\(100%\s*-\s*8px\)\)/u,
  );
});

test("repository host UI and manifest expose adapter selection and diagnosis", async () => {
  const repositoryRoot = path.resolve(__dirname, "../../../..");
  const [template, mainModule, manifestText] = await Promise.all([
    readFile(
      path.join(repositoryRoot, "packages", "webview", "index.html"),
      "utf8",
    ),
    readFile(
      path.join(repositoryRoot, "packages", "webview", "src", "main.mjs"),
      "utf8",
    ),
    readFile(
      path.join(
        repositoryRoot,
        "apps",
        "vscode-extension",
        "package.json",
      ),
      "utf8",
    ),
  ]);
  assert.match(
    template,
    /id="host-adapter-setup"[^>]*hidden/u,
  );
  assert.match(
    template,
    /id="viewer-tools-trigger"[^>]*aria-expanded="false"/u,
  );
  assert.match(mainModule, /setViewerToolsOpen/u);
  assert.match(mainModule, /code\.startsWith\("ADAPTER_"\)/u);
  assert.match(mainModule, /type: "dwg-adapter-select\/1"/u);

  const manifest = JSON.parse(manifestText) as {
    contributes?: {
      commands?: Array<{ command?: string }>;
      configuration?: {
        properties?: Record<
          string,
          { default?: unknown; type?: unknown }
        >;
      };
    };
  };
  const commands = new Set(
    manifest.contributes?.commands?.map(({ command }) => command),
  );
  assert.equal(commands.has("dwgViewer.selectLibreDwgAdapter"), true);
  assert.equal(commands.has("dwgViewer.diagnoseLibreDwgAdapter"), true);
  assert.deepEqual(
    manifest.contributes?.configuration?.properties?.[
      "dwgViewer.progressivePreview"
    ],
    {
      type: "boolean",
      default: false,
      scope: "window",
      description:
        "Show an overview while full conversion continues. This improves first-frame latency but substantially increases concurrent memory.",
    },
  );
  assert.deepEqual(
    manifest.contributes?.configuration?.properties?.[
      "dwgViewer.shxBigFontEncodings"
    ],
    {
      type: "object",
      default: {},
      scope: "window",
      maxProperties: 128,
      additionalProperties: {
        type: "string",
        enum: ["auto", "euc-kr", "cp949", "johab"],
      },
      description:
        "Map a DWG-requested BigFont name to auto glyph probing, strict EUC-KR, Windows CP949/UHC, or Johab CP1361 codes.",
    },
  );
});

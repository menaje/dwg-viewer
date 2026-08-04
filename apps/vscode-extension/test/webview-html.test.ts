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
    locale: "ko-KR",
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
  assert.match(html, /<html lang="ko-KR" data-locale="ko-KR">/u);
  assert.match(html, /vscode-webview:\/\/test\/styles\.css/u);
  assert.match(html, /vscode-webview:\/\/test\/main\.mjs/u);
  assert.doesNotMatch(html, /importmap/u);
});

test("falls back to English for an invalid host locale", () => {
  const html = renderWebviewHtml(template, {
    cspSource: "vscode-webview:",
    nonce: "abcdefghijklmnopqrstuvwxyz",
    stylesUri: "vscode-webview://test/styles.css",
    scriptUri: "vscode-webview://test/main.mjs",
    locale: 'ko" data-host="unsafe',
  });

  assert.match(html, /<html lang="en" data-locale="en">/u);
  assert.doesNotMatch(html, /data-host="unsafe"/u);
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
  assert.match(
    repositoryStyles,
    /body\[data-host="vscode"\]\s+header\s*\{[\s\S]*?right:\s*max\(0\.75rem,\s*env\(safe-area-inset-right\)\);[\s\S]*?width:\s*2\.95rem;[\s\S]*?max-width:\s*calc\(100%\s*-\s*2rem\);[\s\S]*?height:\s*2\.95rem;/u,
  );
  assert.match(
    repositoryStyles,
    /header\.tools-open\s*\{[\s\S]*?width:\s*min\(52rem,\s*calc\(100%\s*-\s*2rem\)\);/u,
  );
  assert.doesNotMatch(
    repositoryStyles,
    /100vw/u,
  );
  assert.match(
    repositoryStyles,
    /body\[data-host="vscode"\]\s+\.review-toolbar\s*\{[\s\S]*?z-index:\s*15;[\s\S]*?width:\s*2\.75rem;[\s\S]*?opacity:\s*0\.72;/u,
  );
  assert.match(
    repositoryStyles,
    /\.review-toolbar button:hover \.review-tool-label,[\s\S]*?\.review-toolbar button:focus-visible \.review-tool-label/u,
  );
  assert.doesNotMatch(
    repositoryStyles,
    /\.review-toolbar:hover \.review-tool-label/u,
  );
  assert.match(
    repositoryStyles,
    /\.toolbar \.viewer-tool-button:hover \.viewer-tool-label,[\s\S]*?visibility:\s*visible;[\s\S]*?opacity:\s*1;/u,
  );
  assert.match(
    repositoryStyles,
    /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?body\[data-host="vscode"\]\s+\.review-result\s*\{[\s\S]*?width:\s*min\(20rem,\s*calc\(100%\s*-\s*11\.25rem\)\);[\s\S]*?body\[data-host="vscode"\]\s+\.view-bookmark-panel\s*\{[\s\S]*?width:\s*min\(23rem,\s*calc\(100%\s*-\s*11\.25rem\)\);/u,
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
  assert.match(template, /id="review-toolbar"/u);
  assert.match(template, /id="window-zoom"/u);
  assert.match(template, /id="view-history-back"/u);
  assert.match(template, /id="view-history-forward"/u);
  assert.match(template, /id="view-bookmarks-toggle"/u);
  assert.match(template, /id="view-bookmark-panel"/u);
  assert.match(template, /id="export-toggle"/u);
  assert.match(template, /id="export-panel"/u);
  assert.match(template, /id="export-target"/u);
  assert.match(template, /id="export-format"/u);
  assert.match(template, /id="export-paper"/u);
  assert.match(template, /id="export-orientation"/u);
  assert.match(template, /id="export-scale"/u);
  assert.match(template, /id="export-plot-style"/u);
  assert.match(template, /data-review-tool="distance"/u);
  assert.match(template, /data-review-action="settings"/u);
  assert.match(template, /data-i18n="review\.settings"/u);
  assert.match(template, /class="viewer-tool-icon"/u);
  assert.match(template, /class="viewer-tool-label"/u);
  assert.match(template, /id="review-result"/u);
  assert.match(
    template,
    /"@menaje\/viewer-core":\s*"\.\.\/viewer-core\/src\/index\.mjs"/u,
  );
  assert.match(
    template,
    /"@menaje\/viewer-ui":\s*"\.\.\/viewer-ui\/src\/index\.mjs"/u,
  );
  assert.match(
    template,
    /"@dwg-viewer\/dwg-scene-source":\s*"\.\.\/dwg-scene-source\/src\/index\.mjs"/u,
  );
  assert.match(
    template,
    /id="host-rebuild"[\s\S]*?data-i18n="toolbar\.rebuild"/u,
  );
  assert.doesNotMatch(template, /캐시 다시 만들기/u);
  assert.match(mainModule, /setViewerToolsOpen/u);
  assert.match(
    mainModule,
    /if\s*\(!open\)\s*\{\s*closeViewerPanels\(\);/u,
  );
  assert.match(mainModule, /viewerToolSurfaceContains/u);
  assert.match(mainModule, /new ReviewTools/u);
  assert.match(mainModule, /new DwgSceneCacheSource/u);
  assert.match(mainModule, /openViewerRuntime/u);
  assert.match(mainModule, /createRenderLayerRangeSource/u);
  assert.match(mainModule, /new ViewerSelectionController/u);
  assert.match(mainModule, /projectDwgSelection/u);
  assert.match(mainModule, /onSelectionChange/u);
  assert.match(mainModule, /new CameraViewHistory/u);
  assert.match(mainModule, /normalizeViewBookmarks/u);
  assert.match(mainModule, /focusAt\(\s*bookmark\.view\.origin/u);
  assert.match(mainModule, /measurementPreferences/u);
  assert.match(mainModule, /vscodeApi\.setState/u);
  assert.match(mainModule, /makeRasterPdf/u);
  assert.match(mainModule, /makeStoredZip/u);
  assert.match(mainModule, /type: "dwg-export-save\/1"/u);
  assert.match(mainModule, /code\.startsWith\("ADAPTER_"\)/u);
  assert.match(mainModule, /type: "dwg-adapter-select\/1"/u);
  assert.match(mainModule, /type: "dwg-font-file-select\/1"/u);
  assert.match(
    mainModule,
    /type: "dwg-plot-style-file-select\/1"/u,
  );

  const manifest = JSON.parse(manifestText) as {
    contributes?: {
      commands?: Array<{ command?: string }>;
      menus?: {
        "view/title"?: Array<{
          command?: string;
          toggled?: string;
        }>;
      };
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
  assert.equal(commands.has("dwgViewer.searchWorkspaceText"), true);
  assert.equal(
    commands.has("dwgViewer.toggleTextSearchRegularExpression"),
    true,
  );
  assert.deepEqual(
    manifest.contributes?.menus?.["view/title"]?.find(
      ({ command }) =>
        command === "dwgViewer.toggleTextSearchRegularExpression",
    ),
    {
      command: "dwgViewer.toggleTextSearchRegularExpression",
      when: "view == dwgViewer.textSearch",
      group: "navigation@3",
      toggled: "dwgViewer.textSearchRegularExpressionEnabled",
    },
  );
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
  assert.deepEqual(
    manifest.contributes?.configuration?.properties?.[
      "dwgViewer.textSearchUseRegularExpression"
    ],
    {
      type: "boolean",
      default: false,
      scope: "window",
      description:
        "Use a bounded JavaScript regular expression by default in workspace DWG text search. The Explorer view toggle is retained per workspace.",
    },
  );
});

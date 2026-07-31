# DWG Viewer for VS Code

Free, local-first, read-only DWG viewing inside VS Code.

This early build opens `.dwg` files with a native Custom Editor, converts them
to the project scene-cache format on the local machine, and streams only the
ranges required by the Webview. Drawing data is never uploaded.

## Native converter

The extension deliberately does not bundle the GPL-licensed LibreDWG adapter in
the MPL-licensed VSIX. Build or extract the repository's separate GPL package,
then run **DWG Viewer: LibreDWG 변환기 선택** and select the executable. The
extension checks the engine version, GPL declaration, protocol and Scene Cache
compatibility before saving the setting.

The same path can be set manually:

```json
{
  "dwgViewer.libredwgAdapterPath": "/absolute/path/to/libredwg-adapter"
}
```

For local development only, `DWG_VIEWER_LIBREDWG_ADAPTER` can provide the same
absolute path. A separately distributed adapter may also be placed at
`native/<platform>-<architecture>/libredwg-adapter`.

Run **DWG Viewer: LibreDWG 변환기 진단** at any time to repeat the bounded
five-second self-test. Diagnosis runs only on request and is not added to the
normal drawing-open or cached first-frame path. If an adapter is missing, the
viewer error screen exposes the same select-and-diagnose action.

The first open creates a private cache under VS Code's extension storage.
Subsequent opens reuse it until the drawing or converter changes.

## Engine boundary

LibreDWG Native runs behind the versioned `dwg-scene-engine/1` interface.
Engine and backend capabilities, bounded progress phases, conversion options
and implementation revision are part of the cache contract. Native and any
future reworked WASM Worker receive separate cache identities and would still
feed the same range reader and renderer.

WASM is not a selectable backend in this build. The actual LibreDWG 0.14
MEMFS prototype produced byte-identical output on a small public fixture and
proved Worker termination, but failed the 800 MB total-memory hard gate and
did not complete that fixture in a real Chromium Worker within 30 seconds. On
the large reference drawing, all string tables matched Native but text
placement, GPU line and HATCH geometry sections were not byte-identical.
The common cache path retains a WASM-shaped contract test only; a redesigned
disk-backed candidate must repeat every geometry, Korean text, cancellation,
memory, performance, license and package gate before any setting or fallback
is added.

## SHX and Korean BigFont folders

After the first geometry frame, the extension reads the drawing's text styles
and resolves only the SHX and BigFont filenames those styles request. The
drawing's own folder is searched first. Additional local folders can be added
from the viewer's **글꼴 → 글꼴 폴더 추가** action, from the command palette
command **DWG Viewer: SHX 글꼴 폴더 추가**, or in settings:

```json
{
  "dwgViewer.shxFontDirectories": [
    "/absolute/path/to/cad-fonts"
  ]
}
```

Folders are indexed non-recursively, in priority order, only until a requested
name is found, and never before the first frame. A requested CAD font can be
mapped to a replacement filename in those folders, or to an explicitly
configured absolute file:

```json
{
  "dwgViewer.shxFontMappings": {
    "whgtxt.shx": "korean.shx",
    "oldfont.shx": "/absolute/path/to/replacement.shx"
  }
}
```

The font panel reports connected, substituted, missing, unreadable, malformed
and over-budget fonts without exposing absolute paths to the Webview. Font
requests are isolated to the active cache, served serially, and capped at 128
files, 32 MiB per file and 64 MiB transferred per drawing. Parsed fonts and
compiled glyphs remain under the Webview's separate byte-bounded caches.

## Current scope

- Read-only model-space viewing
- Bounded cache range reads (maximum 8 MiB per request)
- Layer visibility, pan, zoom, hatch, and text
- Delayed SHX/BigFont discovery, mapping, diagnostics, and Korean fallback
- Conversion cancellation when the editor closes
- Retry and forced cache rebuild

This is the first integration milestone tracked by GitHub issue #19.

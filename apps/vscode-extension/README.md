# DWG Viewer for VS Code

Free, local-first, read-only DWG viewing inside VS Code.

The extension uses an immersive viewer shell: the drawing fills the editor
without the development frame or performance dashboard. Its top-right tool
shelf and bottom layout tabs stay folded until hovered, keyboard-focused or
explicitly opened. The repository's standalone Webview remains the diagnostic
and performance-development surface.

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
The default memory-balanced path finishes the Native conversion before
initializing Webview content. This avoids overlapping LibreDWG's parser
footprint with a fully initialized Webview renderer. Subsequent opens reuse
the canonical cache until the drawing or converter changes.

An explicit speed-first mode can display a bounded line overview while full
detail continues:

```json
{
  "dwgViewer.progressivePreview": true
}
```

This option is off by default because it trades memory for about two seconds
of first-frame latency. On the 24,680,147-byte reference drawing, a stabilized
VS Code host reached the balanced first frame in 3.736–3.795 seconds with
530.4–595.7 MB incremental physical memory across four isolated runs. The
progressive mode reached a frame in 1.824 seconds but used 664.7 MB; during an
immediate cold-start overlap it reached 919.4 MB and failed the 800 MB hard
limit. Both modes keep the same validated canonical cache.

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
and resolves only the SHX, BigFont, TTF and OTF filenames those styles request.
An existing stored relative or native absolute path is tried first, followed
by the drawing folder, bounded project/package roots and finally configured
fallback folders. Additional local folders can be added from the viewer's
**글꼴 → 글꼴 폴더 추가** action, from the command palette command
**DWG Viewer: SHX 글꼴 폴더 추가**, or in settings:

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

The font panel reports connected, substituted, ambiguous, missing, unreadable,
malformed and over-budget fonts without exposing resolved absolute paths to
the Webview. An unresolved row offers a native file picker and keeps the
selected mapping only for the current drawing session. Font requests are
isolated to the active cache, served serially, and capped at 128 files, 32 MiB
per file and 64 MiB transferred per drawing. Parsed fonts and compiled glyphs
remain under the Webview's separate byte-bounded caches.

Layout CTB files use the same stored-path, drawing, bounded project and
configured-folder order. Equal-rank matches are never selected implicitly.
The **출력 선택** action lets the user choose a CTB for the current drawing,
and CTB colors and lineweights are applied only to a layout that references
that output style.

Legacy Korean BigFont codes default to glyph-based automatic probing: strict
EUC-KR first, then the CP949/UHC extension, then Johab/CP1361. The viewer does
not infer an encoding from a font filename. If a font contains ambiguous code
slots, configure the requested DWG BigFont name explicitly:

```json
{
  "dwgViewer.shxBigFontEncodings": {
    "ksc.shx": "euc-kr",
    "whgtxt.shx": "cp949",
    "hanjohab.shx": "johab"
  }
}
```

The accepted values are `auto`, `euc-kr`, `cp949`, and `johab`, with at most
128 mappings per window. The font panel displays the effective choice. Strict
EUC-KR and CP949 are separate, and the Johab path covers all 11,172 modern
Hangul syllables. Non-Hangul Johab symbols and Hanja still require a direct
Unicode glyph or the system-font fallback.

## External references

Scene Cache v1.12 and later retain each DWG XREF's original path. The extension tries,
in order, a saved manual mapping, an absolute path valid on the current
platform, a path relative to the parent drawing, and the adjacent `xref`
folder. It then performs a bounded basename search and ranks candidates by
matching parent, grandparent and further trailing path segments. Equally
ranked files are never selected silently; the **외부 참조** panel offers a
manual file picker.

The resolver understands Windows drive, UNC, POSIX and relative paths on both
Windows and macOS, including leading `..`, Unicode normalization and
case-insensitive comparison where required. A manual selection can be saved
for only that source reference, the same basename, or the original directory
prefix. Optional project roots are configured as absolute paths:

```json
{
  "dwgViewer.xrefSearchDirectories": [
    "/absolute/path/to/project-drawings"
  ]
}
```

Search is limited to 32 roots, depth 8, 50,000 entries and 256 candidates.
Symlink directories and the whole disk are not traversed. Conversion and
Webview loading are serialized; cycles, nesting beyond depth 8 and more than
64 references are rejected. External overview source, overview GPU and detail
GPU data each have a 32 MiB aggregate limit.

Scene Cache v1.18 raster IMAGE references reuse the same portable-path and
bounded parent-folder search rules. The host currently transfers JPG/JPEG and
PNG only, with a 32 MiB file limit, 100-million-pixel source limit, 256
references and 64 MiB unique compressed-transfer budget per open drawing.
`dwgViewer.imageSearchDirectories` adds absolute project image roots. Missing
or ambiguous images appear in the same **외부 참조** panel for manual
selection. The Webview decodes only visible references at their current
screen size, then upgrades the bitmap after a meaningful zoom instead of
eagerly decoding every source at full resolution.

## Current scope

- Read-only model-space viewing
- Memory-balanced first open with an optional progressive Native overview
- Bounded cache range reads (maximum 8 MiB per request)
- Layer visibility, pan, zoom, hatch, and text
- Automatic and manual cross-platform DWG XREF resolution
- Lazy cross-platform JPG/PNG IMAGE resolution and manual replacement
- Shared-instance XREF linework, layer visibility, text, and detail streaming
- Delayed SHX/BigFont discovery, mapping, diagnostics, and Korean fallback
- Conversion cancellation when the editor closes
- Retry and forced cache rebuild

The initial integration milestone is recorded in GitHub issue #19; product
qualification and release completion continue in issue #6.

## License, source, and release artifacts

The VSIX is distributed under MPL-2.0. Its complete source form, build scripts,
license notice, and third-party notices are available in the
[menaje/dwg-viewer repository](https://github.com/menaje/dwg-viewer). A
versioned release is built from the Git tag with the same `v<version>` as the
VSIX manifest. The packaged VSIX includes `LICENSE.txt` and
`THIRD_PARTY_NOTICES.md`.

The GPL-3.0-or-later LibreDWG adapter is never included in the VSIX, even if a
developer has placed one under the extension's local `native/` directory. It
is published only as a separate Linux x64 or macOS arm64 archive containing
the exact LibreDWG source, adapter source, build scripts, license texts,
manifest, and checksums. Release installation and provenance verification are
documented in the
[distribution guide](https://github.com/menaje/dwg-viewer/blob/main/docs/distribution.md).
Windows packaging and qualification are tracked separately in issue #25.

## Product qualification

Build the VSIX first, then run the isolated VS Code qualification with an
absolute CLI path, runtime path, adapter and private drawing:

```bash
pnpm --filter dwg-viewer-vscode package:vsix
pnpm --filter dwg-viewer-vscode qualify:host -- \
  --code "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --runtime "/Applications/Visual Studio Code.app/Contents/MacOS/Code" \
  --adapter /absolute/path/to/libredwg-adapter \
  --drawing /absolute/path/to/reference.dwg \
  --vsix apps/vscode-extension/dwg-viewer-vscode-0.1.0.vsix \
  --output benchmarks/results/vscode-product.json
```

The runner installs the packaged extension into a private VS Code instance,
waits for the host to stabilize, samples the complete process tree, measures
de-duplicated physical memory on macOS or proportional set size on Linux, and
checks cancellation cleanup. Reports contain source size and numeric metrics,
not drawing paths or text. Add `--progressive-preview` only to qualify the
speed-first option.

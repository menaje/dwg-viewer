# Webview renderer

Dependency-free Scene Cache v1.2 reader and WebGL2 line renderer for the
VS Code Webview.

## Implemented

- Reads the cache header and section directory without loading the full file.
- Accepts local `Blob`/`File` sources and strict HTTP byte-range sources.
- Validates section bounds, record sizes, string tables and GPU batch ranges.
- Limits the overview to 8 MiB on read; current converters emit at most 4 MiB.
- Limits each detail read to 512 KiB.
- Resolves nested INSERT and MINSERT references while keeping block geometry
  shared.
- Stores instance transforms in packed `Float64Array` collections.
- Rebases world coordinates around the camera before WebGL2 `f32` upload.
- Renders overview lines with batched, instanced draw calls.
- Provides a 128 MiB byte-budgeted LRU for later viewport detail refinement.

The current page is an engine verification harness, not the final VS Code
extension UI. Pan/zoom, viewport detail selection, text, SHX/BigFont and curved
geometry refinement remain follow-up work.

## Run

From the repository root:

```bash
python3 -m http.server 4173 --bind 127.0.0.1 --directory packages/webview
```

Open `http://127.0.0.1:4173` and select a generated `.cache` file. The file
stays local to the browser.

## Test

```bash
pnpm --filter @dwg-viewer/webview check
```

Tests cover bounded range reads, cache validation, nested block transforms,
large-coordinate camera rebasing and LRU eviction/request coalescing.

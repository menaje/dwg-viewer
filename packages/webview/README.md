# Webview renderer

Dependency-free Scene Cache v1.3 reader and WebGL2 line renderer for the
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
- Supports anchored wheel/button zoom, pointer pan and fitted-view reset.
- Selects LOD 1 model and transformed block batches against the viewport.
- Streams at most two detail reads concurrently and coalesces redraws.
- Caps one visible detail set at 32 MiB and cached GPU detail at 96 MiB.
- Cancels stale queued work and safely releases in-flight results on disposal.
- Searches Hangul layer names and toggles individual or all layers without
  rereading geometry or rebuilding GPU buffers.
- Displays bounded first-pass chords for arcs, circles, ellipses, polyline
  bulges and NURBS splines emitted by the converter.

The current page is an engine verification harness, not the final VS Code
extension UI. Text, SHX/BigFont and view-adaptive high-zoom curve refinement
remain follow-up work.

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
large-coordinate camera rebasing, camera controls, viewport detail selection,
GPU resource ranges, layer visibility and LRU eviction/request coalescing.
